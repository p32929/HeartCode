// MCP servers (Model Context Protocol), JSON-RPC 2.0. Configured like Claude Code / Cursor, in
// ~/.heart/mcp.json and <project>/.heartcode/mcp.json:
//   { "mcpServers": { "name": { "command": "npx", "args": [...], "env": {...}, "description": "...", "disabled": false } } }
// or a remote one: { "url": "https://…/mcp", "headers": { … }, "type": "http" | "sse", "oauth": { "clientId": …, "scope": … } }
// A local server talks over its stdin/stdout, one message per line. A remote one over Streamable
// HTTP (or the older HTTP+SSE: "type": "sse", a URL ending in /sse, or when HTTP is refused), and
// signs in with OAuth when it asks (oauth.js). ${VAR} in a URL or header is the environment's VAR.
// A server starts the first time the model uses it, and stops when HeartCode exits.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOME, readJson, readConfig } from './config.js'
import { log } from './log.js'
import { savedToken, signIn } from './oauth.js'

// Built in; a config entry with the same name changes it, "disabled": true turns it off.
export const DEFAULT_SERVERS = {
  'chrome-devtools': {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    description: 'a Chrome browser: open pages, click, fill forms, read the console and network requests, take screenshots',
  },
}

// extra: more configs from the caller (--mcp-config: a file path or JSON text); strict: only those
// (no built-in or configured servers), like Claude Code's --strict-mcp-config.
export function loadServers(root, { extra = [], strict = false } = {}) {
  const merged = strict ? {} : structuredClone(DEFAULT_SERVERS) // yours (below) win on a name
  const own = strict ? [] : [path.join(HOME, 'mcp.json'), root && path.join(root, '.heartcode', 'mcp.json')].filter(Boolean).map((f) => readConfig(f, {}))
  const given = extra.map((c) => {
    const data = /^\s*\{/.test(c) ? JSON.parse(c) : readJson(path.resolve(c), null)
    if (!data) throw new Error(`can't read the MCP config ${c}`)
    return data
  })
  for (const data of [...own, ...given]) {
    for (const [name, cfg] of Object.entries(data.mcpServers ?? {})) merged[name] = { ...merged[name], ...cfg }
  }
  return Object.fromEntries(Object.entries(merged).filter(([, cfg]) => (cfg.command || cfg.url) && !cfg.disabled))
}

const expand = (v) => String(v).replace(/\$\{(\w+)\}/g, (m, k) => process.env[k] ?? '')

// A server's server-sent events: { event, data }.
async function* sseEvents(body) {
  const dec = new TextDecoder()
  let buf = ''
  let ev = { event: 'message', data: [] }
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line) {
        if (ev.data.length) yield { event: ev.event, data: ev.data.join('\n') }
        ev = { event: 'message', data: [] }
      } else if (!line.startsWith(':')) {
        const i = line.indexOf(':')
        const [field, value] = i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1).replace(/^ /, '')]
        if (field === 'event') ev.event = value
        else if (field === 'data') ev.data.push(value)
      }
    }
  }
}

class Server {
  constructor(name, cfg, root, hub) {
    Object.assign(this, { name, cfg, root, hub, next: 1, pending: new Map(), child: null, ready: null, tools: null })
  }

  get url() {
    return this.cfg.url && expand(this.cfg.url)
  }

  start(signal) {
    this.ready ??= (async () => {
      const init = () => this.request('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'heartcode', version: '0.1.0' } }, this.url ? 600_000 : 120_000, signal) // remote: time to sign in
      let r
      if (this.url) {
        const type = this.cfg.type ?? this.cfg.transport
        log('mcp', `connecting to ${this.name}: ${this.url}`)
        this.sse = type === 'sse' || (!type && /\/sse\/?$/.test(new URL(this.url).pathname))
        if (this.sse) {
          try {
            await this.#openSse(signal)
          } catch (e) {
            if (type || !(e.status >= 400 && e.status < 500)) throw e
            log('mcp', `${this.name}: no HTTP+SSE (${e.status}); trying Streamable HTTP`)
            this.sse = false // only guessed from the URL
            this.noSse = true
          }
        }
        try {
          r = await init()
        } catch (e) {
          if (type || this.sse || this.noSse || ![400, 404, 405].includes(e.status)) throw e
          log('mcp', `${this.name}: no Streamable HTTP (${e.status}); trying HTTP+SSE`)
          this.sse = true
          await this.#openSse(signal)
          r = await init()
        }
      } else r = await this.#spawn(init)
      this.protocol = r?.protocolVersion
      this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    })().catch((e) => {
      this.stop() // failed to start: the next use tries again
      throw e
    })
    return this.ready
  }

  async #spawn(init) {
    const { command, args = [], env = {} } = this.cfg
    log('mcp', `starting ${this.name}: ${command} ${args.join(' ')}`)
    const child = (this.child = spawn(command, args, { cwd: this.root ?? undefined, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })) // in the project, so a relative path in its config works
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) this.#receive(line)
      }
    })
    child.stderr.on('data', (d) => log('mcp', `${this.name} stderr: ${String(d).trim()}`))
    const gone = new Promise((_, reject) => {
      child.on('error', (e) => reject(new Error(`${this.name} could not start: ${e.message}`)))
      child.on('exit', (code) => {
        this.ready = null
        this.#failAll(new Error(`${this.name} stopped (exit ${code})`))
        reject(new Error(`${this.name} stopped (exit ${code})`))
      })
    })
    gone.catch(() => {})
    return Promise.race([init(), gone])
  }

  #failAll(err) {
    for (const { reject } of this.pending.values()) reject(err)
    this.pending.clear()
  }

  // An HTTP request to the server, signed in: a saved token goes with it; a 401 refreshes it, or
  // signs in (the browser opens) once.
  async #http(url, init, signal) {
    this.token ??= await savedToken(this.url)
    for (let attempt = 0; ; attempt++) {
      const headers = { ...Object.fromEntries(Object.entries(this.cfg.headers ?? {}).map(([k, v]) => [k, expand(v)])), ...init.headers, ...(this.token && { authorization: `Bearer ${this.token}` }) }
      const res = await fetch(url, { ...init, headers, signal: init.signal ?? signal })
      if (res.status === 401 && attempt === 0) {
        const how = res.headers.get('www-authenticate') ?? ''
        await res.body?.cancel()
        this.token = (this.token && (await savedToken(this.url, { force: true }))) || (await this.#signIn(how, signal))
        continue
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw Object.assign(new Error(`${this.name}: ${res.status} from ${url}${text ? `: ${text.slice(0, 200)}` : ''}`), { status: res.status })
      }
      return res
    }
  }

  #signIn(how, signal) {
    const open = this.hub.onSignIn
    if (!open) throw new Error(`${this.name} needs you to sign in: start heartcode and run /login_mcp ${this.name}`)
    return signIn(this.url, how, (link) => open(this.name, link), { signal, oauth: this.cfg.oauth })
  }

  // HTTP+SSE (the older transport): a stream of events from the server; the first names where
  // to POST messages, the rest are its messages.
  async #openSse(signal) {
    this.abort?.abort()
    this.abort = new AbortController()
    const res = await this.#http(this.url, { method: 'GET', headers: { accept: 'text/event-stream' }, signal: this.abort.signal }, signal)
    const events = sseEvents(res.body)
    for (;;) {
      const { value, done } = await events.next()
      if (done) throw new Error(`${this.name} closed its event stream before saying where to send messages`)
      if (value.event === 'endpoint') {
        this.endpoint = new URL(value.data, this.url).href
        break
      }
    }
    ;(async () => {
      for await (const ev of events) if (ev.event === 'message') this.#receive(ev.data)
    })()
      .catch((e) => log('mcp', `${this.name} event stream: ${e.message}`))
      .finally(() => {
        if (this.abort?.signal.aborted) return
        this.ready = null
        this.#failAll(new Error(`${this.name} closed the connection`))
      })
  }

  // Streamable HTTP: each message is a POST; the answer is JSON or a stream of events.
  // (HTTP+SSE: answers come on the event stream instead.)
  async #post(msg) {
    const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(this.session && { 'mcp-session-id': this.session }), ...(this.protocol && { 'mcp-protocol-version': this.protocol }) }
    const res = await this.#http(this.sse ? this.endpoint : this.url, { method: 'POST', headers, body: JSON.stringify(msg) })
    this.session = res.headers.get('mcp-session-id') ?? this.session
    const type = res.headers.get('content-type') ?? ''
    if (this.sse || res.status === 202 || !res.body) return void (await res.body?.cancel())
    if (type.includes('text/event-stream')) {
      for await (const ev of sseEvents(res.body)) if (ev.event === 'message') this.#receive(ev.data)
    } else {
      const text = await res.text()
      if (text.trim()) for (const m of [JSON.parse(text)].flat()) this.#receive(m)
    }
  }

  #send(msg) {
    if (!this.url) return this.child.stdin.write(JSON.stringify(msg) + '\n')
    this.#post(msg).catch((e) => {
      const p = this.pending.get(msg.id)
      if (!p) return log('mcp', `${this.name}: ${e.message}`)
      this.pending.delete(msg.id)
      p.reject(e)
    })
  }

  #receive(line) {
    let msg = line
    if (typeof line === 'string') {
      try {
        msg = JSON.parse(line)
      } catch {
        return log('mcp', `${this.name} sent a non-JSON line: ${line.slice(0, 200)}`)
      }
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error) && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      return msg.error ? reject(new Error(`${this.name}: ${msg.error.message ?? JSON.stringify(msg.error)}`)) : resolve(msg.result)
    }
    // requests from the server: answer the common ones, decline the rest
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'ping') return this.#send({ jsonrpc: '2.0', id: msg.id, result: {} })
      // the project folder: servers that read or write files (screenshots, traces) may use it
      if (msg.method === 'roots/list') return this.#send({ jsonrpc: '2.0', id: msg.id, result: { roots: this.root ? [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }] : [] } })
      return this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `HeartCode does not support ${msg.method}` } })
    }
  }

  request(method, params, timeout = 120_000, signal) {
    return new Promise((resolve, reject) => {
      const id = this.next++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name} did not answer ${method} within ${timeout / 1000}s`))
      }, timeout)
      const done = (fn) => (v) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        fn(v)
      }
      const onAbort = () => {
        this.pending.delete(id)
        done(reject)(Object.assign(new Error('stopped'), { name: 'AbortError' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async listTools(signal) {
    await this.start(signal)
    if (!this.tools) {
      this.tools = []
      let cursor
      do {
        const r = await this.request('tools/list', cursor ? { cursor } : {})
        this.tools.push(...(r.tools ?? []))
        cursor = r.nextCursor
      } while (cursor)
    }
    return this.tools
  }

  async call(tool, args, signal) {
    await this.start(signal)
    return this.request('tools/call', { name: tool, arguments: args ?? {} }, 300_000, signal)
  }

  stop() {
    if (this.url) {
      this.abort?.abort()
      Object.assign(this, { ready: null, session: null, endpoint: null })
      return
    }
    if (!this.child) return
    try {
      if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, 'SIGTERM')
      else this.child.kill()
    } catch {}
    this.child = null
    this.ready = null
  }
}

// All configured servers for a project; nothing runs until a server is first used.
// onSignIn(name, url): set by the screen, to show a remote server's sign-in page (none headless).
export class Mcp {
  constructor(root, opts) {
    this.servers = new Map(Object.entries(loadServers(root, opts)).map(([name, cfg]) => [name, new Server(name, cfg, root, this)]))
    this.onExit = () => this.stopAll()
    process.on('exit', this.onExit)
  }

  // Done with it (replaced after the config changed): servers stop, the exit hook goes.
  dispose() {
    this.stopAll()
    process.off('exit', this.onExit)
  }

  get names() {
    return [...this.servers.keys()]
  }

  get(name) {
    return this.servers.get(name)
  }

  stopAll() {
    for (const s of this.servers.values()) s.stop()
  }
}
