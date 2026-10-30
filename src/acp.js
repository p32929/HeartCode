// heartcode --acp: the Agent Client Protocol (https://agentclientprotocol.com), for editors that
// run coding agents (Zed, JetBrains, Neovim's CodeCompanion, …). JSON-RPC 2.0 over stdin/stdout,
// one message per line. The editor starts sessions (session/new, session/load) and sends prompts
// (session/prompt); HeartCode streams its answer, thinking, tool calls and todo list back
// (session/update) and asks the editor before edits and commands (session/request_permission), as
// the permission mode says (the editor's mode picker: session/set_mode).
// In Zed's settings.json: "agent_servers": { "HeartCode": { "command": "heartcode", "args": ["--acp"] } }
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { log } from './log.js'
import { clip, runningCall, failed as toolFailed } from './tools.js'
import { HeadlessUI } from './headless.js'
import { PERMISSIONS } from './ui.js'
import { loadChat } from './sessions.js'

const KIND = { read_file: 'read', list_files: 'search', search: 'search', edit_file: 'edit', write_file: 'edit', run_command: 'execute', web_fetch: 'fetch', web_search: 'fetch', todo: 'think', agent: 'think' }
const plain = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '')

// The screen for one session: everything goes to the editor as session/update.
class AcpUI extends HeadlessUI {
  constructor(conn, permission) {
    super({ permission })
    Object.assign(this, { conn, sessionId: null, calls: [] })
  }
  update(u) {
    this.conn.notify('session/update', { sessionId: this.sessionId, update: u })
  }
  response() {
    const chunk = (sessionUpdate) => (text) => text && this.update({ sessionUpdate, content: { type: 'text', text } })
    return { text: chunk('agent_message_chunk'), think: chunk('agent_thought_chunk'), end() {} }
  }
  setPermission(mode) {
    super.setPermission(mode)
    if (this.sessionId) this.update({ sessionUpdate: 'current_mode_update', currentModeId: mode })
  }
  async confirm(question, kind = 'edit') {
    if ((this.permission === 'all' || (this.permission === 'commands' && kind === 'edit') || (this.permission === 'plan' && kind === 'read'))) return true
    const toolCallId = runningCall.getStore() ?? this.calls[0] ?? `ask_${Date.now()}` // the call asking
    const r = await this.conn
      .request('session/request_permission', {
        sessionId: this.sessionId,
        toolCall: { toolCallId, title: plain(question) },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'all', name: 'Allow everything from now on', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      })
      .catch(() => null)
    const id = r?.outcome?.outcome === 'selected' ? r.outcome.optionId : null
    if (id === 'all') this.setPermission('all')
    return id === 'allow' || id === 'all'
  }
}

// JSON-RPC over stdio.
function connection(input, output) {
  let next = 1
  const pending = new Map()
  const send = (msg) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  return {
    send,
    pending,
    notify: (method, params) => send({ method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = `hc${next++}`
        pending.set(id, { resolve, reject })
        send({ id, method, params })
      }),
  }
}

// makeApp(root, ui, mcpServers) → an App (bin/heartcode.js) for a session's folder.
export async function runAcp({ makeApp, version, permission = 'ask', input = process.stdin, output = process.stdout }) {
  const conn = connection(input, output)
  const sessions = new Map() // id → { app, ui, ctl }
  const modes = (current) => ({ currentModeId: current, availableModes: PERMISSIONS.map(([id, description]) => ({ id, name: id, description })) })

  const open = async (cwd, mcpServers, chat) => {
    const ui = new AcpUI(conn, permission)
    const app = makeApp(path.resolve(cwd || process.cwd()), ui, toMcp(mcpServers))
    if (chat) app.setChat(chat)
    ui.sessionId = app.chat.id
    const s = await app.session()
    if (!s) throw Object.assign(new Error('no model set up: run heart settings to add a provider and choose a model'), { code: -32000 })
    s.onEvent = (e) => events(ui, s, e)
    sessions.set(ui.sessionId, { app, ui, ctl: null })
    return { app, ui }
  }

  const methods = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
      authMethods: [],
      agentInfo: { name: 'heartcode', title: 'HeartCode', version },
    }),
    'session/new': async ({ cwd, mcpServers }) => {
      const { ui } = await open(cwd, mcpServers)
      return { sessionId: ui.sessionId, modes: modes(ui.permission) }
    },
    'session/load': async ({ sessionId, cwd, mcpServers }) => {
      const chat = loadChat(sessionId)
      if (!chat) throw Object.assign(new Error(`no session ${sessionId}`), { code: -32002 })
      const { ui } = await open(cwd ?? chat.root, mcpServers, chat)
      for (const h of chat.history) {
        ui.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: h.task } })
        ui.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: h.answer } })
      }
      return { modes: modes(ui.permission) }
    },
    'session/set_mode': ({ sessionId, modeId }) => {
      const it = sessions.get(sessionId)
      if (!it) throw Object.assign(new Error(`no session ${sessionId}`), { code: -32002 })
      if (!PERMISSIONS.some(([p]) => p === modeId)) throw Object.assign(new Error(`no mode ${modeId}`), { code: -32602 })
      it.ui.setPermission(modeId)
      return {}
    },
    'session/cancel': ({ sessionId }) => sessions.get(sessionId)?.ctl?.abort(),
    'session/prompt': async ({ sessionId, prompt }) => {
      const it = sessions.get(sessionId)
      if (!it) throw Object.assign(new Error(`no session ${sessionId}`), { code: -32002 })
      const { app } = it
      const { text, images } = promptOf(prompt, app.root)
      it.ctl = new AbortController()
      app.signal = it.ctl.signal
      app.working = true // settings changed meanwhile: MCP servers and skills wait for the end of it
      try {
        const s = app.s ?? (await app.session()) // a model chosen again on the settings page
        if (!s) throw Object.assign(new Error('no model set up: run heart settings to add a provider and choose a model'), { code: -32000 })
        s.onEvent ??= (e) => events(it.ui, s, e)
        const k = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
        const skill = k && app.skills.get(k[1])
        await s.run(skill && skill.use !== 'model' ? await app.expandSkill(skill, k[2]) : text, it.ctl.signal, images)
        return { stopReason: 'end_turn' }
      } catch (e) {
        if (it.ctl.signal.aborted) return { stopReason: 'cancelled' }
        if (e.maxTurns) return { stopReason: 'max_turn_requests' }
        throw e
      } finally {
        app.working = false
        app.afterLine?.()
        it.ctl = null
        it.ui.calls = []
        app.save()
      }
    },
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  const running = new Set()
  for await (const line of rl) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      conn.send({ id: null, error: { code: -32700, message: 'parse error' } })
      continue
    }
    if (msg.method === undefined && msg.id !== undefined) {
      // an answer to one of HeartCode's requests
      const p = conn.pending.get(msg.id)
      conn.pending.delete(msg.id)
      msg.error ? p?.reject(new Error(msg.error.message)) : p?.resolve(msg.result)
      continue
    }
    const fn = methods[msg.method]
    log('acp', `← ${msg.method}`, clip(JSON.stringify(msg.params ?? {}), 2000))
    const job = (async () => {
      if (!fn) {
        if (msg.id !== undefined) conn.send({ id: msg.id, error: { code: -32601, message: `HeartCode does not support ${msg.method}` } })
        return
      }
      try {
        const result = await fn(msg.params ?? {})
        if (msg.id !== undefined) conn.send({ id: msg.id, result: result ?? null })
      } catch (e) {
        log('acp', `${msg.method} failed: ${e.stack}`)
        if (msg.id !== undefined) conn.send({ id: msg.id, error: { code: e.code ?? -32603, message: e.message } })
      }
    })()
    running.add(job)
    job.finally(() => running.delete(job))
  }
  await Promise.all(running)
  return 0
}

// Tool calls and results → the editor's tool call list; the todo list → its plan.
function events(ui, s, e) {
  if (e.type === 'assistant') {
    for (const t of e.toolCalls) {
      let args = {}
      try {
        args = JSON.parse(t.function.arguments || '{}')
      } catch {}
      const name = t.function.name
      const what = args.command ?? args.path ?? args.url ?? args.query ?? args.description ?? (args.server ? `${args.server} · ${args.tool}` : '')
      ui.calls.push(t.id)
      ui.update({
        sessionUpdate: 'tool_call',
        toolCallId: t.id,
        title: clip(`${e.helper ? `${e.helper} › ` : ''}${name}${what ? ` ${what}` : ''}`, 120), // a helper's steps: named
        kind: KIND[name] ?? 'other',
        status: 'pending',
        rawInput: args,
        ...(args.path && { locations: [{ path: path.resolve(s.root, String(args.path)) }] }),
      })
    }
  } else if (e.type === 'tool') {
    ui.calls = ui.calls.filter((id) => id !== e.id)
    const failed = toolFailed(e.output)
    ui.update({ sessionUpdate: 'tool_call_update', toolCallId: e.id, status: failed ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: clip(plain(e.output), 4000) } }] })
    if (e.name === 'todo') ui.update({ sessionUpdate: 'plan', entries: (s.chat.todos ?? []).map((t) => ({ content: t.content, priority: 'medium', status: t.status })) })
  }
}

// The prompt's content blocks: text, images, files (linked or with their text).
export function promptOf(blocks, root) {
  const text = []
  const images = []
  for (const b of [blocks].flat()) {
    if (!b) continue
    if (b.type === 'text') text.push(b.text)
    else if (b.type === 'image' && b.data) images.push(`data:${b.mimeType ?? 'image/png'};base64,${b.data}`)
    else if (b.type === 'resource_link') text.push(rel(b.uri, root))
    else if (b.type === 'resource' && b.resource) {
      const r = b.resource
      text.push(r.text !== undefined ? `${rel(r.uri, root)}:\n\`\`\`\n${r.text}\n\`\`\`` : rel(r.uri, root))
    }
  }
  return { text: text.join('\n\n'), images }
}

const rel = (uri, root) => {
  try {
    return uri?.startsWith('file:') ? path.relative(root, fileURLToPath(uri)) || '.' : String(uri)
  } catch {
    return String(uri)
  }
}

// The editor's MCP servers → HeartCode's config ({ name, command, args, env: [{name, value}] } or { type: http|sse, url, headers }).
function toMcp(list = []) {
  const kv = (xs) => Object.fromEntries((xs ?? []).map((x) => [x.name, x.value]))
  const servers = Object.fromEntries(
    list.map((m) => [m.name, m.command ? { command: m.command, args: m.args ?? [], env: kv(m.env) } : { url: m.url, type: m.type === 'sse' ? 'sse' : 'http', headers: kv(m.headers) }]),
  )
  return list.length ? JSON.stringify({ mcpServers: servers }) : null
}

