// Language servers, chosen by the model: it works out which server a language needs (from the
// project, the web), checks it's installed (find_command), and uses it with the lsp tool, naming
// the command: definitions, references, hover, errors. HeartCode starts each server once per
// project and command, and keeps it until it exits. A server the model used for a kind of file is
// remembered for the project (~/.heart/lsp.json): after each edit of such a file its errors go
// back to the model with the edit's result. The settings page (General → Features) turns that off.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { log } from './log.js'
import { HOME, readJson, writeJson } from './config.js'

const SERVERS_FILE = path.join(HOME, 'lsp.json') // { [project root]: { [".ts"]: { server, language } } }

// Where a command is: the project's node_modules/.bin, else PATH (with Windows' extensions). null: not installed.
export function findCommand(root, cmd) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : ['']
  const runnable = (p) => {
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) return false
      if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (cmd.includes('/') || cmd.includes(path.sep)) {
    const abs = path.resolve(root, cmd)
    return runnable(abs) ? abs : null
  }
  for (const d of [path.join(root, 'node_modules', '.bin'), ...(process.env.PATH ?? '').split(path.delimiter)]) {
    if (!d) continue
    for (const e of exts) if (runnable(path.join(d, cmd + e))) return path.join(d, cmd + e)
  }
  return null
}

// "typescript-language-server --stdio" → its words ("…" and '…' keep spaces)
const words = (cmd) => [...String(cmd).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])

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
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { versionSupport: true },
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['plaintext', 'markdown'] },
        },
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

  // The file as it is on disk, opened (or brought up to date) in the server.
  async open(abs) {
    await this.ready
    const uri = pathToFileURL(abs).href
    const text = fs.readFileSync(abs, 'utf8')
    const version = (this.docs.get(uri) ?? 0) + 1
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.language, version, text } })
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    this.docs.set(uri, version)
    return { uri, text }
  }

  // The file's errors after this change: waits for the server's report on it, then for it to go
  // quiet (servers often send a fast report, then a full one).
  async check(abs, text, wait) {
    await this.ready
    const uri = pathToFileURL(abs).href
    const since = Date.now()
    const version = (this.docs.get(uri) ?? 0) + 1
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.language, version, text } })
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

const running = new Map() // root + command → Server
process.on('exit', () => {
  for (const sv of running.values()) sv.stop()
})

// The server for this command in this project: running already, or started now. A string: why not.
function serverFor(root, server, language) {
  const argv = words(server)
  if (!argv.length) return 'no command given'
  const key = `${root}\0${argv.join(' ')}`
  const had = running.get(key)
  if (had && !had.dead) return had
  const bin = findCommand(root, argv[0])
  if (!bin) return `${argv[0]} is not installed`
  const sv = new Server({ name: argv[0], language }, [bin, ...argv.slice(1)], root)
  log('lsp', `started ${bin} ${argv.slice(1).join(' ')} (${language})`)
  running.set(key, sv)
  return sv
}

// The servers this project's kinds of file use: { ".ts": { server, language } }
export const knownServers = (root) => readJson(SERVERS_FILE, {})[root] ?? {}
function remember(root, ext, server, language) {
  const all = readJson(SERVERS_FILE, {})
  const mine = (all[root] ??= {})
  if (mine[ext]?.server === server && mine[ext]?.language === language) return
  mine[ext] = { server, language }
  writeJson(SERVERS_FILE, all)
}

// For the system prompt: "typescript-language-server --stdio (typescript) for .ts, .tsx"
export function serversNote(root) {
  const by = new Map()
  for (const [ext, { server, language }] of Object.entries(knownServers(root))) {
    const k = `${server} (${language})`
    by.set(k, [...(by.get(k) ?? []), ext])
  }
  return [...by].map(([k, exts]) => `${k} for ${exts.join(', ')}`).join('; ')
}

// Waits for a promise, at most ms; the server is unref'd, so this keeps HeartCode up meanwhile.
async function within(p, ms, what) {
  let t
  const keep = setInterval(() => {}, 1000)
  try {
    return await Promise.race([p, new Promise((_, reject) => (t = setTimeout(() => reject(new Error(`no answer to ${what} in ${ms / 1000} seconds`)), ms)))])
  } finally {
    clearTimeout(t)
    clearInterval(keep)
  }
}

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }
const at = (root, uri, range) => {
  const abs = uri.startsWith('file:') ? fileURLToPath(uri) : uri
  const rel = path.relative(root, abs)
  let text = ''
  try {
    text = fs.readFileSync(abs, 'utf8').split('\n')[range.start.line]?.trim().slice(0, 160) ?? ''
  } catch {}
  return `${rel.startsWith('..') ? abs : rel}:${range.start.line + 1}:${range.start.character + 1}${text ? `: ${text}` : ''}`
}
const hoverText = (c) => (Array.isArray(c) ? c.map(hoverText).join('\n') : typeof c === 'string' ? c : (c?.value ?? ''))

// The lsp tool: { server: the command, language: its language id, action, file, line, column | name }
export async function lspTool(s, args, signal) {
  const { root } = s
  const server = String(args.server ?? '').trim()
  const language = String(args.language ?? '').trim()
  const action = String(args.action ?? '')
  if (!server || !language) return 'error: lsp needs "server" (the command that starts it, like "typescript-language-server --stdio") and "language" (its language id, like "typescript")'
  if (!['definition', 'references', 'hover', 'errors'].includes(action)) return 'error: "action" is one of definition, references, hover, errors'
  if (!args.file) return 'error: lsp needs "file"'
  const abs = path.resolve(root, String(args.file))
  if (!fs.existsSync(abs)) return `error: no file ${args.file}`
  const sv = serverFor(root, server, language)
  if (typeof sv === 'string') return `error: ${sv}. Check with find_command; install it, or use search and read_file instead.`
  const first = !sv.used
  const ms = first ? 60_000 : 20_000 // the first request waits for the server to start and index
  try {
    if (action === 'errors') {
      const list = await within(sv.check(abs, fs.readFileSync(abs, 'utf8'), first ? 30_000 : 6000), ms, 'the errors check')
      sv.used = true
      remember(root, path.extname(abs), server, language)
      if (!list) return `${server} sent no report on ${args.file} in time.`
      if (!list.length) return `${server}: no problems in ${args.file}.`
      return list.slice(0, 30).map((d) => `${at(root, pathToFileURL(abs).href, d.range)} — ${SEVERITY[d.severity ?? 1]}: ${String(d.message).split('\n')[0]}`).join('\n') + (list.length > 30 ? `\n… ${list.length - 30} more` : '')
    }
    const { uri, text } = await within(sv.open(abs), ms, 'opening the file')
    const lines = text.split('\n')
    const line = Math.max(1, Math.min(Number(args.line) || 1, lines.length)) - 1
    let col = Number(args.column) > 0 ? Number(args.column) - 1 : -1
    if (col < 0 && args.name) {
      const m = new RegExp(`\\b${String(args.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(lines[line])
      if (!m) return `error: "${args.name}" isn't on line ${line + 1} of ${args.file}: ${lines[line].trim().slice(0, 120)}`
      col = m.index
    }
    if (col < 0) col = Math.max(0, lines[line].search(/\S/))
    const pos = { textDocument: { uri }, position: { line, character: col } }
    const method = { definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover' }[action]
    const res = await within(sv.request(method, action === 'references' ? { ...pos, context: { includeDeclaration: true } } : pos), ms, action)
    sv.used = true
    remember(root, path.extname(abs), server, language)
    if (action === 'hover') return hoverText(res?.contents).trim().slice(0, 3000) || 'nothing to show there'
    const locs = (Array.isArray(res) ? res : res ? [res] : []).map((l) => ({ uri: l.uri ?? l.targetUri, range: l.range ?? l.targetSelectionRange ?? l.targetRange }))
    if (!locs.length) return `no ${action === 'definition' ? 'definition' : 'references'} found for line ${line + 1}, column ${col + 1} (${lines[line].trim().slice(0, 80)})`
    return locs.slice(0, 50).map((l) => at(root, l.uri, l.range)).join('\n') + (locs.length > 50 ? `\n… ${locs.length - 50} more` : '')
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
    log('lsp', `${server}: ${e.message}`)
    return `error: ${server}: ${e.message}. Use search and read_file instead, or another server.`
  }
}

// After an edit: what's wrong in the file now, as a note for the model, or '' (no server used for
// this kind of file in the project, nothing wrong, or no report in time). Errors only, unless there
// are none: the last check's errors are fixed is said too.
export async function diagnose(s, rel, text) {
  const known = knownServers(s.root)[path.extname(rel)]
  if (!known) return ''
  const server = serverFor(s.root, known.server, known.language)
  if (typeof server === 'string') return ''
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
