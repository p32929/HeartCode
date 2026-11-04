import fs from 'node:fs'
import os from 'node:os'
import { log } from './log.js'
import { prompt, userInstructions } from './prompts.js'
import { newChat } from './sessions.js'
import path from 'node:path'
import { est, estMessages, Client, writtenBy, tokensOf, COMPACT_SHARE } from './client.js'
import { runGuided } from './guided.js'
import { markUsed, removeResearch, findResearch } from './research.js'
import { loadRankings, rankIn, rankings } from './rankings.js'
import { TOOL_DEFS, PLAN_HIDDEN, folderView, readOnlyCommand, extraTools, runTool, listFiles, namedFiles, readFileTool, clip, allowed, loadMcpTools, saveOutput, isSavedOutput, runningCall, imageUrl, MAX_IMAGE, failed, noteNamedPaths } from './tools.js'
import { serversNote } from './lsp.js'
import { newlyEnded, jobLine } from './background.js'
import { loadHooks, runHooks } from './hooks.js'
import { takeConfigErrors, HOME } from './config.js'
import { runCheck, PAGE_COMMAND } from './check.js'
import { record, recordLine, similar, loadStats, summary } from './stats.js'
import { c, duration, Block, Markdown, color, diffLines, renderDiff } from './ui.js'

// Images for a helper (the agent tool's "images"), as data: URLs: image URLs (fetched), data: URLs,
// or files: in the project, saved screenshots (OUTPUTS), or a path the user gave in a message.
async function loadImages(list, s, signal) {
  // a list written as text (some models send it so): JSON, or "[a.png, b.png]", or one per line
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = list.replace(/^\s*\[|\]\s*$/g, '').split(/[,\n]/).map((x) => x.trim().replace(/^["'`]|["'`]$/g, ''))
    }
  }
  const out = []
  for (const x of [].concat(list ?? []).filter((v) => v != null).map((v) => String(v).trim()).filter(Boolean)) {
    if (x.startsWith('data:image/')) {
      out.push(x)
    } else if (/^https?:\/\//i.test(x)) {
      const res = await fetch(x, { signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) })
      const type = res.headers.get('content-type')?.split(';')[0].trim() ?? ''
      if (!res.ok || !type.startsWith('image/')) throw new Error(`${x} is not an image (${res.status}${type ? `, ${type}` : ''})`)
      const data = Buffer.from(await res.arrayBuffer())
      if (data.length > MAX_IMAGE) throw new Error(`${x} is too big to send (${Math.round(data.length / 1e6)} MB; at most ${MAX_IMAGE / 1e6} MB)`)
      out.push(`data:${type};base64,${data.toString('base64')}`)
    } else {
      const abs = path.resolve(s.root, x.replace(/^~(?=\/)/, os.homedir()))
      const inside = (dir) => abs.startsWith(dir + path.sep)
      if (fs.existsSync(abs) && !inside(s.root) && !isSavedOutput(abs) && !s.toolImages?.has(abs) && !s.chat.turns.some((t) => t.task.includes(x) || t.task.includes(abs))) throw new Error(`${x} is outside the project; only images in it, saved screenshots and ones the user named can be sent`)
      out.push(imageUrl(abs, x))
    }
  }
  return out
}

// An image the message gives is attached: "@shot.png", or a full path (/Users/me/Downloads/a.png,
// ~/a.png; dragged in: quoted, or with "\ " for spaces), when the file is there. A file only named
// ("rename logo.png") isn't: the model reads it if it needs to. The path stays in the text. Too big
// to send: left out, and the message says so.
const IMAGE_PATH = /(^|\s)(@)?(?:(["'])([^"'\n]+?\.(?:png|jpe?g|gif|webp))\3|((?:\\ |[^\s"'])+?\.(?:png|jpe?g|gif|webp)))(?=$|[\s,;:!?).])/gi
export function extractImages(task, root) {
  const images = []
  const text = task.replace(IMAGE_PATH, (m, pre, at, q, quoted, bare) => {
    const file = (quoted ?? bare.replace(/\\ /g, ' ')).replace(/^~(?=\/)/, os.homedir())
    if (!at && !path.isAbsolute(file)) return m
    const abs = path.resolve(root, file)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return m
    try {
      images.push(imageUrl(abs, file))
    } catch (e) {
      return `${pre}${file} (${e.message})`
    }
    return `${pre}${file}`
  })
  return { text, images }
}

// One model working on one chat. The chat (sessions.js) outlives it: switching models keeps it.
export class Session {
  constructor({ client, profile, strat, root, ui, chat }) {
    Object.assign(this, { client, profile, strat, root, ui, chat: chat ?? newChat(root) })
  }

  get messages() {
    return this.chat.messages
  }
  set messages(v) {
    this.chat.messages = v
  }
  get history() {
    return this.chat.history
  }

  // Forget what the model has seen (the transcript and rewind points stay).
  reset() {
    this.chat.messages = null
    this.chat.history.length = 0
  }

  // Called before HeartCode changes a file: keeps its first version in this turn, for rewinds.
  track(rel, before) {
    const turn = this.chat.turns.at(-1)
    if (turn && !(rel in turn.files)) turn.files[rel] = before
  }

  // Replaces the conversation so far with a summary the model writes (prompts/compact/*.md).
  // midTask: compacting in the middle of a task, so the model is told to carry on with `task`
  // (the user's request, kept word for word).
  // The conversation before is kept per compaction ("epoch"), so /rewind can still go back.
  // why: what the spinner says the compacting is for ("context 85% full (650k/768k)").
  async compact({ signal, focus = '', midTask = false, task = '', why = '' } = {}) {
    const { chat, client, strat, ui } = this
    const native = Boolean(chat.messages?.length)
    const head = native ? chat.messages.slice(0, chat.messages[0].role === 'system' ? 1 : 2) : [] // the system prompt stays
    const body = native ? chat.messages.slice(head.length) : []
    const conversation = native ? transcript(body) : chat.history.map((h) => `User: ${h.task}\nAssistant: ${h.answer}`).join('\n\n')
    if (!conversation.trim()) return null
    const room = Math.floor((strat.context * 0.6 * 3.5) / (strat.ratio ?? 1)) // characters of conversation the summary request can carry
    const cut = () => (conversation.length > room ? `[… the earliest part is cut]\n${conversation.slice(-room)}` : conversation)
    const before = native ? size(body) : est(conversation)
    ui.spinner(why ? `${why}: compacting the conversation` : 'compacting the conversation')
    const findings = native ? await this.findings(signal) : ''
    // A model shown its own work tends to carry on with it (calling tools, or writing tool calls
    // as text) instead of summarizing: so it's told what it is, and a reply that isn't a summary
    // is asked for again once; then the compaction fails (the conversation is trimmed instead).
    const request = (extra) => prompt('compact/summarize', { conversation: cut(), focus }) + extra
    const send = (extra) =>
      client.chat({ messages: [{ role: 'system', content: prompt('compact/summarizer') }, { role: 'user', content: request(extra) }] }, { signal })
    const ask = (extra = '') => send(extra)
    let summary = notSummary((await ask()).content)
    if (!summary) {
      log('compact', 'the reply was not a summary; asking again')
      summary = notSummary((await ask(`\n\n${prompt('compact/summarize-again')}`)).content)
    }
    if (!summary) throw new Error('the model did not write a summary')
    const epoch = chat.epoch ?? 0
    ;(chat.snapshots ??= [])[epoch] = { messages: chat.messages, history: [...chat.history] }
    chat.sentNotes = [] // the summary replaces the messages the notes came with
    chat.epoch = epoch + 1
    const recap = prompt('compact/summary', { summary, findings, requests: requestsOf(chat) })
    if (native) {
      chat.messages = midTask
        ? [...head, { role: 'user', content: `${recap}\n\n${prompt('compact/continue', { task })}` }]
        : [...head, { role: 'user', content: recap }, { role: 'assistant', content: prompt('compact/acknowledged') }]
    }
    chat.history.splice(0, chat.history.length, { task: '(the conversation before this point, summarized)', answer: summary })
    const after = native ? size(chat.messages.slice(head.length)) : est(summary)
    log('compact', `${midTask ? 'auto' : 'manual'}${why ? ` (${why})` : ''}: ~${before} → ~${after} tokens`, summary)
    client.lastTokens = 0 // the server's count was for the conversation before: none yet for this one
    this.counted = null
    ui.stopSpin()
    ui.print(`${c.faint('✻')} ${c.muted(`Compacted the conversation: ~${kTokens(before)} → ~${kTokens(after)} tokens`)}`)
    return summary
  }

  // Before the conversation is summarized, the model working on it writes down what it has found:
  // its conclusions live in its reasoning, which the summary (written from the transcript) never
  // sees, and without them it reads the same files again after every compaction. Asked as the next
  // message of its own conversation with the same tools, so the provider's cache of it still holds;
  // tool calls in the reply aren't run. '' when there's nothing to ask or it fails (the summary alone).
  async findings(signal) {
    const { chat, client, strat } = this
    if (!chat.messages?.length || !this.lastTools) return ''
    // already past the model's window (one step can add a lot): the request would only be refused
    if (strat.context > 0 && tokensOf(chat.messages, this.lastTools.map((t) => t.function), strat.ratio ?? 1) > strat.context * 0.95) {
      log('compact', 'no findings note: the conversation is already past the window')
      return ''
    }
    try {
      const r = await client.chat({ messages: [...chat.messages, { role: 'user', content: prompt('compact/findings') }], tools: this.lastTools }, { signal })
      const note = String(r.content ?? '').trim()
      log('compact', note ? `findings note: ${note.length} characters` : 'no findings note (the reply had no text)', note)
      return note
    } catch (e) {
      if (e.name === 'AbortError') throw e
      log('compact', `no findings note: ${e.message}`)
      return ''
    }
  }

  // images: data: URLs from the caller (headless input), besides @shot.png in the task.
  async run(task, signal, extra = []) {
    if (!this.isSub) this.client.newMessage?.() // the model list: from #1 again (unless set to stay)
    this.runs = (this.runs ?? 0) + 1
    const { chat, ui } = this
    repairSummary(chat)
    if (this.hooks !== false) this.hooks = loadHooks(this.root) // edits to hooks.json apply right away
    if (!this.isSub) for (const e of takeConfigErrors()) ui.warn(e) // a hooks.json or mcp.json that doesn't parse
    const hook = await runHooks(this, 'UserPromptSubmit', { prompt: task }, signal)
    if (hook.block) {
      const answer = prompt('agent/hook-blocked-prompt', { reason: hook.block })
      ui.warn(answer)
      return answer
    }
    if (hook.context) task = `${task}\n\n${hook.context}`
    // guided mode only shows the last few exchanges: fold older ones into a summary first
    if (this.strat.actions !== 'tools' && this.autoCompact && chat.history.length > 5) {
      await this.compact({ signal }).catch((e) => e.name === 'AbortError' ? Promise.reject(e) : ui.warn(`could not compact: ${e.message}`))
    }
    const epoch = chat.epoch ?? 0
    chat.turns.push({ id: Math.random().toString(36).slice(2, 10), task, at: new Date().toISOString(), epoch, msgIndex: chat.messages?.length ?? 0, histIndex: chat.history.length, logIndex: ui.inputMark ?? Math.max(0, ui.log.length - 1), files: {} })
    this.onTurn?.() // saved now: a message sent and not answered yet (quit, crash) can still be continued
    // a summary of the branch the user left (/tree) goes in before this message
    if (chat.branchNote && this.strat.actions !== 'tools') {
      chat.history.push({ task: prompt('compact/branch-note-task'), answer: chat.branchNote })
      delete chat.branchNote
    }
    let { text, images } = extractImages(task, this.root)
    images = [...images, ...extra]
    if (images.length && !this.strat.vision) {
      const fails = (t) => this.failures?.[`${t.provider} ${t.model}`] ?? 0
      const seers = (this.team?.() ?? []).filter((t) => t.images).sort((a, b) => fails(a) - fails(b)) // your models that can: they describe them
      if (seers.length) text += await this.describeImages(images, seers, text, signal)
      else this.ui.warn(`${this.client.model} can't read images (per its probe); ignoring ${images.length} image(s)`)
      images = []
    }
    // An orchestrator: the message starts on one of the models picked for it, which answers at once
    // or hands the work to your other models (it decides) — only when there are others to hand to.
    if (!this.isSub) {
      const lead = this.fitMode?.() ? (this.orchestrators?.() ?? []) : []
      this.client.orderBy?.(lead.length ? lead.map((t) => `${t.provider} ${t.model}`) : null)
      this.orchestrating = lead.length > 0 // (then team() leaves the orchestrators out)
      if (this.orchestrating && !this.team?.().length) this.orchestrating = false // no one to hand to: it does the work itself
      if (this.orchestrating) rankings().catch(() => {}) // their places, for its list of models: fetched behind (once a week), never waited for
      // never tested together (the settings page's Test): it picks by names and ranks alone, so say how to do better, once
      if (this.orchestrating && !Session.tipped && !fs.existsSync(path.join(HOME, 'full-test.json'))) (Session.tipped = true), this.ui.warn(prompt('agent/orchestrator-untested'))
      log('rotate', `this message starts on ${this.client.provider ?? ''} · ${this.client.model}${this.client.rotation ? ` (#${this.client.rotation.at + 1} of ${this.client.rotation.list.length}${this.orchestrating ? ', orchestrating' : ', your order'})` : ''}`)
    }
    log('task', `${text} (${this.strat.actions} mode, ${images.length} image(s))`)
    const answer = this.strat.actions === 'tools' ? await runNative(this, text, images, signal) : await runGuided(this, text, images, signal)
    log('answer', answer) // the conversation's log
    log('task', `answered (${String(answer ?? '').length} characters)`)
    this.history.push({ task: text, answer })
    return answer
  }

  // The agent tool: a helper with a fresh conversation and the same tools (but no helpers of its
  // own, no memory, no director) does one job; its final reply is the tool's result. Its steps show
  // under the main conversation's, its file changes count for /rewind like the main agent's.
  // model: one of your models (this one when left out); images: for it to look at (it must see).
  // A helper that fails or replies with nothing: the job goes to the next of your models that can
  // do it, until one does. id: the agent tool call's; the helper's steps go to onEvent (headless,
  // ACP) as that call's.
  async subagent(args, signal, id) {
    const task = String(args.prompt ?? args.task ?? '').trim()
    if (!task) return this.orchestrating ? 'error: "prompt" is missing: put the whole task for the model in "prompt", and which model does it in "model"' : 'error: give the helper its job in "prompt"'
    // an orchestrator's handoff: with what the user asked, in their words (a summary loses what they cared about)
    this.handed = true
    const check = this.orchestrating ? String(args.check ?? '').trim() : '' // how HeartCode proves it worked, run when the model is done
    const job = this.orchestrating ? `${task}\n\n${prompt('agent/hand-request', { request: requestsOf(this.chat, 1500), choices: (this.chat?.choices ?? []).join('; '), check, run: /^page\s/i.test(check) ? check.replace(/^page/i, PAGE_COMMAND) : check })}` : task
    let images
    try {
      images = await loadImages(args.images, this, signal)
    } catch (e) {
      if (e.name === 'AbortError') throw e
      return `error: ${e.message}`
    }
    const name = (t) => `${t.provider} ${t.model}`
    const self = { provider: this.client.provider, model: this.client.model, images: this.strat.vision, tools: this.strat.actions === 'tools', self: true }
    const all = [...(this.orchestrating ? [] : [self]), ...(this.team?.() ?? [])] // an orchestrator hands work out, never to itself
    const want = String(args.model ?? '').trim()
    // only one model available (a pinned model, or you have just one): helpers use it, whatever was asked
    const first = !want || all.length === 1 ? all[0] : (all.find((t) => name(t) === want || `${t.provider}/${t.model}` === want) ?? all.find((t) => t.model === want || want.endsWith(` ${t.model}`) || t.model.endsWith(`/${want}`)))
    if (!first) return `error: no model "${want}". Yours: ${all.map(name).join(', ')}`
    const until = this.resting?.[name(first)] ?? 0
    if (this.orchestrating && until > Date.now()) return `error: ${name(first)} is out of quota for ${Math.ceil((until - Date.now()) / 60_000)} more minutes (its provider said so); hand it to another model` // not asked again: it would only refuse
    // the one asked for first (if it can do the job), then the others that can: those that call
    // tools first, then the ones that failed least this session, in your list's order
    const able = (t) => !images.length || t.images
    const fails = (t) => this.failures?.[name(t)] ?? 0
    const rests = (t) => (this.resting?.[name(t)] ?? 0) > Date.now() // out of quota: tried last
    // an orchestrator's choice only: when it fails, the orchestrator chooses again (a model of the size it wants)
    const order = (this.orchestrating ? [first] : [first, ...all.filter((t) => t !== first).sort((a, b) => b.tools - a.tools || fails(a) - fails(b))]).filter(able).sort((a, b) => rests(a) - rests(b))
    if (!order.length) return this.orchestrating ? `error: ${name(first)} can't see images; hand it to one that can` : 'error: none of your models can see images'
    const failed = []
    // what each did, for the record (stats.js): what the orchestrator learns models by
    const about = { job: clip(String(args.description ?? '').trim() || task.split('\n')[0], 80), about: clip(`${task} ${requestsOf(this.chat, 300)}`, 300) }
    for (const [i, t] of order.entries()) {
      let answer = ''
      const t0 = Date.now()
      try {
        answer = (await this.#helper(t, job, images, args.description, id, signal, args.ownFiles))?.trim()
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e
        failed.push(`${t.model}: ${clip(e.message, 150)}`)
        if (e.status !== 429) record(name(t), { ...about, ms: Date.now() - t0, ok: false, why: clip(e.message, 120) }) // out of quota says nothing of the model (this.resting has it)
      }
      if (answer) {
        const ms = Date.now() - t0
        let checked = null
        if (check) {
          this.ui.step('check', clip(check, 80))
          checked = await runCheck(this.root, check, signal)
          log('agent', `check of ${name(t)}'s work: ${checked.report}`)
          this.ui.step('check', `${checked.ok ? 'passed' : 'failed'}: ${clip(checked.report.split('\n')[0], 100)}`)
        }
        record(name(t), { ...about, ms, ok: true, ...(checked && { check: checked.ok ? 'pass' : 'fail', why: checked.ok ? undefined : clip(checked.report, 120) }) })
        const said = t === first ? answer : `(Answered by ${name(t)}, not ${name(first)}${failed.length ? `: ${failed.join('; ')}` : ''})\n\n${answer}`
        return checked ? `${said}\n\n${prompt(checked.ok ? 'agent/check-passed' : 'agent/check-failed', { model: name(t), report: checked.report })}` : said
      }
      if (failed.length < i + 1) {
        record(name(t), { ...about, ms: Date.now() - t0, ok: false, why: 'no reply' })
        failed.push(`${t.model}: no reply`)
        if (this.failures) this.failures[name(t)] = fails(t) + 1 // (a failed request is counted where it fails: engine's onFail)
      }
      if (order[i + 1]) this.ui.warn(`${t.model} couldn't do it (${failed.at(-1).slice(t.model.length + 2)}); handing it to ${order[i + 1].model}`)
    }
    if (this.orchestrating) return `error: ${name(first)} couldn't do it (${failed.join('; ').slice(first.model.length + 2)}). Hand it to another model.`
    return `error: none of your models that can do it managed: ${failed.join('; ')}`
  }

  // One helper on one model (t: this one, or another of yours), with its own connection (a helper's
  // failure moves no one else on to another model) that gives up after a few tries (then the next
  // model gets the job).
  async #helper(t, task, images, description, id, signal, ownFiles) {
    let { client, profile, strat } = this
    if (this.engineFor) {
      ;({ client, profile, strat } = await this.engineFor(t))
      const was = client.retryIf
      client.retryIf = (e, attempt) => attempt < 3 && !e.notStarted && e.status !== 429 && (!was || was(e, attempt)) // not answering in time or rate-limited: the next model, not another wait
    }
    const label = clip(`${client.model}: ${String(description ?? '').trim() || task.split('\n')[0]}`, 60)
    const helper = new Session({ client, profile, strat, root: this.root, ui: helperUI(this.ui, label), chat: newChat(this.root) })
    helper.worker = Boolean(this.orchestrating) // it does the work an orchestrator handed out: held to proving it like the main conversation (notDone; the review is the orchestrator's)
    if (ownFiles?.length) helper.ownFiles = ownFiles.map((f) => path.resolve(this.root, f)) // a part of the plan: changes only its own files
    Object.assign(helper, { isSub: true, research: this.research, ran: this.ran, noResearch: this.noResearch, mcp: this.mcp, skills: this.skills, hooks: this.hooks, allowTools: this.allowTools, denyTools: this.denyTools, maxTurns: this.maxTurns, autoCompact: this.autoCompact, appendSystem: this.appendSystem, fileCache: this.fileCache, noFormat: this.noFormat, noLsp: this.noLsp })
    helper.track = (rel, before) => this.track(rel, before)
    helper.mcpGate = async () => (await this.#gate(helper), () => {})
    if (this.onEvent) helper.onEvent = (e) => this.onEvent({ ...e, parent: id, helper: label })
    log('agent', `helper "${label}" (${images.length} image(s)): ${task}`)
    try {
      const answer = await (strat.actions === 'tools' ? runNative : runGuided)(helper, task, images, signal)
      log('agent', `helper "${label}" done`, answer)
      return answer
    } finally {
      this.#release(helper)
    }
  }

  // The MCP servers (a browser…) are one helper's from its first MCP call to its end: helpers
  // working at the same time don't drive the same browser; the others (and this conversation)
  // wait their turn. One turn for all of them, so two helpers can't each hold one the other waits on.
  // ponytail: helpers that use different servers wait for each other too; a turn per server needs
  // a fixed order of taking them (or waiting without holding) to stay deadlock-free.
  // Returns what ends the turn: a helper's lasts until it ends (#helper), this conversation's until
  // its call is done.
  async mcpGate() {
    await this.#gate(this)
    return () => this.#release(this)
  }
  async #gate(who) {
    while (this.mcpTurn && this.mcpTurn.who !== who) await this.mcpTurn.done
    if (!this.mcpTurn) {
      let release
      const done = new Promise((r) => (release = r))
      this.mcpTurn = { who, done, release }
    }
  }
  #release(who) {
    if (this.mcpTurn?.who !== who) return
    const { release } = this.mcpTurn
    this.mcpTurn = null
    release()
  }

  // Images for a model that can't see them: your models that can describe each, for the task (the
  // next one when one fails).
  async describeImages(images, seers, task, signal) {
    const out = []
    let by = ''
    for (const [i, url] of images.entries()) {
      let said = ''
      for (const seer of seers) {
        this.ui.spinner(`${seer.model} is looking at image ${i + 1}`)
        try {
          const { client } = await this.engineFor(seer)
          client.retryIf = (e, attempt) => attempt < 3 && !e.notStarted
          said = (await client.chat({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt('guided/describe-image', { task }) }, { type: 'image_url', image_url: { url } }] }] }, { signal })).content.trim()
        } catch (e) {
          if (e.name === 'AbortError' || signal?.aborted) throw e
          this.ui.warn(`${seer.model} couldn't look at image ${i + 1}: ${clip(e.message, 120)}`)
        }
        if (said) {
          by = seer.model
          this.ui.step('image', `${seer.model} described image ${i + 1}`)
          break
        }
      }
      out.push(`Image ${i + 1}:\n${said || '(none of your models that see images could look at it)'}`)
    }
    log('images', `described by ${by}`, out)
    return `\n\n${prompt('agent/images-described', { model: by || 'another model', descriptions: out.join('\n\n') })}`
  }

  // /btw: a side question, answered from the conversation so far. Nothing goes into the
  // conversation and no tools are offered, so it can run while a task works: on its own client,
  // so the task's request timer and retries are left alone (its cost still counts).
  async side(question, signal) {
    const { client, strat, chat } = this
    const ask = prompt('agent/btw', { question })
    let messages
    if (chat.messages?.length) {
      messages = chat.messages.map((m) => ({ ...m })) // copies: trimming them leaves the real ones alone
      pairTools(messages) // a tool still running has no result yet
      messages.push({ role: 'user', content: ask })
      fitMessages(messages, Math.floor((strat.context * 0.75) / (strat.ratio ?? 1)) - 800)
    } else {
      const past = chat.history.map((h) => `User: ${h.task}\nAssistant: ${h.answer}`).join('\n\n').slice(-Math.floor(strat.context * 2))
      messages = [{ role: 'user', content: past ? `${prompt('agent/btw-history', { conversation: past })}\n\n${ask}` : ask }]
    }
    const side = new Client({ baseUrl: client.baseUrl, apiKey: client.apiKey, model: client.model, provider: client.provider })
    Object.assign(side, { effort: client.effort, quirks: client.quirks, can: client.can, tokenRatio: client.tokenRatio, onSpend: client.onSpend, purpose: 'btw' })
    log('btw', question)
    const res = await side.chat({ messages }, { signal })
    log('btw', 'answer:', res.content)
    return res.content?.trim() ?? ''
  }

  // A summary of the part of a branch the user is leaving (/tree), for the branch they go to.
  async summarizeBranch(conversation, files, signal) {
    const { client, strat } = this
    const room = Math.floor((strat.context * 0.6 * 3.5) / (strat.ratio ?? 1))
    const text = conversation.length > room ? `[… the earliest part is cut]\n${conversation.slice(-room)}` : conversation
    const request = prompt('compact/branch-summarize', { conversation: text, files: files.join(', ') })
    const messages = [{ role: 'system', content: prompt('compact/summarizer') }, { role: 'user', content: request }]
    const summary = notSummary((await client.chat({ messages }, { signal })).content)
    if (!summary) throw new Error('the model did not write a summary')
    return summary
  }

  #extractPrompt(about) {
    const notes = this.memory.relevant(about, 10).map((n) => `[[${n.name}]] — ${n.description} (${[n.scope, ...n.tags].join(', ')})`).join('\n')
    return prompt('agent/memory-extract', { tags: this.memory.tagSummary() || '(none yet)', notes })
  }

  // A small tool loop with the memory tool (saving and tidying notes), and any `extra` tools ({ defs,
  // run(name, args) → result or undefined for the memory tool }). It ends when the model answers, or
  // makes exactly the calls it just made (going round, not getting anywhere).
  async memoryTask(system, user, signal, extra = null) {
    const tools = [...extraTools({ memory: this.memory }), ...(extra?.defs ?? [])].map((f) => ({ type: 'function', function: f }))
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }]
    let last = ''
    const client = extra?.client ?? this.client
    for (;;) {
      const was = client.purpose
      client.purpose = extra?.purpose ?? 'memory' // in the requests log
      let res
      try {
        res = await client.chat({ messages, tools }, { signal })
      } finally {
        client.purpose = was
      }
      messages.push({ role: 'assistant', content: res.content || '', ...(res.toolCalls.length && { tool_calls: res.toolCalls }) })
      if (!res.toolCalls.length) return res.content.trim()
      const these = res.toolCalls.map((t) => `${t.function.name} ${t.function.arguments}`).join('\n')
      if (these === last) return res.content.trim()
      last = these
      for (const call of res.toolCalls) {
        let args = {}
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch {}
        const out = (await extra?.run(call.function.name, args)) ?? (call.function.name === 'memory' ? await runTool('memory', args, this, signal) : `error: there is no tool named ${call.function.name}`)
        if (call.function.name === 'memory' && (args.action === 'write' || args.action === 'delete') && !failed(out)) this.ui.step('memory', `${args.action === 'write' ? 'saved' : 'deleted'} ${out.match(/\[\[[^\]]+\]\]/)?.[0] ?? ''}${args.scope === 'global' ? ' (global)' : ''}`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: out })
      }
    }
  }

  // After a task that read the web, ran commands or made files: what's worth knowing next time is
  // saved as notes (project or global), each page it read is kept (marked with what it was used for)
  // or deleted as junk, and throwaway files it made are removed. Done by code after every such task,
  // not left to the model to remember: a fresh, small request (the task, its answer, the lists), on
  // the model that did the task. Helpers' pages are in the same list (they share it).
  // It runs after the answer is back (wrapUpLater), beside whatever you do next: its own connection,
  // one wrap-up at a time; what it needs is taken from the task first, before the next one changes it.
  wrapUpLater(task, answer) {
    const at = { research: this.research, turn: this.chat.turns.at(-1), dirsBefore: this.dirsBefore, ran: this.ran, runs: this.runs }
    const job = (this.wrapping ?? Promise.resolve())
      .then(() => this.wrapUp(task, answer, undefined, at))
      .catch((e) => log('wrapup', `failed: ${e.message}`))
      .finally(() => this.wrapping === job && (this.wrapping = null))
    this.wrapping = job
  }

  // at: the task's own state (wrapUpLater), else this message's
  async wrapUp(task, answer, signal, at = { research: this.research, turn: this.chat.turns.at(-1), dirsBefore: this.dirsBefore, ran: this.ran, runs: this.runs }) {
    if (this.isSub || !this.memory || this.ui.permission === 'plan') return
    const pages = at.research ?? []
    const turn = at.turn
    const made = Object.entries(turn?.files ?? {}).filter(([rel, before]) => before === null && fs.existsSync(path.join(this.root, rel))).map(([rel]) => rel)
    // folders the task made that are still empty (a test folder): offered for cleanup too
    if (at.dirsBefore) for (const d of foldersOf(this.root)) if (!at.dirsBefore.has(d) && isEmptyDir(path.join(this.root, d))) made.push(`${d}/`)
    const ran = at.ran ?? []
    if (!pages.length && !made.length && !ran.length) return
    const commands = ran.map((r) => `- ${clip(r.command.replace(/\s+/g, ' '), 200)} → ${r.result}`).join('\n')
    const known = this.memory.relevant(`${task}\n${answer}\n${pages.map((p) => p.title).join('\n')}`, 12)
    const request = prompt('agent/wrapup-task', {
      task: clip(task, 4000),
      answer: clip(String(answer ?? ''), 4000) + (commands ? `\n\nCommands it ran (newest last):\n${commands.length > 6000 ? `…\n${commands.slice(-6000)}` : commands}` : ''),
      pages: pages.map((p) => `- [${p.kind}] ${p.title}${p.url ? ` — ${p.url}` : ''} → file: ${p.file}`).join('\n') || '(none)',
      files: made.map((f) => `- ${f}`).join('\n') || '(none)',
      notes: known.map((n) => `- [[${n.name}]] (${n.scope}) — ${n.description}`).join('\n') || '(none)',
    })
    const files = new Set(pages.map((p) => p.file))
    const scratch = new Set(made)
    const mine = at.runs // a message sent since: its task may use these files, so none are deleted
    const kept = []
    const dropped = []
    const removed = []
    const defs = [
      { name: 'research', description: 'Keep (verdict "used", with used_for) or delete (verdict "junk") one page or search the task read.', parameters: { type: 'object', properties: { file: { type: 'string' }, verdict: { type: 'string', enum: ['used', 'junk'] }, used_for: { type: 'string' } }, required: ['file', 'verdict'] } },
      { name: 'scratch', description: 'Keep or delete one new file the task made.', parameters: { type: 'object', properties: { path: { type: 'string' }, verdict: { type: 'string', enum: ['keep', 'delete'] } }, required: ['path', 'verdict'] } },
    ]
    const run = (name, a) => {
      if (name === 'research') {
        const f = [...files].find((x) => x === a.file || path.basename(x) === path.basename(String(a.file ?? '')))
        if (!f) return `error: "${a.file}" isn't one of the pages this task read: ${[...files].join(', ')}`
        if (a.verdict === 'junk') return removeResearch(this.root, f) ? (dropped.push(f), `Deleted ${f}.`) : `error: ${f} is gone already`
        return markUsed(this.root, f, String(a.used_for ?? '').trim()) ? (kept.push(f), `Kept ${f}.`) : `error: ${f} is gone`
      }
      if (name === 'scratch') {
        let rel = String(a.path ?? '').trim().replace(/^\.\//, '')
        if (!scratch.has(rel) && scratch.has(`${rel}/`)) rel = `${rel}/` // a folder named without its slash
        if (!scratch.has(rel)) return `error: "${rel}" isn't one of the new files this task made: ${[...scratch].join(', ')}`
        if (a.verdict !== 'delete') return `Kept ${rel}.`
        if (this.runs !== mine) return `Kept ${rel}: the user has gone on to another task, which may use it.`
        if (rel.endsWith('/')) {
          if (!isEmptyDir(path.join(this.root, rel))) return `error: ${rel} isn't empty: delete the files in it first, or keep it`
          fs.rmSync(path.join(this.root, rel, '.DS_Store'), { force: true })
          fs.rmdirSync(path.join(this.root, rel))
        } else fs.rmSync(path.join(this.root, rel), { force: true })
        scratch.delete(rel)
        removed.push(rel)
        this.ui.step('cleanup', `removed ${rel}`)
        return `Deleted ${rel}.`
      }
    }
    const own = { provider: this.client.provider, model: this.client.model }
    try {
      const { client } = this.engineFor ? await this.engineFor(own) : { client: this.client }
      const said = await this.memoryTask(prompt('agent/wrapup'), request, signal, { defs, run, client, purpose: 'wrapup' })
      log('wrapup', `${said} | pages kept ${kept.length}, deleted ${dropped.length}; files removed ${removed.length}`)
      if (kept.length || dropped.length) this.ui.step('research', `kept ${kept.length} page${kept.length === 1 ? '' : 's'}${dropped.length ? `, deleted ${dropped.length} as junk` : ''}`)
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) throw e
      log('wrapup', `failed: ${e.message}`)
    }
  }

  // /tidy_memory: merge duplicates, drop what's outdated, link related notes.
  async tidyMemory(signal) {
    const notes = this.memory.list()
    if (!notes.length) return 'No notes to tidy.'
    this.ui.spinner('tidying the memory')
    const room = Math.floor(this.strat.context * 0.5 * 3.5)
    const text = notes.map((n) => `## [[${n.name}]] (${n.scope}, ${n.type}; tags: ${n.tags.join(', ') || 'none'}) — ${n.description}\n${n.body}`).join('\n\n').slice(0, room)
    const broken = this.memory.brokenLinks().map((b) => `[[${b.to}]] in [[${b.from}]]`).join(', ')
    const summary = await this.memoryTask(this.#extractPrompt(''), prompt('agent/memory-tidy', { notes: text, broken }), signal)
    this.ui.stopSpin()
    this.ui.print(`${c.faint('✻')} ${c.muted(`Tidied the memory${summary && summary !== 'NONE' ? `: ${clip(summary.split('\n')[0], 140)}` : ''}`)}`)
    return summary
  }
}

// The system prompt: prompts/tools/system.md. No absolute path in it: small models copy it into
// tool calls, garbled.
// The user's HEARTCODE.md / AGENTS.md instructions are added when there are any.
// In director mode the director part is added.
// No list of the project's files: the model looks up what the task needs (list_files, search).
// A program's own instructions (--append-system-prompt: Nibedita, a script) come last, and HeartCode's
// own say less then (caller): no role of its own, no "stay in the folder", no way to finish of its
// own, no director; they're told to follow the program's where they differ.
// One line of context about where HeartCode runs, so the model knows the OS, shell and tools to expect.
const OS_NAMES = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }
const envLine = () => {
  const shell = (process.env.SHELL || process.env.ComSpec || '').split(/[/\\]/).pop()
  return `${OS_NAMES[process.platform] ?? process.platform} (${process.platform} ${os.release()}, ${process.arch})${shell ? `, shell ${shell}` : ''}`
}

// The project root's entries, every one (names only), for the system prompt.
const rootList = (root) => {
  const v = folderView(root)
  return v.error ? `(can't read it: ${v.error})` : v.entries.length ? v.entries.join(' · ') + (v.more ? ` · … ${v.more} more` : '') : '(empty)'
}

// An orchestrator's system prompt and tools as a session gives them, handing work to team (the
// settings page's Test orchestrators)
export function orchestratorSetup(root, team) {
  const s = { root, orchestrating: true, subagent: true, fitMode: () => true, team: () => team, strat: {}, client: {} }
  return { system: SYSTEM(s), tools: [...TOOL_DEFS, ...extraTools(s)].filter((f) => allowed(s, f.name)).map((f) => ({ type: 'function', function: f })) }
}

const SYSTEM = (s) => {
  if (s.orchestrating) return prompt('agent/orchestrator', { root: s.root, env: envLine(), today: new Date().toISOString().slice(0, 10), ...teamOf(s) })
  const instructions = userInstructions(s.root)
  return [
    prompt('agent/system', { root: s.root, env: envLine(), today: new Date().toISOString().slice(0, 10), rootList: rootList(s.root), servers: serversNote(s.root), files: '', more: '', caller: Boolean(s.appendSystem) }),
    instructions && prompt('agent/instructions', { instructions }),
    ...[...(s.skills?.values() ?? [])].filter((k) => k.use === 'always').map((k) => k.body), // skills that say how to work (use: always)
    s.memory && prompt('agent/memory', { tags: s.memory.tagSummary() || '(none yet)' }),
    s.strat.vision && prompt('agent/you-see'), // models that can see often say they can't
    s.director && !s.appendSystem && s.director.app.cfg.director !== false && prompt('agent/director'),
    !s.isSub && teamPrompt(s),
    s.isSub && prompt('agent/subagent'),
    s.appendSystem && prompt('agent/caller'),
    s.appendSystem,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Your other models and what each can do, for the agent tool's model (only when there are any): a
// short line each — with an orchestrator, with its places in the public rankings (rankings.js).
const RANKED_AS = { overall: 'text:overall', code: 'text:coding', web: 'webdev:webdev', vision: 'vision:overall' }
const teamPrompt = (s) => {
  const team = s.team?.() ?? []
  return team.length ? prompt('agent/team', teamOf(s, team)) : ''
}
const teamOf = (s, team = s.team?.() ?? []) => {
  const data = s.fitMode?.() ? loadRankings() : null
  const ranks = (t) => (data ? Object.entries(RANKED_AS).map(([k, list]) => ((r) => r && `${k} #${r.rank}`)(rankIn(t.model, list, data))).filter(Boolean).join(' ') : '')
  const line = (t) => {
    const failed = s.failures?.[`${t.provider} ${t.model}`]
    const rest = Math.ceil(((s.resting?.[`${t.provider} ${t.model}`] ?? 0) - Date.now()) / 60_000)
    // what it has shown first (its record, its tests, its speed), then what it can do, then ranks
    const slow = t.replyMs != null && typical && t.replyMs > Math.max(5000, typical * 3)
    const facts = [rest > 0 && `out of quota for ${rest < 120 ? `${rest} min` : `${Math.round(rest / 60)} h`}`, failed && `failed ${failed}× this session`, recordLine(stats[`${t.provider} ${t.model}`]), skillsLine(t.skills), t.replyMs != null && `${slow ? 'SLOW: ' : ''}a one-word reply takes it ${(t.replyMs / 1000).toFixed(1)} s`, t.tools === false && 'no tool calls', t.toolsOk === false && "failed a test of doing a job with a tool", t.images && 'images', t.thinking && 'thinking', ranks(t) && `ranked ${ranks(t)}`].filter(Boolean)
    return `- ${t.provider} ${t.model}${facts.length ? `: ${facts.join('; ')}` : ''}`
  }
  const stats = loadStats()
  const times = team.map((t) => t.replyMs).filter((x) => x != null).sort((a, b) => a - b)
  const typical = times[Math.floor(times.length / 2)] // the median: "slow" is slow next to your others
  // the models with something to show for themselves first (best first), then the rest in your order
  const proof = (t) => { const xs = [...Object.values(t.skills ?? {}).filter((r) => r?.score != null).map((r) => r.score), ...((j) => (j.jobs ? [j.passed + j.failed ? j.passed / (j.passed + j.failed) : (j.jobs - j.lost) / j.jobs] : []))(summary(stats[`${t.provider} ${t.model}`]))]; return xs.length ? xs.reduce((a, b) => a + b) / xs.length : null }
  team = team.map((t) => [t, proof(t)]).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1)).map(([t]) => t)
  const you = [s.strat.vision ? 'images' : 'no images', s.strat.thinking && 'thinking', ranks(s.client) && `ranked ${ranks(s.client)}`].filter(Boolean).join(', ')
  return { models: team.map(line).join('\n'), you, ranked: Boolean(data), past: s.orchestrating ? similar(s.chat?.turns?.at(-1)?.task, team.map((t) => `${t.provider} ${t.model}`), 6, stats) : '' }
}

// Test skills' scores (settings page, skilltest.js), in words: "tests: code 90%, web page 75%, …"
const SKILL_WORDS = { code: 'code', page: 'web page', vision: 'finding things in an image', tools: 'a job with tools' }
const skillsLine = (k) => {
  const done = Object.entries(SKILL_WORDS).filter(([key]) => k?.[key] && !k[key].skipped).map(([key, w]) => ((r) => `${w} ${r.slow ? 'no answer in time' : r.error ? 'failed to answer' : `${Math.round(r.score * 100)}%${r.ms ? ` in ${Math.round(r.ms / 1000)} s` : ''}`}`)(k[key]))
  return done.length ? `tests: ${done.join(', ')}` : ''
}

const sizeOf = (m) =>
  (Array.isArray(m.content) ? m.content.reduce((n, p) => n + (p.type === 'text' ? est(p.text) : 800), 0) : est(m.content)) +
  (m.tool_calls ? est(JSON.stringify(m.tool_calls)) : 0) +
  (m.reasoning_content ? est(m.reasoning_content) : 0)
export const size = (messages) => messages.reduce((n, m) => n + sizeOf(m), 0)
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// A chat template's tool-call markup in a reply's text (a tool call the model wrote out): outside
// code blocks, and the reply ends in it (an answer that only mentions such tags isn't one).
const MARKUP = /<\/?tool_call>|<\/?arg_(?:key|value)>|<function=[\w.-]+>|<\|[a-z_]+\|>/i
export function leakedMarkup(text) {
  const prose = String(text ?? '').replace(/```[\s\S]*?(```|$)/g, (m) => ' '.repeat(m.length)) // code keeps its place
  const m = MARKUP.exec(prose)
  return m && /[>}]\s*$/.test(prose) ? m : null
}

// "assistant to=mcp({...})", "to=functions.read_file <|constrain|>json<|message|>{...}": a tool
// call written as text. Returns { name, arguments } (arguments as JSON text), or null.
export function leakedCall(text) {
  const m = /^\s*(?:assistant\s*)?(?:<\|[^|]*\|>\s*)*to=(?:functions\.)?([\w-]+)[^{]*?(\{[\s\S]*\})\s*\)?\s*$/.exec(String(text ?? ''))
  if (!m) return null
  try {
    JSON.parse(m[2])
  } catch {
    return null
  }
  return { name: m[1], arguments: m[2] }
}

// The user's messages in this chat, word for word, newest last (as many as fit in ~1500 tokens):
// they go with every summary, so what was asked is never lost, even when the last message is just
// "continue".
export function requestsOf(chat, room = 1500) {
  const out = []
  for (const t of [...chat.turns].reverse()) {
    const line = `- ${t.task.trim()}`
    if (est(out.join('\n') + line) > room && out.length) break
    out.unshift(est(line) > room ? `${line.slice(0, room * 3)}…` : line)
  }
  return out.join('\n')
}

// A chat compacted by an older HeartCode can hold a "summary" that isn't one (a tool call the
// model wrote as text). It's replaced with what's known for sure: the user's messages.
export function repairSummary(chat) {
  const head = prompt('compact/summary', { summary: '\u0000', requests: '' }).split('\u0000')[0]
  const i = chat.messages?.findIndex((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(head)) ?? -1
  if (i === -1) return false
  const rest = chat.messages[i].content.slice(head.length)
  if (rest.trim() && !leakedCall(rest.split('\n\n')[0])) return false // a real summary (only a tool call written as text is broken)
  log('compact', 'a broken summary in this chat was replaced with the user\'s messages')
  chat.messages[i] = { ...chat.messages[i], content: prompt('compact/summary', { summary: prompt('compact/summary-lost'), requests: requestsOf(chat) }) }
  if (chat.messages[i + 1]?.role === 'assistant' && leakedCall(chat.messages[i + 1].content)) chat.messages[i + 1] = { role: 'assistant', content: prompt('compact/acknowledged') }
  return true
}

// The summary, or '' when the reply isn't one: empty, too short, or a tool call written as text.
export function notSummary(text) {
  const t = String(text ?? '').trim()
  return t.length < 10 || leakedCall(t) || /^\s*\{\s*"/.test(t) ? '' : t
}

// A conversation as plain text, for the model to summarize. Tool calls are described, not written
// as calls, so the summarizer doesn't imitate them.
export function transcript(messages) {
  const text = (content) => (Array.isArray(content) ? content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ') : String(content ?? ''))
  return messages
    .map((m) => {
      if (m.role === 'tool') return `[tool result] ${clip(text(m.content), 1500)}`
      const calls = (m.tool_calls ?? []).map((t) => `\n[used the ${t.function.name} tool with: ${clip(t.function.arguments, 400)}]`).join('')
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text(m.content)}${calls}`
    })
    .join('\n\n')
}

// Keep the conversation inside the context window: shrink old tool output first, then drop old turns.
export function fitMessages(messages, budget) {
  const total = () => messages.reduce((n, m) => n + sizeOf(m), 0)
  for (let i = 1; i < messages.length - 2 && total() > budget; i++) {
    const m = messages[i]
    if (m.role === 'tool' && m.content.length > 300) m.content = m.content.slice(0, 300) + '\n[older output trimmed]'
  }
  while (total() > budget) {
    const next = messages.findIndex((m, i) => i > 1 && m.role === 'user')
    if (next === -1) break
    messages.splice(1, next - 1)
  }
}

// The model keeps replying with nothing (seen when it's done but its server fails to decode the
// last message): asked once more without tools, for the answer only. Never ends a task with
// nothing: failing that, HeartCode says itself what changed.
async function finalAnswer(s, signal, why = 'empty replies in a row') {
  const { client, ui } = s
  log('task', `${why}; asking for the final answer without tools`)
  ui.spinner('asking for the final answer')
  try {
    const res = await client.chat({ messages: [...s.messages, { role: 'user', content: prompt('agent/final-answer') }] }, { signal })
    const text = res.content?.trim()
    if (text && !leakedCall(text)) {
      s.messages.push({ role: 'user', content: prompt('agent/final-answer') }, { role: 'assistant', content: text })
      ui.stopSpin()
      const out = ui.response()
      out.text(text)
      out.end()
      return text
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e
    log('task', `final answer request failed: ${e.message}`)
  }
  ui.stopSpin()
  const changed = Object.keys(s.chat.turns.at(-1)?.files ?? {})
  const text = prompt('agent/no-final-answer', { model: client.model, changed: changed.join(', ') })
  ui.warn(text)
  return text
}

// An older conversation called MCP tools by their own names (mcp__server__tool: each was offered as
// a tool then). Now they're all behind the one mcp tool, so those calls are rewritten as mcp calls:
// a request then names only tools it offers (some providers refuse one that doesn't). In place.
export function legacyMcpCalls(messages, direct) {
  for (const m of messages ?? []) {
    for (const t of m.tool_calls ?? []) {
      const name = t.function?.name ?? ''
      if (!name.startsWith('mcp__')) continue
      const d = direct?.get(name)
      const parts = /^mcp__(.+?)__(.+)$/.exec(name)
      const server = d?.server ?? parts?.[1]
      const tool = d?.tool ?? parts?.[2]
      if (!server || !tool) continue
      let args = {}
      try {
        args = JSON.parse(t.function.arguments || '{}')
      } catch {}
      t.function = { name: 'mcp', arguments: JSON.stringify({ server, tool, arguments: args }) }
    }
  }
}

// Every tool call needs its result right after it, and every result its call, or the API rejects
// the request (and it would be retried forever). Esc during a tool leaves a call without a result;
// trimming can leave a result without its call. Mends both, in place.
export function pairTools(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'tool') {
      const owner = messages.slice(0, i).findLast((x) => x.role !== 'tool')
      if (!owner?.tool_calls?.some((t) => t.id === m.tool_call_id)) messages.splice(i--, 1)
      continue
    }
    if (!m.tool_calls?.length) continue
    let j = i + 1
    const have = new Set()
    while (messages[j]?.role === 'tool') have.add(messages[j++].tool_call_id)
    const missing = m.tool_calls.filter((t) => !have.has(t.id)).map((t) => ({ role: 'tool', tool_call_id: t.id, content: '(not run: the user stopped it)' }))
    messages.splice(j, 0, ...missing)
  }
}

async function runNative(s, task, images, signal) {
  const { client, strat, ui } = s
  if (s.mcp?.names.length) {
    ui.spinner('getting the MCP servers\' tools')
    await loadMcpTools(s, signal) // before the system prompt: it has their instructions
  }
  // The model's thinking goes back with its steps while it works on a message (it keeps its plan
  // from one tool call to the next), not into later messages.
  for (const m of s.messages ?? []) delete m.reasoning_content
  legacyMcpCalls(s.messages, s.mcpDirect)
  // The system prompt is rebuilt for every message: files come and go, and a resumed chat's is
  // from back then (it once told the model the project was empty after it had made files).
  // Unchanged, it stays the same text, so a provider's prompt cache still holds.
  const sys = SYSTEM(s)
  if (!s.messages) {
    s.messages = [{ role: 'system', content: sys }]
  } else if (s.messages[0]?.content !== sys && s.messages[0]?.role === 'system') {
    s.messages[0] = { ...s.messages[0], content: sys }
  }
  if (s.chat.branchNote && !s.isSub) {
    s.messages.push({ role: 'user', content: s.chat.branchNote }, { role: 'assistant', content: prompt('compact/acknowledged') })
    delete s.chat.branchNote
  }
  s.compactedAt = -1
  // Auto-compact: when the conversation takes 85% of the window of the model answering now (its
  // window as set up, measured or learned; also when that changes mid-task, or the model list moves
  // on to a model with a smaller one), so there's room left for the reply. Its size: what the server
  // counted for this conversation's last request (s.counted) plus the estimate of what came since
  // (the tool results, never counted smaller than estimated: they're often code), or the estimate of
  // all of it when that's more (no count yet: a resumed session, just compacted). After a failed try:
  // again once it has grown by another 5%.
  const used = () => {
    const ratio = strat.ratio ?? 1
    const all = tokensOf(s.messages, [...TOOL_DEFS, ...extraTools(s)], ratio)
    const k = s.counted
    if (!k?.tokens || k.upTo > s.messages.length) return all
    return Math.max(all, k.tokens + tokensOf(s.messages.slice(k.upTo), null, Math.max(1, ratio)))
  }
  const nearlyFull = () => s.autoCompact && strat.context > 0 && used() >= strat.context * COMPACT_SHARE && used() >= (s.compactFailedAt ?? 0)
  const fullness = () => `context ${Math.round((used() / strat.context) * 100)}% full (~${kTokens(used())} of ${kTokens(strat.context)})`
  // Still that full after compacting (what every request carries, the system prompt and the tools'
  // schemas, takes most of the window): compacting again won't free anything, so not until it has
  // grown by another 5% (not a summary request at every step).
  const afterCompact = () => (s.compactFailedAt = used() >= strat.context * COMPACT_SHARE ? used() + Math.round(strat.context * 0.05) : 0)
  // Over the current model's window and your list holds a model that can take the whole conversation:
  // move to it instead of compacting — losing nothing beats summarizing when you have a roomier model.
  // Scanned in your list order, so it picks your highest-priority model that fits; false when none of
  // your other models has more room (then the caller compacts: use what's available).
  const roomier = () => {
    const r = client.rotation
    if (!r || r.list.length < 2 || !s.windowOf) return false
    const need = used()
    for (let k = 0; k < r.list.length; k++) {
      if (k === r.at) continue
      const win = s.windowOf(r.list[k])
      if (win > 0 && need <= win * COMPACT_SHARE) {
        ui.print(c.dim(`↻ this chat (~${kTokens(need)}) is past ${client.model}'s window — moving to ${r.list[k].model} (holds ~${kTokens(win)})`))
        client.switchTo(r.list[k], `context ~${kTokens(need)} > ${client.model} window`)
        return true
      }
    }
    return false
  }
  // Already that long from earlier messages: switch to a roomier model, or else compact first, so the
  // new message stays word for word.
  if (nearlyFull() && dropStale(s)) log('compact', 'older copies of files read again shortened first')
  if (nearlyFull() && !roomier()) {
    await s.compact({ signal, why: fullness() }).then(afterCompact, (e) => (e.name === 'AbortError' ? Promise.reject(e) : ui.warn(`could not compact: ${e.message}`)))
  }
  // only the memory notes this message matches go with it (the system prompt has just the tags)
  // each note once per conversation (again if it changed, or after compacting dropped it)
  const sent = new Set(s.chat.sentNotes ?? [])
  const key = (n) => `${n.scope}:${n.name}:${n.description}`
  const notes = (s.memory?.relevant(task) ?? []).filter((n) => !sent.has(key(n)))
  // pages already read for this project that match: titles only (the model opens one when needed)
  const pages = s.isSub || !s.memory ? [] : findResearch(s.root, task, 6).filter((r) => r.kind !== 'search' && !sent.has(`research:${r.name}:${r.fetched}`))
  s.chat.sentNotes = [...sent, ...notes.map(key), ...pages.map((r) => `research:${r.name}:${r.fetched}`)]
  const known = [
    notes.length && prompt('agent/memory-relevant', { notes: notes.map((n) => `[[${n.name}]] — ${n.description}`).join('\n') }),
    pages.length && prompt('agent/research-known', { pages: pages.map((r) => `- ${r.title} — ${r.url} (read ${r.fetched}) → ${r.file}`).join('\n') }),
  ].filter(Boolean)
  const text = known.length ? `${task}\n\n${known.join('\n\n')}` : task
  if (!s.isSub) Object.assign(s, { research: [], ran: [], lastQuery: '', dirsBefore: foldersOf(s.root), noResearch: !s.memory }) // this message's pages and commands (helpers add theirs), and the folders there were, for the wrap-up
  const planning = ui.permission === 'plan'
  const said = planning && !s.isSub ? `${text}\n\n${prompt('agent/plan-mode')}` : text
  const content = images.length ? [{ type: 'text', text: said }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : said
  s.messages.push({ role: 'user', content })
  attachNamed(s, task) // files the message names: as if already read (saves a round trip each)
  // the tools: built again each step (the model answering may change; client.js leaves them out for
  // one that can't call tools)
  const toolList = () => [...TOOL_DEFS, ...extraTools(s)].filter((f) => allowed(s, f.name) && !(planning && PLAN_HIDDEN.has(f.name)) && !(f.name === 'ask_user' && ui.noUser)).map((f) => ({ type: 'function', function: f }))
  const guard = newGuard() // calls made again with nothing changed: the earlier result instead
  let lastCall = '' // the last call (tool and arguments), and how many times in a row
  let inRow = 0
  // A todo list left done from an earlier message is cleared; an unfinished one stays.
  if (!s.isSub && s.chat.todos?.every((t) => t.status === 'completed')) s.chat.todos = []
  s.todoTouched = false
  s.task = task // the user's message, for the review
  for (const turn of s.chat.turns ?? []) noteNamedPaths(turn.task) // folders outside the project any message here names (a resumed chat's too): readable, and cd there is no wrong turn
  noteNamedPaths(task)
  if (!s.isSub) s.choicesFresh = false // a question about how to do it, this message: replaces the earlier answers (s.chat.choices)
  s.runFails = new Map() // a command that failed (by its tool) → its error; when the same tool runs clean after an edit, that's a verified fix to learn from (any language, not just web)
  s.edits = 0 // successful file edits so far this message (to tell a real fix from a lucky rerun)
  s.userSaid = [] // what the user typed with a "no" to a tool call: sent as their message after the results (declined in tools.js)
  s.acted = false // used a tool this message (so a reply that only promises more is a premature stop)
  s.handed = s.workNudged = false // an orchestrator: handed work out this message; told it wrote the work itself
  let nudged = 0 // reminders sent this message about open todo items, a premature stop, or a Stop hook
  let sinceNudge = true // a tool call made since the last reminder: one that changed nothing isn't sent again (no count: it goes on while the model gets on)
  s.planAsked = false // asked for a plan before its first change, this message
  s.splitAsked = false // asked whether a plan's parts could run side by side, this message
  // what changed and when it was last checked, this message: a change not run/tested since isn't done
  Object.assign(s, { changed: new Set(), seq: 0, lastChangeAt: -1, lastCheckAt: -1, reviewedAt: -1, checksSince: 0, spots: new Map() })

  let empty = 0 // replies in a row with neither text nor tool calls
  let looping = 0 // replies cut for going into a loop, this message
  let stuck = null // why it's going round in circles (then the next model takes over; nothing stops but Esc)
  // Going round in circles: the next of your models carries on (a different model often gets out of
  // it); with no other model, a warning, and it goes on being told what it repeats — only Esc stops it.
  const handOver = (why) => {
    const was = client.model
    if (client.moveOn?.(`${was} ${why}`)) ui.warn(`${was} ${why}; handing over to ${client.model}`)
    else ui.warn(`${was} ${why} — it carries on, told so; Esc stops it`)
  }
  let garbled = 0 // replies with a tool call written as text (template markup), this message
  let movedOn = 0 // models given up on for that, in this message
  let refitted = false // this step's conversation was just compacted for a smaller model the list moved on to
  // No step limit (helpers too): a long fix takes many steps, and Esc stops it. A caller can set one (--max-turns).
  for (let step = 0; ; step++) {
    if (step && !s.isSub) s.onTurn?.() // saved after every step: a quit, crash or kill mid-task loses nothing done so far
    const tools = toolList()
    s.lastTools = tools // what the requests carry: the findings note before compacting sends the same (compact)
    if (s.maxTurns && step >= s.maxTurns) {
      ui.warn(`stopped after ${s.maxTurns} steps (--max-turns); say "continue" to go on`)
      throw Object.assign(new Error(`stopped after ${s.maxTurns} steps (--max-turns)`), { maxTurns: true })
    }
    // after a failed compaction, the next try waits until the conversation has grown by 5% of the window
    if (nearlyFull() && dropStale(s)) log('compact', 'older copies of files read again shortened first')
    if (nearlyFull() && step !== s.compactedAt && !roomier()) {
      s.compactedAt = step
      await s.compact({ signal, midTask: true, task, why: fullness() }).then(
        afterCompact,
        (e) => {
          if (e.name === 'AbortError') throw e
          s.compactFailedAt = used() + Math.round(strat.context * 0.05)
          log('compact', `failed (${e.message}); trying again once it's ~${s.compactFailedAt} tokens`)
        },
      )
    }
    // the model answering can change mid-message (your model list): the system prompt follows it
    const now = SYSTEM(s)
    if (s.messages[0]?.content !== now && s.messages[0]?.role === 'system') s.messages[0] = { ...s.messages[0], content: now }
    pairTools(s.messages)
    ui.spinner('thinking')
    const out = ui.response(client.model) // named: helpers think too (theirs are named in helperUI)
    const stream = strat.stream
    // A long tool call (a whole file) streams in silently: say what's being written.
    const onToolDelta = (name, args) => ui.spinner(`${name === 'run_command' ? 'preparing a command' : `writing ${/"path"\s*:\s*"([^"]+)"/.exec(args)?.[1] ?? name}`} · ${args.length >= 1000 ? `${(args.length / 1000).toFixed(1)}k` : args.length} chars`)
    // the prompts or HEARTCODE.md changed meanwhile (applySettings): the system prompt again, now
    if (s.refreshSystem && s.messages[0]?.role === 'system') s.messages[0] = { ...s.messages[0], content: SYSTEM(s) }
    s.refreshSystem = false
    let res
    try {
      res = await client.chat({ messages: s.messages, tools, stream }, { signal, onToken: out.text, onReasoning: out.think, onToolDelta, fit: !refitted })
    } catch (e) {
      if (!e.tooBig) throw e
      // The model list moved on (the one before failed) to a model whose window can't hold the
      // conversation: compacted for it (by it, to its size), then the same step again. Once: still
      // too big after that (its window can't even hold the start), it's sent anyway.
      ui.stopSpin()
      out.end()
      log('compact', e.message)
      refitted = true
      await s.compact({ signal, midTask: true, task, why: `${client.model} took over and its window is smaller` }).catch((err) => {
        if (err.name === 'AbortError') throw err
        log('compact', `failed (${err.message}); sending it anyway`)
      })
      step--
      continue
    }
    refitted = false
    ui.stopSpin()
    if (!stream) {
      out.think(res.reasoning)
      out.text(res.content)
    }
    out.end()
    // the reply went round and round (client.js cut it): told so, and asked again
    if (res.looped) {
      if (++looping > 3) {
        handOver(`keeps going into a loop`)
        looping = 0
      } else ui.warn(`${client.model} went into a loop; cut, and asked again`)
      if (res.content.trim()) s.messages.push({ role: 'assistant', content: res.content })
      s.messages.push({ role: 'user', content: prompt('agent/looped', { sample: res.looped }) })
      continue
    }
    s.messages.push({ role: 'assistant', content: res.content || '', ...(res.toolCalls.length && { tool_calls: res.toolCalls }), ...(res.reasoning && res.toolCalls.length && { reasoning_content: res.reasoning }) }) // client.js sends it by the name the provider uses, or not at all
    s.counted = { tokens: client.lastTokens, upTo: s.messages.length } // the server's count: up to this reply (auto-compact)
    writtenBy.set(s.messages.at(-1), client.model) // its thinking goes back to this model only
    // a tool call written out as text instead of made (some models do, after a long conversation): made
    const leak = !res.toolCalls.length && leakedCall(res.content)
    if (leak && tools.some((t) => t.function.name === leak.name)) {
      log('tool', `tool call written as text, made for real: ${leak.name}`)
      res.toolCalls = [{ id: `text_${Date.now().toString(36)}`, type: 'function', function: { name: leak.name, arguments: leak.arguments } }]
      res.content = ''
      s.messages[s.messages.length - 1] = { role: 'assistant', content: '', tool_calls: res.toolCalls }
    }
    // A tool call written as text in the model's own template (<tool_call>, <arg_key>, <function=…>,
    // <|…|>): not an answer. The model is told and asked again (twice); then the text before the
    // markup is the answer.
    const markup = !res.toolCalls.length ? leakedMarkup(res.content) : null
    if (markup && garbled++ < 2) {
      log('task', `${client.model}: a tool call written as text; asking again`, res.content)
      s.messages.pop()
      s.messages.push({ role: 'user', content: prompt('agent/garbled-call') })
      continue
    }
    if (markup) {
      res.content = res.content.slice(0, markup.index).trim()
      s.messages[s.messages.length - 1] = { ...s.messages.at(-1), content: res.content }
    }
    if (res.toolCalls.length) s.acted = sinceNudge = true // did real work this message, for the premature-stop check
    s.onEvent?.({ type: 'assistant', model: `${client.provider}/${client.model}`, content: res.content, reasoning: res.reasoning, toolCalls: res.toolCalls }) // headless output
    if (!res.toolCalls.length && !res.content?.trim()) {
      // Nothing at all (seen after a failed tool call): not an answer. The same request again
      // first (often fine the second time), then asked to go on; three in a row ends the task.
      s.messages.pop() // some APIs reject an empty assistant message
      if (empty++ < 3) {
        log('task', `empty reply ${empty}; ${empty === 1 ? 'asking again' : 'asking the model to continue'}`)
        if (empty > 1 && s.messages.at(-1)?.content !== prompt('agent/empty-reply')) s.messages.push({ role: 'user', content: prompt('agent/empty-reply') })
        continue
      }
      // still nothing: the next model in your list carries on (each one once), before giving up
      const was = client.model
      if (movedOn < (client.rotation?.list.length ?? 1) - 1 && client.moveOn(`${was}: ${empty} empty replies in a row`)) {
        movedOn++
        empty = 0
        ui.warn(`${was} keeps replying with nothing; going on with ${client.model}`)
        continue
      }
      return finalAnswer(s, signal)
    }
    empty = 0
    if (!res.toolCalls.length) {
      // an orchestrator that wrote the work (a lot of code) in its reply and handed nothing out: told once
      const didWork = s.orchestrating && !s.handed && !s.workNudged && codeLines(res.content) > 30 && (s.workNudged = true)
      if (didWork) log('task', 'the orchestrator wrote the work in its reply; telling it to hand it out')
      const more = didWork ? prompt('agent/orchestrator-did-work') : sinceNudge && (!s.isSub || s.worker) && ((await notDone(s, signal, nudged > 0, res.content)) ?? (await review(s, task, res.content, signal)))
      if (!more) {
        s.wrapUpLater?.(task, res.content) // after the answer, beside what comes next
        return res.content
      }
      nudged++
      sinceNudge = false
      s.messages.push({ role: 'user', content: more })
      continue
    }

    // Helpers (agent) asked for in one reply work at the same time: the same model or several.
    // ponytail: no cap on how many at once; add one if a provider's rate limit makes them crawl.
    const argsOf = (call) => {
      try {
        return JSON.parse(call.function.arguments || '{}')
      } catch {
        return null
      }
    }
    const together = new Map()
    for (const call of res.toolCalls) {
      const args = argsOf(call)
      // an orchestrator's: one after another (several at once went over each other's work)
      if (call.function.name !== 'agent' || !args || !allowed(s, 'agent') || s.orchestrating || res.toolCalls.filter((x) => x.function.name === 'agent').length < 2) continue
      ui.step('agent', clip([args.model && `${args.model}:`, args.description].filter(Boolean).join(' '), 80))
      together.set(call.id, runTool('agent', args, s, signal, call.id))
    }
    // lookups in one reply (searches, pages, files) run at the same time; the same one twice, once
    const early = new Map() // call id → { refused } or { running }
    const bySig = new Map()
    for (const call of res.toolCalls) {
      const name = call.function.name
      const args = argsOf(call)
      if (!LOOKUPS.has(name) || !args || !allowed(s, name)) continue
      const sig = `${name} ${JSON.stringify(args)}`
      const refused = guard.before(name, args)
      if (refused) early.set(call.id, { refused })
      else early.set(call.id, { running: bySig.get(sig) ?? bySig.set(sig, runTool(name, args, s, signal, call.id)).get(sig) })
    }
    for (const call of res.toolCalls) {
      const name = call.function.name
      const args = argsOf(call)
      const detail = !args
        ? ''
        : args.server
          ? `${args.server} · ${args.tool ?? ''}`
          : name === 'memory'
            ? `${args.action} ${args.name ? `[[${args.name}]]` : (args.query ?? '')}`
            : name === 'manage' || name === 'background'
              ? [args.action, args.kind, args.name, args.id && `#${args.id}`].filter(Boolean).join(' ')
              : name === 'agent'
                ? [args.model && `${args.model}:`, args.description].filter(Boolean).join(' ')
                : name === 'todo' || name === 'ask_user'
                  ? ''
                  : (args.path ?? args.url ?? args.query ?? args.filter ?? args.name ?? '')
      if (name !== 'run_command' && !together.has(call.id)) ui.step(name, clip(detail, 80))
      const pre = early.get(call.id)
      // the first changes to the files with no plan yet (this message, or still open from an earlier one):
      // not made — the plan first, then the changes again. Every change in that reply (one made beside a
      // refused one is easily taken for refused too), once a message; not a helper's (its job is its plan)
      const planFirst = !s.isSub && (!s.planAsked || s.planHeldIn === res) && EDITS.has(name) && args && allowed(s, name) && ui.permission !== 'plan' && !s.todoTouched && !(s.chat.todos ?? []).some((t) => t.status !== 'completed')
      if (planFirst) Object.assign(s, { planAsked: true, planHeldIn: res })
      const refused = planFirst ? prompt('agent/plan-first') : pre ? (pre.refused ?? null) : !together.has(call.id) && args && allowed(s, name) ? guard.before(name, args) : null
      let out = refused ?? (pre ? await pre.running : together.has(call.id) ? await together.get(call.id) : !allowed(s, name) ? `error: the tool ${name} is not allowed here` : args ? await runTool(name, args, s, signal, call.id) : 'error: the tool arguments were not valid JSON')
      if (!refused && args) out += guard.after(name, args, out)
      if (guard.stuck) stuck ??= guard.stuck
      if (args && !refused) {
        s.seq++
        if (EDITS.has(name) && !failed(out)) {
          s.lastChangeAt = s.seq
          s.checksSince = 0
          // the same spot changed again and again (and what it checks still comes out the same): told
          // at the third time that the cause is likely elsewhere
          const at = Number(/\nNow:\n\s*(\d+)\|/.exec(out)?.[1])
          if (args.path && at) {
            const spot = `${args.path}:${Math.round(at / 10)}`
            const n = (s.spots ??= new Map()).set(spot, (s.spots.get(spot) ?? 0) + 1).get(spot)
            if (n === 3) out += `\n\n${prompt('agent/same-spot', { file: String(args.path), line: at })}`
          }
          if (args.path) s.changed.add(String(args.path))
        } else if (name === 'agent' && s.orchestrating) {
          // the files a model it handed work to changed: changes of this message, for the review (the
          // model ran its own checks; the orchestrator can't)
          const was = s.changed.size
          for (const rel of Object.keys(s.chat.turns.at(-1)?.files ?? {})) s.changed.add(rel)
          if (s.changed.size > was) s.lastChangeAt = s.lastCheckAt = s.seq
        } else if (CHECKS.has(name)) {
          s.lastCheckAt = s.seq // ran something: a check of what changed (the model judges its result)
          // checking on and on with nothing changed (sleeps, screenshots, play-throughs): told once per
          // change that it's proven or not by now — stop, or fix what's broken
          if (++s.checksSince === 5 && (s.changed.size || s.isSub)) out += `\n\n${prompt('agent/enough-checks', { n: s.checksSince, choices: (s.chat?.choices ?? []).join('; ') })}`
        }
      }
      if (name === 'run_command' && args && !refused) s.ran?.push({ command: String(args.command ?? ''), result: clip(String(out).split('\n').filter((l) => l.trim()).slice(0, 2).join(' · '), 160) })
      if (!s.isSub && s.memory && !refused && args) await noteRun(s, name, args, out, signal).catch((e) => log('learn', `run note: ${e.message}`)) // learn from any run that failed then passed
      // the same call again and again in a row (a weak model going round): told at the third, stopped at the fifth
      const sig = `${name} ${call.function.arguments}`
      inRow = sig === lastCall ? inRow + 1 : 1
      lastCall = sig
      if (inRow >= 3) out += `\n\n${prompt('agent/repeating', { n: inRow })}`
      if (inRow >= 5) stuck = `made the same ${name} call five times in a row`
      if (name === 'read_file' || name === 'search' || name === 'list_files' || name === 'web_fetch' || name === 'web_search' || name === 'changes') ui.result(`${out.split('\n').length} lines`)
      else if (name === 'agent' && !failed(out)) ui.result(`${s.ui.permission === 'plan' ? 'planned' : 'done'}: ${clip(out.split('\n').find((l) => l.trim()) ?? '', 100)}`)
      else if (failed(out)) ui.result(clip(out, 120))
      client.refresh?.() // a setting changed while the tool ran (the window): its result is cut by the new one
      // every sizable result is saved as it comes (a web page already is, in research): later it can
      // become a pointer to its file in the conversation without anything being lost
      if (out.length > SAVE_AT && name !== 'read_file' && !s.chat.outputs?.[call.id]) {
        const file = saveOutput(s.chat?.id, name, out)
        if (file) (s.chat.outputs ??= {})[call.id] = file
      }
      const msg = { role: 'tool', tool_call_id: call.id, content: fitResult(s, name, out, s.chat.outputs?.[call.id]) }
      if (name === 'read_file' && args && !args.start_line && !args.end_line && !failed(out)) replaceCopy(s, args.path, msg)
      s.messages.push(msg)
      s.onEvent?.({ type: 'tool', id: call.id, name, output: out })
    }
    if (s.userSaid.length) s.messages.push({ role: 'user', content: s.userSaid.splice(0).join('\n\n') }) // their own words, as they typed them
    trimOldResults(s)
    const ended = newlyEnded(s.root) // background commands that exited meanwhile: the model hears it now
    if (ended.length) {
      for (const j of ended) ui.step('background', `#${j.id} ${clip(j.command, 60)} exited with ${j.code}`)
      s.messages.push({ role: 'user', content: prompt('agent/background-ended', { jobs: ended.map(jobLine).join('\n') }) })
    }
    if (stuck) {
      handOver(stuck)
      stuck = null
      inRow = 0
      guard.calm()
    }
    // screenshots from MCP tools: tool results are text only, so images follow as a message
    if (s.pendingImages?.length) {
      s.messages.push({ role: 'user', content: [{ type: 'text', text: prompt('agent/tool-images', { files: s.pendingImages.map((p) => p.file).join(', ') }) }, ...s.pendingImages.map(({ url }) => ({ type: 'image_url', image_url: { url } }))] })
      s.pendingImages = []
    }
  }
}

// One message's calls, so a model going round in circles is caught even when the calls aren't in a
// row or differ only a little: the same search or page again, the same command, read or search
// again with nothing changed since (it gets the earlier result back instead), command after command
// failing. No limit on how much it looks up: new searches and pages always run; only going round
// (ten calls already made) stops it.
// before: what to send back instead of running it (the earlier result), or null; after: a note for its result.
const EDITS = new Set(['edit_file', 'write_file', 'append_file', 'apply_patch'])
// Tools that run or look at what was made (a command, a test, a browser, a helper): a check after a change.
const CHECKS = new Set(['run_command', 'mcp', 'agent', 'lsp'])
// Files only read by people (a change there needs no run to check it).
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i
// Tools that only look (nothing changes): several in one reply run at the same time.
const LOOKUPS = new Set(['web_search', 'web_fetch', 'read_file', 'search', 'list_files', 'find_command', 'lsp', 'changes'])
export function newGuard() {
  const seen = new Map() // what a call is → { out, at }
  let epoch = 0 // goes up with each change (an edit, a command that can change things)
  let failing = 0
  let repeats = 0
  const g = { stuck: null }
  g.calm = () => { // after a handover or a warning: counted again from nothing
    g.stuck = null
    repeats = 0
    failing = 0
  }
  const words = (q) => [...new Set(String(q ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].sort().join(' ')
  const keyOf = (name, a) => {
    if (name === 'web_search') return `search: ${words(a.query)}${a.fresh ? ' (fresh)' : ''}`
    if (name === 'web_fetch') return `page: ${String(a.url ?? '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '')} @${a.start ?? 0} ${words(a.look_for)}`
    if (['run_command', 'read_file', 'search', 'list_files', 'find_command', 'lsp', 'changes'].includes(name)) return `${name} ${JSON.stringify(a)} @${epoch}`
    return null
  }
  g.before = (name, a) => {
    const k = keyOf(name, a)
    const was = k && seen.get(k)
    // a command may be waited on (a server starting): the same one again after a while runs
    if (!was || (name === 'run_command' && Date.now() - was.at > 20_000)) return null
    repeats++
    if (repeats >= 10) g.stuck = 'kept making calls it had already made (10 repeats)' // going round, not finding anything new
    return prompt('agent/already-done', { result: was.out }) + (repeats >= 3 ? `\n\n${prompt('agent/circling')}` : '')
  }
  g.after = (name, a, out) => {
    let note = ''
    if (name === 'run_command') {
      const code = Number(/^exit code (-?\d+)/.exec(out)?.[1] ?? 0)
      failing = code ? failing + 1 : 0
      if (failing >= 4) note += `\n\n${prompt('agent/failing-in-row', { n: failing })}`
      if (failing >= 8) g.stuck = 'had eight commands in a row fail'
      if (!readOnlyCommand(String(a.command ?? ''))) epoch++ // it may have changed things: what came before can be done again
    }
    if (EDITS.has(name) && !failed(out)) epoch++
    const k = keyOf(name, a) // after the command's own change: the same again right away is the same
    if (k) seen.set(k, { out: clip(String(out), 6000), at: Date.now() })
    return note
  }
  return g
}

// A command's tool: its first word (npm, python3, go, cargo, make, curl…), paths and flags dropped,
// so the same kind of command failing then passing is recognised across runs.
const runTool_ = (cmd) => (String(cmd).trim().match(/^[\w./-]+/)?.[0] ?? '').split('/').pop()

// After a command: a failure (non-zero exit, or a tool error) is remembered by its tool; a later
// clean run of the same tool, once files were edited, means it was fixed — learn from it. This is
// how HeartCode learns from anything it runs, in any language, not only web pages.
async function noteRun(s, name, args, out, signal) {
  if (name === 'edit_file' || name === 'write_file' || name === 'apply_patch') {
    if (!failed(out) && !/error:/i.test(out.slice(0, 40))) s.edits++
    return
  }
  if (name !== 'run_command') return
  const tool = runTool_(args.command)
  if (!tool) return
  const code = Number(/^exit code (-?\d+)/.exec(out)?.[1] ?? (failed(out) ? 1 : 0))
  const bad = code !== 0 || /\b(error|traceback|exception|failed|cannot|not found|undefined)\b/i.test(out.split('\n').slice(0, 6).join(' '))
  if (bad) {
    const line = out.split('\n').find((l) => /\b(error|traceback|exception|failed|cannot|not found)\b/i.test(l)) ?? out.split('\n').find((l) => l.trim()) ?? ''
    s.runFails.set(tool, { error: `${args.command.split(/\s+/)[0]}: ${line.trim().slice(0, 160)}`, atEdits: s.edits, cmd: args.command })
    return
  }
  // a clean run: did this tool fail earlier, and have files been edited since? then it's a real fix
  const prev = s.runFails.get(tool)
  if (prev && s.edits > prev.atEdits) {
    s.runFails.delete(tool)
    await learnFromFixes(s, [{ error: prev.error, context: `${prev.cmd} ${prev.error}` }], signal)
  }
}

// Turn each fixed mistake into one reusable rule and save it (global memory, tagged by the tool it came from). The
// model writes the rule from the error; a near-duplicate lesson is skipped. Recall is automatic
// (memory.relevant attaches matching notes to a later message).
async function learnFromFixes(s, fixed, signal) {
  for (const { error, context } of fixed.slice(0, 5)) {
    const tags = [runTool_(context ?? error) || 'general'] // the tool it came from (npm, python3, cargo…)
    const near = s.memory.search(`tag:lesson ${tags.join(' ')}`).find((n) => n.body.toLowerCase().includes(error.replace(/^[^:]*:\s*/, '').toLowerCase().slice(0, 30)))
    if (near) continue // already learned
    let rule = ''
    let scope = 'global'
    try {
      const was = s.client.purpose
      s.client.purpose = 'lesson'
      let reply
      try {
        reply = await s.client.chat({ messages: [{ role: 'user', content: prompt('agent/lesson', { error }) }] }, { signal })
      } finally {
        s.client.purpose = was
      }
      const said = reply.content.trim().split('\n').filter((l) => l.trim())
      rule = (said.find((l) => !/^\s*\W*scope\s*:/i.test(l)) ?? '').replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').replace(/^["'\s-]+|["']+$/g, '').slice(0, 200)
      if (/scope\s*:\W*project/i.test(said.join('\n'))) scope = 'project'
    } catch (e) {
      if (e.name === 'AbortError') throw e
    }
    if (!rule || rule.length < 10) rule = error.replace(/^[^:]*:\s*/, '') // the model couldn't phrase it: keep the error's own wording
    const name = s.memory.write({ description: rule, type: 'reference', tags: ['lesson', ...tags], content: `${rule}\n\nLearned on ${new Date().toISOString().slice(0, 10)} after this was caught and fixed while building: ${error}`, scope })
    s.ui.step('learned', `${rule.slice(0, 90)}${scope === 'project' ? ' (this project)' : ''}`)
    log('learn', `saved lesson [[${name}]] (${scope}, #${tags.join(' #')}): ${rule}`)
  }
}

// The model says it's done: is it? Not while its todo list (from this message) has open items, or
// while a Stop hook says otherwise. Returns what to tell it, or null. Each is asked a few times at
// most (the caller counts), so a model that can't finish still ends.
// The model said it would do something but stopped without doing it ("let me rewrite…", "I'll fix…"):
// a next action named, then no tool call. Not matched by explanations ("let me explain", "you can run").
const PROMISED_MORE =
  /\b(?:let me|i['’]?ll|i will|i['’]?m going to|i am going to|i need to|i['’]?m about to|next,? i['’]?ll|now,? i['’]?ll)\b[^.!?\n]{0,70}\b(?:do|make|create|add|fix|write|update|change|implement|build|run|rewrite|replace|edit|install|set ?up|finish|continue|proceed|start|redo|retry|try|hand|pass|send|give)\b/i

// Is the task really done, or did the model stop early? Open todo items, or (after it did real work)
// a reply that only promises more, get one nudge to keep going. Then any Stop hook. null = truly done.
export async function notDone(s, signal, again, reply = '') {
  const open = s.todoTouched && s.ui.permission !== 'plan' ? (s.chat.todos ?? []).filter((t) => t.status !== 'completed') : [] // plan mode: they wait for the approval
  if (open.length) {
    log('task', `stopped with ${open.length} open todo item(s); reminding`)
    return prompt('agent/todo-unfinished', { items: open.map((t) => `- ${t.content}`).join('\n') })
  }
  // changed files and hasn't run anything since: not proven to work
  const changed = [...(s.changed ?? [])]
  if (changed.length && s.lastCheckAt < s.lastChangeAt && !changed.every((f) => DOC_FILE.test(f)) && s.ui.permission !== 'plan') {
    log('task', `finished with changes not checked since (${changed.join(', ')}); asking for a check`)
    return prompt('agent/unchecked', { files: changed.join(', ') })
  }
  // says it made files that aren't there
  const missing = missingFiles(s.root, reply)
  if (missing.length) {
    log('task', `the answer names files that don't exist: ${missing.join(', ')}`)
    return prompt('agent/missing-files', { files: missing.join(', ') })
  }
  if (s.acted && reply && PROMISED_MORE.test(reply)) {
    log('task', 'reply names a next step but no tool call followed; nudging to finish')
    return prompt('agent/stopped-early')
  }
  if (s.isSub) return null // a helper: the Stop hooks are the main conversation's
  const hook = await runHooks(s, 'Stop', { stop_hook_active: again }, signal)
  return hook.block ? prompt('agent/hook-stop', { reason: hook.block }) : null
}

// lines inside the reply's fenced code blocks
export const codeLines = (text) => [...String(text ?? '').matchAll(/```[^\n]*\n([\s\S]*?)```/g)].reduce((n, m) => n + m[1].split('\n').length, 0)

// Files the final answer says were made, that aren't in the project: a path in backticks, or one
// with a folder, with a source/config/doc extension, while the answer says it created or wrote
// something. A name that's anywhere in the project (by its file name) counts as there.
const FILE_EXT = 'html?|css|scss|m?js|cjs|tsx?|jsx|json|md|py|go|rs|java|kts?|swift|rb|php|c|h|cpp|cs|sh|ya?ml|toml|xml|gradle|vue|svelte|sql|txt|env'
export function missingFiles(root, reply) {
  const text = String(reply ?? '')
  if (!/\b(created?|wrote|written|added|saved|generated|made|new file)\b/i.test(text)) return []
  const named = new Set()
  for (const m of text.matchAll(new RegExp(`\`([^\`\\s]+\\.(?:${FILE_EXT}))\``, 'gi'))) named.add(m[1])
  for (const m of text.matchAll(new RegExp(`(?:^|[\\s(])((?:[\\w.-]+/)+[\\w.-]+\\.(?:${FILE_EXT}))(?=[\\s),.:;]|$)`, 'gim'))) named.add(m[1])
  const out = []
  let names = null
  for (const f of named) {
    if (/^(https?:|\/\/|~|\$)/.test(f) || path.isAbsolute(f)) continue
    if (fs.existsSync(path.join(root, f))) continue
    names ??= new Set(listFiles(root).map((x) => path.basename(x)))
    if (names.has(path.basename(f))) continue
    out.push(f)
  }
  return out
}

// Every folder in the project (relative paths), the ignored ones (.git, node_modules…) and
// HeartCode's own left out: to tell the folders a task made.
function foldersOf(root) {
  const out = new Set()
  const walk = (rel, depth) => {
    if (out.size > 20_000 || depth > 12) return
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORED_DIRS.has(e.name) || e.name === '.heartcode') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      out.add(r)
      walk(r, depth + 1)
    }
  }
  walk('', 0)
  return out
}
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', 'venv', '__pycache__', 'target', '.cache', '.gradle', '.idea'])
const isEmptyDir = (abs) => {
  try {
    return fs.readdirSync(abs).filter((f) => f !== '.DS_Store').length === 0
  } catch {
    return false
  }
}

// A second look before it's called done, in a request of its own: another of your models when
// there is one (fresh eyes), else this one, with nothing but the user's request, the plan, the
// answer, the changes and what was run since. It answers YES (done right) or NO with what's wrong;
// a NO goes back to the model to fix. Asked again only once files changed since its last look.
// Returns what to tell the model, or null.
export async function review(s, task, answer, signal) {
  if (s.isSub || !s.changed?.size || s.lastChangeAt <= s.reviewedAt || s.ui.permission === 'plan') return null
  s.reviewedAt = s.lastChangeAt
  const turn = s.chat.turns.at(-1)
  const diffs = []
  let room = 16_000
  for (const [rel, before] of Object.entries(turn?.files ?? {})) {
    let now = null
    try {
      now = fs.readFileSync(path.join(s.root, rel), 'utf8')
    } catch {}
    if (now === before) continue
    const text = before === null ? `${rel} (new file):\n${now ?? ''}` : now === null ? `${rel}: deleted` : renderDiff(diffLines(before, now), rel, false, 3, 400)
    const piece = clip(text, Math.min(5000, room))
    room -= piece.length
    diffs.push(piece)
    if (room <= 500) {
      diffs.push('(more changes not shown)')
      break
    }
  }
  if (!diffs.length) return null
  const plan = (s.chat.todos ?? []).map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`).join('\n')
  const ran = (s.ran ?? []).slice(-15).map((r) => `- ${clip(r.command.replace(/\s+/g, ' '), 160)} → ${r.result}`).join('\n')
  const ask = prompt('agent/review', { request: requestsOf(s.chat, 1200), emphasis: (s.chat?.choices ?? []).join('; '), plan: plan || '(none)', answer: clip(String(answer ?? ''), 3000), changes: diffs.join('\n\n'), ran: ran || '(nothing)' })
  const self = { provider: s.client.provider, model: s.client.model, self: true }
  const fails = (t) => s.failures?.[`${t.provider} ${t.model}`] ?? 0
  const team = (s.team?.() ?? []).filter((t) => t.tools !== false && !(t.provider === self.provider && t.model === self.model)).sort((a, b) => fails(a) - fails(b))
  for (const t of [...team.slice(0, 2), ...(s.orchestrating ? [] : [self])]) { // an orchestrator doesn't check the work
    s.ui.spinner(`${t.model} is reviewing the work`)
    try {
      const { client } = t.self ? { client: s.client } : await s.engineFor(t)
      if (!t.self) client.retryIf = (e, attempt) => attempt < 2 && !e.notStarted
      const was = client.purpose
      client.purpose = 'review'
      let said
      try {
        said = (await client.chat({ messages: [{ role: 'user', content: ask }] }, { signal })).content.trim()
      } finally {
        client.purpose = was
      }
      s.ui.stopSpin()
      log('review', `${t.model}: ${said}`)
      if (/^\W*yes\b/i.test(said)) {
        s.ui.step('review', `${t.model}: looks right`)
        return null
      }
      if (/^\W*no\b/i.test(said)) {
        const issues = said.replace(/^\W*no\b[\s.:—-]*/i, '').trim()
        s.ui.step('review', `${t.model}: ${clip(issues.split('\n').find((l) => l.trim()) ?? 'problems found', 90)}`)
        return prompt('agent/review-failed', { model: t.model, issues: issues || '(no details given)' })
      }
      log('review', `${t.model} didn't answer YES or NO; trying another`)
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) throw e
      log('review', `${t.model} couldn't review: ${e.message}`)
    }
  }
  s.ui.stopSpin()
  return null
}

// A helper agent's view of the screen: its steps are labelled, and its replies (which go to the
// main agent) aren't shown as answers. Everything else is the main UI's.
// Its thinking is shown whole when its reply is in (helpers working at once don't mix), named.
// Questions to the user (confirm, pick, ask) wait their turn: helpers working at once ask one by one.
const asking = new WeakMap() // ui → the question being asked
function helperUI(ui, label) {
  // What the helper says is shown in full under its name. Held until its reply ends, then printed at
  // once: helpers run side by side, and streamed text from two would interleave.
  const response = () => {
    const t0 = Date.now()
    let thought = ''
    let said = ''
    return {
      think: (t) => (thought += t ?? ''),
      text: (t) => (said += t ?? ''),
      end() {
        if (thought.trim()) ui.print(c.faint(c.italic(`  ✻ ${label} thought for ${duration(Date.now() - t0)}`)) + (ui.showThinking ? `\n${c.think(c.italic(thought.trim().replace(/^/gm, '    ')))}` : ''))
        if (!said.trim()) return
        ui.print(`  ${c.bright(c.bold('●'))} ${c.bold(label)}`)
        let block = new Block((x) => ui.write(x), { marker: '    ', style: c.text })
        if (color) block = new Markdown(block, c.text)
        block.push(said.trim())
        block.end()
      },
    }
  }
  const inTurn = (k) => (...a) => {
    const next = (asking.get(ui) ?? Promise.resolve()).then(() => ui[k](...a))
    asking.set(ui, next.catch(() => {}))
    return next
  }
  const own = {
    step: (name, detail) => ui.step(`  ${label} › ${name}`, detail),
    result: (text) => ui.result(`  ${text}`),
    response,
    spinner: (text) => ui.spinner(`${label} · ${text}`),
    confirm: inTurn('confirm'),
    pick: inTurn('pick'),
    ask: inTurn('ask'),
  }
  return new Proxy(ui, { get: (t, k) => (k in own ? own[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]), set: (t, k, v) => ((t[k] = v), true) })
}

export { allowed }

const shortened = new WeakSet() // kept outside the messages: providers reject unknown message fields

// How long a tool result may be in the conversation: a tenth of the window, 4k to 100k characters
// (Claude Code allows about 25k tokens). A longer one: its start, and the whole of it in a file the
// model can read in parts (read_file, search), as Claude Code does. file: where it's saved already.
export function fitResult(s, name, out, file) {
  const max = Math.max(4000, Math.min(100_000, Math.floor((s.strat.context * 3.5 * 0.1) / (s.strat.ratio ?? 1))))
  if (out.length <= max) return out
  file ??= saveOutput(s.chat?.id, name, out)
  log('tool', `${name}: ${out.length} characters, ${max} shown${file ? `; all of it in ${file}` : ''}`)
  return `${out.slice(0, max)}\n…\n${prompt('agent/output-cut', { shown: max, total: out.length, file })}`
}

// Results longer than this are saved to a file when they come (so they can leave the conversation later).
const SAVE_AT = 1500
// What a tool call was, in a few words: "web_fetch https://…", "run_command npm test".
function callOf(messages, id) {
  for (const m of messages) {
    const t = m.tool_calls?.find((x) => x.id === id)
    if (!t) continue
    let a = {}
    try {
      a = JSON.parse(t.function.arguments || '{}')
    } catch {}
    const what = a.server ? `${a.server} · ${a.tool ?? ''}` : (a.path ?? a.url ?? a.command ?? a.query ?? a.description ?? '')
    return `${t.function.name}${what ? ` ${clip(String(what).replace(/\s+/g, ' '), 120)}` : ''}`
  }
  return 'a tool'
}

// The conversation carries only the newest results whole: the model decides what else it needs and
// reads it from the files (every sizable result is saved when it comes; web pages are in the
// project's research). Once there are more than `most` long ones, all but the newest `keep` become a
// pointer: what the call was, how long, where it's saved, and its first lines. All at once, so a
// provider's prompt cache (the conversation's unchanged start) is broken rarely, not every step.
// An older conversation's results (no file yet) are saved now, before they're cut.
export function trimOldResults(s, keep = 4, most = 8) {
  const long = s.messages.filter((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.length > SAVE_AT && !shortened.has(m) && !/^\[older output/.test(m.content) && !s.staleCopies?.has(m))
  if (long.length <= most) return
  dropStale(s) // the conversation changes here anyway: the older copies of files read again go too
  for (const m of long.slice(0, -keep)) {
    const call = callOf(s.messages, m.tool_call_id)
    const read = /^read_file /.test(call) ? call.slice('read_file '.length) : '' // a project file: read it again
    const file = read || s.chat.outputs?.[m.tool_call_id] || saveOutput(s.chat?.id, 'older', m.content)
    if (file && !read) (s.chat.outputs ??= {})[m.tool_call_id] = file
    m.content = `${prompt('agent/output-old', { call, total: m.content.length, file })}\n${m.content.slice(0, 300)}\n…`
    shortened.add(m)
  }
  log('tool', `older tool output cut: ${long.length - keep} results`)
}

// A file read again: the older copy in the conversation becomes a one-line note, later. Changing a
// message in the middle makes the provider process everything after it again (its prompt cache
// keeps only the unchanged start: minutes on a local model, full price on a paid one), so the older
// copies wait and go together with the old results (trimOldResults), or when it's nearly full.
function replaceCopy(s, file, msg) {
  const key = path.normalize(String(file))
  const older = (s.copies ??= new Map()).get(key)
  if (older && !shortened.has(older)) (s.staleCopies ??= new Map()).set(older, file)
  s.copies.set(key, msg)
}
// the older copies waiting, replaced now: true when there were any
function dropStale(s) {
  if (!s.staleCopies?.size) return false
  for (const [m, file] of s.staleCopies) if (!shortened.has(m)) (m.content = prompt('agent/older-copy', { file })), shortened.add(m)
  s.staleCopies.clear()
  return true
}

// Files the user's message names go in as if the model had already read them: one round trip less
// per file, and the model starts from the real content. Small text files only, at most 3.
function attachNamed(s, task) {
  const files = namedFiles(task, listFiles(s.root)).slice(0, 3)
  const calls = []
  const results = []
  for (const f of files) {
    let body
    try {
      if (fs.statSync(path.join(s.root, f)).size > 40_000) continue
      body = readFileTool(s.root, f)
    } catch {
      continue
    }
    if (failed(body) || body.startsWith(`${f} is a binary file`)) continue // an image: read_file shows it, or says who can see it
    const id = `named_${Date.now().toString(36)}_${calls.length}`
    calls.push({ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: f }) } })
    const msg = { role: 'tool', tool_call_id: id, content: body }
    replaceCopy(s, f, msg)
    results.push(msg)
    s.ui.step('read_file', f)
    s.ui.result(`${body.split('\n').length} lines`)
  }
  if (calls.length) s.messages.push({ role: 'assistant', content: '', tool_calls: calls }, ...results)
}

// /context: what the next request carries, part by part, in tokens (estimated, by this model's
// ratio of counted to estimated; the server's count of the last request beside it), and the
// biggest single pieces. Returns { total, window, compactAt, counted, parts: [{ name, tokens, note }], biggest: [{ tokens, what, ago }] }.
export function contextReport(s) {
  const ratio = s.strat?.ratio ?? 1
  const tok = (x) => Math.round(est(typeof x === 'string' ? x : JSON.stringify(x ?? '')) * ratio)
  const msgs = s.messages ?? []
  const tasks = (s.chat.turns ?? []).map((t) => String(t.task ?? '').slice(0, 60)).filter(Boolean)
  const tools = [...TOOL_DEFS, ...extraTools(s)].filter((f) => allowed(s, f.name))
  const parts = { system: 0, you: 0, notes: 0, replies: 0, results: 0, pointers: 0 }
  let whole = 0
  let cut = 0
  const pieces = []
  msgs.forEach((m, i) => {
    const n = Math.round(estMessages([m]) * ratio)
    const ago = msgs.length - 1 - i
    if (i === 0 && m.role === 'system') return void (parts.system += n)
    if (m.role === 'tool') {
      const old = typeof m.content === 'string' && /^\[older output/.test(m.content)
      old ? (parts.pointers += n, cut++) : (parts.results += n, whole++)
      pieces.push({ tokens: n, what: `${callOf(msgs, m.tool_call_id)} (result${old ? ', a pointer' : ''})`, ago })
    } else if (m.role === 'assistant') {
      parts.replies += n
      pieces.push({ tokens: n, what: 'a model reply', ago })
    } else {
      const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(' ')
      const yours = tasks.some((t) => text.startsWith(t))
      yours ? (parts.you += n) : (parts.notes += n)
      pieces.push({ tokens: n, what: yours ? `your message "${clip(text.split('\n')[0], 50)}"` : `a note to the model "${clip(text.split('\n')[0], 50)}"`, ago })
    }
  })
  const toolTokens = tok(tools.map((f) => ({ type: 'function', function: f })))
  const list = [
    { name: 'system prompt', tokens: parts.system },
    { name: `tools (${tools.length})`, tokens: toolTokens },
    { name: 'your messages', tokens: parts.you },
    { name: 'notes to the model', tokens: parts.notes, note: 'summaries, guides, reminders, saved notes found' },
    { name: 'model replies', tokens: parts.replies },
    { name: 'tool results', tokens: parts.results, note: `${whole} whole` },
    { name: 'older results', tokens: parts.pointers, note: `${cut} shortened to pointers to their files` },
  ]
  const total = list.reduce((a, p) => a + p.tokens, 0)
  const window = s.strat?.context ?? 0
  return { total, window, compactAt: Math.round(window * COMPACT_SHARE), counted: s.counted?.tokens ?? 0, parts: list, biggest: pieces.sort((a, b) => b.tokens - a.tokens).slice(0, 5) }
}
