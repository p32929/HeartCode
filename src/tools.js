import fs from 'node:fs'
import { log } from './log.js'
import { slug } from './memory.js'
import { fillArgs } from './skills.js'
import { prompt } from './prompts.js'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { applyEdit } from './edit.js'
import { readJson } from './config.js'
import { c, diffLines, renderDiff } from './ui.js'
import { webFetch, webSearch } from './web.js'
import { runHooks } from './hooks.js'
import { parsePatch, applyChunks } from './patch.js'
import { formatFile } from './format.js'
import { diagnose } from './lsp.js'

const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', 'venv', '__pycache__', 'target', '.cache', '.DS_Store'])

export const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s))
export const tail = (s, n) => (s.length > n ? '…' + s.slice(-n) : s)

// Tool output too long for the conversation is saved here (one folder per chat), where read_file
// and search can read it although it's outside the project.
export const OUTPUTS = path.join(os.tmpdir(), 'heartcode-outputs')
export function saveOutput(chatId, name, text) {
  try {
    const dir = path.join(OUTPUTS, String(chatId ?? 'chat'))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now().toString(36)}-${String(name).replace(/[^\w-]/g, '_').slice(0, 60)}.txt`)
    fs.writeFileSync(file, text)
    return file
  } catch (e) {
    log('tool', `could not save the output: ${e.message}`)
    return ''
  }
}

export function resolveIn(root, p) {
  const clean = String(p ?? '').trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!clean) throw new Error('no path given')
  let abs = path.resolve(root, clean)
  if (abs.startsWith(OUTPUTS + path.sep)) return abs // a saved tool output
  // "num.js:" or "num.js," from a sloppy model: the file without the stray mark, if that one exists
  const trimmed = path.resolve(root, clean.replace(/[:;,.]+$/, ''))
  if (trimmed !== abs && !fs.existsSync(abs) && fs.existsSync(trimmed)) abs = trimmed
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`${clean} is outside the project; use a path relative to the project folder`)
  return abs
}

// Project files a message names (by path, or by file name like "num.js"), most specific first.
export function namedFiles(text, files) {
  const t = text.toLowerCase()
  return files.filter((f) => {
    const base = path.basename(f).toLowerCase()
    return t.includes(f.toLowerCase()) || (base.includes('.') && new RegExp(`(^|[^\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(t))
  })
}

// git-aware file list (respects .gitignore), falling back to a plain walk.
export function listFiles(root, limit = 2000) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 << 20,
    })
    return out
      .split('\0')
      .filter((f) => f && fs.existsSync(path.join(root, f)))
      .sort()
      .slice(0, limit)
  } catch {}
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= limit) return
      if (IGNORE.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) files.push(path.relative(root, p))
    }
  }
  walk(root)
  return files.sort()
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0)
export const numberLines = (lines, from = 1) => lines.map((l, i) => `${from + i}| ${l}`).join('\n')

export function readFileTool(root, p, start, end, maxLines = 400) {
  const abs = resolveIn(root, p)
  const rel = path.relative(root, abs)
  if (!fs.existsSync(abs)) {
    const base = path.basename(abs)
    const near = listFiles(root).filter((f) => path.basename(f) === base)
    return `error: ${rel} does not exist${near.length ? `. Did you mean: ${near.slice(0, 5).join(', ')}` : ''}`
  }
  if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).join('\n') || '(empty directory)'
  const buf = fs.readFileSync(abs)
  if (isBinary(buf)) return `${rel} is a binary file (${buf.length} bytes)`
  const lines = buf.toString('utf8').split('\n')
  const s = Math.max(1, Number(start) || 1)
  let e = Math.min(lines.length, Number(end) || lines.length, s + maxLines - 1)
  // long lines: stop at a line before the result would be cut (12k characters), and say where
  for (let i = s - 1, n = 0; i < e; i++) if ((n += lines[i].length + 8) > 11_000) e = Math.max(s, i)
  const more = e < lines.length ? `\n… (${lines.length} lines total; read with start_line=${e + 1} for more)` : ''
  return numberLines(lines.slice(s - 1, e), s) + more
}

// An image file: shown to a model that can see images (after the tool results, as MCP screenshots
// are); for one that can't, where to send it.
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
function readImage(s, p) {
  const abs = resolveIn(s.root, p)
  const rel = path.relative(s.root, abs) || p
  if (!fs.existsSync(abs)) return readFileTool(s.root, p)
  if (s.strat?.vision) {
    const ext = path.extname(abs).slice(1).toLowerCase()
    ;(s.pendingImages ??= []).push(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(abs).toString('base64')}`)
    return `${rel}: the image is attached in the next message`
  }
  const seer = s.team?.().find((t) => t.images)
  return `${rel} is an image, and you can't see images.${seer ? ` Ask a model that can: the agent tool with model "${seer.provider} ${seer.model}", and the image's path in the prompt.` : ''}`
}

export function searchFiles(root, query, sub = '', limit = 50) {
  const ci = query === query.toLowerCase()
  let re
  try {
    re = new RegExp(query, ci ? 'i' : '')
  } catch {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : '')
  }
  const abs = sub ? resolveIn(root, sub) : ''
  const saved = abs.startsWith(OUTPUTS + path.sep) // a tool output saved outside the project
  const prefix = sub && !saved ? path.relative(root, abs) : ''
  const hits = []
  for (const f of saved ? [abs] : listFiles(root)) {
    if (prefix && f !== prefix && !f.startsWith(prefix + '/')) continue
    let buf
    try {
      buf = fs.readFileSync(path.resolve(root, f))
    } catch {
      continue
    }
    if (buf.length > 1 << 20 || isBinary(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      hits.push(`${f}:${i + 1}: ${clip(lines[i].trim(), 200)}`)
      if (hits.length >= limit) return hits.join('\n') + `\n… (stopped at ${limit} matches)`
    }
  }
  return hits.join('\n') || `no matches for ${query}`
}

// Runs a shell command in its own process group. The command is over when its shell exits, even
// if something it started in the background (`server &`) still holds the output open; whatever is
// left in the group is then stopped, so nothing hangs or outlives HeartCode. Esc (signal) and the
// timeout stop the whole group too.
// stdin: text for its input; env: added variables; split: stderr returned apart (hooks).
export function runCommand(root, cmd, { signal, timeout = 120_000, stdin, env, split = false } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const group = process.platform !== 'win32'
    const child = spawn(cmd, {
      cwd: root,
      shell: true,
      detached: group,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    })
    if (stdin !== undefined) {
      child.stdin.on('error', () => {}) // a command that doesn't read its input
      child.stdin.end(stdin)
    }
    const kill = (sig) => {
      try {
        if (group) process.kill(-child.pid, sig)
        else child.kill(sig)
        return true
      } catch {
        return false // nothing left
      }
    }
    const finish = (code, note = '') => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (kill(0) && code !== 'interrupted' && code !== 'timeout') {
        note += '\n(Processes this command left running in the background were stopped: run_command cannot keep a server running.)'
      }
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 2000).unref()
      child.stdout.destroy()
      child.stderr.destroy()
      const plain = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      resolve({ code, output: plain(out) + note, ...(split && { stderr: plain(err) }) })
    }
    const add = (d) => {
      out += d
      if (out.length > 200_000) out = out.slice(-100_000)
    }
    const addErr = (d) => {
      err += d
      if (err.length > 200_000) err = err.slice(-100_000)
    }
    const stop = () => finish('interrupted', '\n(stopped by the user)')
    const timer = setTimeout(() => finish('timeout', `\n(stopped after ${timeout / 1000}s)`), timeout)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.stdout.on('data', add)
    child.stderr.on('data', split ? addErr : add)
    child.on('error', (e) => {
      add(`\n${e.message}`)
      finish('error')
    })
    child.on('exit', (code, sig) => setTimeout(() => finish(code ?? sig), 150)) // last output, then done
    child.on('close', (code, sig) => finish(code ?? sig))
  })
}

export function suggestCommands(root) {
  const out = []
  const has = (f) => fs.existsSync(path.join(root, f))
  const pkg = readJson(path.join(root, 'package.json'), null)
  for (const k of Object.keys(pkg?.scripts ?? {})) out.push(k === 'test' || k === 'start' ? `npm ${k}` : `npm run ${k}`)
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) out.push('python -m pytest')
  if (has('go.mod')) out.push('go test ./...', 'go build ./...')
  if (has('Cargo.toml')) out.push('cargo test', 'cargo build')
  if (has('Makefile')) out.push('make')
  return out.slice(0, 9)
}

const PLACEHOLDER = /(\.\.\.|…)\s*(rest|existing|remaining|unchanged|other)|rest of (the )?(code|file)|existing code (here|unchanged)/i

// Shows the diff, asks the user, writes (next = null: deletes the file). Shared by both agent modes.
export async function proposeWrite(s, rel, old, next) {
  if (old === next) return { status: 'unchanged' }
  if (s.ui.permission === 'plan') return { status: 'rejected', feedback: prompt('agent/plan-refused') } // both modes write through here
  const ops = diffLines(old, next ?? '')
  s.ui.print(renderDiff(ops, rel))
  if (next !== null && PLACEHOLDER.test(next) && !PLACEHOLDER.test(old)) s.ui.warn('the new content seems to contain a placeholder like "rest of code unchanged"')
  const ok = await s.ui.confirm(next === null ? `Delete ${rel}?` : old ? `Apply this change to ${rel}?` : `Create ${rel}?`)
  log('write', rel, ok === true ? 'approved' : `rejected ${typeof ok === 'string' ? ok : ''}`)
  if (ok !== true) return { status: 'rejected', feedback: typeof ok === 'string' ? ok : '' }
  const abs = resolveIn(s.root, rel)
  s.track?.(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null) // for /rewind
  if (next === null) fs.rmSync(abs, { force: true })
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, next)
  }
  const add = ops.filter(([t]) => t === '+').length
  const del = ops.filter(([t]) => t === '-').length
  const res = { status: 'applied', summary: `+${add} -${del}`, diff: renderDiff(ops, rel, false, 2, 60), ops, text: next }
  if (next !== null) await afterWrite(s, rel, old, res)
  return res
}

// After a write: the project's formatter (format.js), then a language server's errors (lsp.js).
// The model is told both: its next edit must match the formatted text, and errors are its to fix.
async function afterWrite(s, rel, old, res) {
  const notes = []
  if (!s.noFormat) {
    const f = await formatFile(s.root, rel).catch((e) => (log('format', `${rel}: ${e.message}`), null))
    if (f) {
      res.text = f.text
      res.ops = diffLines(old, f.text)
      res.diff = renderDiff(res.ops, rel, false, 2, 60) // guided mode shows the model this
      res.formatted = true
      s.ui.result(`formatted with ${f.by}`)
      notes.push(`${f.by} formatted ${rel} after the change (the excerpt below is the formatted text).`)
    }
  }
  if (!s.noLsp) {
    s.ui.spinner(`checking ${rel}`)
    const problems = await diagnose(s, rel, res.text)
    s.ui.stopSpin()
    if (problems) {
      const n = /reports (\d+) error/.exec(problems)?.[1]
      s.ui.result(n ? `${n} error${n === '1' ? '' : 's'} from the language server` : 'no errors now')
      notes.push(problems)
    }
  }
  if (notes.length) res.note = notes.join('\n')
}

// A search over the whole disk or the home folder ("grep -r x /", "find ~ -name …"): minutes of
// waiting for nothing, which weak models do when they've lost track. Refused at once instead.
const SEARCHES = /^(grep|egrep|rgrep|rg|ag|ack|find|fd|locate|mdfind|du|tree)$/
export function searchesOutside(cmd, root) {
  const home = process.env.HOME ?? ''
  const wide = (t) => {
    const p = t.replace(/^["']|["']$/g, '').replace(/\/+$/, '') || '/'
    if (['/', '~', '$HOME', '${HOME}'].includes(p) || p === home) return true
    return p.startsWith('/') && root.startsWith(p + '/') // a folder the project is inside
  }
  return String(cmd)
    .split(/[;&|\n]+/)
    .some((part) => {
      const words = part.trim().split(/\s+/).filter((w) => !/^(sudo|nice|timeout|gtimeout|\d+[smh]?)$/.test(w))
      if (!SEARCHES.test(words[0] ?? '') && !(words[0] === 'ls' && words.some((w) => /^-\w*R/.test(w)))) return false
      if (words[0].includes('grep') && !words.some((w) => /^-\w*[rR]|^--(recursive|dereference-recursive)$/.test(w))) return false
      return words.slice(1).some((w) => !w.startsWith('-') && wide(w))
    })
}

export async function runConfirmed(s, cmd, signal) {
  s.ui.step('run', cmd)
  if (s.ui.permission === 'plan' && !readOnlyCommand(cmd)) {
    s.ui.result('not run: plan mode')
    return prompt('agent/plan-refused-command')
  }
  if (searchesOutside(cmd, s.root)) {
    log('command', `refused (searches outside the project): ${cmd}`)
    s.ui.result('not run: searches outside the project')
    return prompt('agent/command-too-wide', { root: s.root })
  }
  const ok = s.ui.permission === 'plan' ? true : await s.ui.confirm(`Run ${c.bold(cmd)}?`, 'command') // plan mode: only read-only ones get here
  if (ok !== true) return `The user declined to run this command.${typeof ok === 'string' ? ' User feedback: ' + ok : ''}`
  const before = snapshot(s)
  s.ui.spinner(`running ${cmd}`)
  const t0 = Date.now()
  const { code, output } = await runCommand(s.root, cmd, { signal })
  log('command', `${cmd} → exit ${code} in ${Date.now() - t0}ms\n${tail(output, 8000)}`)
  s.ui.stopSpin()
  s.ui.result(`exit ${code}`)
  const changed = changesSince(s, before)
  const why = code === 'timeout' ? `\n${prompt('agent/command-timeout', { root: s.root })}` : ''
  return `exit code ${code}\n${tail(output, 4000) || '(no output)'}${changed ? `\nFiles this command changed: ${changed}` : ''}${why}`
}

// Files a shell command changes are tracked like HeartCode's own edits: shown as diffs, kept for
// /rewind, and told to the model. Text files up to 256 KB, read only when they changed since the
// last look (the contents are cached per session).
const SNAP_MAX = 256_000
function snapshot(s) {
  const cache = (s.fileCache ??= new Map())
  const now = new Map()
  for (const rel of listFiles(s.root)) {
    let st
    try {
      st = fs.statSync(path.join(s.root, rel))
    } catch {
      continue
    }
    const sig = `${st.mtimeMs}:${st.size}`
    now.set(rel, sig)
    if (st.size > SNAP_MAX || cache.get(rel)?.sig === sig) continue
    try {
      const text = fs.readFileSync(path.join(s.root, rel), 'utf8')
      cache.set(rel, { sig, text: text.includes('\0') ? null : text }) // null: binary
    } catch {}
  }
  return now
}

function changesSince(s, before) {
  const was = new Map([...before.keys()].map((rel) => [rel, s.fileCache.get(rel)?.text])) // before the command: text, null (binary), undefined (too big)
  const after = snapshot(s) // refreshes the cache with the new contents
  const notes = []
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(rel) === after.get(rel)) continue
    const old = was.get(rel)
    const next = after.has(rel) ? s.fileCache.get(rel)?.text : undefined
    let note = !before.has(rel) ? `${rel} (new)` : !after.has(rel) ? `${rel} (deleted)` : rel
    if (!before.has(rel)) s.track?.(rel, null) // /rewind removes it
    else if (typeof old === 'string') s.track?.(rel, old) // /rewind puts this version back
    if (typeof old === 'string' && typeof next === 'string') {
      const ops = diffLines(old, next)
      s.ui.print(renderDiff(ops, rel, undefined, 2, 40))
      note += ` (+${ops.filter(([t]) => t === '+').length} -${ops.filter(([t]) => t === '-').length})`
    } else s.ui.result(note)
    notes.push(note)
  }
  return notes.slice(0, 30).join(', ') + (notes.length > 30 ? `, … ${notes.length - 30} more` : '')
}

export function writeResult(rel, r) {
  if (r.status === 'applied') return `${r.deleted ? 'Deleted' : 'Changed'} ${rel} (${r.summary}).${r.note ? `\n${r.note}` : ''}`
  if (r.status === 'unchanged') return `No change: the new content of ${rel} is identical to the old content.`
  return `The user rejected the change to ${rel}.${r.feedback ? ' User feedback: ' + r.feedback : ''}`
}

// --- native tool calling ---

// Kept short: these definitions go with every request.
const str = { type: 'string' }
const int = { type: 'integer' }
const obj = (properties, required = []) => ({ type: 'object', properties, required })
export const TOOL_DEFS = [
  { name: 'read_file', description: prompt('agent/tool-read_file'), parameters: obj({ path: str, start_line: int, end_line: int }, ['path']) },
  { name: 'search', description: prompt('agent/tool-search'), parameters: obj({ query: str, path: str }, ['query']) },
  { name: 'list_files', description: prompt('agent/tool-list_files'), parameters: obj({ filter: str }) },
  // One edit per call: a list of edits per call measured 2–6 malformed calls per benchmark run vs 0.
  { name: 'edit_file', description: prompt('agent/tool-edit_file'), parameters: obj({ path: str, search: str, replace: str }, ['path', 'search', 'replace']) },
  { name: 'write_file', description: prompt('agent/tool-write_file'), parameters: obj({ path: str, content: str, append: { type: 'boolean' } }, ['path', 'content']) },
  { name: 'run_command', description: prompt('agent/tool-run_command'), parameters: obj({ command: str }, ['command']) },
  { name: 'todo', description: prompt('agent/tool-todo'), parameters: obj({ todos: { type: 'array', items: obj({ content: str, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, ['content', 'status']) } }, ['todos']) },
  { name: 'web_search', description: prompt('agent/tool-web_search'), parameters: obj({ query: str }, ['query']) },
  { name: 'web_fetch', description: prompt('agent/tool-web_fetch'), parameters: obj({ url: str, start: int }, ['url']) },
  { name: 'ask_user', description: prompt('agent/tool-ask_user'), parameters: obj({ question: str, options: { type: 'array', items: str }, multiple: { type: 'boolean' } }, ['question']) },
]

// Plan mode (permission "plan"): looking around is fine, changing things isn't. Edits are refused,
// and a command runs only when it only reads (else it's refused, not asked about).
export const PLAN_HIDDEN = new Set(['edit_file', 'write_file', 'apply_patch'])
const READ_ONLY = /^(ls|cat|head|tail|wc|grep|egrep|rg|find|fd|tree|pwd|file|stat|du|df|which|type|echo|date|printenv|diff|cmp|sort|uniq|cut|jq|nl|basename|dirname|realpath|readlink|uname|whoami|(node|npm|python3?|go|cargo) --version|npm (ls|list|view|outdated)|git (status|log|diff|show|ls-files|blame|grep|describe|shortlog|rev-parse|config --get)|git (branch|tag|remote)( -[avlr]+| --list| -v)*$)\b/
export function readOnlyCommand(cmd) {
  const c = String(cmd).trim()
  if (/[>`]|\$\(|\b(sudo|rm|mv|cp|tee|chmod|chown|dd|truncate|mkdir|touch|ln)\b|-delete\b|-exec|-ok\b|sed\s+-i|\bsort\b.*\s-o/.test(c)) return false // writes, or runs something else
  return c.split(/\s*(?:&&|\|\||;|\|)\s*/).every((part) => READ_ONLY.test(part))
}

// MCP servers' tools as the model sees them: each its own tool, mcp__server__tool (Claude Code's
// names), with its description and arguments, the way the model would see them in Claude Code.
// Servers whose tools aren't known yet (still starting, failed), or too many tools at once, go
// through the one mcp tool instead. Sets s.mcpDirect (name → { server, tool, def }), s.mcpMeta
// (servers behind the mcp tool) and s.mcpInstructions (what the servers say about using them).
export const MAX_MCP_TOOLS = 100
export async function loadMcpTools(s, signal) {
  if (!s.mcp?.names.length) return Object.assign(s, { mcpDirect: new Map(), mcpMeta: [], mcpInstructions: '' })
  const catalog = await s.mcp.catalog(signal)
  // the servers with the fewest tools first, while they fit
  const known = [...catalog].sort((a, b) => a[1].tools.length - b[1].tools.length)
  const direct = new Map()
  const notes = []
  for (const [server, { tools, instructions }] of known) {
    if (direct.size + tools.length > MAX_MCP_TOOLS) continue
    for (const t of tools) direct.set(mcpName(server, t.name), { server, tool: t.name, def: t })
    if (instructions) notes.push(`### ${server}\n${instructions}`)
  }
  const shown = new Set([...direct.values()].map((d) => d.server))
  return Object.assign(s, { mcpDirect: direct, mcpMeta: s.mcp.names.filter((n) => !shown.has(n)), mcpInstructions: notes.join('\n\n'), mcpCatalog: catalog })
}
// Tool names may only have letters, digits, _ and - (64 at most).
export const mcpName = (server, tool) => `mcp__${server}__${tool}`.replace(/[^\w-]/g, '_').slice(0, 64)
// A schema as providers take it: an object, without the keys some refuse ($schema).
function cleanSchema(x) {
  if (Array.isArray(x)) return x.map(cleanSchema)
  if (!x || typeof x !== 'object') return x
  return Object.fromEntries(Object.entries(x).filter(([k]) => k !== '$schema').map(([k, v]) => [k, cleanSchema(v)]))
}
function mcpDefs(s) {
  return [...(s.mcpDirect?.values() ?? [])].map(({ server, tool, def }) => {
    const schema = cleanSchema(def.inputSchema ?? {})
    return { name: mcpName(server, tool), description: clip(String(def.description ?? `${tool} (${server})`).trim(), 2000), parameters: { ...schema, type: 'object', properties: schema.properties ?? {} } }
  })
}

// The MCP servers' tools, the one tool for the rest, and the skill loader; each only when there's
// something to offer.
export function extraTools(s) {
  const out = mcpDefs(s)
  const meta = s.mcpMeta ?? s.mcp?.names ?? []
  if (meta.length) {
    // no description: the names of its tools, when known, say what it's for
    const about = (n) => s.mcp.get(n).cfg.description || (s.mcpCatalog?.get(n) ? `tools: ${clip(s.mcpCatalog.get(n).tools.map((t) => t.name).join(', '), 300)}` : 'no description')
    out.push({ name: 'mcp', description: prompt('agent/tool-mcp', { servers: meta.map((n) => `${n}: ${about(n)}`).join('\n') }), parameters: obj({ server: str, tool: str, arguments: { type: 'object' } }, ['server', 'tool']) })
  }
  if (s.memory) {
    out.push({
      name: 'memory',
      description: prompt('agent/tool-memory'),
      parameters: obj({ action: { type: 'string', enum: ['write', 'read', 'search', 'delete'] }, name: str, description: str, type: str, tags: str, scope: { type: 'string', enum: ['project', 'global'] }, content: str, query: str }, ['action']),
    })
  }
  const forModel = [...(s.skills?.values() ?? [])].filter((k) => k.use !== 'me') // "use: me" skills cost nothing here
  if (forModel.length) {
    const skills = forModel.map((k) => `${k.name}: ${k.description}`).join('\n')
    out.push({ name: 'skill', description: prompt('agent/tool-skill', { skills }), parameters: obj({ name: str }, ['name']) })
  }
  // the patch format OpenAI's models are trained on (they also write it as a shell command, below)
  if (/gpt|codex|\bo\d/i.test(s.client?.model ?? '')) out.push({ name: 'apply_patch', description: prompt('agent/tool-apply_patch'), parameters: obj({ input: str }, ['input']) })
  if (!s.isSub && s.subagent) {
    const team = s.team?.() ?? []
    const model = { type: 'string', description: prompt('agent/tool-agent-model') }
    out.push({ name: 'agent', description: prompt('agent/tool-agent'), parameters: obj({ description: str, prompt: str, ...(team.length && { model }) }, ['description', 'prompt']) })
  }
  return [...out, ...(s.director && !s.appendSystem ? s.director.toolDefs(s) : [])] // manage (director.js); not when a program gives the instructions (--append-system-prompt)
}

// todo: the model's checklist for this message, shown to the user each time it changes.
// Lenient: the list as JSON text, plain strings for items, "done" for completed.
const MARK = { pending: '☐', in_progress: '◐', completed: '☑' }
function todoTool(s, args) {
  let list = args.todos ?? args.items ?? args
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = list.split('\n').filter((l) => l.trim())
    }
  }
  if (!Array.isArray(list)) return 'error: todos must be a list of {content, status}'
  const todos = list
    .map((t) => (typeof t === 'string' ? { content: t, status: 'pending' } : { content: String(t?.content ?? t?.task ?? t?.title ?? ''), status: String(t?.status ?? 'pending') }))
    .filter((t) => t.content.trim())
    .map((t) => ({ ...t, status: /done|complete/i.test(t.status) ? 'completed' : /progress|doing|active/i.test(t.status) ? 'in_progress' : 'pending' }))
  s.chat.todos = todos
  s.todoTouched = true
  const paint = { pending: c.muted, in_progress: (x) => c.info(c.bold(x)), completed: (x) => c.faint(x) }
  s.ui.print(todos.map((t) => `  ${paint[t.status](`${MARK[t.status]} ${t.content}`)}`).join('\n') || c.faint('  (todo list cleared)'))
  const done = todos.filter((t) => t.status === 'completed').length
  const next = todos.find((t) => t.status !== 'completed')
  return `Todo list saved: ${done} of ${todos.length} done.${next ? ` Next: ${next.content}` : ''}`
}

// ask_user: a question for the user mid-task, with choices (and their own answer) or free text.
async function askUser(s, args) {
  const question = String(args.question ?? '').trim()
  if (!question) return 'error: ask_user needs "question"'
  if (s.ui.noUser) return prompt('agent/ask-nobody')
  let options = args.options ?? []
  if (typeof options === 'string') {
    try {
      options = JSON.parse(options)
    } catch {
      options = options.split('\n')
    }
  }
  const items = [options].flat().map((o) => (typeof o === 'string' ? { label: o.trim() } : { label: String(o?.label ?? o?.value ?? '').trim(), desc: o?.description })).filter((o) => o.label)
  s.ui.stopSpin()
  let answer
  if (items.length) {
    const got = [await s.ui.pick(question, [...items, { label: 'Something else', desc: 'type your own answer', own: true }], { multi: Boolean(args.multiple) })].flat().filter(Boolean)
    const own = got.some((x) => x.own) ? await s.ui.ask(`${c.bold('Your answer')} ${c.dim('›')} `) : ''
    answer = [...got.filter((x) => !x.own).map((x) => x.label), own?.trim()].filter(Boolean).join(', ')
  } else answer = (await s.ui.ask(`${c.yellow('?')} ${c.bold(question)} `))?.trim()
  log('ask', question, answer)
  return answer ? `The user answered: ${answer}` : prompt('agent/ask-no-answer')
}

async function webTool(s, name, args, signal) {
  const what = name === 'web_search' ? String(args.query ?? '') : String(args.url ?? '')
  if (!what.trim()) return `error: ${name} needs ${name === 'web_search' ? '"query"' : '"url"'}`
  const ok = await s.ui.confirm(name === 'web_search' ? `Search the web for ${c.bold(what)}?` : `Fetch ${c.bold(what)}?`, 'read')
  if (ok !== true) return `The user declined this.${typeof ok === 'string' ? ' User feedback: ' + ok : ''}`
  s.ui.spinner(name === 'web_search' ? `searching: ${clip(what, 60)}` : `fetching ${clip(what, 60)}`)
  return name === 'web_search' ? await webSearch(what, { signal }) : await webFetch(what, { start: args.start, signal })
}

function memoryTool(s, args) {
  const m = s.memory
  if (!m) return 'error: there is no memory here'
  const name = String(args.name ?? '')
  switch (args.action) {
    case 'write': {
      if (!args.content && !args.description) return 'error: write needs at least content or a description'
      const n = m.write(args)
      s.memoryWrites = (s.memoryWrites ?? 0) + 1
      return `Saved [[${n}]]${m.read(n)?.scope === 'global' ? ' (global)' : ''}.`
    }
    case 'read': {
      const n = m.read(name)
      if (!n) return `error: no note [[${slug(name)}]]. ${m.search(name).slice(0, 5).map((x) => `[[${x.name}]]`).join(', ') || 'Search the memory to find notes.'}`
      return `[[${n.name}]] (${n.scope === 'global' ? 'global' : 'this project'}, ${n.type}${n.tags.length ? `; ${n.tags.join(', ')}` : ''}): ${n.description}\n\n${n.body}${n.backlinks.length ? `\n\nLinked from: ${n.backlinks.join(', ')}` : ''}`
    }
    case 'search': {
      const hits = m.search(args.query ?? name)
      return hits.length ? hits.slice(0, 20).map((n) => `[[${n.name}]] — ${n.description} (${[n.scope === 'global' && 'global', ...n.tags].filter(Boolean).join(', ')})`).join('\n') : 'no notes match'
    }
    case 'delete':
      return m.delete(name, args.scope) ? `Deleted [[${slug(name)}]].` : `error: no note [[${slug(name)}]]`
    default:
      return 'error: action must be write, read, search or delete'
  }
}

// Lenient about slips in names: "chrome-devtools:", "evaluate_script'", no server when there's one.
const bare = (v) => String(v ?? '').trim().replace(/^["'`]+|["'`:;,.]+$/g, '')

async function mcpTool(s, args, signal) {
  const names = s.mcp?.names ?? []
  // everything written into "server": 'chrome-devtools" tool="navigate_page" arguments={...}'
  const crammed = /^\s*"?([\w.-]+)"?\s+tool\s*[=:]\s*"?([\w.-]+)"?(?:\s+arguments\s*[=:]\s*(\{[\s\S]*\}))?/.exec(String(args.server ?? ''))
  if (crammed && names.includes(crammed[1])) {
    let a = args.arguments
    try {
      a = crammed[3] ? JSON.parse(crammed[3]) : a
    } catch {}
    args = { server: crammed[1], tool: args.tool ?? crammed[2], arguments: a }
  }
  let a = args.arguments ?? {}
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch {
      a = {}
    }
  }
  if (bare(args.tool) === 'search') return await searchMcp(s, String(a.query ?? args.query ?? a.name ?? ''), bare(args.server), signal)
  const server = s.mcp?.get(bare(args.server) || (names.length === 1 ? names[0] : ''))
  if (!server) return `error: no MCP server "${args.server}". Servers: ${names.join(', ') || 'none'}`
  const tool = bare(args.tool) || 'list'
  if (tool === 'list' || tool === 'describe') {
    s.ui.spinner(`starting ${server.name}`)
    const tools = await server.listTools(signal)
    if (tool === 'list') return tools.map((t) => `${t.name}: ${String(t.description ?? '').split(/(?<=\.)\s/)[0].slice(0, 160)}`).join('\n')
    const t = tools.find((x) => x.name === a.name)
    return t ? `${t.name}: ${t.description ?? ''}\nArguments (JSON schema): ${JSON.stringify(t.inputSchema ?? {})}` : `error: ${server.name} has no tool "${a.name}"; tool "list" shows its tools`
  }
  return callMcp(s, server, tool, a, signal)
}

// One MCP tool call. Asked about like a command, unless the server marks the tool read-only.
async function callMcp(s, server, tool, a, signal) {
  if (!allowed(s, mcpName(server.name, tool))) return `error: the tool ${mcpName(server.name, tool)} is not allowed here`
  const def = (server.tools ?? s.mcpCatalog?.get(server.name)?.tools)?.find((t) => t.name === tool)
  if (!def?.annotations?.readOnlyHint) {
    const ok = await s.ui.confirm(`Use ${server.name} → ${tool}?`, 'command')
    if (ok !== true) return `The user declined this call.${typeof ok === 'string' ? ' User feedback: ' + ok : ''}`
  }
  s.ui.spinner(`${server.name} · ${tool}`)
  const r = await server.call(tool, a, signal)
  const parts = r.content ?? []
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  const images = parts.filter((p) => p.type === 'image' && p.data)
  let note = ''
  if (images.length && s.strat?.vision) {
    ;(s.pendingImages ??= []).push(...images.map((p) => `data:${p.mimeType ?? 'image/png'};base64,${p.data}`))
    note = `\n(${images.length} image(s) attached in the next message)`
  } else if (images.length) note = `\n(${images.length} image(s) not shown: this model can't see images)`
  return `${r.isError ? 'error: ' : ''}${text || '(no text)'}${note}`
}

// tool "search": the tools of every server (or one) whose name or description has the query's
// words, best first. Servers start for it, so the model needn't list them one by one.
async function searchMcp(s, query, only, signal) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)
  if (!words.length) return 'error: search needs arguments {"query": "what the tool should do"}'
  const all = s.mcp?.names ?? []
  const names = all.includes(only) ? [only] : all // a server name that isn't one ("mcp", models do): every server
  s.ui.spinner(`searching the tools of ${names.length} MCP server${names.length === 1 ? '' : 's'}`)
  const lists = await Promise.allSettled(names.map((n) => s.mcp.get(n).listTools(signal)))
  const hits = []
  const failed = []
  lists.forEach((r, i) => {
    if (r.status === 'rejected') return failed.push(`${names[i]} (${clip(r.reason?.message ?? r.reason, 80)})`)
    for (const t of r.value) {
      const name = t.name.toLowerCase()
      const text = `${name} ${String(t.description ?? '').toLowerCase()}`
      const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : text.includes(w) ? 1 : 0), 0)
      if (score) hits.push({ score, line: `${names[i]} · ${t.name}: ${String(t.description ?? '').split(/(?<=\.)\s/)[0].slice(0, 160)}` })
    }
  })
  hits.sort((x, y) => y.score - x.score)
  const out = hits.filter((h) => h.score * 2 >= hits[0].score).slice(0, 15).map((h) => h.line).join('\n') || `no tool matches "${query}"` // weak matches (only "the", "page") left out
  return `${out}${failed.length ? `\n(not searched, failed to start: ${failed.join(', ')})` : ''}\nCall one with server and tool; tool "describe" with {"name": …} shows its arguments.`
}

// After an edit: the changed lines with 2 lines around them, numbered, so the model can check its
// work without reading the whole file again.
export function excerpt(next, ops, around = 2, max = 40) {
  const lines = next.split('\n')
  const changed = []
  let n = 0
  for (const [t] of ops) {
    if (t === '+') changed.push(n)
    if (t !== '-') n++
    else if (!changed.includes(n)) changed.push(n) // a deletion: show where it was
  }
  const show = new Set()
  for (const i of changed) for (let k = Math.max(0, i - around); k <= Math.min(lines.length - 1, i + around); k++) show.add(k)
  const rows = [...show].sort((a, b) => a - b)
  const out = []
  rows.slice(0, max).forEach((i, j) => {
    if (j && i !== rows[j - 1] + 1) out.push('…')
    out.push(`${i + 1}| ${lines[i]}`)
  })
  if (rows.length > max) out.push(`… (${rows.length - max} more changed lines)`)
  return out.join('\n')
}

// edit_file: all edits apply together or not at all. Lenient about the shape models send: `edits`
// as a list or as JSON text, the single search/replace form, a `path` per edit. An edit without a
// path, or whose text isn't in the given file, goes to the one project file that contains its text.
async function editFiles(s, args) {
  const { root } = s
  let edits = args.edits
  if (typeof edits === 'string') {
    for (const text of [edits, `[${edits}]`]) { // a list as text, or objects without the [ ]
      try {
        edits = JSON.parse(text)
        break
      } catch {}
    }
  }
  if (edits && typeof edits === 'object' && !Array.isArray(edits)) edits = [edits] // one edit, not in a list
  if (!Array.isArray(edits)) edits = [{ search: args.search, replace: args.replace }]
  const files = new Map() // path → { old, text }
  const textOf = (rel) => {
    if (!files.has(rel)) files.set(rel, { old: fs.readFileSync(resolveIn(root, rel), 'utf8') })
    const f = files.get(rel)
    return f.text ?? f.old
  }
  const holder = (search) => {
    const hits = listFiles(root).filter((f) => {
      try {
        const abs = resolveIn(root, f)
        return fs.statSync(abs).size < 1_000_000 && fs.readFileSync(abs, 'utf8').includes(search)
      } catch {
        return false
      }
    })
    return hits.length === 1 ? hits[0] : null
  }
  for (const [i, e] of edits.entries()) {
    const { search: s0, replace: r0, path: p0 } = normalize(e ?? {})
    const search = String(s0 ?? '')
    const replace = String(r0 ?? '')
    const given = p0 ?? args.path
    const label = edits.length > 1 ? `edit ${i + 1} of ${edits.length}: ` : ''
    let rel = given && fs.existsSync(resolveIn(root, given)) ? path.relative(root, resolveIn(root, given)) : null
    let r = rel ? applyEdit(textOf(rel), search, replace) : null
    if (!r || r.error) {
      const other = search.trim() && holder(search)
      if (other && other !== rel) [rel, r] = [other, applyEdit(textOf(other), search, replace)]
    }
    if (!rel) return `error: ${label}${given ? `${given} does not exist; use write_file to create it` : 'no "path" given, and its search text is not in exactly one file'}. Nothing was changed.`
    if (r.error) return `error: ${label}${r.error}. Nothing was changed.`
    files.get(rel).text = r.text
  }
  const out = []
  for (const [rel, f] of files) {
    if (f.text === undefined) continue
    const res = await proposeWrite(s, rel, f.old, f.text)
    out.push(writeResult(rel, res) + (res.status === 'applied' ? `\nNow:\n${excerpt(res.text, res.ops)}` : ''))
  }
  return out.join('\n\n')
}

// apply_patch (patch.js): every file's change is worked out first (nothing is written if one
// fails), then each is shown, asked about and written like an edit_file change.
async function applyPatch(s, text) {
  const body = /\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/.exec(String(text))?.[0] ?? String(text)
  let ops
  try {
    ops = parsePatch(body)
  } catch (e) {
    return `error: ${e.message}. Nothing was changed.`
  }
  if (!ops.length) return 'error: the patch changes no files. Nothing was changed.'
  const plan = [] // [rel, old, next (null: delete)]
  for (const op of ops) {
    const abs = resolveIn(s.root, op.path)
    const rel = path.relative(s.root, abs)
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
    if (op.type === 'add') {
      plan.push([rel, old ?? '', op.content.join('\n') + '\n'])
      continue
    }
    if (old === null) return `error: ${op.path} does not exist${op.type === 'update' ? ' (use *** Add File: to create it)' : ''}. Nothing was changed.`
    if (op.type === 'delete') {
      plan.push([rel, old, null])
      continue
    }
    const r = applyChunks(old, op.chunks)
    if (r.error) return `error: ${op.path}: ${r.error}. Nothing was changed.`
    if (op.moveTo) plan.push([path.relative(s.root, resolveIn(s.root, op.moveTo)), '', r.text], [rel, old, null])
    else plan.push([rel, old, r.text])
  }
  const out = []
  for (const [rel, old, next] of plan) {
    const res = await proposeWrite(s, rel, old, next)
    if (next === null && res.status === 'applied') res.deleted = true
    out.push(writeResult(rel, res) + (res.status === 'applied' && next !== null ? `\nNow:\n${excerpt(res.text, res.ops)}` : ''))
  }
  return out.join('\n\n')
}

// Every tool call goes through the user's PreToolUse and PostToolUse hooks (hooks.js).
export async function runTool(name, args, s, signal) {
  log('tool', name, args)
  const pre = await runHooks(s, 'PreToolUse', { tool_name: name, tool_input: args }, signal)
  if (pre.block) return prompt('agent/hook-blocked-tool', { reason: pre.block })
  let out = await tool(name, args, s, signal)
  const post = await runHooks(s, 'PostToolUse', { tool_name: name, tool_input: args, tool_response: out }, signal)
  if (post.block) out += `\n\n${prompt('agent/hook-after-tool', { reason: post.block })}`
  log('tool', `${name} result:`, clip(out, 4000))
  return out
}

// Argument names other tools use (Claude Code's file_path, old_string, new_string, …): models
// trained on them send them here too.
const ALIASES = { file_path: 'path', filePath: 'path', file: 'path', old_string: 'search', old_str: 'search', oldText: 'search', new_string: 'replace', new_str: 'replace', newText: 'replace', cmd: 'command' }
function normalize(args) {
  const out = { ...args }
  for (const [from, to] of Object.entries(ALIASES)) if (out[to] === undefined && out[from] !== undefined) out[to] = out[from]
  return out
}

// The MCP tool a name means: mcp__server__tool (offered, or a server behind the mcp tool), or a
// bare tool name only one server has ("click").
function mcpTarget(s, name) {
  const d = s.mcpDirect?.get(name)
  if (d) return { server: s.mcp.get(d.server), tool: d.tool }
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (m && s.mcp?.get(m[1])) return { server: s.mcp.get(m[1]), tool: m[2] }
  const same = [...(s.mcpDirect?.values() ?? [])].filter((x) => x.tool === name)
  return same.length === 1 ? { server: s.mcp.get(same[0].server), tool: name } : null
}

// Tools the caller allowed (--allowedTools) or took away (--disallowedTools); all by default. An
// MCP tool goes by its own name, its server's (mcp__server, as in Claude Code) or "mcp" (all of them).
export function allowed(s, name) {
  const names = name.startsWith('mcp__') ? [name, name.split('__').slice(0, 2).join('__'), 'mcp'] : [name]
  if (names.some((n) => s.denyTools?.has(n))) return false
  if (!s.allowTools) return true
  return names.some((n) => s.allowTools.has(n)) || (name === 'mcp' && [...s.allowTools].some((n) => n.startsWith('mcp__')))
}

async function tool(name, args, s, signal) {
  if (!name.startsWith('mcp__') && !mcpTarget(s, name)) args = normalize(args) // an MCP tool's arguments are its own
  try {
    const { root } = s
    if (s.ui.permission === 'plan') {
      if (PLAN_HIDDEN.has(name) || name === 'append_file' || name === 'manage' && args.action !== 'list' && args.action !== 'show' && args.action !== 'help') return prompt('agent/plan-refused')
    }
    switch (name) {
      case 'read_file':
        return IMAGE.test(String(args.path ?? '')) ? readImage(s, args.path) : readFileTool(root, args.path, args.start_line, args.end_line)
      case 'list_files': {
        const files = listFiles(root).filter((f) => !args.filter || f.includes(args.filter))
        return files.slice(0, 500).join('\n') + (files.length > 500 ? `\n… ${files.length - 500} more` : '') || 'no files'
      }
      case 'search':
        return searchFiles(root, String(args.query ?? ''), args.path)
      case 'edit_file':
        return await editFiles(s, args)
      case 'write_file':
      case 'append_file': {
        if (!args.path) return 'error: write_file needs "path" (the file to write) and "content". Nothing was written.'
        const abs = resolveIn(root, args.path)
        const rel = path.relative(root, abs)
        const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
        const append = name === 'append_file' || args.append === true || args.append === 'true'
        const res = await proposeWrite(s, rel, old, (append ? old : '') + String(args.content ?? ''))
        return writeResult(rel, res) + (res.formatted ? `\nNow:\n${excerpt(res.text, res.ops)}` : '') // what it wrote isn't what's there now
      }
      case 'run_command':
        if (/^\s*apply_patch\b[\s\S]*\*\*\* Begin Patch/.test(String(args.command ?? ''))) return await applyPatch(s, args.command) // apply_patch <<'EOF' … as Codex runs it
        return await runConfirmed(s, String(args.command ?? ''), signal)
      case 'apply_patch':
        return await applyPatch(s, args.input ?? args.patch ?? args.command ?? '')
      case 'mcp':
        return await mcpTool(s, args, signal)
      case 'memory':
        return memoryTool(s, args)
      case 'todo':
        return todoTool(s, args)
      case 'web_search':
      case 'web_fetch':
        return await webTool(s, name, args, signal)
      case 'agent':
        return await s.subagent(args, signal)
      case 'ask_user':
        return await askUser(s, args)
      case 'skill': {
        const k = s.skills?.get(String(args.name ?? ''))
        return k && k.use !== 'me' ? fillArgs(k.body, '') : `error: no skill "${args.name}". Skills: ${[...(s.skills?.values() ?? [])].filter((x) => x.use !== 'me').map((x) => x.name).join(', ') || 'none'}`
      }
      default: {
        const m = mcpTarget(s, name)
        if (m) return await callMcp(s, m.server, m.tool, args, signal)
        return (await s.director?.tool(name, args, s, signal)) ?? `error: there is no tool named ${name}`
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e
    return `error: ${e.message}`
  }
}
