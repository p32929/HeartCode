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
import { clip, TOOL_DEFS, extraTools } from './tools.js'
import { allowed } from './agent.js'

// Claude Code's tool names → HeartCode's (for --allowedTools / --disallowedTools).
const CLAUDE_TOOLS = { Read: 'read_file', Grep: 'search', Glob: 'list_files', LS: 'list_files', Edit: 'edit_file', MultiEdit: 'edit_file', Write: 'write_file', NotebookEdit: 'edit_file', Bash: 'run_command' }
export function toolNames(list) {
  const names = list.flatMap((x) => String(x).split(/[,\s]+/)).filter(Boolean).map((t) => t.replace(/\(.*$/, '')) // ponytail: "Bash(git:*)" allows every command, not just git
  return new Set(names.map((t) => (t.startsWith('mcp__') ? 'mcp' : (CLAUDE_TOOLS[t] ?? t))))
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
    const error = 'no model set up: add a provider and choose a model (heart settings), or pass --base-url and --model'
    if (out === 'text') process.stderr.write(`heartcode: ${error}\n`)
    else emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: error, num_turns: 0, session_id: app.chat.id })
    return 1
  }
  s.appendSystem = opts.appendSystem || undefined
  const session_id = app.chat.id
  const model = `${app.cfg.provider}/${s.client.model}`

  // usage and request count, over everything this message sends (tool loop, compaction, memory)
  let usage = { input_tokens: 0, output_tokens: 0 }
  let requests = 0
  const chat = s.client.chat.bind(s.client)
  s.client.chat = async (...a) => {
    const r = await chat(...a)
    requests++
    usage.input_tokens += r.usage?.prompt_tokens ?? 0
    usage.output_tokens += r.usage?.completion_tokens ?? 0
    return r
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
        if (e.content) said = true
        if (content.length) emit({ type: 'assistant', message: { role: 'assistant', model, content }, session_id })
      } else if (e.type === 'tool') {
        emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: e.id, content: e.output, is_error: e.output.startsWith('error') }] }, session_id })
      }
    }
    const tools = s.strat.actions === 'tools' ? [...TOOL_DEFS, ...extraTools(s)].map((f) => f.name).filter((n) => allowed(s, n)) : []
    emit({ type: 'system', subtype: 'init', session_id, model, cwd: app.root, tools, mcp_servers: app.mcp.names.map((name) => ({ name, status: 'pending' })), permissionMode: app.ui.permission, apiKeySource: 'none' })
  }

  let current = null // the message running now: { ctl }
  const turn = async (text, images = []) => {
    const t0 = Date.now()
    const spent = app.chat.usage?.cost ?? 0
    usage = { input_tokens: 0, output_tokens: 0 }
    requests = 0
    said = false
    current = { ctl: new AbortController() }
    app.signal = current.ctl.signal
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
    }
    const subtype = current.maxTurns ? 'error_max_turns' : error ? 'error_during_execution' : 'success' // as Claude Code names them
    current = null
    const result = { type: 'result', subtype, is_error: Boolean(error), result: error ?? answer, num_turns: Math.max(1, requests), duration_ms: Date.now() - t0, total_cost_usd: (app.chat.usage?.cost ?? 0) - spent, usage, modelUsage: { [model]: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }, session_id }
    if (out === 'stream-json') {
      if (!error && answer && !said) emit({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: answer }] }, session_id }) // guided mode
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
      if (msg.request?.subtype === 'interrupt') current?.ctl.abort()
      emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } })
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
