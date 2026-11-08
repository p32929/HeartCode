// Headless mode (heartcode -p): for other programs to run HeartCode, the way they run Claude Code.
// Same flags and the same output as `claude -p`, so a program that drives Claude Code (like
// Nibedita) drives HeartCode by changing the command name:
//   heartcode -p "fix the test"                                   the answer on stdout
//   heartcode -p --output-format json "…"                         one JSON result
//   heartcode -p --input-format stream-json --output-format stream-json
//       stdin:  {"type":"user","message":{"role":"user","content":"…"}}   one per line, any number
//               {"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}
//       stdout: {"type":"system","subtype":"init",…}, {"type":"assistant",…}, {"type":"user",…}
//               (tool results), {"type":"result",…} after each message; and what the full screen
//               shows besides, as {"type":"system","subtype":…}: "todos" (the plan: content, status,
//               why: a stuck step's reason, by: the model a part went to), "stuck" (the model says it's
//               stuck: step, why, count, model), "helper" (one at work: tool_use_id, label, model, status;
//               "done" at its end), "review" (model, verdict yes/no, issues), "model_switch" (from, to,
//               reason), "warning" (message), "retry" (attempt, delay_ms, error), "status" (what it's
//               doing now, as the spinner says it: a running command's latest output line too)
// Nothing asks anything: what the permission mode would ask about is declined, with the reason
// told to the model. Logs go to their files (or HEART_LOG), never stdout; warnings and retries go to
// stderr with --verbose (and, in stream-json, as system lines).
import readline from 'node:readline'
import { log } from './log.js'
import { clip, TOOL_DEFS, extraTools, loadMcpTools, mcpName, failed as toolFailed } from './tools.js'
import { allowed } from './agent.js'

const plain = (t) => String(t ?? '').replace(/\x1b\[[0-9;]*m/g, '')

// Claude Code's tool names → HeartCode's (for --allowedTools / --disallowedTools).
const CLAUDE_TOOLS = { Read: 'read_file', Grep: 'search', Glob: 'list_files', LS: 'list_files', Edit: 'edit_file', MultiEdit: 'edit_file', Write: 'write_file', NotebookEdit: 'edit_file', Bash: 'run_command', BashOutput: 'background', KillShell: 'background', KillBash: 'background', WebFetch: 'web_fetch', WebSearch: 'web_search', TodoWrite: 'todo', Task: 'agent' }
export function toolNames(list) {
  const names = list.flatMap((x) => String(x).split(/[,\s]+/)).filter(Boolean).map((t) => t.replace(/\(.*$/, '')) // ponytail: "Bash(git:*)" allows every command, not just git
  return new Set(names.map((t) => CLAUDE_TOOLS[t] ?? t)) // mcp__server__tool and mcp__server as they are (tools.js allowed)
}

// --permission-mode, in HeartCode's terms or Claude Code's.
export const PERMISSION_MODES = { all: 'all', commands: 'commands', ask: 'ask', bypassPermissions: 'all', acceptEdits: 'commands', default: 'ask', plan: 'plan', dontAsk: 'ask' }

// A UI that shows nothing and asks nobody; what the full screen would show goes to this.event (set
// by stream-json: a system message each) as data.
export class HeadlessUI {
  constructor({ permission = 'all', verbose = false } = {}) {
    Object.assign(this, { permission, verbose, log: [], showThinking: true, full: false, noUser: true, event: null })
    // helpers at work (agent.js: label → { id, model, what }): each change sent as a "helper" event
    const ui = this
    this.helpers = new (class extends Map {
      set(label, v) {
        ui.event?.({ subtype: 'helper', tool_use_id: v?.id ?? null, label, model: v?.model ?? null, status: v?.what ?? null })
        return super.set(label, v)
      }
      delete(label) {
        const v = this.get(label)
        if (v) ui.event?.({ subtype: 'helper', tool_use_id: v.id ?? null, label, model: v.model ?? null, status: 'done' })
        return super.delete(label)
      }
    })()
  }
  #err(text) {
    if (this.verbose) process.stderr.write(`${text}\n`)
  }
  warn(text) {
    log('warn', text)
    this.#err(`heartcode: ${text}`)
    this.event?.({ subtype: 'warning', message: plain(text) })
  }
  retrying(err, ms, attempt) {
    if (err) this.#err(`heartcode: retrying in ${Math.ceil(ms / 1000)}s (attempt ${attempt}): ${err.message}`)
    if (err) this.event?.({ subtype: 'retry', attempt, delay_ms: ms, error: plain(err.message) })
  }
  // What it's doing now, as the spinner would say it: sent when it changes (a label that's a function,
  // a running command's latest line: read once a second)
  spinner(label) {
    clearInterval(this.spinTimer)
    const say = () => {
      const text = plain(typeof label === 'function' ? label() : label)
      // model: a helper's when it's that helper's ("<its job> · …"), else the main conversation's
      const helper = [...this.helpers].find(([job]) => text.startsWith(`${job} · `))?.[1]
      if (text && text !== this.said) this.event?.({ subtype: 'status', status: (this.said = text), model: helper?.model ?? this.waitingFor?.() ?? null })
    }
    say()
    if (typeof label === 'function') this.spinTimer = setInterval(say, 1000).unref() // never what keeps a finished run going
  }
  stopSpin() {
    clearInterval(this.spinTimer)
    this.said = null
  }
  async confirm(question, kind = 'edit') {
    if (this.permission === 'all' || (this.permission === 'commands' && kind === 'edit') || (this.permission === 'plan' && kind === 'read')) return true // plan: only reading
    log('headless', `declined: ${question}`)
    return `Not allowed: HeartCode runs headless with permission mode "${this.permission}", so this can't be approved. Don't retry it; say in your reply what you would have done.`
  }
  setPermission(mode) {
    this.permission = mode
  }
  // A model's reply as it comes, for --include-partial-messages (stream-json): Claude Code's events
  // (message_start, a content block each for its thinking and its text with their deltas,
  // message_stop) through this.partial. Without it, or a helper's reply (its steps come whole, with
  // their parent): nothing.
  response(who, { helper = false } = {}) {
    const send = !helper && this.partial
    if (!send) return { text() {}, think() {}, end() {} }
    let started = false
    let kind = null
    let index = -1
    const open = (k) => {
      if (!started) (started = true), send({ type: 'message_start', message: { role: 'assistant', model: who, content: [] } })
      if (kind === k) return
      if (kind) send({ type: 'content_block_stop', index })
      kind = k
      send({ type: 'content_block_start', index: ++index, content_block: k === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } })
    }
    return {
      think: (t) => t && (open('thinking'), send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } })),
      text: (t) => t && (open('text'), send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } })),
      end: () => {
        if (kind) send({ type: 'content_block_stop', index })
        if (started) send({ type: 'message_stop' })
        started = false
        kind = null
      },
    }
  }
  async ask() {
    return null
  }
  async pick() {
    return null
  }
  print() {}
  write() {}
  gap() {}
  step() {}
  result() {}
  busy() {}
  idle() {}
  render() {}
  notice() {}
  refreshMenu() {}
  cancelAsk() {}
  clear() {}
  setLog() {}
  close() {}
  leaveFullscreen() {}
  recolor() {}
  setMouse() {}
}

// Runs the messages (prompt, or stdin) and writes the output. Returns the exit code.
// app: the App (bin/heartcode.js); opts: { prompt, input, output, appendSystem }
export async function runHeadless(app, opts) {
  const out = opts.output ?? 'text'
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  const s = await app.session()
  if (!s) {
    const error = app.allOff() ? "the providers of all the models are switched off: switch one on (heart settings), or pass --model" : 'no model set up: add a provider and choose a model (heart settings), or pass --base-url and --model'
    if (out === 'text') process.stderr.write(`heartcode: ${error}\n`)
    else emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: error, num_turns: 0, session_id: app.chat.id })
    return 1
  }
  s.appendSystem = opts.appendSystem || undefined
  const session_id = app.chat.id
  const model = `${s.client.provider ?? app.cfg.provider}/${s.client.model}`

  // usage and request count, over everything this message sends (tool loop, compaction, memory)
  // (also your other models', when this one hands them a job: modelUsage has each)
  let usage = { input_tokens: 0, output_tokens: 0 }
  let byModel = {}
  let requests = 0
  // each request under the model that answered it (the model list may have moved on)
  const count = (client) => {
    const chat = client.chat.bind(client)
    client.chat = async (...a) => {
      const r = await chat(...a)
      const m = (byModel[`${client.provider}/${client.model}`] ??= { inputTokens: 0, outputTokens: 0 })
      if (client === s.client) requests++
      usage.input_tokens += r.usage?.prompt_tokens ?? 0
      usage.output_tokens += r.usage?.completion_tokens ?? 0
      m.inputTokens += r.usage?.prompt_tokens ?? 0
      m.outputTokens += r.usage?.completion_tokens ?? 0
      return r
    }
  }
  count(s.client)
  const engineFor = s.engineFor
  if (engineFor) s.engineFor = async (t) => {
    const e = await engineFor(t)
    count(e.client)
    return e
  }

  // An MCP call goes out as Claude Code sends one: the tool by its own name (mcp__server__tool) with
  // its own arguments, not HeartCode's one mcp tool around them (a program reading it, Nibedita,
  // knows its tools by those names).
  const asClaude = (name, input) => (name === 'mcp' && input?.server && input?.tool ? { name: mcpName(String(input.server), String(input.tool)), input: input.arguments ?? {} } : { name, input })
  let said = '' // the main conversation's last text sent as an assistant message
  // why a reply ended, in Claude's words (stop_reason)
  const STOP = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', incomplete: 'max_tokens', content_filter: 'refusal', loop: 'end_turn' }
  const stopOf = (r) => (r ? (STOP[r] ?? r) : null)
  if (out === 'stream-json') {
    if (opts.partial) app.ui.partial = (event) => emit({ type: 'stream_event', event, session_id, parent_tool_use_id: null }) // the replies as they come (--include-partial-messages)
    app.ui.event = (e) => emit({ type: 'system', ...e, session_id })
    app.ui.waitingFor = () => `${s.client.provider}/${s.client.model}` // the model at work now, on status events // the plan, helpers, reviews, model switches, warnings, retries, status
    s.onEvent = (e) => {
      if (e.type === 'assistant') {
        const content = [
          ...(e.reasoning ? [{ type: 'thinking', thinking: e.reasoning }] : []),
          ...(e.content ? [{ type: 'text', text: e.content }] : []),
          ...e.toolCalls.map((t) => ({ type: 'tool_use', id: t.id, ...asClaude(t.function.name, parseArgs(t.function.arguments)) })),
        ]
        if (e.content && !e.parent) said = e.content
        // a helper's (agent) steps too, as Claude Code sends a subagent's: parent_tool_use_id is its agent call
        if (content.length) emit({ type: 'assistant', message: { role: 'assistant', model: e.model ?? model, content, stop_reason: stopOf(e.stop) }, parent_tool_use_id: e.parent ?? null, session_id })
      } else if (e.type === 'tool') {
        emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: e.id, content: e.output, is_error: toolFailed(e.output) }] }, model: e.model ?? null, parent_tool_use_id: e.parent ?? null, session_id }) // model: the one that made the call
      }
    }
    if (s.strat.actions === 'tools' && s.mcp?.names.length) await loadMcpTools(s) // their tools are in the list, as in Claude Code's
    // each MCP tool by its own name (mcp__server__tool), as Claude Code lists them; the model reaches them through its one mcp tool
    const tools = s.strat.actions === 'tools' ? [...[...TOOL_DEFS, ...extraTools(s)].map((f) => f.name), ...(s.mcpDirect?.keys() ?? [])].filter((n) => allowed(s, n)) : []
    emit({ type: 'system', subtype: 'init', session_id, model, cwd: app.root, tools, mcp_servers: app.mcp.names.map((name) => ({ name, status: s.mcpCatalog?.has(name) ? 'connected' : 'pending' })), permissionMode: app.ui.permission, apiKeySource: 'none' })
  }

  let current = null // the message running now: { ctl }
  const turn = async (text, images = []) => {
    const t0 = Date.now()
    const spent = app.chat.usage?.cost ?? 0
    usage = { input_tokens: 0, output_tokens: 0 }
    byModel = {}
    requests = 0
    said = ''
    s.lastStop = null
    current = { ctl: new AbortController() }
    app.signal = current.ctl.signal
    app.working = true // settings changed meanwhile: MCP servers and skills wait for the end of it
    let answer = ''
    let error = null
    try {
      const k = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
      const skill = k && app.skills.get(k[1].replace(/^skill:/, '')) // /name or /skill:name, as in the full screen
      answer = await s.run(skill && skill.use !== 'model' ? await app.expandSkill(skill, k[2]) : text, current.ctl.signal, images)
    } catch (e) {
      error = current.ctl.signal.aborted ? 'interrupted' : e.message
      if (e.maxTurns) current.maxTurns = true
      log('error', error, e.stack)
    } finally {
      app.save()
      app.working = false
      app.afterLine?.()
    }
    const subtype = current.maxTurns ? 'error_max_turns' : error ? 'error_during_execution' : 'success' // as Claude Code names them
    current = null
    const result = { type: 'result', subtype, is_error: Boolean(error), result: error ?? answer, stop_reason: error ? null : stopOf(s.lastStop ?? 'stop'), num_turns: Math.max(1, requests), duration_ms: Date.now() - t0, total_cost_usd: (app.chat.usage?.cost ?? 0) - spent, usage, modelUsage: Object.keys(byModel).length ? byModel : { [model]: { inputTokens: 0, outputTokens: 0 } }, session_id }
    if (out === 'stream-json') {
      // the answer as a reply of its own, unless it just went out as one (as it was: a cut-off answer is
      // its pieces together; guided mode, an answer made after empty replies: never sent)
      if (!error && answer && said.trim() !== answer.trim()) emit({ type: 'assistant', message: { role: 'assistant', model: `${s.client.provider}/${s.client.model}`, content: [{ type: 'text', text: answer }], stop_reason: stopOf(s.lastStop ?? 'stop') }, parent_tool_use_id: null, session_id })
      emit(result)
    } else if (out === 'json') emit(result)
    else if (error) process.stderr.write(`heartcode: ${error}\n`)
    else process.stdout.write(answer.trim() + '\n')
    await s.wrapping // the wrap-up (notes, research, cleanup) after the result is out, before it exits
    return !error
  }

  if (opts.input !== 'stream-json') {
    const text = opts.prompt || (process.stdin.isTTY ? '' : await readAll(process.stdin))
    if (!text.trim()) {
      process.stderr.write('heartcode: -p needs a prompt (as an argument or on stdin)\n')
      return 1
    }
    return (await turn(text.trim())) ? 0 : 1
  }

  // stream-json: messages one per line, in order; an interrupt stops the one running
  let ok = true
  let queue = Promise.resolve()
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      log('headless', `not JSON: ${clip(line, 200)}`)
      continue
    }
    if (msg.type === 'control_request') {
      // as Claude Code answers them: initialize (an SDK's first line), interrupt, a permission mode;
      // any other is said to be unsupported, not taken as done
      const kind = msg.request?.subtype
      const ok = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } })
      if (kind === 'interrupt') (current?.ctl.abort(), ok())
      else if (kind === 'initialize') ok()
      else if (kind === 'set_permission_mode' && PERMISSION_MODES[msg.request.mode]) (app.ui.setPermission(PERMISSION_MODES[msg.request.mode]), ok())
      else emit({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `HeartCode doesn't support the control request "${kind ?? ''}"` } })
      continue
    }
    if (msg.type !== 'user') continue
    const { text, images } = contentOf(msg.message?.content)
    queue = queue.then(() => turn(text, images)).then((r) => (ok = r))
  }
  await queue
  return ok ? 0 : 1
}

// A message's content: a string, or blocks of text and images (Claude's or OpenAI's shape).
export function contentOf(content) {
  if (typeof content === 'string') return { text: content, images: [] }
  const blocks = Array.isArray(content) ? content : []
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    images: blocks.flatMap((b) => (b.type === 'image' && b.source?.data ? [`data:${b.source.media_type ?? 'image/png'};base64,${b.source.data}`] : b.type === 'image_url' ? [b.image_url?.url ?? b.image_url] : [])),
  }
}

function parseArgs(text) {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return { raw: text }
  }
}

async function readAll(stream) {
  let text = ''
  for await (const ch of stream) text += ch
  return text
}
