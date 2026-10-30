// Headless mode (heartcode -p): for other programs to run HeartCode, the way they run Claude Code.
// Same flags and the same output as `claude -p`, so a program that drives Claude Code (like
// Nibedita) drives HeartCode by changing the command name:
//   heartcode -p "fix the test"                                   the answer on stdout
//   heartcode -p --output-format json "…"                         one JSON result
//   heartcode -p --input-format stream-json --output-format stream-json
//       stdin:  {"type":"user","message":{"role":"user","content":"…"}}   one per line, any number
//               {"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}
//       stdout: {"type":"system","subtype":"init",…}, {"type":"assistant",…}, {"type":"user",…}
//               (tool results), {"type":"result",…} after each message
// Nothing asks anything: what the permission mode would ask about is declined, with the reason
// told to the model. Logs and warnings go to stderr (and HEART_LOG), never stdout.
import readline from 'node:readline'
import { log } from './log.js'
import { clip, TOOL_DEFS, extraTools, loadMcpTools, failed as toolFailed } from './tools.js'
import { allowed } from './agent.js'

// Claude Code's tool names → HeartCode's (for --allowedTools / --disallowedTools).
const CLAUDE_TOOLS = { Read: 'read_file', Grep: 'search', Glob: 'list_files', LS: 'list_files', Edit: 'edit_file', MultiEdit: 'edit_file', Write: 'write_file', NotebookEdit: 'edit_file', Bash: 'run_command' }
export function toolNames(list) {
  const names = list.flatMap((x) => String(x).split(/[,\s]+/)).filter(Boolean).map((t) => t.replace(/\(.*$/, '')) // ponytail: "Bash(git:*)" allows every command, not just git
  return new Set(names.map((t) => CLAUDE_TOOLS[t] ?? t)) // mcp__server__tool and mcp__server as they are (tools.js allowed)
}

// --permission-mode, in HeartCode's terms or Claude Code's.
export const PERMISSION_MODES = { all: 'all', commands: 'commands', ask: 'ask', bypassPermissions: 'all', acceptEdits: 'commands', default: 'ask', plan: 'plan', dontAsk: 'ask' }

// A UI that shows nothing and asks nobody.
export class HeadlessUI {
  constructor({ permission = 'all', verbose = false } = {}) {
    Object.assign(this, { permission, verbose, log: [], showThinking: true, full: false, noUser: true })
  }
  #err(text) {
    if (this.verbose) process.stderr.write(`${text}\n`)
  }
  warn(text) {
    log('warn', text)
    this.#err(`heartcode: ${text}`)
  }
  retrying(err, ms, attempt) {
    if (err) this.#err(`heartcode: retrying in ${Math.ceil(ms / 1000)}s (attempt ${attempt}): ${err.message}`)
  }
  async confirm(question, kind = 'edit') {
    if (this.permission === 'all' || (this.permission === 'commands' && kind === 'edit') || (this.permission === 'plan' && kind === 'read')) return true // plan: only reading
    log('headless', `declined: ${question}`)
    return `Not allowed: HeartCode runs headless with permission mode "${this.permission}", so this can't be approved. Don't retry it; say in your reply what you would have done.`
  }
  setPermission(mode) {
    this.permission = mode
  }
  response() {
    return { text() {}, think() {}, end() {} }
  }
  async ask() {
    return null
  }
  async pick() {
    return null
  }
  spinner() {}
  stopSpin() {}
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
}

// Runs the messages (prompt, or stdin) and writes the output. Returns the exit code.
// app: the App (bin/heartcode.js); opts: { prompt, input, output, appendSystem }
export async function runHeadless(app, opts) {
  const out = opts.output ?? 'text'
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  const s = await app.session()
  if (!s) {
    const error = app.allOff() ? "the providers of all your models are switched off: switch one on (heart settings), or pass --model" : 'no model set up: add a provider and choose a model (heart settings), or pass --base-url and --model'
    if (out === 'text') process.stderr.write(`heartcode: ${error}\n`)
    else emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: error, num_turns: 0, session_id: app.chat.id })
    return 1
  }
  s.appendSystem = opts.appendSystem || undefined
  const session_id = app.chat.id
  const model = `${app.cfg.provider}/${s.client.model}`

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

  let said = false // the model's text was already sent as an assistant message
  if (out === 'stream-json') {
    s.onEvent = (e) => {
      if (e.type === 'assistant') {
        const content = [
          ...(e.reasoning ? [{ type: 'thinking', thinking: e.reasoning }] : []),
          ...(e.content ? [{ type: 'text', text: e.content }] : []),
          ...e.toolCalls.map((t) => ({ type: 'tool_use', id: t.id, name: t.function.name, input: parseArgs(t.function.arguments) })),
        ]
        if (e.content && !e.parent) said = true
        // a helper's (agent) steps too, as Claude Code sends a subagent's: parent_tool_use_id is its agent call
        if (content.length) emit({ type: 'assistant', message: { role: 'assistant', model: e.model ?? model, content }, parent_tool_use_id: e.parent ?? null, session_id })
      } else if (e.type === 'tool') {
        emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: e.id, content: e.output, is_error: toolFailed(e.output) }] }, parent_tool_use_id: e.parent ?? null, session_id })
      }
    }
    if (s.strat.actions === 'tools' && s.mcp?.names.length) await loadMcpTools(s) // their tools are in the list, as in Claude Code's
    const tools = s.strat.actions === 'tools' ? [...TOOL_DEFS, ...extraTools(s)].map((f) => f.name).filter((n) => allowed(s, n)) : []
    emit({ type: 'system', subtype: 'init', session_id, model, cwd: app.root, tools, mcp_servers: app.mcp.names.map((name) => ({ name, status: s.mcpCatalog?.has(name) ? 'connected' : 'pending' })), permissionMode: app.ui.permission, apiKeySource: 'none' })
  }

  let current = null // the message running now: { ctl }
  const turn = async (text, images = []) => {
    const t0 = Date.now()
    const spent = app.chat.usage?.cost ?? 0
    usage = { input_tokens: 0, output_tokens: 0 }
    byModel = {}
    requests = 0
    said = false
    current = { ctl: new AbortController() }
    app.signal = current.ctl.signal
    app.working = true // settings changed meanwhile: MCP servers and skills wait for the end of it
    let answer = ''
    let error = null
    try {
      const k = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
      const skill = k && app.skills.get(k[1])
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
    const result = { type: 'result', subtype, is_error: Boolean(error), result: error ?? answer, num_turns: Math.max(1, requests), duration_ms: Date.now() - t0, total_cost_usd: (app.chat.usage?.cost ?? 0) - spent, usage, modelUsage: Object.keys(byModel).length ? byModel : { [model]: { inputTokens: 0, outputTokens: 0 } }, session_id }
    if (out === 'stream-json') {
      if (!error && answer && !said) emit({ type: 'assistant', message: { role: 'assistant', model: `${s.client.provider}/${s.client.model}`, content: [{ type: 'text', text: answer }] }, parent_tool_use_id: null, session_id }) // guided mode
      emit(result)
    } else if (out === 'json') emit(result)
    else if (error) process.stderr.write(`heartcode: ${error}\n`)
    else process.stdout.write(answer.trim() + '\n')
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
