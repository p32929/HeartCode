// After HeartCode writes a file, a language server for it (when one is installed) says what is now
// wrong, and the errors go back to the model with the edit's result: it fixes a type error right
// away instead of finding it at the end, or never.
// Servers, each found on PATH or in the project's node_modules/.bin: typescript-language-server,
// gopls, pyright (or basedpyright), rust-analyzer, clangd, dart. One per language and project,
// started at the first edit and kept until HeartCode exits. The settings page (General → Features) turns it off.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { log } from './log.js'

const SERVERS = [
  { name: 'typescript', ext: /\.(m?[jt]sx?|cjs|cts)$/, cmds: [['typescript-language-server', '--stdio']], id: (f) => (/\.[cm]?tsx?$/.test(f) ? (f.endsWith('x') ? 'typescriptreact' : 'typescript') : f.endsWith('x') ? 'javascriptreact' : 'javascript') },
  { name: 'go', ext: /\.go$/, cmds: [['gopls']], id: () => 'go' },
  { name: 'python', ext: /\.pyi?$/, cmds: [['pyright-langserver', '--stdio'], ['basedpyright-langserver', '--stdio']], id: () => 'python' },
  { name: 'rust', ext: /\.rs$/, cmds: [['rust-analyzer']], id: () => 'rust' },
  { name: 'c', ext: /\.(c|cc|cpp|cxx|h|hh|hpp)$/, cmds: [['clangd']], id: (f) => (/\.(c|h)$/.test(f) ? 'c' : 'cpp') },
  { name: 'dart', ext: /\.dart$/, cmds: [['dart', 'language-server', '--client-id', 'heartcode']], id: () => 'dart' },
]

// Extra servers for tests or the user: { name, ext, cmds, id }; tried before the built-in ones.
export const extraServers = []

function find(root, cmd) {
  const local = path.join(root, 'node_modules', '.bin', cmd)
  if (fs.existsSync(local)) return local
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) if (d && fs.existsSync(path.join(d, cmd))) return path.join(d, cmd)
  return null
}

class Server {
  constructor(spec, argv, root) {
    Object.assign(this, { spec, root, next: 1, pending: new Map(), docs: new Map(), diags: new Map(), waiters: new Set(), dead: false })
    this.child = spawn(argv[0], argv.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
    let buf = Buffer.alloc(0)
    this.child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        const head = buf.indexOf('\r\n\r\n')
        if (head === -1) return
        const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, head).toString())?.[1])
        if (!(len >= 0)) return this.#die('a message without Content-Length')
        if (buf.length < head + 4 + len) return
        const body = buf.subarray(head + 4, head + 4 + len).toString()
        buf = buf.subarray(head + 4 + len)
        try {
          this.#receive(JSON.parse(body))
        } catch (e) {
          log('lsp', `${spec.name}: unreadable message: ${e.message}`)
        }
      }
    })
    this.child.on('error', (e) => this.#die(e.message))
    this.child.on('exit', (code) => this.#die(`exited (${code})`))
    this.child.stdin.on('error', () => {})
    // it never keeps HeartCode running: stopped on exit (below), waited on only while checking
    this.child.unref()
    this.child.stdin.unref?.()
    this.child.stdout.unref?.()
    const uri = pathToFileURL(root).href
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      rootPath: root,
      workspaceFolders: [{ uri, name: path.basename(root) }],
      capabilities: {
        textDocument: { synchronization: { didSave: true }, publishDiagnostics: { versionSupport: true } },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
    }).then(() => this.notify('initialized', {}))
  }

  #die(why) {
    if (this.dead) return
    this.dead = true
    log('lsp', `${this.spec.name} stopped: ${why}`)
    for (const { reject } of this.pending.values()) reject(new Error(`${this.spec.name} language server ${why}`))
    this.pending.clear()
    for (const w of this.waiters) w()
  }

  #send(msg) {
    if (this.dead) return
    const body = JSON.stringify({ jsonrpc: '2.0', ...msg })
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  request(method, params) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error(`${this.spec.name} language server is not running`))
      this.pending.set(id, { resolve, reject })
      this.#send({ id, method, params })
    })
  }

  notify(method, params) {
    this.#send({ method, params })
  }

  #receive(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      return msg.error ? p?.reject(new Error(msg.error.message)) : p?.resolve(msg.result)
    }
    if (msg.id !== undefined) {
      // the server asks something: its settings (none given: its defaults), progress tokens, registrations
      const result = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => null) : msg.method === 'workspace/workspaceFolders' ? [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }] : null
      return this.#send({ id: msg.id, result })
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      this.diags.set(msg.params.uri, { at: Date.now(), list: msg.params.diagnostics ?? [] })
      for (const w of this.waiters) w()
    }
  }

  // The file's errors after this change: waits for the server's report on it, then for it to go
  // quiet (servers often send a fast report, then a full one).
  async check(abs, text, wait) {
    await this.ready
    const uri = pathToFileURL(abs).href
    const since = Date.now()
    const version = (this.docs.get(uri) ?? 0) + 1
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.id(abs), version, text } })
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    this.notify('textDocument/didSave', { textDocument: { uri }, text })
    this.docs.set(uri, version)
    const fresh = () => (this.diags.get(uri)?.at ?? 0) >= since
    const end = Date.now() + wait
    while (!this.dead) {
      const until = Math.min(end, fresh() ? this.diags.get(uri).at + 700 : end) // 0.7s without a newer report
      if (Date.now() >= until) break
      await new Promise((resolve) => {
        const w = () => (this.waiters.delete(w), clearTimeout(t), resolve())
        const t = setTimeout(w, until - Date.now())
        this.waiters.add(w)
      })
    }
    return fresh() ? this.diags.get(uri).list : null
  }

  stop() {
    if (this.dead) return
    this.dead = true
    try {
      if (process.platform !== 'win32') process.kill(-this.child.pid, 'SIGTERM')
      else this.child.kill()
    } catch {}
  }
}

const running = new Map() // root + server name → Server, or null (none installed / it died)
process.on('exit', () => {
  for (const s of running.values()) s?.stop()
})

function serverFor(root, rel) {
  const spec = [...extraServers, ...SERVERS].find((x) => x.ext.test(rel))
  if (!spec) return null
  const key = `${root}\0${spec.name}`
  if (!running.has(key)) {
    let server = null
    for (const [cmd, ...args] of spec.cmds) {
      const bin = find(root, cmd)
      if (!bin) continue
      server = new Server(spec, [bin, ...args], root)
      log('lsp', `started ${spec.name}: ${bin} ${args.join(' ')}`)
      break
    }
    running.set(key, server)
  }
  const s = running.get(key)
  return s && !s.dead ? s : null
}

const SEVERITY = { 1: 'error', 2: 'warning' }

// What's wrong in the file now, as a note for the model, or '' (no server, nothing wrong, or no
// report in time). Errors only, unless there are none: the last check's errors are fixed is said too.
export async function diagnose(s, rel, text) {
  const server = serverFor(s.root, rel)
  if (!server) return ''
  const abs = path.join(s.root, rel)
  let list
  const keep = setInterval(() => {}, 1000) // the server is unref'd: this keeps HeartCode up while it answers
  try {
    list = await server.check(abs, text, server.checked ? 6000 : 30_000) // the first check waits for the server to start
    server.checked = true
  } catch (e) {
    log('lsp', `${rel}: ${e.message}`)
    return ''
  } finally {
    clearInterval(keep)
  }
  if (!list) return ''
  const errors = list.filter((d) => (d.severity ?? 1) === 1)
  const had = (s.lspErrors ??= new Map()).get(rel)
  s.lspErrors.set(rel, errors.length)
  log('lsp', `${rel}: ${errors.length} error(s)`, errors.slice(0, 20))
  if (!errors.length) return had ? `The ${server.spec.name} language server reports no errors in ${rel} now.` : ''
  const lines = errors.slice(0, 10).map((d) => `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${SEVERITY[d.severity ?? 1]}: ${String(d.message).split('\n')[0]}${d.source ? ` (${d.source})` : ''}`)
  return `The ${server.spec.name} language server reports ${errors.length} error${errors.length > 1 ? 's' : ''} in ${rel} now:\n${lines.join('\n')}${errors.length > 10 ? `\n… ${errors.length - 10} more` : ''}`
}
