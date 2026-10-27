import fs from 'node:fs'
import { log } from './log.js'
import { prompt, userInstructions } from './prompts.js'
import { newChat } from './sessions.js'
import path from 'node:path'
import { est, Client } from './client.js'
import { runGuided } from './guided.js'
import { TOOL_DEFS, PLAN_HIDDEN, extraTools, runTool, listFiles, namedFiles, readFileTool, clip } from './tools.js'
import { loadHooks, runHooks } from './hooks.js'
import { takeConfigErrors } from './config.js'
import { c } from './ui.js'

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// "@shot.png" in a task attaches that image.
export function extractImages(task, root) {
  const images = []
  const text = task.replace(/(^|\s)@(\S+\.(png|jpe?g|gif|webp))\b/gi, (m, pre, file, ext) => {
    const abs = path.resolve(root, file)
    if (!fs.existsSync(abs)) return m
    images.push(`data:${MIME[ext.toLowerCase()]};base64,${fs.readFileSync(abs).toString('base64')}`)
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
  async compact({ signal, focus = '', midTask = false, task = '' } = {}) {
    const { chat, client, strat, ui } = this
    const native = Boolean(chat.messages?.length)
    const head = native ? chat.messages.slice(0, chat.messages[0].role === 'system' ? 1 : 2) : [] // the system prompt stays
    const body = native ? chat.messages.slice(head.length) : []
    const conversation = native ? transcript(body) : chat.history.map((h) => `User: ${h.task}\nAssistant: ${h.answer}`).join('\n\n')
    if (!conversation.trim()) return null
    let room = Math.floor((strat.context * 0.6 * 3.5) / (strat.ratio ?? 1)) // characters of conversation the summary request can carry
    const cut = () => (conversation.length > room ? `[… the earliest part is cut]\n${conversation.slice(-room)}` : conversation)
    const before = native ? size(body) : est(conversation)
    ui.spinner(midTask ? 'context almost full: compacting the conversation' : 'compacting the conversation')
    // A model shown its own work tends to carry on with it (calling tools, or writing tool calls
    // as text) instead of summarizing: so it's told what it is, and a reply that isn't a summary
    // is asked for again once; then the compaction fails (the conversation is trimmed instead).
    const request = (extra) => prompt('compact/summarize', { conversation: cut(), focus }) + extra
    const send = (extra) =>
      client.chat({ messages: strat.mergeSystem ? [{ role: 'user', content: `${prompt('compact/summarizer')}\n\n${request(extra)}` }] : [{ role: 'system', content: prompt('compact/summarizer') }, { role: 'user', content: request(extra) }] }, { signal })
    // too large even for the summary request: send less of it (the newest part) until it fits
    const ask = async (extra = '') => {
      for (;;) {
        try {
          return await send(extra)
        } catch (e) {
          if (!e.inputLimit || room < 2000) throw e
          room = Math.floor(Math.min(room, (e.inputLimit * 3.5) / (strat.ratio ?? 1)) * 0.7)
        }
      }
    }
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
    const recap = prompt('compact/summary', { summary, requests: requestsOf(chat) })
    if (native) {
      chat.messages = midTask
        ? [...head, { role: 'user', content: `${recap}\n\n${prompt('compact/continue', { task })}` }]
        : [...head, { role: 'user', content: recap }, { role: 'assistant', content: prompt('compact/acknowledged') }]
    }
    chat.history.splice(0, chat.history.length, { task: '(the conversation before this point, summarized)', answer: summary })
    const after = native ? size(chat.messages.slice(head.length)) : est(summary)
    log('compact', `${midTask ? 'auto' : 'manual'}: ~${before} → ~${after} tokens`, summary)
    ui.stopSpin()
    ui.print(`${c.faint('✻')} ${c.muted(`Compacted the conversation: ~${kTokens(before)} → ~${kTokens(after)} tokens`)}`)
    return summary
  }

  // images: data: URLs from the caller (headless input), besides @shot.png in the task.
  async run(task, signal, extra = []) {
    if (!this.isSub) this.client.newMessage?.() // the model list: from #1 again (unless set to stay)
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
      this.ui.warn(`${this.client.model} can't read images (per its probe); ignoring ${images.length} image(s)`)
      images = []
    }
    log('task', `${text} (${this.strat.actions} mode, ${images.length} image(s))`)
    const answer = this.strat.actions === 'tools' ? await runNative(this, text, images, signal) : await runGuided(this, text, images, signal)
    log('task', 'answer:', answer)
    this.history.push({ task: text, answer })
    if (this.memory && this.strat.actions === 'tools') await this.afterTask(text, answer, signal)
    return answer
  }

  // The agent tool: a helper with a fresh conversation and the same tools (but no helpers of its
  // own, no memory, no director) does one job; its final reply is the tool's result. Its steps show
  // under the main conversation's, its file changes count for /rewind like the main agent's.
  // ponytail: helpers run one after another; run several at once if waiting on them gets long.
  async subagent(args, signal) {
    const task = String(args.prompt ?? args.task ?? '').trim()
    if (!task) return 'error: give the helper its job in "prompt"'
    const label = clip(String(args.description ?? '').trim() || task.split('\n')[0], 40)
    const helper = new Session({ client: this.client, profile: this.profile, strat: this.strat, root: this.root, ui: helperUI(this.ui, label), chat: newChat(this.root) })
    Object.assign(helper, { isSub: true, mcp: this.mcp, skills: this.skills, hooks: this.hooks, allowTools: this.allowTools, denyTools: this.denyTools, maxTurns: this.maxTurns, autoCompact: this.autoCompact, appendSystem: this.appendSystem, fileCache: this.fileCache, noFormat: this.noFormat, noLsp: this.noLsp })
    helper.track = (rel, before) => this.track(rel, before)
    log('agent', `helper "${label}": ${task}`)
    const answer = await runNative(helper, task, [], signal)
    log('agent', `helper "${label}" done`, answer)
    return answer?.trim() || '(the helper finished without a reply)'
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
    Object.assign(side, { effort: client.effort, quirks: client.quirks, tokenRatio: client.tokenRatio, onSpend: client.onSpend, purpose: 'btw' })
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
    const messages = strat.mergeSystem ? [{ role: 'user', content: `${prompt('compact/summarizer')}\n\n${request}` }] : [{ role: 'system', content: prompt('compact/summarizer') }, { role: 'user', content: request }]
    const summary = notSummary((await client.chat({ messages }, { signal })).content)
    if (!summary) throw new Error('the model did not write a summary')
    return summary
  }

  // After a task: if the user said something worth keeping and the model didn't save it, ask it to
  // (one small request, with only the related notes). Never fails the task.
  async afterTask(task, answer, signal) {
    const writes = this.memoryWrites ?? 0
    try {
      if (!writes && REMEMBER.test(task)) {
        this.ui.spinner('remembering')
        await this.memoryTask(this.#extractPrompt(`${task}\n${answer}`), prompt('agent/memory-exchange', { task, answer: clip(answer, 2000) }), signal)
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e
      this.ui.warn(`memory: ${e.message}`)
    } finally {
      this.memoryWrites = 0
    }
  }

  #extractPrompt(about) {
    const notes = this.memory.relevant(about, 10).map((n) => `[[${n.name}]] — ${n.description} (${[n.scope, ...n.tags].join(', ')})`).join('\n')
    return prompt('agent/memory-extract', { tags: this.memory.tagSummary() || '(none yet)', notes })
  }

  // A small tool loop with only the memory tool (saving and tidying notes).
  async memoryTask(system, user, signal, steps = 12) {
    const tools = extraTools({ memory: this.memory }).map((f) => ({ type: 'function', function: f }))
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }]
    for (let step = 0; step < steps; step++) {
      const res = await this.client.chat({ messages, tools }, { signal })
      messages.push({ role: 'assistant', content: res.content || '', ...(res.toolCalls.length && { tool_calls: res.toolCalls }) })
      if (!res.toolCalls.length) return res.content.trim()
      for (const call of res.toolCalls) {
        let args = {}
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch {}
        const out = await runTool(call.function.name, args, this, signal)
        if (args.action === 'write' || args.action === 'delete') this.ui.step('memory', `${args.action === 'write' ? 'saved' : 'deleted'} ${out.match(/\[\[[^\]]+\]\]/)?.[0] ?? ''}`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: out })
      }
    }
    return ''
  }

  // /tidy_memory: merge duplicates, drop what's outdated, link related notes.
  async tidyMemory(signal) {
    const notes = this.memory.list()
    if (!notes.length) return 'No notes to tidy.'
    this.ui.spinner('tidying the memory')
    const room = Math.floor(this.strat.context * 0.5 * 3.5)
    const text = notes.map((n) => `## [[${n.name}]] (${n.scope}, ${n.type}; tags: ${n.tags.join(', ') || 'none'}) — ${n.description}\n${n.body}`).join('\n\n').slice(0, room)
    const broken = this.memory.brokenLinks().map((b) => `[[${b.to}]] in [[${b.from}]]`).join(', ')
    const summary = await this.memoryTask(this.#extractPrompt(''), prompt('agent/memory-tidy', { notes: text, broken }), signal, 30 + notes.length * 3)
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
const SYSTEM = (s) => {
  const instructions = userInstructions(s.root)
  return [
    prompt('agent/system', { root: s.root, files: '', more: '' }),
    instructions && prompt('agent/instructions', { instructions }),
    s.memory && prompt('agent/memory', { tags: s.memory.tagSummary() || '(none yet)' }),
    s.director && s.director.app.cfg.director !== false && prompt('agent/director'),
    s.isSub && prompt('agent/subagent'),
    s.appendSystem, // from the caller (--append-system-prompt)
  ]
    .filter(Boolean)
    .join('\n\n')
}

const sizeOf = (m) =>
  (Array.isArray(m.content) ? m.content.reduce((n, p) => n + (p.type === 'text' ? est(p.text) : 800), 0) : est(m.content)) +
  (m.tool_calls ? est(JSON.stringify(m.tool_calls)) : 0)
export const size = (messages) => messages.reduce((n, m) => n + sizeOf(m), 0)
// Words that suggest the user said something to remember (then HeartCode asks the model to save it).
const REMEMBER = /\b(always|never|prefer|remember|don'?t|do not|instead of|from now on|we use|convention|make sure|keep in mind)\b/i
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

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
async function finalAnswer(s, signal) {
  const { client, ui } = s
  log('task', 'empty replies in a row; asking for the final answer without tools')
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
  // The system prompt is rebuilt for every message: files come and go, and a resumed chat's is
  // from back then (it once told the model the project was empty after it had made files).
  // Unchanged, it stays the same text, so a provider's prompt cache still holds.
  const sys = SYSTEM(s)
  if (!s.messages) {
    s.messages = strat.mergeSystem ? [{ role: 'user', content: sys }, { role: 'assistant', content: prompt('agent/system-acknowledged') }] : [{ role: 'system', content: sys }]
  } else if (s.messages[0]?.content !== sys && (s.messages[0]?.role === 'system' || strat.mergeSystem)) {
    s.messages[0] = { ...s.messages[0], content: sys }
  }
  if (s.chat.branchNote && !s.isSub) {
    s.messages.push({ role: 'user', content: s.chat.branchNote }, { role: 'assistant', content: prompt('compact/acknowledged') })
    delete s.chat.branchNote
  }
  let shrink = 1 // drops when the server says a request is too large
  s.compactedAt = -1
  // What may be sent: the window less a tenth (estimates are estimates) and less room for the
  // reply (the longest the model gives, from models.dev, at most a quarter of the window; 8k when
  // unknown) and the tools; trimming keeps to it. Auto-compact starts at 90% of it, so it comes
  // before any trimming.
  // s.sizeCap: "too large" without the server saying its limit: a guess for this conversation only
  const windowSize = () => Math.min(strat.context, s.sizeCap ?? Infinity)
  const reply = () => Math.min(strat.reply || 8192, Math.floor(windowSize() * 0.25))
  const budget = () => Math.floor(((windowSize() * 0.9 - reply()) * shrink) / (strat.ratio ?? 1)) - 800 // in estimated tokens
  const nearlyFull = () => s.autoCompact && s.messages.length > 3 && size(s.messages) > budget() * 0.9
  // Already near full from earlier messages: compact first, so the new message stays word for word.
  if (nearlyFull()) {
    await s.compact({ signal }).catch((e) => (e.name === 'AbortError' ? Promise.reject(e) : ui.warn(`could not compact: ${e.message}`)))
  }
  // only the memory notes this message matches go with it (the system prompt has just the tags)
  // each note once per conversation (again if it changed, or after compacting dropped it)
  const sent = new Set(s.chat.sentNotes ?? [])
  const key = (n) => `${n.scope}:${n.name}:${n.description}`
  const notes = (s.memory?.relevant(task) ?? []).filter((n) => !sent.has(key(n)))
  s.chat.sentNotes = [...sent, ...notes.map(key)]
  const text = notes.length ? `${task}\n\n${prompt('agent/memory-relevant', { notes: notes.map((n) => `[[${n.name}]] — ${n.description}`).join('\n') })}` : task
  const planning = ui.permission === 'plan'
  const said = planning && !s.isSub ? `${text}\n\n${prompt('agent/plan-mode')}` : text
  const content = images.length ? [{ type: 'text', text: said }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : said
  s.messages.push({ role: 'user', content })
  attachNamed(s, task) // files the message names: as if already read (saves a round trip each)
  const tools = [...TOOL_DEFS, ...extraTools(s)].filter((f) => allowed(s, f.name) && !(planning && PLAN_HIDDEN.has(f.name)) && !(f.name === 'ask_user' && ui.noUser)).map((f) => ({ type: 'function', function: f }))
  // A todo list left done from an earlier message is cleared; an unfinished one stays.
  if (!s.isSub && s.chat.todos?.every((t) => t.status === 'completed')) s.chat.todos = []
  s.todoTouched = false
  let nudged = 0 // reminders sent this message about open todo items or a Stop hook

  let empty = 0 // replies in a row with neither text nor tool calls
  // No step limit: a long fix takes many steps, and Esc stops it. A caller can set one (--max-turns).
  for (let step = 0; ; step++) {
    if (s.maxTurns && step >= s.maxTurns) {
      ui.warn(`stopped after ${s.maxTurns} steps (--max-turns); say "continue" to go on`)
      throw Object.assign(new Error(`stopped after ${s.maxTurns} steps (--max-turns)`), { maxTurns: true })
    }
    // after a failed compaction, the next try waits until the conversation grew by a fifth
    if (nearlyFull() && s.messages.length > 4 && step !== s.compactedAt && size(s.messages) > (s.compactFailedAt ?? 0) * 1.2) {
      s.compactedAt = step
      await s.compact({ signal, midTask: true, task }).catch((e) => {
        if (e.name === 'AbortError') throw e
        // no summary: free the space anyway, by shortening older tool output and dropping the oldest turns
        fitMessages(s.messages, Math.floor(budget() * 0.5))
        s.compactFailedAt = size(s.messages)
        ui.warn(`could not compact (${e.message}); shortened older tool output and messages instead`)
        log('compact', `failed (${e.message}); trimmed to ~${s.compactFailedAt} tokens`)
      })
    }
    // what the user typed while it worked goes in before the next step (steering)
    const added = step && !s.isSub ? (ui.takeAhead?.() ?? []) : []
    if (added.length) {
      for (const l of added) ui.print(`${c.magenta('♥')} ${c.bright(l)}`)
      log('task', 'the user added while working:', added)
      s.messages.push({ role: 'user', content: prompt('agent/user-added', { text: added.join('\n\n') }) })
    }
    fitMessages(s.messages, budget())
    pairTools(s.messages)
    ui.spinner('thinking')
    const out = ui.response()
    const stream = strat.toolsStream
    let res
    try {
      // A long tool call (a whole file) streams in silently: say what's being written.
      const onToolDelta = (name, args) => ui.spinner(`${name === 'run_command' ? 'preparing a command' : `writing ${/"path"\s*:\s*"([^"]+)"/.exec(args)?.[1] ?? name}`} · ${args.length >= 1000 ? `${(args.length / 1000).toFixed(1)}k` : args.length} chars`)
      res = await client.chat({ messages: s.messages, tools, stream }, { signal, onToken: out.text, onReasoning: out.think, onToolDelta })
    } catch (e) {
      if (!e.inputLimit || shrink < 0.3) throw e
      s.sizeCap = Math.min(s.sizeCap ?? Infinity, e.inputLimit)
      out.end()
      shrink *= 0.8 // strat.context already dropped to the limit; leave more headroom each time
      step--
      continue
    }
    ui.stopSpin()
    if (!stream) {
      out.think(res.reasoning)
      out.text(res.content)
    }
    out.end()
    s.messages.push({ role: 'assistant', content: res.content || '', ...(res.toolCalls.length && { tool_calls: res.toolCalls }) })
    // a tool call written out as text instead of made (some models do, after a long conversation): made
    const leak = !res.toolCalls.length && leakedCall(res.content)
    if (leak && tools.some((t) => t.function.name === leak.name)) {
      log('tool', `tool call written as text, made for real: ${leak.name}`)
      res.toolCalls = [{ id: `text_${Date.now().toString(36)}`, type: 'function', function: { name: leak.name, arguments: leak.arguments } }]
      res.content = ''
      s.messages[s.messages.length - 1] = { role: 'assistant', content: '', tool_calls: res.toolCalls }
    }
    s.onEvent?.({ type: 'assistant', content: res.content, reasoning: res.reasoning, toolCalls: res.toolCalls }) // headless output
    if (!res.toolCalls.length && !res.content?.trim()) {
      // Nothing at all (seen after a failed tool call): not an answer. The same request again
      // first (often fine the second time), then asked to go on; three in a row ends the task.
      s.messages.pop() // some APIs reject an empty assistant message
      if (empty++ < 3) {
        log('task', `empty reply ${empty}; ${empty === 1 ? 'asking again' : 'asking the model to continue'}`)
        if (empty > 1 && s.messages.at(-1)?.content !== prompt('agent/empty-reply')) s.messages.push({ role: 'user', content: prompt('agent/empty-reply') })
        continue
      }
      return finalAnswer(s, signal)
    }
    empty = 0
    if (!res.toolCalls.length) {
      const more = nudged < 3 && !s.isSub && (await notDone(s, signal, nudged > 0))
      if (!more) return res.content
      nudged++
      s.messages.push({ role: 'user', content: more })
      continue
    }

    for (const call of res.toolCalls) {
      const name = call.function.name
      let args = null
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {}
      const detail = !args
        ? ''
        : args.server
          ? `${args.server} · ${args.tool ?? ''}`
          : name === 'memory'
            ? `${args.action} ${args.name ? `[[${args.name}]]` : (args.query ?? '')}`
            : name === 'manage'
              ? [args.action, args.kind, args.name].filter(Boolean).join(' ')
              : name === 'agent'
                ? (args.description ?? '')
                : name === 'todo' || name === 'ask_user'
                  ? ''
                  : (args.path ?? args.url ?? args.query ?? args.filter ?? args.name ?? '')
      if (name !== 'run_command') ui.step(name, clip(detail, 80))
      const out = !allowed(s, name) ? `error: the tool ${name} is not allowed here` : args ? await runTool(name, args, s, signal) : 'error: the tool arguments were not valid JSON'
      if (name === 'read_file' || name === 'search' || name === 'list_files' || name === 'web_fetch' || name === 'web_search') ui.result(`${out.split('\n').length} lines`)
      else if (name === 'agent' && !out.startsWith('error')) ui.result(`${s.ui.permission === 'plan' ? 'planned' : 'done'}: ${clip(out.split('\n').find((l) => l.trim()) ?? '', 100)}`)
      else if (out.startsWith('error')) ui.result(clip(out, 120))
      const msg = { role: 'tool', tool_call_id: call.id, content: clip(out, Math.min(12_000, strat.context)) }
      if (name === 'read_file' && args && !args.start_line && !args.end_line && !out.startsWith('error')) replaceCopy(s, args.path, msg)
      s.messages.push(msg)
      s.onEvent?.({ type: 'tool', id: call.id, name, output: out })
    }
    // screenshots from MCP tools: tool results are text only, so images follow as a message
    if (s.pendingImages?.length) {
      s.messages.push({ role: 'user', content: [{ type: 'text', text: prompt('agent/tool-images') }, ...s.pendingImages.map((url) => ({ type: 'image_url', image_url: { url } }))] })
      s.pendingImages = []
    }
  }
}

// The model says it's done: is it? Not while its todo list (from this message) has open items, or
// while a Stop hook says otherwise. Returns what to tell it, or null. Each is asked a few times at
// most (the caller counts), so a model that can't finish still ends.
async function notDone(s, signal, again) {
  const open = s.todoTouched && s.ui.permission !== 'plan' ? (s.chat.todos ?? []).filter((t) => t.status !== 'completed') : [] // plan mode: they wait for the approval
  if (open.length) {
    log('task', `stopped with ${open.length} open todo item(s); reminding`)
    return prompt('agent/todo-unfinished', { items: open.map((t) => `- ${t.content}`).join('\n') })
  }
  const hook = await runHooks(s, 'Stop', { stop_hook_active: again }, signal)
  return hook.block ? prompt('agent/hook-stop', { reason: hook.block }) : null
}

// A helper agent's view of the screen: its steps are labelled, and its replies (which go to the
// main agent) aren't shown as answers. Everything else is the main UI's.
function helperUI(ui, label) {
  const quiet = { think() {}, text() {}, end() {} }
  const own = {
    step: (name, detail) => ui.step(`  ${label} › ${name}`, detail),
    result: (text) => ui.result(`  ${text}`),
    response: () => quiet,
    spinner: (text) => ui.spinner(`${label} · ${text}`),
  }
  return new Proxy(ui, { get: (t, k) => (k in own ? own[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]), set: (t, k, v) => ((t[k] = v), true) })
}

// Tools the caller allowed (--allowedTools) or took away (--disallowedTools); all by default.
export const allowed = (s, name) => (!s.allowTools || s.allowTools.has(name)) && !s.denyTools?.has(name)

const shortened = new WeakSet() // kept outside the messages: providers reject unknown message fields

// A file read again: the older copy in the conversation becomes a one-line note.
function replaceCopy(s, file, msg) {
  const key = path.normalize(String(file))
  const older = (s.copies ??= new Map()).get(key)
  if (older && !shortened.has(older)) {
    older.content = prompt('agent/older-copy', { file })
    shortened.add(older)
  }
  s.copies.set(key, msg)
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
    if (body.startsWith('error')) continue
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
