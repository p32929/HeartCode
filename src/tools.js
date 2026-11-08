import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { log } from './log.js'
import { slug, fullSlug, keywords } from './memory.js'
import { fillArgs, skillFiles, readSkillFile } from './skills.js'
import { prompt } from './prompts.js'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { applyEdit, closest, trimBlank } from './edit.js'
import { readJson, HOME } from './config.js'
import { c, diffLines, renderDiff } from './ui.js'
import { webFetch, webSearch, fetchPage, pageView } from './web.js'
import { savePage, saveSearch, findResearch } from './research.js'
import { runHooks } from './hooks.js'
import { parsePatch, applyChunks } from './patch.js'
import { formatFile } from './format.js'
import { diagnose, lspTool, findCommand } from './lsp.js'
import { startJob, waitFor, newOutput, tailLines, listJobs, getJob, stopJob, removeJob, keepLeftovers, jobLine } from './background.js'

const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', 'venv', '__pycache__', 'target', '.cache', '.DS_Store'])

export const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s))
export const tail = (s, n) => (s.length > n ? '…' + s.slice(-n) : s)

// Tool output too long for the conversation is saved here (one folder per chat), where read_file
// and search can read it although it's outside the project.
export const OUTPUTS = path.join(HOME, 'outputs') // kept with the chat: a resumed one's pointers still open
const LEGACY_OUTPUTS = path.join(os.tmpdir(), 'heartcode-outputs') // where older HeartCode kept them
export const isSavedOutput = (abs) => [OUTPUTS, LEGACY_OUTPUTS].some((d) => String(abs).startsWith(d + path.sep))
// data: text, or an image's bytes (ext: png…)
let saved = 0
export function saveOutput(chatId, name, data, ext = 'txt') {
  try {
    const dir = path.join(OUTPUTS, String(chatId ?? 'chat'))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now().toString(36)}-${(++saved).toString(36)}-${String(name).replace(/[^\w-]/g, '_').slice(0, 60)}.${ext}`) // several in one millisecond: each its own file
    fs.writeFileSync(file, data)
    return file
  } catch (e) {
    log('tool', `could not save the output: ${e.message}`)
    return ''
  }
}

// Folders (and files) outside the project that the user's messages name ("look at ~/code/other
// first"): read_file, list_files and search read there, and commands there aren't called a wrong
// turn. Nothing outside the project is written.
const namedOutside = new Set()
const expandHome = (p) => p.replace(/^~(?=[\\/]|$)/, os.homedir())
export function noteNamedPaths(text) {
  for (const m of String(text ?? '').matchAll(/(?:^|[\s"'`(<])((?:~|\/|[A-Za-z]:[\\/])[^\s"'`)>]+)/g)) {
    const abs = path.resolve(expandHome(m[1].replace(/[.,;:!?]+$/, '')))
    if (abs !== path.parse(abs).root && abs !== os.homedir() && fs.existsSync(abs)) namedOutside.add(abs)
  }
}
const readableOutside = (abs) => [...namedOutside].some((d) => abs === d || abs.startsWith(d + path.sep))

// read: a path the user named outside the project is fine too (for reading only)
export function resolveIn(root, p, read = false) {
  const clean = expandHome(String(p ?? '').trim().replace(/^["'`]+|["'`]+$/g, ''))
  if (!clean) throw new Error('no path given')
  const bare = root.replace(/^[\\/]+/, '') // the project's own path, its leading "/" left out by a sloppy copy
  let abs = clean === bare || clean.startsWith(bare + '/') ? path.join(root, clean.slice(bare.length)) : path.resolve(root, clean)
  if (isSavedOutput(abs)) return abs // a saved tool output
  if (read && readableOutside(abs) && !(abs === root || abs.startsWith(root + path.sep))) return abs
  // "num.js:" or "num.js," from a sloppy model: the file without the stray mark, if that one exists
  const trimmed = path.resolve(root, clean.replace(/[:;,.]+$/, ''))
  if (trimmed !== abs && !fs.existsSync(abs) && fs.existsSync(trimmed)) abs = trimmed
  if (abs !== root && !abs.startsWith(root + path.sep)) abs = intoProject(root, clean) ?? abs
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`${clean} is outside the project; use a path relative to the project folder (${root}), like "index.html" or "src/app.js"`)
  return abs
}

// A small model's mangled copy of the project's long path, meant inside it: any path with the
// project folder's name in it ("/Users-me-…/myapp/index.html"): what comes after that name.
// null: no such reading.
function intoProject(root, p) {
  const slash = p.replace(/\\/g, '/')
  const name = path.basename(root)
  const parts = slash.split('/')
  const at = parts.lastIndexOf(name)
  return at >= 0 ? path.resolve(root, parts.slice(at + 1).join('/') || '.') : null
}

// Project files a message names: by its path, or by a file name only one file in the project has
// ("num.js"; in a project with three index.js, "index.js" names none of them).
export function namedFiles(text, files) {
  const t = text.toLowerCase()
  const count = new Map()
  for (const f of files) count.set(path.basename(f).toLowerCase(), (count.get(path.basename(f).toLowerCase()) ?? 0) + 1)
  const word = (w) => new RegExp(`(^|[^\\w./-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(t)
  return files.filter((f) => {
    const base = path.basename(f).toLowerCase()
    return t.includes(f.toLowerCase()) || (base.includes('.') && count.get(base) === 1 && word(base))
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

// One folder's entries (the project root: ''), all of them: folders end in "/", what .gitignore
// leaves out says "(ignored)". Names only. At most `limit`.
export function folderView(root, rel = '', limit = 200) {
  const abs = resolveIn(root, rel || '.', true)
  let entries
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch (e) {
    return { error: e.code === 'ENOENT' ? `no folder ${rel}` : e.code === 'ENOTDIR' ? `${rel} is a file, not a folder` : e.message }
  }
  let ignored = null // the entries .gitignore leaves out ("node_modules/", "dist/", ".env")
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', abs], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 })
    ignored = new Set(out.split('\0').filter(Boolean).map((f) => f.replace(/\/$/, '')))
  } catch {}
  const here = path.relative(root, abs)
  const names = entries
    .map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(abs, e.name), { throwIfNoEntry: false })?.isDirectory()) }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name))
  const shown = names.slice(0, limit).map(({ name, dir }) => {
    const p = path.join(here, name).split(path.sep).join('/')
    const off = ignored ? ignored.has(p) : IGNORE.has(name)
    return `${name}${dir ? '/' : ''}${off && name !== '.git' ? ' (ignored)' : ''}`
  })
  return { entries: shown, more: Math.max(0, names.length - limit) }
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0)
export const numberLines = (lines, from = 1) => lines.map((l, i) => `${from + i}| ${l}`).join('\n')

export function readFileTool(root, p, start, end, maxLines = 400) {
  const abs = resolveIn(root, p, true)
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

// Images: the formats providers take, and the size sent at most (bigger ones, a full-page
// screenshot of a long page, are refused by some providers; HeartCode has no image library to
// shrink them).
export const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
export const MAX_IMAGE = 5_000_000
// An image file as a data: URL; an error that says why not (shown: the name it was given as).
export function imageUrl(abs, shown = abs) {
  const mime = IMAGE_MIME[path.extname(abs).slice(1).toLowerCase()]
  if (!mime) throw new Error(`${shown} is not an image file (png, jpg, gif, webp)`)
  if (!fs.existsSync(abs)) throw new Error(`${shown} does not exist`)
  const size = fs.statSync(abs).size
  if (size > MAX_IMAGE) throw new Error(`${shown} is too big to send (${Math.round(size / 1e6)} MB; at most ${MAX_IMAGE / 1e6} MB)`)
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
}

// An image file: shown to a model that can see images (after the tool results, as MCP screenshots
// are); for one that can't, where to send it.
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
function readImage(s, p) {
  const abs = resolveIn(s.root, p, true)
  const rel = path.relative(s.root, abs) || p
  if (!fs.existsSync(abs)) return readFileTool(s.root, p)
  if (s.strat?.vision) {
    try {
      ;(s.pendingImages ??= []).push({ url: imageUrl(abs, rel), file: rel })
    } catch (e) {
      return `error: ${e.message}`
    }
    return `${rel}: the image is attached in the next message`
  }
  return s.team?.().some((t) => t.images) ? prompt('agent/tool-images', { files: rel, unseen: true }) : `${rel} is an image, and you can't see images.`
}

export function searchFiles(root, query, sub = '', limit = 50) {
  const ci = query === query.toLowerCase()
  let re
  let literal = false // not a valid regular expression: searched as the text it is
  try {
    re = new RegExp(query, ci ? 'i' : '')
  } catch {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : '')
    literal = true
  }
  // a pattern given as the path ("src/*.css", "**/*.ts"): the folder before it, and its files that fit
  let only = null
  const pattern = sub
  if (/[*?]/.test(sub)) {
    const parts = String(sub).split(/[\\/]/)
    const at = parts.findIndex((p) => /[*?]/.test(p))
    const glob = parts.slice(at).filter((p) => p !== '**').join('/') || '*'
    only = new RegExp(`(^|/)${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
    sub = parts.slice(0, at).join('/')
  }
  const abs = sub ? resolveIn(root, sub, true) : ''
  if (abs && !fs.existsSync(abs)) return `error: ${sub} doesn't exist, so nothing was searched (this is not "no matches"). Give a file or folder that exists, or leave path out to search the whole project.`
  const away = abs && abs !== root && !abs.startsWith(root + path.sep) && !isSavedOutput(abs) // a folder the user named outside the project
  let single = false // one file named: searched whatever lists leave out (a saved page, a .gitignored file)
  try {
    single = Boolean(abs) && fs.statSync(abs).isFile()
  } catch {}
  const saved = isSavedOutput(abs) || single
  const prefix = sub && !saved && !away ? path.relative(root, abs) : ''
  const hits = []
  let searched = 0
  for (const f of saved ? [abs] : away ? listFiles(abs).map((f) => path.join(abs, f)) : listFiles(root)) {
    if (prefix && f !== prefix && !f.startsWith(prefix + '/')) continue
    if (only && !only.test(f)) continue
    searched++
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
  if (hits.length) return hits.join('\n')
  return searched ? `no matches for ${query} in ${searched} file${searched === 1 ? '' : 's'} searched${literal ? ' (as plain text: it isn\'t a valid regular expression)' : ''}` : `nothing was searched: no files${only ? ` fit ${pattern}` : ''} in ${sub || 'the project'} (this is not "no matches")`
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
        note += '\n(Processes this command left running in the background were stopped. To keep a server or watcher running, run it with background: true.)'
      }
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 2000).unref()
      child.stdout.destroy()
      child.stderr.destroy()
      const plain = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      resolve({ code, output: (dropped ? '(the start of a very long output was left out: only its last 100,000 characters are here; the command itself was not affected)\n…' : '') + plain(out) + note, ...(split && { stderr: plain(err) }) })
    }
    let dropped = false // a very long output's start, left out (said, so it isn't read as the command failing)
    const add = (d) => {
      out += d
      if (out.length > 200_000) (out = out.slice(-100_000)), (dropped = true)
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

// What the model changed in files: this message's (or with all, the conversation's), each file from
// before its first change to now (the turns keep that first version for /rewind; /diff shows the same).
function changesTool(s, args) {
  const turns = args.all ? (s.chat?.turns ?? []) : (s.chat?.turns ?? []).slice(-1)
  const first = new Map()
  for (const t of turns) for (const [rel, before] of Object.entries(t.files ?? {})) if (!first.has(rel)) first.set(rel, before)
  const want = String(args.path ?? '').trim().replace(/^\.\//, '')
  const out = []
  for (const rel of [...first.keys()].filter((f) => !want || f === want || f.endsWith('/' + want)).sort()) {
    const abs = path.join(s.root, rel)
    const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
    const was = first.get(rel)
    if (was === now) continue
    out.push(was === null ? `${rel} (new)\n${renderDiff(diffLines('', now), rel, false, 3, 400)}` : now === null ? `${rel} (deleted)` : renderDiff(diffLines(was, now), rel, false, 3, 400))
  }
  const where = args.all ? 'in this conversation' : 'for this message'
  return out.join('\n\n') || (want ? `No changes to ${want} ${where}.` : `No file changes ${where}${first.size ? ' (the files you changed are back as they were)' : ''}.`)
}

// A "no" from the user, with what they typed instead. Their words go to the model as their own message,
// after the tool results (s.userSaid, which the agent sends): inside a result a model reads them as the
// tool talking, and tries again. Where there's no queue (guided mode) or no user (headless: the "no" is
// HeartCode's), they stay in the result.
export function declined(s, ok, what) {
  const said = typeof ok === 'string' ? ok.trim() : ''
  if (said && s.userSaid && !s.ui.noUser) {
    s.userSaid.push(said)
    return `${what} What they want instead is in their message that follows.`
  }
  return `${what}${said ? ` ${s.ui.noUser ? said : `User feedback: ${said}`}` : ''}`
}

const PLACEHOLDER = /(\.\.\.|…)\s*(rest|existing|remaining|unchanged|other)|rest of (the )?(code|file)|existing code (here|unchanged)/i

// Shows the diff, asks the user, writes (next = null: deletes the file). Shared by both agent modes.
export async function proposeWrite(s, rel, old, next) {
  if (old === next) return { status: 'unchanged' }
  if (s.ui.permission === 'plan') return { status: 'rejected', feedback: prompt('agent/plan-refused', { command: false }) } // both modes write through here
  if (s.ownFiles && !s.ownFiles.includes(path.resolve(s.root, rel))) return { status: 'rejected', feedback: prompt('agent/part-files', { file: rel, files: s.ownFiles.map((f) => path.relative(s.root, f)).join(', ') }) } // a part's helper: every way of writing (a patch in run_command, guided mode)
  const ops = diffLines(old, next ?? '')
  s.ui.print(renderDiff(ops, rel))
  if (next !== null && PLACEHOLDER.test(next) && !PLACEHOLDER.test(old)) s.ui.warn('the new content seems to contain a placeholder like "rest of code unchanged"')
  const ok = await s.ui.confirm(next === null ? `Delete ${rel}?` : old ? `Apply this change to ${rel}?` : `Create ${rel}?`)
  log('write', rel, ok === true ? 'approved' : `rejected ${typeof ok === 'string' ? ok : ''}`)
  if (ok !== true) return { status: 'rejected', said: declined(s, ok, '') }
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
    // a formatter the project gave (a cloned repo's own commands): only once the user says yes
    const allow = async (cmd) => {
      s.formatters ??= new Map()
      if (!s.formatters.has(cmd)) s.formatters.set(cmd, (await s.ui.confirm(`Run this project's formatter after each write? ${cmd}`, 'command')) === true)
      return s.formatters.get(cmd)
    }
    const f = await formatFile(s.root, rel, allow).catch((e) => (log('format', `${rel}: ${e.message}`), null))
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

// Waited on for `wait` seconds (the model's choice): finished by then, its exit code and output;
// still running, it carries on in the background, and the model checks on it when it likes.
export async function runConfirmed(s, cmd, signal, background = false, wait) {
  s.ui.step(background ? 'run in background' : 'run', cmd, s.client?.model)
  if (s.ui.permission === 'plan' && !readOnlyCommand(cmd)) {
    s.ui.result('not run: plan mode')
    return prompt('agent/plan-refused', { command: true })
  }
  if (searchesOutside(cmd, s.root)) {
    log('command', `refused (searches outside the project): ${cmd}`)
    s.ui.result('not run: searches outside the project')
    return prompt('agent/outside-project', { root: s.root, wide: true })
  }
  const ok = s.ui.permission === 'plan' ? true : await s.ui.confirm(`Run ${c.bold(cmd)}?`, 'command') // plan mode: only read-only ones get here
  if (ok !== true) {
    s.ui.result('declined')
    return declined(s, ok, 'The user declined to run this command.')
  }
  const secs = Number(wait) > 0 ? Number(wait) : background ? 3 : 30
  const before = snapshot(s)
  const job = startJob(s.root, cmd)
  // its latest output line beside it, read a few times a second (the label is re-read every frame)
  let last = ''
  let readAt = 0
  s.ui.spinner(() => {
    if (Date.now() - readAt > 250) [readAt, last] = [Date.now(), tailLines(job, 3).filter((l) => l.trim()).at(-1)?.trim() ?? '']
    return `running ${clip(cmd, 50)}${last ? ` › ${clip(last, 60)}` : ''}`
  })
  await waitFor(job, secs * 1000, signal)
  s.ui.stopSpin()
  if (!job.exited) {
    if (signal?.aborted && !background) {
      removeJob(job) // Esc stops what it was waiting on
      s.ui.result('stopped')
      return `Stopped by the user (Esc) after ${Math.round((Date.now() - job.started) / 1000)}s.`
    }
    s.ui.result(`still running: #${job.id} in the background`)
    return prompt('agent/background-started', { id: job.id, secs, output: newOutput(job).trim() || '(nothing yet)', file: job.file })
  }
  const output = newOutput(job, 4000)
  const left = keepLeftovers(job) // `server &`: kept running, as a background command
  if (!left) removeJob(job) // done: not one of the background list
  log('command', `${cmd} → exit ${job.code} in ${job.ended - job.started}ms\n${output}`)
  let lines = 0
  try {
    lines = fs.readFileSync(job.file, 'utf8').split(/\r?\n|\r/).filter((l) => l.trim()).length
  } catch {}
  s.ui.result(`exit ${job.code}${lines ? ` · ${lines} line${lines === 1 ? '' : 's'}` : ''}`)
  // failed: its last lines under it (what went wrong, usually), aligned with the result's text
  // why it failed: the last error line and what follows it (a stack's end says nothing), else the last lines
  const tail = job.code !== 0 ? tailLines(job, 40).filter((x) => x.trim()) : []
  const at = tail.findLastIndex((l) => /\b(error|exception|failed|fail|assert\w*|cannot|not found|denied)\b/i.test(l))
  if (job.code !== 0) for (const l of at === -1 ? tail.slice(-3) : tail.slice(at, at + 3)) s.ui.print(`${s.isSub ? '      ' : '    '}${c.faint(clip(l.trimEnd(), 120))}`)
  const changed = changesSince(s, before)
  return `exit code ${left ? 0 : job.code}\n${output.trim() || '(no output)'}${changed ? `\nFiles this command changed: ${changed}` : ''}${left ? `\n${prompt('agent/left-running', { id: job.id })}` : ''}`
}

// The background tool: what a command still running printed since the last look (after waiting
// up to `wait` seconds for it to finish, if asked), the list of them, or stop one.
async function backgroundTool(s, a, signal) {
  const mine = listJobs(s.root)
  if (a.action === 'list') return mine.length ? mine.map(jobLine).join('\n') : 'No background commands.'
  const job = getJob(a.id ?? mine.at(-1)?.id)
  if (!job || job.root !== s.root) return `error: no background command #${a.id}. ${mine.length ? `They are: ${mine.map((j) => `#${j.id} ${j.command}`).join(', ')}` : 'None are running.'}`
  if (a.action === 'stop') {
    const was = stopJob(job)
    s.ui.result(was ? `stopped #${job.id}` : `#${job.id} had already exited`)
    return was ? `Stopped #${job.id} (${job.command}).` : `#${job.id} had already exited with ${job.code}.`
  }
  if (Number(a.wait) > 0) {
    s.ui.spinner(`waiting on #${job.id} ${clip(job.command, 60)}`)
    await waitFor(job, Number(a.wait) * 1000, signal)
    s.ui.stopSpin()
  }
  if (job.exited) job.told = true // told here: not again as a background-ended note
  const out = newOutput(job)
  return `${jobLine(job)}\n${out.trim() ? `New output since the last look:\n${out}` : '(no new output since the last look)'}`
}

// Files a shell command changes are tracked like HeartCode's own edits: shown as diffs, kept for
// /rewind, and told to the model. Text files up to 256 KB, read only when they changed since the
// last look (the contents are cached per session).
const SNAP_MAX = 256_000
// complete: every file of the project is in it (a list cut at its limit isn't, and a file missing
// from it may well have been there: never taken for a new one, which /rewind would delete).
const SNAP_FILES = 20_000
function snapshot(s) {
  const cache = (s.fileCache ??= new Map())
  const now = new Map()
  const files = listFiles(s.root, SNAP_FILES + 1)
  now.complete = files.length <= SNAP_FILES
  for (const rel of files.slice(0, SNAP_FILES)) {
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
    if (/^\.heartcode[\\/]/.test(rel)) continue // HeartCode's own (research, memory, models) written meanwhile — a page fetched while the command ran — not the command's
    if (!(before.complete && after.complete) && (!before.has(rel) || !after.has(rel))) continue // a list cut at its limit: in one, not the other, says nothing
    const old = was.get(rel)
    const next = after.has(rel) ? s.fileCache.get(rel)?.text : undefined
    let note = !before.has(rel) ? `${rel} (new)` : !after.has(rel) ? `${rel} (deleted)` : rel
    if (!before.has(rel)) {
      if (before.complete) s.track?.(rel, null) // /rewind removes it
    } else if (typeof old === 'string') s.track?.(rel, old) // /rewind puts this version back
    else if (old === undefined) note += ` (over ${SNAP_MAX / 1000} KB: /rewind can't put it back)`
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
  return r.feedback ? r.feedback : `The user rejected the change to ${rel}.${r.said ?? ''}`
}

// --- native tool calling ---

// Kept short: these definitions go with every request.
const str = { type: 'string' }
const int = { type: 'integer' }
const obj = (properties, required = []) => ({ type: 'object', properties, required })
// (descriptions read each time: a project's own prompts and the settings page's edits apply at once)
export const TOOL_DEFS = [
  { name: 'read_file', get description() { return prompt('agent/tool-read_file') }, parameters: obj({ path: str, start_line: int, end_line: int }, ['path']) },
  { name: 'search', get description() { return prompt('agent/tool-search') }, parameters: obj({ query: str, path: str }, ['query']) },
  { name: 'changes', get description() { return prompt('agent/tool-changes') }, parameters: obj({ path: str, all: { type: 'boolean' } }) },
  { name: 'list_files', get description() { return prompt('agent/tool-list_files') }, parameters: obj({ path: str, filter: str }) },
  { name: 'find_command', get description() { return prompt('agent/tool-find_command') }, parameters: obj({ names: { type: 'array', items: str } }, ['names']) },
  { name: 'lsp', get description() { return prompt('agent/tool-lsp') }, parameters: obj({ server: str, language: str, action: { type: 'string', enum: ['definition', 'references', 'hover', 'errors'] }, file: str, line: int, column: int, name: str }, ['server', 'language', 'action', 'file']) },
  // One edit per call: a list of edits per call measured 2–6 malformed calls per benchmark run vs 0.
  { name: 'edit_file', get description() { return prompt('agent/tool-edit_file') }, parameters: obj({ path: str, search: str, replace: str, start_line: int, end_line: int }, ['path', 'replace']) },
  { name: 'write_file', get description() { return prompt('agent/tool-write_file') }, parameters: obj({ path: str, content: str, append: { type: 'boolean' } }, ['path', 'content']) },
  { name: 'run_command', get description() { return prompt('agent/tool-run_command') }, parameters: obj({ command: str, wait: int, background: { type: 'boolean' } }, ['command']) },
  { name: 'background', get description() { return prompt('agent/tool-background') }, parameters: obj({ action: { type: 'string', enum: ['output', 'list', 'stop'] }, id: int, wait: int }, ['action']) },
  { name: 'todo', get description() { return prompt('agent/tool-todo') }, parameters: obj({ todos: { type: 'array', items: obj({ content: str, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'stuck'] }, why: str, parallel: { type: 'boolean' }, model: str, files: { type: 'array', items: str } }, ['content', 'status']) } }, ['todos']) },
  { name: 'web_search', get description() { return prompt('agent/tool-web_search') }, parameters: obj({ query: str, fresh: { type: 'boolean' } }, ['query']) },
  { name: 'web_fetch', get description() { return prompt('agent/tool-web_fetch') }, parameters: obj({ url: str, look_for: str, start: int }, ['url']) },
  { name: 'ask_user', get description() { return prompt('agent/tool-ask_user') }, parameters: obj({ question: str, header: str, options: { type: 'array', items: str }, multiple: { type: 'boolean' }, emphasis: { type: 'boolean' } }, ['question', 'options']) }, // one question a call (small models manage that); several calls in one reply are one dialog (agent.js)
]

// Plan mode (permission "plan"): looking around is fine, changing things isn't. Edits are refused,
// and a command runs only when it only reads (else it's refused, not asked about).
export const PLAN_HIDDEN = new Set(['edit_file', 'write_file', 'apply_patch'])
const READ_ONLY = /^(cd|ls|cat|head|tail|wc|grep|egrep|rg|find|fd|tree|pwd|file|stat|du|df|which|type|echo|date|printenv|diff|cmp|sort|uniq|cut|jq|nl|basename|dirname|realpath|readlink|uname|whoami|(node|npm|python3?|go|cargo) --version|npm (ls|list|view|outdated)|git (status|log|diff|show|ls-files|blame|grep|describe|shortlog|rev-parse|config --get)|git (branch|tag|remote)( -[avlr]+| --list| -v)*$)\b/
// A command that went into a folder outside the project (a small model copying the project's long
// path wrong, then lost in what it finds there): told where the project is.
function outsideNote(root, cmd) {
  const dirs = [...cmd.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|\S+)/g)].map((m) => m[1].replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, os.homedir()))
  const out = dirs.map((d) => path.resolve(root, d)).find((d) => d !== root && !d.startsWith(root + path.sep) && !readableOutside(d))
  return out ? `\n\n${prompt('agent/outside-project', { dir: out, root, wide: false })}` : ''
}

export function readOnlyCommand(cmd) {
  const c = String(cmd).trim()
  if (/[>`]|\$\(|<\(|\b(sudo|rm|mv|cp|tee|chmod|chown|dd|truncate|mkdir|touch|ln)\b|-delete\b|-exec|-ok\b|-fprint|-fls\b|--output\b|--pre\b|sed\s+-i|\bsort\b.*\s-o/.test(c)) return false // writes, or runs something else (git's --output, find's -fprint/-fls, rg's --pre)
  return c.split(/\s*(?:&&|\|\||[;|&\n])\s*/).every((part) => READ_ONLY.test(part)) // `a & b`, a new line: each its own command
}

// MCP servers' tools as the model sees them: one tool, mcp, whose description lists every server's
// tools by name with one line on what each does — not each tool's whole schema in every request
// (two browser servers' schemas alone were ~14k tokens a request). A tool's arguments come when
// they're needed: "describe" shows them, and a call whose arguments don't fit its schema gets the
// schema back with what's wrong (nothing is sent to the server). Sets s.mcpDirect
// (mcp__server__tool → { server, tool, def }: only to understand a call by that name — an older
// conversation's, or a model used to Claude Code's names) and s.mcpCatalog (with what each server
// says about using it: given with its first result, howTo).
export async function loadMcpTools(s, signal) {
  if (!s.mcp?.names.length) return Object.assign(s, { mcpDirect: new Map() })
  const catalog = await s.mcp.catalog(signal)
  const direct = new Map()
  for (const [server, { tools }] of catalog) {
    for (const t of tools) {
      let n = mcpName(server, t.name)
      if (direct.has(n)) n = `${n.slice(0, 57)}_${createHash('sha256').update(`${server}/${t.name}`).digest('hex').slice(0, 6)}` // cut to the same 64 characters as another
      direct.set(n, { server, tool: t.name, def: t })
    }
  }
  return Object.assign(s, { mcpDirect: direct, mcpCatalog: catalog })
}
// Tool names may only have letters, digits, _ and - (64 at most).
export const mcpName = (server, tool) => `mcp__${server}__${tool}`.replace(/[^\w-]/g, '_').slice(0, 64)

// The MCP servers (one tool for all of their tools), the memory and the skill loader; each only when
// there's something to offer.
export function extraTools(s) {
  const out = []
  const servers = s.mcp?.names ?? []
  if (servers.length) {
    const list = (n) => {
      const cfg = s.mcp.get(n)?.cfg ?? {}
      const tools = s.mcpCatalog?.get(n)?.tools
      const head = `${n}${cfg.description ? ` — ${cfg.description}` : ''}`
      return tools ? `${head}: ${tools.map((t) => t.name).join(', ')}` : `${head} (its tools aren't known yet: tool "list" shows them)`
    }
    out.push({ name: 'mcp', description: prompt('agent/tool-mcp', { servers: servers.map(list).join('\n') }), parameters: obj({ server: str, tool: str, arguments: { type: 'object' } }, ['server', 'tool']) })
  }
  if (s.memory) {
    out.push({
      name: 'memory',
      description: prompt('agent/tool-memory', { tags: s.memory.tagSummary() || '(none yet)' }),
      parameters: obj({ action: { type: 'string', enum: ['write', 'read', 'search', 'delete'] }, name: str, description: str, type: str, tags: str, scope: { type: 'string', enum: ['project', 'global'] }, content: str, query: str }, ['action']),
    })
  }
  const forModel = [...(s.skills?.values() ?? [])].filter((k) => k.use !== 'me') // "use: me" skills cost nothing here; "always" ones are in the system prompt, and listed so their files can be read
  if (forModel.length) {
    const skills = forModel.map((k) => `${k.name}: ${k.description}`).join('\n')
    out.push({ name: 'skill', description: prompt('agent/tool-skill', { skills }), parameters: obj({ name: str, file: str }, ['name']) })
  }
  if (!s.isSub && s.subagent) {
    const team = s.team?.() ?? []
    const model = { type: 'string', description: team.some((t) => t.jobs) ? 'Which helper does the job ("provider model" from "Your helpers"). Left out: the first helper.' : 'Which of your models does the job ("provider model" from "Your other models"). Left out: yours, or with images you can\'t see, the first of yours that can.' }
    const images = { type: 'array', items: str, description: 'Image paths or URLs for the helper to look at. Needs a model that sees images.' }
    out.push({ name: 'agent', get description() { return prompt('agent/tool-agent') }, parameters: obj({ description: str, prompt: str, ...(team.length && { model, images }) }, ['description', 'prompt']) })
  }
  return [...out, ...(s.director && !s.appendSystem ? s.director.toolDefs(s) : [])] // manage (director.js); not when a program gives the instructions (--append-system-prompt)
}

// todo: the model's checklist for this message, shown to the user each time it changes.
// Lenient: the list as JSON text, plain strings for items, "done" for completed.
const MARK = { pending: '☐', in_progress: '◐', completed: '☑', stuck: '⚠' }
// In the conversation: the whole plan when it's new (or its steps changed), else only the steps whose
// status changed, on one line; the whole of it stays in sight under the spinner (full screen).
// the plan for a program reading HeartCode (headless stream-json): its steps, and who's doing a part
export const sendTodos = (s) => !s.isSub && s.ui.event?.({ subtype: 'todos', todos: (s.chat.todos ?? []).map(({ content, status, why, by, byProvider }) => ({ content, status, ...(why && { why }), ...(by && { by: byProvider ? `${byProvider}/${by}` : by }) })) })
function showTodos(s, before, todos) {
  const paint = { pending: c.muted, in_progress: (x) => c.info(c.bold(x)), completed: (x) => c.faint(x), stuck: (x) => c.warn(x) }
  const item = (t) => paint[t.status](`${MARK[t.status]} ${t.content}`) + (t.status === 'stuck' && t.why ? c.warn(`: ${clip(t.why, 80)}`) : '') + (t.by ? c.faint(` · ${t.by}`) : '')
  // full screen, the same plan changed (most of its steps still in it): only what changed, on one line
  // (steps added, taken out, or whose status moved); the whole plan is pinned under the spinner
  const was = new Map((before ?? []).map((t) => [t.content, `${t.status}${t.why ?? ''}`]))
  const kept = todos.filter((t) => was.has(t.content)).length
  if (!s.ui.full || !before?.length || kept < Math.max(1, todos.length / 2)) return s.ui.print(todos.map((t) => `  ${item(t)}`).join('\n') || c.faint('  (todo list cleared)'))
  const now = new Set(todos.map((t) => t.content))
  const changes = [
    ...todos.filter((t) => was.get(t.content) !== `${t.status}${t.why ?? ''}`).map((t) => (was.has(t.content) ? item(t) : `${c.faint('+')} ${item(t)}`)),
    ...(before ?? []).filter((t) => !now.has(t.content)).map((t) => c.faint(`− ${t.content}`)),
  ]
  if (changes.length) s.ui.print(`  ${changes.join(c.faint(' · '))}`)
}
async function todoTool(s, args, signal, id) {
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
    .map((t) => (typeof t === 'string' ? { content: t, status: 'pending' } : { content: String(t?.content ?? t?.task ?? t?.title ?? ''), status: String(t?.status ?? 'pending'), ...(t?.why && { why: String(t.why).trim() }), ...(t?.model && { model: String(t.model) }), ...((t?.parallel === true || t?.parallel === 'true') && { parallel: true }), ...([t?.files ?? []].flat().filter(Boolean).length && { files: [t.files].flat().map(String) }) }))
    .filter((t) => t.content.trim())
    .map((t) => ({ ...t, status: /stuck|block|fail|struggl/i.test(t.status) ? 'stuck' : /done|complete/i.test(t.status) ? 'completed' : /progress|doing|active/i.test(t.status) ? 'in_progress' : 'pending' }))
    .map(({ why, ...t }) => (t.status === 'stuck' ? { ...t, why: why || 'no reason given' } : t)) // a reason only on a stuck step
  for (const t of todos) Object.assign(t, ((x) => (x?.by && !t.by ? { by: x.by, byProvider: x.byProvider } : {}))(s.chat.todos?.find((x) => x.content === t.content))) // the model a part was given to: kept when the plan is written again
  // newly stuck (or stuck for a new reason): the model says it's struggling. Counted per message; not
  // the same stuck step sent again with the rest of the list
  const before = new Map((s.chat.todos ?? []).map((t) => [t.content, t]))
  const newlyStuck = todos.filter((t) => t.status === 'stuck' && !(before.get(t.content)?.status === 'stuck' && before.get(t.content)?.why === t.why))
  showTodos(s, s.chat.todos, todos)
  s.chat.todos = todos
  sendTodos(s)
  s.todoTouched = true
  // a step it said it was stuck on, now done: what got it out is worth learning (agent.js)
  for (const t of todos) if (t.status === 'completed' && before.get(t.content)?.status === 'stuck') (s.unstuck ??= []).push({ step: t.content, why: before.get(t.content).why })
  if (newlyStuck.length) return `Todo list saved: ${todos.filter((x) => x.status === 'completed').length} of ${todos.length} done.\n\n${await stuckSaid(s, newlyStuck[0].content, newlyStuck[0].why, signal, id)}`
  const parts = await runParts(s, todos, signal, id)
  const done = todos.filter((t) => t.status === 'completed').length
  const next = todos.find((t) => t.status !== 'completed')
  // a plan of several parts with none given to another model or run side by side: asked once a message
  const open = todos.filter((t) => t.status === 'pending')
  const askSplit = !parts && !s.isSub && !s.splitAsked && open.length >= 3 && !todos.some((t) => t.parallel || t.model) && s.subagent && s.team?.().length && s.ui.permission !== 'plan'
  if (askSplit) s.splitAsked = true
  // a plan of a few steps made without looking anything up: asked once a message whether it uses something to read up on
  const askResearch = !parts && !s.isSub && !s.researchAsked && !s.lookedUp && !s.research?.lookedUp && open.length >= 2
  if (askResearch) s.researchAsked = true
  const check = askSplit || askResearch ? `\n\n${prompt('agent/plan-check', { split: askSplit, research: askResearch })}` : ''
  return `Todo list saved: ${done} of ${todos.length} done.${next ? ` Next: ${next.content}` : ''}${parts ? `\n\n${parts}` : ''}${check}`
}

// The model says it's stuck on a step (todo status "stuck", with why). Believed: a model rarely says
// so when it isn't (a "done" is what gets checked). The 1st time this message: told to change its
// approach; the 2nd: a second opinion from another of your models (a Big & hard helper first),
// which looks into it without changing files; the 3rd: the next of your models takes over (agent.js).
// Also when its final answer says it didn't manage (agent.js). Returns what to tell it.
export async function stuckSaid(s, step, why, signal, id, answer = false) {
  const t = { content: step, why }
  const n = (s.stuckReports = (s.stuckReports ?? 0) + 1)
  const say = (more = {}) => (more.last && (s.toldLast = true), prompt('agent/stuck', { why, last: false, advice: '', adviser: '', ...more, plain: !answer && !more.advice && !more.last, answer: answer && !more.advice && !more.last }))
  log('stuck', `${s.client?.model} says it's stuck (${n}): ${t.content} — ${t.why}`)
  s.ui.event?.({ subtype: 'stuck', step: t.content, why: t.why, count: n, model: `${s.client?.provider}/${s.client?.model}` })
  if (!s.isSub) (s.troubles ??= []).push({ model: s.client?.model, step: t.content, why: t.why })
  // models it could go to: yours, not this one, not one given up on this message
  const r = s.client?.rotation
  const others = (r?.list ?? []).filter((x) => x !== r.list[r.at] && !s.gaveUp?.has(`${x.provider}/${x.model}`)).length
  if (n >= 3 && !s.isSub && others) {
    // two models have taken over already this message: no more; it says plainly what blocks it
    if ((s.stuckHandovers ?? 0) >= 2) return say({ last: true })
    s.stuckSelf = `said it's stuck ${n} times (last: "${clip(t.content, 60)}": ${clip(t.why, 120)})`
    return '(Noted. Another of your models takes over from here.)'
  }
  if (n >= 3 && !s.isSub) return say({ last: true }) // no model left to take over (or the others were stuck too): it says plainly what blocks it
  let advice = ''
  const other = n === 2 && !s.isSub && s.subagent && secondOpinionModel(s)
  if (other) {
    s.ui.step('stuck', `asking ${other.model} for a second opinion`)
    const tried = (s.ran ?? []).slice(-12).map((r) => `- ${r.command} → ${r.result}`).join('\n')
    try {
      advice = await s.subagent({ prompt: prompt('agent/second-opinion', { task: s.task ?? '', step: t.content, why: t.why, tried }), model: `${other.provider} ${other.model}`, description: 'second opinion' }, signal, id)
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) throw e
      advice = `error: ${e.message}`
    }
    if (failed(advice)) advice = ''
  }
  return say({ advice: clip(advice, 4000), adviser: other ? `${other.provider} ${other.model}` : '' })
}
// Another of your models for a second opinion: a Big & hard helper, else your first helper or model that isn't this one.
function secondOpinionModel(s) {
  const me = (t) => t.model === s.client?.model && (t.provider ?? s.client?.provider) === s.client?.provider
  const team = (s.team?.() ?? []).filter((t) => !me(t) && !s.gaveUp?.has(`${t.provider ?? s.client?.provider}/${t.model}`))
  const helpers = team.filter((t) => t.jobs)
  return helpers.find((t) => t.jobs.includes('hard')) ?? helpers[0] ?? (team.some((t) => t.jobs) ? null : team[0]) ?? null
}

// The plan's parts marked parallel (or given to another model): each started at once as a helper
// on its model, all at the same time, each changing only the files its part owns; marked done when
// it reports back. What they did, for the model to put together and check. '' when none.
async function runParts(s, todos, signal, id) {
  const parts = todos.filter((t) => t.status === 'pending' && (t.parallel || t.model))
  if (!parts.length || s.isSub || !s.subagent || s.ui.permission === 'plan') return ''
  // a model that isn't one of yours (a name made up, the product's own name): the part runs on this one
  const team = s.team?.() ?? []
  const yours = [{ provider: s.client?.provider, model: s.client?.model }, ...(team.some((t) => t.jobs) ? team.filter((t) => t.jobs) : team)] // with helpers ticked: those (only they can be started)
  const known = (m) => yours.some((y) => `${y.provider} ${y.model}` === m || y.model === m || m.endsWith(` ${y.model}`))
  const unknown = [...new Set(parts.filter((t) => t.model && !known(t.model)).map((t) => t.model))]
  for (const t of parts) if (t.model && !known(t.model)) delete t.model
  const shown = todos.map((t) => ({ ...t })) // as printed: after the parts, what they changed
  for (const t of parts) t.status = 'in_progress'
  log('parts', parts.map((t) => `${t.content}${t.model ? ` (${t.model})` : ''}${t.files ? ` [${t.files.join(', ')}]` : ''}`))
  s.ui.step('parts', `${parts.length} part${parts.length > 1 ? 's' : ''} at once: ${parts.map((t) => `${clip(t.content, 40)}${t.model ? ` (${t.model})` : ''}`).join(' · ')}`)
  const plan = todos.map((t) => `- ${t.content}`).join('\n')
  const choices = (s.chat?.choices ?? []).join('; ')
  const reports = await Promise.all(
    parts.map(async (t) => {
      const brief = prompt('agent/part', { task: s.task ?? '', plan, part: t.content, files: (t.files ?? []).join(', '), choices })
      let out
      try {
        out = await s.subagent({ prompt: brief, model: t.model, description: clip(t.content, 40), ownFiles: t.files, part: t }, signal, id) // part: its model is noted on it (by)
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e
        out = `error: ${e.message}`
      }
      t.status = failed(out) ? 'pending' : 'completed'
      return `## ${t.content}${t.model ? ` (${t.model})` : ''}: ${failed(out) ? 'not done' : 'done'}\n${clip(out, 3000)}`
    }),
  )
  s.chat.todos = todos
  showTodos(s, shown, todos)
  sendTodos(s)
  return prompt('agent/parts-done', { reports: reports.join('\n\n'), unknown: unknown.join(', '), models: yours.map((y) => `${y.provider} ${y.model}`).join(', ') })
}

// ask_user: questions for the user mid-task, each with choices (and their own answer); several are
// tabs in one dialog (←/→ between them, then Send). Nobody answers for ASK_WAIT seconds (each key
// starts the wait again): the recommended ones, the first of each, are taken for what's unanswered.
const ASK_WAIT = 30
const listOf = (v) => {
  if (typeof v !== 'string') return [v ?? []].flat()
  try {
    return [JSON.parse(v)].flat()
  } catch {
    return v.split('\n')
  }
}
async function askUser(s, args) {
  const qs = listOf(args.questions ?? [args]).map((q) => ({
    question: String(q?.question ?? '').trim(),
    header: String(q?.header ?? '').trim(),
    multi: q?.multiple === true || q?.multiple === 'true',
    emphasis: q?.emphasis === true || q?.emphasis === 'true',
    items: listOf(q?.options).map((o) => (typeof o === 'string' ? { label: o.trim() } : { label: String(o?.label ?? o?.value ?? '').trim(), desc: o?.description })).filter((o) => o.label),
  }))
  if (!qs.length || qs.some((q) => !q.question)) return 'error: ask_user needs "question" (or "questions", each with its "question")'
  if (s.ui.noUser || s.isSub) return prompt('agent/no-answer')
  // always a recommended answer (the first option): taken when nobody answers (ASK_WAIT seconds without a key)
  if (qs.some((q) => !q.items.length)) return 'error: ask_user needs options for every question: 2-4 short answers, your recommended one first (the user can still type their own)'
  s.askedUser = true // asked through the dialog this message (not as text: see askedInText)
  for (const q of qs) {
    q.items[0].desc = ['recommended', q.items[0].desc].filter(Boolean).join(' · ')
    q.own = { label: 'Something else', desc: 'type an answer', own: true }
  }
  s.ui.stopSpin()
  const tabbed = qs.length > 1 && s.ui.full
  const said = qs.map(() => null) // each: { got: [items], text: own answer, auto }
  const answerOf = (a) => (a ? [...a.got.filter((x) => !x.own).map((x) => x.label), a.text].filter(Boolean).join(', ') : '')
  const tabs = (at) =>
    [...qs.map((q, i) => `${said[i] ? '✓' : '○'} ${q.header || clip(q.question, 18)}`), '  Send']
      .map((t, i) => (i === at ? c.select(c.bright(c.bold(` ${t} `))) : said[i] ? c.text(` ${t} `) : c.faint(` ${t} `))) // its own color on the highlight: the terminal's may not show on it (light theme, dark terminal)
      .join(c.ghost('│'))
  let auto = false
  for (let i = 0; i < qs.length || tabbed; ) {
    if (i === qs.length) {
      // the last tab: every answer, sent with Enter (or after ASK_WAIT seconds)
      const body = qs.map((q, j) => `${q.question} ${c.faint('›')} ${answerOf(said[j]) || `${q.items[0].label} ${c.faint('(recommended)')}`}`).join('\n')
      const send = { label: 'Send answers', desc: 'or ← to change one' }
      const got = await s.ui.pick('Send these answers?', [send], { body, tabs: tabs(i), nav: true, quiet: true, auto: { item: send, secs: ASK_WAIT, say: 'the answers are sent' } })
      if (got?.nav) {
        i = Math.min(qs.length, Math.max(0, i + got.nav)) // → on Send: stays there
        continue
      }
      if (!got) return prompt('agent/no-answer')
      auto = s.ui.autoPicked
      break
    }
    const q = qs[i]
    const items = [...q.items, q.own]
    const typed = Boolean(q.own.text?.trim()) // typed in its row, then off to another tab without Enter: that row again
    for (const x of items) x.current = typed ? x === q.own : Boolean(said[i]?.got.includes(x)) // back on a tab: its answer selected
    const got = await s.ui.pick(q.question, items, { multi: q.multi, tabs: tabbed ? tabs(i) : '', nav: tabbed, quiet: s.ui.full, auto: { item: q.items[0], secs: ASK_WAIT, say: tabbed ? 'the recommended answers are sent' : 'the recommended answer is chosen' } })
    if (got?.nav) {
      i = Math.min(qs.length, Math.max(0, i + got.nav))
      continue
    }
    if (!got) return prompt('agent/no-answer') // Esc: the whole dialog
    const list = [got].flat().filter(Boolean)
    let text = ''
    if (list.some((x) => x.own)) {
      // typed in its row (full screen); without full screen, asked for now
      text = q.own.text?.trim() || ((await s.ui.ask(`${c.bold('Answer')} ${c.dim('›')} `, { initial: said[i]?.text ?? '' }))?.trim() ?? '')
      Object.assign(q.own, { text, desc: text ? `› ${text}` : 'type an answer' })
      if (!text && list.length === 1) continue // nothing typed: the same question again
    }
    if (s.ui.autoPicked) {
      auto = s.ui.autoPicked
      if (auto === 'theirs' || !said[i]) said[i] = { got: list, text, auto: auto !== 'theirs' } // what's ticked or typed is theirs; answered before (back on its tab): theirs stays
      break
    }
    said[i] = { got: list, text }
    i++
  }
  // nobody there: what's unanswered gets the recommended one
  for (const [i, q] of qs.entries()) if (!answerOf(said[i])) said[i] = { got: [q.items[0]], text: '', auto: true }
  const answers = qs.map((q, i) => answerOf(said[i]))
  for (const [i, q] of qs.entries()) log('ask', q.question, answers[i])
  if (s.ui.full) s.ui.print(qs.map((q, i) => `  ${c.dim(q.question)} ${c.dim('›')} ${c.bright(answers[i])}${said[i].auto ? c.faint(' (recommended, no answer in time)') : ''}`).join('\n')) // each question with its answer
  // how the user wants the work done: kept with the conversation (a "continue" later still knows), the
  // first such question of a new message starts them afresh; steers the checks and reviews
  for (const [i, q] of qs.entries()) {
    if (!q.emphasis || !answers[i] || !s.chat) continue
    if (!s.choicesFresh) s.chat.choices = []
    s.choicesFresh = true
    s.chat.choices.push(`${q.question} → ${answers[i]}`)
  }
  const why = auto === 'nobody' ? "nobody can answer (the input isn't a terminal)" : `no answer in ${ASK_WAIT} seconds`
  if (qs.length === 1) {
    if (auto === 'theirs') return `Not sent within ${ASK_WAIT} seconds, so what the user had chosen was taken: ${answers[0]}`
    if (auto) return `${why[0].toUpperCase()}${why.slice(1)}, so your recommended one was taken: ${answers[0]}`
    return `The user answered: ${answers[0]}`
  }
  return `The user answered:\n${qs.map((q, i) => `- ${q.question} → ${answers[i]}${said[i].auto ? ` (${why}: your recommended one)` : ''}`).join('\n')}`
}

async function webTool(s, name, args, signal) {
  const what = name === 'web_search' ? String(args.query ?? '') : String(args.url ?? '')
  if (!what.trim()) return `error: ${name} needs ${name === 'web_search' ? '"query"' : '"url"'}`
  s.lookedUp = true // looked something up this message (the plan check doesn't ask then)
  if (s.research) s.research.lookedUp = true // this message's research, shared with its helpers: theirs count too
  const ok = await s.ui.confirm(name === 'web_search' ? `Search the web for ${c.bold(what)}?` : `Fetch ${c.bold(what)}?`, 'read')
  if (ok !== true) return declined(s, ok, 'The user declined this.')
  // what this message's research is for: the page's look_for, else the last search, else the task
  const purpose = String(args.look_for ?? '').trim() || s.lastQuery || String(s.task ?? '').split('\n')[0].slice(0, 160)
  if (name === 'web_search') {
    s.lastQuery = what
    // already read for this project: offered first (the model decides: use it, or search fresh)
    const saved = !args.fresh && s.root && !s.noResearch ? findResearch(s.root, what, 5).filter((r) => r.kind !== 'search') : []
    if (saved.length) {
      log('research', `"${what}": ${saved.length} saved page(s) offered first`)
      return prompt('agent/research-saved', { query: what, pages: saved.map((r) => `- ${r.title} — ${r.url} (read ${r.fetched}${r.used_for ? `; used for: ${r.used_for}` : ''}) → ${r.file}`).join('\n') })
    }
    s.ui.spinner(`searching: ${clip(what, 60)}`)
    const out = await webSearch(what, { signal })
    if (s.root && !s.noResearch && !/^(error:|no results)/.test(out)) {
      const { file } = saveSearch(s.root, what, out)
      s.research?.push({ kind: 'search', file, title: `Search: ${what}` })
    }
    return out
  }
  s.ui.spinner(`fetching ${clip(what, 60)}`)
  if (!s.root || s.noResearch) return await webFetch(what, { start: args.start, signal }) // nothing kept (--no-memory)
  const page = await fetchPage(what, { signal })
  if (page.error) return `error: ${page.error}`
  const head = `${page.ok ? '' : `error: HTTP ${page.status}\n`}${page.url !== page.asked ? `(redirected to ${page.url})\n` : ''}`
  if (!page.ok || !page.text.trim()) return `${head}${page.text.slice(0, MAX_PAGE) || '(empty page)'}` // an error page isn't worth keeping
  const { file, bodyLine } = savePage(s.root, { url: page.url, title: page.title, text: page.text, query: purpose })
  s.research?.push({ kind: 'page', file, url: page.url, title: page.title || page.url })
  const id = runningCall.getStore()
  if (id && s.chat) (s.chat.outputs ??= {})[id] = file // its result, cut from the conversation later, points here
  log('research', `saved ${page.url} → ${file}`)
  // "start": the part from there on, as before (an older conversation's way of reading on)
  if (Number(args.start) > 0) return `${head}${await webFetch(page.url, { start: args.start, signal })}\n\n(All of this page is saved in ${file}.)`
  return `${head}${page.title ? `# ${page.title}\n` : ''}${page.url}\n\n${pageView(page.text, { lookFor: args.look_for, file, bodyLine })}`
}
const MAX_PAGE = 10_000

function memoryTool(s, args) {
  const m = s.memory
  if (!m) return 'error: there is no memory here'
  const name = String(args.name ?? '')
  switch (args.action) {
    case 'write': {
      if (!args.content && !args.description) return 'error: write needs at least content or a description'
      if (!String(args.name ?? '').trim() && !String(args.description ?? '').trim()) return 'error: write needs a "name" (or a description to name it by). Nothing was saved.'
      if (String(args.name ?? '').trim() && fullSlug(args.name).length > 60) return 'error: the name is too long (60 characters at most, as a file name). Nothing was saved.'
      const isNew = !m.read(args.name || args.description)
      const n = m.write(args)
      // a new note that says much the same as one there already: said, so they're merged, not piled up
      const words = new Set(keywords(`${n} ${args.description ?? ''}`))
      const overlap = (x) => {
        const theirs = new Set(keywords(`${x.name} ${x.description}`))
        return [...theirs].filter((w) => words.has(w)).length / Math.max(1, Math.min(theirs.size, words.size))
      }
      const similar = isNew && words.size >= 3 ? m.list().filter((x) => x.name !== n && overlap(x) >= 0.6).slice(0, 3) : []
      return `Saved [[${n}]]${m.read(n)?.scope === 'global' ? ' (global)' : ''}.${similar.length ? ` Similar notes exist: ${similar.map((x) => `[[${x.name}]] — ${x.description}`).join('; ')}. If one says the same thing, merge them: write the merged note under one name and delete the other.` : ''}`
    }
    case 'read': {
      if (!name.trim()) return 'error: read needs the note\'s "name" (search finds notes by words).'
      const n = m.read(name)
      if (!n) return `error: no note [[${slug(name)}]]. ${m.search(name).slice(0, 5).map((x) => `[[${x.name}]]`).join(', ') || 'Search the memory to find notes.'}`
      return `[[${n.name}]] (${n.scope === 'global' ? 'global' : 'this project'}, ${n.type}${n.tags.length ? `; ${n.tags.join(', ')}` : ''}): ${n.description}\n\n${n.body}${n.backlinks.length ? `\n\nLinked from: ${n.backlinks.join(', ')}` : ''}`
    }
    case 'search': {
      const hits = m.search(args.query ?? name)
      return hits.length ? hits.slice(0, 20).map((n) => `[[${n.name}]] — ${n.description} (${[n.scope === 'global' && 'global', ...n.tags].filter(Boolean).join(', ')})`).join('\n') : 'no notes match'
    }
    case 'delete':
      if (!name.trim()) return 'error: delete needs the note\'s "name". Nothing was deleted.'
      return m.delete(name, args.scope) ? `Deleted [[${slug(name)}]].` : `error: no note [[${slug(name)}]]`
    default:
      return 'error: action must be write, read, search or delete'
  }
}

// Lenient about slips in names: "chrome-devtools:", "evaluate_script'", no server when there's one.
const bare = (v) => String(v ?? '').trim().replace(/^["'`]+|["'`:;,.]+$/g, '')

// A server's own words on using it (its MCP "instructions"): with its first result in this
// conversation, not in every request's system prompt.
function howTo(s, server, out) {
  const said = s.mcpCatalog?.get(server)?.instructions
  if (!said || typeof out !== 'string' || (s.mcpTold ??= new Set()).has(server)) return out
  s.mcpTold.add(server)
  return `${out}\n\n${prompt('agent/mcp-instructions', { server, instructions: said })}`
}

async function mcpTool(s, args, signal) {
  return howTo(s, bare(args?.server) || (s.mcp?.names.length === 1 ? s.mcp.names[0] : ''), await mcpCall(s, args, signal))
}
async function mcpCall(s, args, signal) {
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
    const t = tools.find((x) => x.name === (a.name ?? a.tool))
    return t ? describeTool(t) : `error: ${server.name} has no tool "${a.name ?? a.tool}"; tool "list" shows its tools`
  }
  return callMcp(s, server, tool, a, signal)
}

// What's wrong with a call's arguments for a tool's JSON schema (the common part of it: required,
// unknown names, types, enums), or [] when they fit. Unknown names get the closest real one.
export function argProblems(schema, a) {
  const props = schema?.properties ?? {}
  const out = []
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['"arguments" must be an object']
  for (const k of schema?.required ?? []) if (a[k] === undefined) out.push(`"${k}" is required`)
  const near = (k) => {
    const d = (x, y) => {
      const m = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)])
      for (let j = 1; j <= y.length; j++) m[0][j] = j
      for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
      return m[x.length][y.length]
    }
    const best = Object.keys(props).map((p) => [p, d(k.toLowerCase(), p.toLowerCase())]).sort((x, y) => x[1] - y[1])[0]
    return best && best[1] <= Math.max(2, Math.floor(best[0].length / 3)) ? ` (did you mean "${best[0]}"?)` : ''
  }
  const typeOk = (t, v) => ({ string: typeof v === 'string', number: typeof v === 'number', integer: Number.isInteger(v), boolean: typeof v === 'boolean', array: Array.isArray(v), object: v !== null && typeof v === 'object' && !Array.isArray(v), null: v === null })[t] ?? true
  for (const [k, v] of Object.entries(a)) {
    const p = props[k]
    if (!p) {
      if (schema?.properties && schema.additionalProperties !== true) out.push(`"${k}" is not one of its arguments${near(k)}`)
      continue
    }
    const types = [p.type ?? []].flat()
    if (types.length && !types.some((t) => typeOk(t, v))) out.push(`"${k}" must be ${types.join(' or ')}, not ${Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v}`)
    if (p.enum && !p.enum.includes(v)) out.push(`"${k}" must be one of ${p.enum.map((x) => JSON.stringify(x)).join(', ')}`)
  }
  return out
}

// A call's arguments mended where the tool's schema says what was meant, so it isn't sent back over
// a slip any model makes: a name in the wrong case (msgId → msgid), an unknown name when exactly one
// required one is missing (expression → function), one value where a list is wanted, a number or
// true/false written as text, a required one left out that an earlier call to this server gave (or
// its result marked "[selected]": the page a browser has open). Returns { a, fixed } (what changed).
export function repairArgs(schema, a, known = {}) {
  const props = schema?.properties ?? {}
  if (!a || typeof a !== 'object' || Array.isArray(a) || !schema?.properties) return { a, fixed: [] }
  a = { ...a }
  const fixed = []
  const rename = (k, to) => ((a[to] = a[k]), delete a[k], fixed.push(`"${k}" → "${to}"`))
  for (const k of Object.keys(a)) {
    const to = !props[k] && Object.keys(props).find((p) => p.toLowerCase() === k.toLowerCase())
    if (to && a[to] === undefined) rename(k, to)
  }
  for (const k of (schema.required ?? []).filter((k) => a[k] === undefined && known[k] !== undefined)) {
    a[k] = known[k]
    fixed.push(`"${k}": ${JSON.stringify(known[k])} (from the last call)`)
  }
  const unknown = Object.keys(a).filter((k) => !props[k])
  const missing = (schema.required ?? []).filter((k) => a[k] === undefined)
  const fits = (k, v) => { const ty = [props[k]?.type ?? []].flat(); return !ty.length || ty.includes(Array.isArray(v) ? 'array' : typeof v) || ty.includes('array') || (Number.isInteger(v) && ty.includes('integer')) }
  if (unknown.length === 1 && missing.length === 1 && fits(missing[0], a[unknown[0]])) rename(unknown[0], missing[0])
  for (const [k, v] of Object.entries(a)) {
    const types = [props[k]?.type ?? []].flat()
    if (!types.length || v === undefined || v === null) continue
    if (types.includes('array') && !Array.isArray(v)) (a[k] = [v]), fixed.push(`"${k}" made a list`)
    else if ((types.includes('number') || types.includes('integer')) && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) && !types.includes('string')) (a[k] = Number(v)), fixed.push(`"${k}" made a number`)
    else if (types.includes('boolean') && (v === 'true' || v === 'false') && !types.includes('string')) (a[k] = v === 'true'), fixed.push(`"${k}" made ${v}`)
  }
  return { a, fixed }
}

// One tool's description and arguments, for the model (describe, or a call that didn't fit).
const describeTool = (t) => `${t.name}: ${t.description ?? ''}\nArguments (JSON schema): ${JSON.stringify(t.inputSchema ?? {})}`

// One MCP tool call. Asked about like a command, unless the server marks the tool read-only.
async function callMcp(s, server, tool, a, signal) {
  if (!allowed(s, mcpName(server.name, tool))) return `error: the tool ${mcpName(server.name, tool)} is not allowed here`
  let def = (server.tools ?? s.mcpCatalog?.get(server.name)?.tools)?.find((t) => t.name === tool)
  if (!def) {
    const tools = await server.listTools(signal).catch(() => null)
    def = tools?.find((t) => t.name === tool)
    if (tools && !def) {
      const close = tools.filter((t) => t.name.includes(tool) || tool.includes(t.name)).map((t) => t.name)
      return `error: ${server.name} has no tool "${tool}".${close.length ? ` Did you mean ${close.join(' or ')}?` : ''} Its tools: ${tools.map((t) => t.name).join(', ')}`
    }
  }
  // slips mended first (said in the result, so it's done right next time); what still doesn't fit:
  // the schema comes back with what's wrong, and nothing is sent
  const known = (server.lastArgs ??= {}) // values earlier calls to this server gave (helpers share it)
  const mended = def?.inputSchema ? repairArgs(def.inputSchema, a, known) : { a, fixed: [] }
  a = mended.a
  const problems = def?.inputSchema ? argProblems(def.inputSchema, a) : []
  if (problems.length) return `error: ${server.name} · ${tool} wasn't called — ${problems.join('; ')}.\n${describeTool(def)}\nCall it again with arguments that fit.`
  // a tool its server marks read-only isn't asked about (reading isn't, in any mode; headless
  // declines what it would ask, so a browser's snapshot must not be); any other like a command
  if (!def?.annotations?.readOnlyHint) {
    if (s.ui.permission === 'plan') return prompt('agent/plan-refused', { command: false }) // might change something
    const ok = await s.ui.confirm(`Use ${server.name} → ${tool}?`, 'command')
    if (ok !== true) return declined(s, ok, 'The user declined this call.')
  }
  const done = await s.mcpGate?.() // a helper may be using the MCP servers (a browser): its turn first
  s.ui.spinner(`${server.name} · ${tool}`)
  const started = Date.now()
  let r
  try {
    r = await server.call(tool, a, signal)
  } finally {
    done?.()
  }
  const parts = r.content ?? []
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  for (const [k, v] of Object.entries(a)) if (v !== null && typeof v !== 'object') known[k] = v
  const selected = /(\d+):[^\n]*\[selected\]/.exec(text)?.[1] // a browser's open page, after new_page/select_page
  if (selected) known.pageId = Number(selected)
  // Its images: the ones it returned, and image files it made while it ran (a path in its text to a
  // file written during the call: "Saved screenshot to /…/shot.webp"; an old one it only mentions
  // isn't one). Each is a file too, so a model that can't see them can have one that can look.
  const made = [...new Set([...text.matchAll(/(?:^|[\s"'`(])((?:\/|~\/)[^\s"'`)]+\.(?:png|jpe?g|gif|webp))\b/gi)].map((m) => m[1].replace(/^~(?=\/)/, os.homedir())))].filter((f) => {
    try {
      return fs.statSync(f).mtimeMs >= started - 1000
    } catch {
      return false
    }
  })
  const returned = parts.filter((p) => p.type === 'image' && p.data).map((p, i) => ({ p, file: saveOutput(s.chat?.id, `${tool}-${i + 1}`, Buffer.from(p.data, 'base64'), (p.mimeType ?? 'image/png').split('/')[1].replace('jpeg', 'jpg')) }))
  const files = [...returned.map((x) => x.file).filter(Boolean), ...made]
  s.toolImages ??= new Set()
  for (const f of files) s.toolImages.add(f) // may be sent to a helper (agent images)
  let note = ''
  if ((files.length || returned.length) && s.strat?.vision) {
    const left = []
    const shown = (s.pendingImages ??= []).length
    for (const { p, file } of returned) if (!file) s.pendingImages.push({ url: `data:${p.mimeType ?? 'image/png'};base64,${p.data}`, file: '(not saved)' }) // couldn't be saved: shown as it came
    for (const f of files) {
      try {
        s.pendingImages.push({ url: imageUrl(f), file: f })
      } catch (e) {
        left.push(e.message)
      }
    }
    note = `\n(${s.pendingImages.length - shown} image(s): shown to you in the next message${left.length ? `; not shown: ${left.join('; ')}` : ''})`
  } else if (files.length && s.team?.().some((t) => t.images)) note = `\n${prompt('agent/tool-images', { files: files.join('\n'), unseen: true })}`
  else if (files.length && s.describeFor) note = `\n${await s.describeFor(files).catch((e) => `(couldn't have the image(s) described: ${e.message})`)}`
  else if (files.length) note = `\n(${files.length} image(s) not shown: this model can't see images)`
  const mendNote = mended.fixed.length ? `\n(HeartCode corrected the arguments: ${mended.fixed.join('; ')}. Use them that way next time.)` : ''
  return `${r.isError ? 'error: ' : ''}${text || '(no text)'}${note}${mendNote}`
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
  if (!Array.isArray(edits)) edits = [{ search: args.search, replace: args.replace, start_line: args.start_line, end_line: args.end_line }]
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
        if (fs.statSync(abs).size >= 1_000_000) return false
        const buf = fs.readFileSync(abs)
        return !isBinary(buf) && buf.toString('utf8').includes(search) // a binary file is never edited as text
      } catch {
        return false
      }
    })
    return hits.length === 1 ? hits[0] : null
  }
  for (const [i, e] of edits.entries()) {
    const { search: s0, replace: r0, path: p0, start_line: a0, end_line: b0 } = normalize(e ?? {})
    const search = String(s0 ?? '')
    const given = p0 ?? args.path
    const label = edits.length > 1 ? `edit ${i + 1} of ${edits.length}: ` : ''
    // no "replace" at all isn't "replace with nothing": a model that left it out would delete code
    // (one did). Deleting is an explicit "replace": "".
    if (r0 === undefined || r0 === null) return `error: ${label}"replace" is missing: give the new text (or "replace": "" to delete the lines). Nothing was changed.`
    if (typeof r0 !== 'string' && !(Array.isArray(r0) && r0.every((l) => typeof l === 'string'))) return `error: ${label}"replace" must be text, a string. Nothing was changed.`
    const replace = Array.isArray(r0) ? r0.join('\n') : r0

    // Line-range edit: given start_line (and optionally end_line), replace exactly those lines —
    // no text to reproduce, so a weak model that can't copy the file byte-for-byte can still edit it.
    if (a0 !== undefined && a0 !== null && String(a0).trim() !== '') {
      const rel = given && fs.existsSync(resolveIn(root, given)) ? path.relative(root, resolveIn(root, given)) : null
      if (!rel) return `error: ${label}${given ? `${given} does not exist; use write_file to create it` : 'start_line needs a "path"'}. Nothing was changed.`
      const lines = textOf(rel).split('\n')
      const a = Math.trunc(Number(a0))
      const b = b0 === undefined || b0 === null || String(b0).trim() === '' ? a : Math.trunc(Number(b0))
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a || a > lines.length)
        return `error: ${label}start_line ${a0}/end_line ${b0 ?? a0} is out of range; ${rel} has ${lines.length} lines (read_file to see them). Nothing was changed.`
      lines.splice(a - 1, Math.min(b, lines.length) - a + 1, ...(replace === '' ? [] : replace.split('\n'))) // "" deletes the lines

      files.get(rel).text = lines.join('\n')
      s.editFails?.delete(rel) // it landed: clear the miss count for this file
      continue
    }

    if (!search.trim()) return `error: ${label}give "search" (the exact text to find) or "start_line"/"end_line" (the line numbers to replace). Nothing was changed.`
    let rel = given && fs.existsSync(resolveIn(root, given)) ? path.relative(root, resolveIn(root, given)) : null
    let r = rel ? applyEdit(textOf(rel), search, replace) : null
    if (!r || r.error) {
      const other = search.trim() && holder(search)
      // no path given: the one file that has the text; a path given: that file only (the other is named)
      if (other && other !== rel && !given) [rel, r] = [other, applyEdit(textOf(other), search, replace)]
      else if (other && other !== rel) return `error: ${label}${rel ? `the search text isn't in ${given}` : `${given} does not exist`}, but the text is in ${other}: give that path if that's the file to change. Nothing was changed.`
    }
    if (!rel) return `error: ${label}${given ? `${given} does not exist; use write_file to create it` : 'no "path" given, and its search text is not in exactly one file'}. Nothing was changed.`
    if (r.error) {
      // a second miss on the same file: show it, numbered, so the model can copy an exact block or
      // rewrite it instead of guessing the search text over and over
      const fails = (s.editFails ??= new Map())
      const n = (fails.get(rel) ?? 0) + 1
      fails.set(rel, n)
      return `error: ${label}${r.error}. Nothing was changed.${n >= 2 ? fileToCopy(root, rel, search) : ''}`
    }
    files.get(rel).text = r.text
  }
  const out = []
  for (const [rel, f] of files) {
    if (f.text === undefined) continue
    const res = await proposeWrite(s, rel, f.old, f.text)
    if (res.status === 'applied') s.editFails?.delete(rel) // it worked: start the fail count over
    out.push(writeResult(rel, res) + (res.status === 'applied' ? `\nNow:\n${excerpt(res.text, res.ops)}` : ''))
  }
  return out.join('\n\n')
}

// After an edit keeps missing: the file with line numbers (the whole thing if short, else the lines
// around where the search text most nearly fits) so the model can copy an exact block or write_file.
function fileToCopy(root, rel, search) {
  let text
  try {
    text = fs.readFileSync(resolveIn(root, rel), 'utf8')
  } catch {
    return ''
  }
  const lines = text.split('\n')
  let a = 0
  let b = lines.length
  if (lines.length > 150) {
    const at = closest(lines, trimBlank(search.split('\n')))
    const c = at < 0 ? 0 : at
    a = Math.max(0, c - 8)
    b = Math.min(lines.length, c + trimBlank(search.split('\n')).length + 8)
  }
  const where = lines.length > 150 ? `${rel} around there` : `all of ${rel}`
  return `\nThis edit has missed twice. Stop guessing the SEARCH text. Here is ${where}, with line numbers. Easiest: call edit_file again with start_line and end_line (the line numbers below) and the new "replace" text — no search needed. Or copy an exact block (without the "N| " prefixes) for SEARCH, or use write_file for the whole file:\n${numberLines(lines.slice(a, b), a + 1)}`
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
  const seen = new Set()
  for (const op of ops) {
    const abs = resolveIn(s.root, op.path)
    const rel = path.relative(s.root, abs)
    // each file once: a second section for it would be worked out from the original and undo the first
    if (seen.has(rel)) return `error: the patch changes ${op.path} twice; put all its changes in one section. Nothing was changed.`
    seen.add(rel)
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
    if (op.type === 'add') {
      if (old !== null) return `error: ${op.path} already exists (*** Add File: is for new files; use *** Update File: to change it). Nothing was changed.`
      plan.push([rel, '', op.content.join('\n') + '\n'])
      continue
    }
    if (old === null) return `error: ${op.path} does not exist${op.type === 'update' ? ' (use *** Add File: to create it)' : ''}. Nothing was changed.`
    if (op.type === 'delete') {
      plan.push([rel, old, null])
      continue
    }
    const r = applyChunks(old, op.chunks)
    if (r.error) return `error: ${op.path}: ${r.error}. Nothing was changed.`
    if (op.moveTo) {
      const dest = path.relative(s.root, resolveIn(s.root, op.moveTo))
      if (dest === rel) plan.push([rel, old, r.text]) // moved onto itself: just the change
      else if (fs.existsSync(resolveIn(s.root, op.moveTo)) || seen.has(dest)) return `error: ${op.moveTo} already exists (or the patch writes it twice); a move doesn't overwrite a file. Nothing was changed.`
      else (seen.add(dest), plan.push([dest, '', r.text], [rel, old, null]))
    }
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
// The tool call running now (its id), through everything it does: an editor's permission prompt
// names that call, also with several at once (helpers).
export const runningCall = new AsyncLocalStorage()
// A tool's result that is HeartCode's error, not the tool's output (command output starts with
// "exit code", a file's with line numbers).
export const failed = (out) => /^error: /.test(String(out))
// A call that wasn't done (held for a plan, plan mode, a hook, another part's file, declined, already
// made): why, in a few words, for the ⎿ line under it; '' when it ran. Matched on the built-in prompts' starts.
const REFUSALS = [
  [/^NOT DONE: nothing was written/, 'not done: no plan yet'],
  [/^Not done: plan mode/, 'not done: plan mode'],
  [/^Not run: in plan mode/, 'not run: plan mode'],
  [/^Not run: it searches/, 'not run: searches outside the project'],
  [/^Not done: the user's hook blocked it: (.*)/, (m) => `blocked by a hook: ${clip(m[1], 80)}`],
  [/^Not changed: \S+ belongs to another part/, "not changed: another part's file"],
  [/^The user (declined|rejected)/, 'declined'],
  [/^\(Already done, and nothing changed/, 'not run again: nothing changed since'],
]
export function refusal(out) {
  for (const [re, why] of REFUSALS) {
    const m = re.exec(String(out))
    if (m) return typeof why === 'function' ? why(m) : why
  }
  return ''
}

// id: the tool call's (a helper's steps are sent as its, for other apps to show under it)
export async function runTool(name, args, s, signal, id) {
  return id ? runningCall.run(id, () => toolRun(name, args, s, signal, id)) : toolRun(name, args, s, signal, id)
}
async function toolRun(name, args, s, signal, id) {
  log('tool', name, args)
  // hooks see an MCP tool by its own name (mcp__server__tool), also when called through "mcp"
  const hookName = name === 'mcp' && args?.server && args?.tool ? mcpName(String(args.server), String(args.tool)) : name
  const pre = await runHooks(s, 'PreToolUse', { tool_name: hookName, tool_input: args }, signal)
  const notMine = !pre.block && s.ownFiles && partPaths(name, args).find((f) => !s.ownFiles.includes(path.resolve(s.root, f)))
  const stop = pre.block ? prompt('agent/hook', { reason: pre.block, blocked: true }) : notMine ? prompt('agent/part-files', { file: notMine, files: s.ownFiles.map((f) => path.relative(s.root, f)).join(', ') }) : null
  if (stop && name === 'run_command') {
    s.ui.step('run', String(args?.command ?? ''), s.client?.model) // a command's lines are shown where it runs, which this one never reaches
    s.ui.result(refusal(stop))
  }
  if (stop) return stop
  let out = await tool(name, args, s, signal, id)
  const post = await runHooks(s, 'PostToolUse', { tool_name: hookName, tool_input: args, tool_response: out }, signal)
  if (post.block) out += `\n\n${prompt('agent/hook', { reason: post.block, after: true })}`
  log('tool', `${name} result:`, clip(out, 4000))
  return out
}

// The files a change would touch (edit_file's edits, write_file's path, a patch's files), for a part
// of the plan that owns only some.
function partPaths(name, args) {
  const a = normalize(args ?? {})
  if (name === 'edit_file') return [a.path, ...[a.edits ?? []].flat().map((e) => e?.path)].filter(Boolean).map(String)
  if (name === 'write_file' || name === 'append_file') return [a.path].filter(Boolean).map(String)
  if (name === 'apply_patch') return [...String(a.input ?? a.patch ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
  return []
}

// Argument names other tools use (Claude Code's file_path, old_string, new_string, …): models
// trained on them send them here too.
const ALIASES = { file_path: 'path', filePath: 'path', file: 'path', old_string: 'search', old_str: 'search', oldText: 'search', new_string: 'replace', new_str: 'replace', newText: 'replace', cmd: 'command', startLine: 'start_line', lineStart: 'start_line', start: 'start_line', endLine: 'end_line', lineEnd: 'end_line', end: 'end_line' }
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

async function tool(name, args, s, signal, id) {
  if (!name.startsWith('mcp__') && !mcpTarget(s, name)) args = normalize(args) // an MCP tool's arguments are its own
  try {
    const { root } = s
    if (s.ui.permission === 'plan') {
      if (PLAN_HIDDEN.has(name) || name === 'append_file' || name === 'manage' && args.action !== 'list' && args.action !== 'show' && args.action !== 'help') return prompt('agent/plan-refused', { command: false })
    }
    switch (name) {
      case 'read_file':
        return IMAGE.test(String(args.path ?? '')) ? readImage(s, args.path) : readFileTool(root, args.path, args.start_line, args.end_line)
      case 'list_files': {
        if (args.path !== undefined && args.path !== '' && !args.filter) {
          const v = folderView(root, String(args.path))
          return v.error ? `error: ${v.error}` : v.entries.join('\n') + (v.more ? `\n… ${v.more} more` : '') || '(empty folder)'
        }
        const under = String(args.path ?? '').replace(/^\.?\/+|\/+$/g, '') // with a filter too: the files under that folder that match
        const files = listFiles(root).filter((f) => (!under || under === '.' || f === under || f.startsWith(`${under}/`)) && (!args.filter || f.includes(args.filter)))
        return files.slice(0, 500).join('\n') + (files.length > 500 ? `\n… ${files.length - 500} more` : '') || 'no files'
      }
      case 'search':
        return searchFiles(root, String(args.query ?? ''), args.path)
      case 'changes':
        return changesTool(s, args)
      case 'find_command': {
        const names = (Array.isArray(args.names) ? args.names : String(args.names ?? args.name ?? '').split(/[\s,]+/)).map(String).filter(Boolean)
        if (!names.length) return 'error: find_command needs "names": the commands to look for, like ["rg", "pnpm"]'
        return names.map((n) => `${n}: ${findCommand(root, n) ?? 'not installed'}`).join('\n')
      }
      case 'lsp':
        return await lspTool(s, args, signal)
      case 'edit_file':
        return await editFiles(s, args)
      case 'write_file':
      case 'append_file': {
        if (!args.path) return 'error: write_file needs "path" (the file to write) and "content". Nothing was written.'
        // no "content" at all isn't an empty file (a model that left it out would empty one)
        if (args.content === undefined || args.content === null) return 'error: write_file needs "content" (the whole file; "" for an empty one). Nothing was written.'
        if (Array.isArray(args.content) && args.content.every((l) => typeof l === 'string')) args.content = args.content.join('\n') // its lines
        if (typeof args.content !== 'string') return 'error: write_file\'s "content" must be the file\'s text, a string (JSON too: as text). Nothing was written.'
        const abs = resolveIn(root, args.path)
        const rel = path.relative(root, abs)
        const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
        const append = name === 'append_file' || args.append === true || args.append === 'true'
        const res = await proposeWrite(s, rel, old, (append ? old : '') + String(args.content ?? ''))
        return writeResult(rel, res) + (res.formatted ? `\nNow:\n${excerpt(res.text, res.ops)}` : '') // what it wrote isn't what's there now
      }
      case 'run_command':
        if (/^\s*apply_patch\b[\s\S]*\*\*\* Begin Patch/.test(String(args.command ?? ''))) return !allowed(s, 'apply_patch') ? 'error: the tool apply_patch is not allowed here' : await applyPatch(s, args.command) // apply_patch <<'EOF' … as Codex runs it
        return (await runConfirmed(s, String(args.command ?? ''), signal, args.background === true || args.background === 'true', args.wait)) + outsideNote(root, String(args.command ?? ''))
      case 'background':
        return await backgroundTool(s, args, signal)
      case 'apply_patch':
        return await applyPatch(s, args.input ?? args.patch ?? args.command ?? '')
      case 'mcp':
        return await mcpTool(s, args, signal)
      case 'memory':
        return memoryTool(s, args)
      case 'todo':
        return await todoTool(s, args, signal, id)
      case 'web_search':
      case 'web_fetch':
        return await webTool(s, name, args, signal)
      case 'agent':
        if (s.isSub) return 'error: a helper can\'t start helpers. Do the job yourself.' // hidden from helpers; a call anyway would nest without end
        return await s.subagent(args, signal, id)
      case 'ask_user':
        return await askUser(s, args)
      case 'skill': {
        const k = s.skills?.get(String(args.name ?? ''))
        if (!k || k.use === 'me') return `error: no skill "${args.name}". Skills: ${[...(s.skills?.values() ?? [])].filter((x) => x.use !== 'me').map((x) => x.name).join(', ') || 'none'}`
        if (args.file) return readSkillFile(k, String(args.file))
        const files = skillFiles(k)
        const loaded = (k.load ?? []).map((f) => `\n\n--- ${f} ---\n${readSkillFile(k, f)}`).join('')
        return fillArgs(k.body, '') + loaded + (files.length ? `\n\n${prompt('agent/skill-files', { name: k.name, files: files.join('\n') })}` : '')
      }
      default: {
        const m = mcpTarget(s, name)
        if (m) return howTo(s, m.server.name, await callMcp(s, m.server, m.tool, args, signal))
        return (await s.director?.tool(name, args, s, signal)) ?? `error: there is no tool named ${name}`
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e
    return `error: ${e.message}`
  }
}
