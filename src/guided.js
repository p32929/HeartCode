// Guided mode, for models without (reliable) tool calls. HeartCode drives the
// task as a series of single questions; every answer has one trivial shape
// (a number, a path, or "the whole reply is code") and is checked against
// reality before use. With constrained output, the server enforces the shape.
import fs from 'node:fs'
import { log } from './log.js'
import { prompt, userInstructions } from './prompts.js'
import path from 'node:path'
import { est } from './client.js'
import { applyEdit, parseBlocks, cleanCode, lostNames, reindent } from './edit.js'
import { listFiles, namedFiles, readFileTool, searchFiles, numberLines, proposeWrite, runConfirmed, suggestCommands, resolveIn, writeResult, clip } from './tools.js'
import { c } from './ui.js'

// The steps, as "name: description" lines in prompts/guided/actions.md.
const ACTIONS = prompt('guided/actions')
  .split('\n')
  .map((l) => l.split(/:\s*/, 2))
  .filter(([n, d]) => n && d)
const DESC = Object.fromEntries(ACTIONS)
const CHANGE_WORDS = /\b(fix|add|change|implement|create|write|make|rename|refactor|update|remove|delete|replace|edit|convert|move|improve)\b/i
const RUN_WORDS = /\b(tests?|run|build|lint|compile)\b/i
const FAIL_WORDS = /\b(fail\w*|broken|breaks?|errors?|crash\w*)\b/i
const TEST_FILE = /(^|[/._-])(tests?|spec|__tests__)([/._-]|$)/i
const TESTS_ARE_TARGET = /\b(add|write|update|change|fix|edit)\s+(the\s+|a\s+|some\s+)?(unit\s+)?tests?\b/i
const QUESTION = /^\s*(what|how|why|where|which|who|when|explain|describe|summari[sz]e|tell|show|list|is|are|does|do|can|could|should)\b|\?\s*$/i

// Wording first; the model only breaks a tie (small models answer yes/no unreliably).
export function intent(task) {
  const change = CHANGE_WORDS.test(task)
  const question = QUESTION.test(task)
  return change && !question ? true : question && !change ? false : null
}

// A path in the task that doesn't exist yet, e.g. "create src/slug.js".
export function newFileIn(task, files) {
  if (!/\b(create|new|add|write|make|generate)\b/i.test(task)) return null
  for (const m of task.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w-]+\.[a-z0-9]{1,6})(?=$|[\s`'"),:;]|\.(?:\s|$))/gi)) {
    const f = m[1].replace(/^\.\//, '')
    if (!files.includes(f) && !/^(node|next|vue|react|nuxt|express|three|d3)\.js$/i.test(f)) return f
  }
  return null
}

// Obvious next steps are taken without asking: a weak model's effort goes into
// writing code, not into navigating. Returns an action, or null to ask.
export function autoAction(st) {
  if (st.newFile && st.wantsChange) return 'create'
  if (st.failing && st.canRun && !st.runs && !st.edits) return 'run' // see the failure first
  if (st.lastRun !== null && st.lastRun !== 0 && !st.editsSinceRun && st.wantsChange && st.fixes < 3) return 'edit'
  if (st.wantsChange && st.reads && !st.edits) return 'edit'
  if (st.editsSinceRun && st.canRun && st.wantsRun) return 'run'
  if (st.lastRun === 0 && st.edits && !st.editsSinceRun) return 'finish'
  if (st.wantsRun && !st.runs && !st.wantsChange) return 'run'
  return null
}

// When HeartCode does ask, small models still lean to the first option, so the
// likeliest step goes first.
export function nextActions(st) {
  let first
  if (!st.reads && st.hasFiles) first = ['read', 'search']
  else if (st.wantsChange && !st.edits) first = st.hasFiles ? ['edit', 'create', 'read'] : ['create']
  else first = ['finish', 'edit', 'run']
  return [...new Set([...first, ...ACTIONS.map(([n]) => n)])]
}

// A reply may be plain text or (when enforced) JSON like {"path": "a.js"}.
export function answerText(reply) {
  const t = String(reply).trim()
  if (t.startsWith('{')) {
    try {
      const v = Object.values(JSON.parse(t))[0]
      if (v !== undefined) return String(v)
    } catch {}
  }
  return t
}

export function parsePick(reply, names) {
  const t = answerText(reply).toLowerCase()
  const n = Number(/\d+/.exec(t)?.[0])
  if (n >= 1 && n <= names.length) return names[n - 1]
  const found = names.map((name) => [name, t.search(new RegExp(`\\b${name}\\b`))]).filter(([, i]) => i !== -1)
  return found.sort((a, b) => a[1] - b[1])[0]?.[0] ?? null
}

export function parseRange(reply, max) {
  const t = String(reply).trim()
  let a
  let b
  try {
    const o = JSON.parse(t)
    ;[a, b] = [Number(o.start), Number(o.end)]
  } catch {
    const m = /(\d+)\s*(?:-|–|to|,|:|\.\.)\s*(\d+)/i.exec(t) ?? /(\d+)/.exec(t)
    if (m) [a, b] = [Number(m[1]), Number(m[2] ?? m[1])]
  }
  if (!(a > 0)) return null
  if (!(b > 0)) b = a
  if (a > b) [a, b] = [b, a]
  return [Math.min(a, max), Math.min(b, max)]
}

const STOP = new Set('the and for with that this from into instead should would could file code function change make sure fix add use not but its it'.split(' '))

// The project's files worth showing a model for this task, instead of all of them: a small project
// whole (40 files or fewer); else the files already read, then those whose path has the task's words
// (most matches first), up to 30; with nothing related, the top level of the project, to start from.
export function relevantFiles(task, files, read = [], max = 30) {
  if (files.length <= 40) return files
  const words = [...new Set(String(task).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].filter((w) => !STOP.has(w))
  const score = (f) => words.reduce((n, w) => n + (f.toLowerCase().includes(w) ? 1 : 0), 0)
  const hits = files.map((f) => [f, score(f)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([f]) => f)
  const picked = [...new Set([...read.filter((f) => files.includes(f)), ...hits])].slice(0, max)
  if (picked.length) return picked
  return [...new Set(files.map((f) => f.split('/')[0] + (f.includes('/') ? '/' : '')))].slice(0, max) // the top level
}

// For files too big to show whole: the window of lines most related to `hint`.
export function focusWindow(lines, hint, maxChars) {
  const words = [...new Set(String(hint).toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? [])].filter((w) => !STOP.has(w))
  let best = -1
  let score = 0
  lines.forEach((l, i) => {
    const low = l.toLowerCase()
    const sc = words.filter((w) => low.includes(w)).length
    if (sc > score) [best, score] = [i, sc]
  })
  if (best < 0) return null
  let a = best
  let b = best + 1
  let size = lines[best].length
  while ((a > 0 || b < lines.length) && size < maxChars) {
    if (a > 0) size += lines[--a].length + 8
    if (b < lines.length && size < maxChars) size += lines[b++].length + 8
  }
  return [a, b] // 0-based, end exclusive
}

const unquote = (s) => s.replace(/^[`'"*(]+|[`'"*).,:;]+$/g, '').replace(/^\.\//, '').replace(/\\/g, '/')
const shortest = (list) => list.sort((a, b) => a.length - b.length)[0]

// Map whatever the model said onto a real file.
export function matchFile(files, answer) {
  const line = String(answer).split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const tokens = [unquote(line), ...line.split(/\s+/).map(unquote)].filter(Boolean)
  for (const t of tokens) {
    if (files.includes(t)) return t
    const tailHits = files.filter((f) => f.endsWith('/' + t))
    if (tailHits.length) return shortest(tailHits)
    const baseHits = files.filter((f) => path.basename(f).toLowerCase() === t.toLowerCase())
    if (baseHits.length) return shortest(baseHits)
  }
  return null
}

function closest(files, answer, n) {
  const parts = String(answer).toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length > 1)
  const score = (f) => parts.filter((p) => f.toLowerCase().includes(p)).length
  return [...files].sort((a, b) => score(b) - score(a) || a.length - b.length).slice(0, n)
}

const fence = (t) => {
  const f = '`'.repeat(Math.max(3, ...[...t.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)))
  return `${f}\n${t}\n${f}`
}

// Project files a file imports by relative path ('./num.js', '../lib/x').
export function localImports(file, text, files) {
  const out = []
  for (const m of text.matchAll(/(?:from|import|require\(|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]))
    const hit = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '/index.js', '/index.ts'].map((x) => base + x).find((x) => files.includes(x))
    if (hit && !out.includes(hit)) out.push(hit)
  }
  return out
}

export function cleanCommand(reply) {
  const line = String(reply).split('\n').map((l) => l.trim()).find((l) => l && !/^(`{3,}|~{3,})/.test(l)) ?? ''
  return line.replace(/^\$\s+/, '').replace(/^`+|`+$/g, '').trim()
}

export function runGuided(s, task, images, signal) {
  return new Guided(s, task, signal).start(images)
}

class Guided {
  constructor(s, task, signal) {
    this.s = s
    this.task = task
    this.signal = signal
    this.notes = []
    this.changed = new Set()
    this.files = listFiles(s.root)
    this.st = { reads: 0, edits: 0, editsSinceRun: 0, runs: 0, fixes: 0, lastRun: null, hasFiles: this.files.length > 0, canRun: suggestCommands(s.root).length > 0 }
  }

  async yesNo(question, fallback) {
    const schema = { type: 'object', properties: { answer: { type: 'string', enum: ['yes', 'no'] } }, required: ['answer'], additionalProperties: false }
    const res = await this.query(prompt('guided/yes-no', { question }), { room: 20, schema, oneLine: true })
    const m = /\b(yes|no)\b/i.exec(answerText(res.content))
    return m ? m[1].toLowerCase() === 'yes' : fallback
  }

  get ui() {
    return this.s.ui
  }

  note(key, title, body) {
    if (key) this.notes = this.notes.filter((n) => n.key !== key)
    this.notes.push({ key, title, body })
  }

  // Everything the model needs to know, fitted into the context window.
  context(reserve, skipKey) {
    const budget = Math.max(1500, (this.s.strat.context - reserve - 200) * 3.5)
    const history = this.s.history
      .slice(-3)
      .map((h) => `User: ${clip(h.task, 300)}\nYou: ${clip(h.answer, 500)}`)
      .join('\n')
    // the files that matter for this task (not the whole project): see relevantFiles
    const picked = relevantFiles(this.task, this.files, this.notes.filter((n) => n.key?.startsWith('read:')).map((n) => n.key.slice(5)))
    let list = ''
    for (const f of picked) {
      if (list.length + f.length > budget * 0.2) break
      list += f + '\n'
    }
    const more = this.files.length - list.split('\n').filter(Boolean).length
    const files = this.files.length ? `\n${list}${more ? `(${this.files.length} files in all: the ones related to the task are shown; use search to find others)` : ''}`.trimEnd() : ' (none, the project is empty)'
    const vars = { task: this.task, history, files }
    let left = budget - prompt('guided/context', { ...vars, done: '' }).length
    const parts = []
    const notes = this.notes.filter((n) => !skipKey || n.key !== skipKey)
    for (let i = notes.length - 1; i >= 0; i--) {
      const full = `--- ${notes[i].title} ---\n${notes[i].body}`.trimEnd()
      if (full.length <= left) {
        parts.unshift(full)
        left -= full.length
      } else if (left > 400) {
        parts.unshift(full.slice(0, left - 40) + '\n[… cut to fit]')
        left = 0
      } else {
        parts.unshift(`(${i + 1} earlier step(s) not shown)`)
        break
      }
    }
    return prompt('guided/context', { ...vars, done: parts.join('\n\n') }).trimEnd()
  }

  // `answer: true` streams the reply to the user as the answer; otherwise only thinking is shown.
  // room: tokens of context to keep free for the reply (only for fitting the context; never sent).
  async query(question, opts = {}, tries = 0) {
    try {
      return await this.ask1(question, opts, tries)
    } catch (e) {
      // too large for the model: strat.context has dropped to its limit, so the context shrinks
      if (!e.inputLimit || tries >= 3) throw e
      return this.query(question, opts, tries + 1)
    }
  }

  async ask1(question, { room = 32, schema, oneLine, onToken, answer, skipKey } = {}, tries = 0) {
    const { client, strat } = this.s
    const think = strat.thinking ? 4096 : 0
    const user = `${this.context(est(question) + room + think + tries * 600, skipKey)}\n\n${question}`
    this.instructions ??= userInstructions(this.s.root)
    const system = [prompt('guided/system'), this.instructions && prompt('agent/instructions', { instructions: this.instructions }), this.s.appendSystem].filter(Boolean).join('\n\n')
    const messages = strat.mergeSystem
      ? [{ role: 'user', content: `${system}\n\n${user}` }]
      : [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]
    const out = this.ui.response()
    if (answer) onToken = out.text
    const stream = Boolean(strat.stream && (onToken || strat.thinking))
    const body = { messages, temperature: 0, stream } // no max_tokens: the model decides how long
    if (schema && strat.enforce) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } }
    else if (oneLine && strat.stop) body.stop = ['\n\n']
    const res = await client.chat(body, { signal: this.signal, onToken, onReasoning: out.think })
    if (!stream) out.think(res.reasoning)
    if (answer && !stream) out.text(res.content)
    out.end()
    log('guided', `asked: ${question}\n  replied: ${JSON.stringify(res.content)}`)
    return res
  }

  progress(label) {
    let n = 0
    this.ui.spinner(label)
    return (t) => this.ui.spinner(`${label} · ${(n += t.length)} chars`)
  }

  async start(images) {
    if (images.length) await this.describeImages(images)
    this.autoRead()
    this.ui.spinner('reading the task')
    this.st.wantsChange = intent(this.task) ?? (await this.yesNo(prompt('guided/intent'), false))
    this.st.newFile = newFileIn(this.task, this.files)
    this.st.wantsRun = RUN_WORDS.test(this.task)
    this.st.failing = FAIL_WORDS.test(this.task)
    let last = ''
    let repeats = 0
    // No step limit (Esc stops it); a model doing the same thing three times in a row is stopped.
    for (let step = 0; !this.s.maxTurns || step < this.s.maxTurns; step++) {
      this.ui.spinner('deciding next step')
      const auto = autoAction(this.st)
      const action = auto ?? (await this.pickAction())
      log('guided', `step ${step + 1}: ${action}${auto ? ' (autopilot)' : ''}`, this.st)
      if (auto === 'edit' && this.st.runs) this.st.fixes++
      if (action === 'finish') break
      let sig
      try {
        sig = await this[action]()
      } catch (e) {
        if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.status || /cannot reach/.test(e.message)) throw e
        this.ui.result(c.red(e.message))
        this.note(null, `${action} failed`, e.message)
        sig = `${action}:error`
      }
      repeats = sig === last ? repeats + 1 : 0
      last = sig
      if (repeats >= 2) {
        this.ui.warn(`stopped: ${this.s.client.model} did the same thing three times in a row`)
        break
      }
      if (repeats === 1) this.note(null, 'warning', prompt('guided/note-repeated'))
    }
    return this.finish()
  }

  async describeImages(images) {
    for (const [i, url] of images.entries()) {
      this.ui.spinner(`looking at image ${i + 1}`)
      const text = prompt('guided/describe-image', { task: this.task })
      const res = await this.s.client.chat(
        { messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url } }] }] },
        { signal: this.signal },
      )
      this.note(`image:${i}`, `attached image ${i + 1}`, res.content)
      this.ui.step('image', `described image ${i + 1}`)
    }
  }

  // Files named in the task are read up front: one less decision for a weak model.
  autoRead() {
    for (const f of namedFiles(this.task, this.files).slice(0, 3)) this.readNote(f)
  }

  readNote(f, quiet = false) {
    const body = readFileTool(this.s.root, f, 1, undefined, 2000)
    this.note(`read:${f}`, `contents of ${f}`, clip(body, Math.floor(this.s.strat.context * 3.5 * 0.4)))
    if (!quiet) this.ui.step('read', f)
    this.st.reads++
  }

  async pickAction() {
    const names = nextActions(this.st)
    const menu = names.map((n, i) => `${i + 1}. ${n} - ${DESC[n]}`).join('\n')
    let q = prompt('guided/next-action', { menu })
    const schema = { type: 'object', properties: { choice: { type: 'integer', enum: names.map((_, i) => i + 1) } }, required: ['choice'], additionalProperties: false }
    for (let i = 0; i < 2; i++) {
      const res = await this.query(q, { room: 16, schema, oneLine: true })
      const a = parsePick(res.content, names)
      if (a) return a
      q += '\n\n' + prompt('guided/next-action-retry', { reply: clip(res.content, 40), count: names.length })
    }
    return 'finish'
  }

  async pickFile(question, candidates) {
    if (!candidates.length) {
      this.note(null, 'note', prompt('guided/note-no-files'))
      return null
    }
    const schema =
      candidates.length <= 300 ? { type: 'object', properties: { path: { type: 'string', enum: candidates } }, required: ['path'], additionalProperties: false } : undefined
    let q = prompt('guided/pick-file', { question })
    for (let i = 0; i < 2; i++) {
      const res = await this.query(q, { room: 60, schema, oneLine: true })
      const said = answerText(res.content)
      const f = matchFile(candidates, said)
      if (f) return f
      q = prompt('guided/pick-file-retry', { question, said: clip(said, 60), choices: closest(candidates, said, 15).join('\n') })
    }
    this.note(null, 'note', prompt('guided/note-unknown-file'))
    return null
  }

  async read() {
    const f = await this.pickFile(prompt('guided/which-file-to-read'), this.files)
    if (f) this.readNote(f)
    return `read:${f}`
  }

  async search() {
    const res = await this.query(prompt('guided/search'), { room: 40, oneLine: true })
    const q = unquote(answerText(res.content).split('\n')[0].trim())
    if (!q) return 'search:'
    this.ui.step('search', q)
    const out = searchFiles(this.s.root, q)
    this.ui.result(out.startsWith('no matches') ? 'no matches' : `${out.split('\n').length} matches`)
    this.note(`search:${q}`, `search results for "${q}"`, out)
    return `search:${q}`
  }

  async edit() {
    const seen = this.notes.filter((n) => n.key?.startsWith('read:')).map((n) => n.key.slice(5)).reverse()
    // Weak models pick the first option: offer the code under test before the tests themselves.
    let files = [...new Set([...seen, ...this.files])]
    const testsAreTarget = TESTS_ARE_TARGET.test(this.task)
    if (!testsAreTarget) files = [...files.filter((x) => !TEST_FILE.test(x)), ...files.filter((x) => TEST_FILE.test(x))]
    let f = await this.pickFile(prompt('guided/which-file-to-edit'), files)
    if (!f) return 'edit:'
    if (this.st.lastRun && TEST_FILE.test(f) && !testsAreTarget) f = this.codeUnderTest(f)
    const old = fs.readFileSync(resolveIn(this.s.root, f), 'utf8')
    this.ui.step('edit', f)
    let next = null
    if (this.s.strat.edits === 'search_replace') next = await this.editBlocks(f, old)
    if (next === null) next = await this.editRewrite(f, old)
    if (next === null) return `edit:${f}`
    const lost = lostNames(old, next, this.task)
    if (lost.length) {
      this.ui.result(c.yellow(`that edit deleted ${lost.join(', ')}; retrying`))
      const again = await this.editRewrite(f, old, prompt('guided/keep-names', { names: lost.join(', '), them: lost.length > 1 ? 'them' : 'it' }))
      if (again !== null && !lostNames(old, again, this.task).length) next = again
      else this.ui.warn(`this edit removes ${lost.join(', ')}; check the diff`)
    }
    await this.apply(f, old, next)
    return `edit:${f}`
  }

  // Weak models "fix" failing tests by editing the tests. Unless the task asks for test changes,
  // the edit goes to the code the test imports.
  codeUnderTest(test) {
    const code = localImports(test, fs.readFileSync(resolveIn(this.s.root, test), 'utf8'), this.files).find((x) => !TEST_FILE.test(x))
    if (code) this.note(null, 'note', prompt('guided/note-tests-are-right', { test, code }))
    return code ?? test
  }

  async editBlocks(f, old) {
    const q = prompt('guided/edit-blocks', { file: f, content: fence(old) })
    const res = await this.query(q, { room: Math.min(est(old) + 800, 4096), onToken: this.progress(`editing ${f}`), skipKey: `read:${f}` })
    const blocks = parseBlocks(res.content)
    let text = old
    for (const b of blocks) {
      const r = applyEdit(text, b.search, b.replace)
      if (r.error) {
        this.ui.result(`edit block did not apply (${clip(r.error, 80)}); rewriting instead`)
        return null
      }
      text = r.text
    }
    return blocks.length ? text : null
  }

  async editRewrite(f, old, extra = '') {
    const skipKey = `read:${f}`
    if (est(old) * 2.3 + 1000 < this.s.strat.context) {
      const q = prompt('guided/rewrite', { file: f, content: fence(old), extra })
      const res = await this.query(q, { room: Math.ceil(est(old) * 1.5) + 600, onToken: this.progress(`rewriting ${f}`), skipKey })
      if (res.finishReason === 'length') return this.failed(f, 'the reply was cut off before the end of the file')
      return cleanCode(res.content, old)
    }

    // Too big to rewrite whole: find the right area, pick a line range, rewrite just that.
    const lines = old.split('\n')
    const room = Math.floor(this.s.strat.context * 3.5 * 0.4)
    let win = focusWindow(lines, this.task, room)
    if (!win) {
      const res = await this.query(prompt('guided/find-place', { file: f }), {
        room: 30,
        oneLine: true,
        skipKey,
      })
      win = focusWindow(lines, answerText(res.content), room) ?? [0, lines.length]
    }
    const view = clip(numberLines(lines.slice(win[0], win[1]), win[0] + 1), room)
    const schema = { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } }, required: ['start', 'end'], additionalProperties: false }
    const part = win[0] > 0 || win[1] < lines.length ? ` (lines ${win[0] + 1}-${win[1]} of ${lines.length})` : ''
    const rres = await this.query(prompt('guided/pick-range', { file: f, part, view: fence(view) }), {
      room: 20,
      schema,
      oneLine: true,
      skipKey,
    })
    const range = parseRange(rres.content, lines.length)
    if (!range) return this.failed(f, `could not understand the line range "${clip(rres.content, 40)}"`)
    const [a, b] = range
    const chunk = lines.slice(a - 1, b).join('\n')
    const q = prompt('guided/rewrite-range', {
      file: f,
      a,
      b,
      chunk: fence(chunk),
      before: fence(lines.slice(Math.max(0, a - 6), a - 1).join('\n')),
      after: fence(lines.slice(b, b + 4).join('\n')),
      extra,
    })
    const res = await this.query(q, { room: est(chunk) * 2 + 500, onToken: this.progress(`rewriting ${f}:${a}-${b}`), skipKey })
    if (res.finishReason === 'length') return this.failed(f, 'the reply was cut off')
    const repl = reindent(lines.slice(a - 1, b), cleanCode(res.content, chunk).split('\n'))
    return [...lines.slice(0, a - 1), ...repl, ...lines.slice(b)].join('\n')
  }

  failed(f, why) {
    this.ui.result(c.red(`edit failed: ${why}`))
    this.note(null, `editing ${f} failed`, why)
    return null
  }

  async apply(f, old, next) {
    this.ui.stopSpin()
    const r = await proposeWrite(this.s, f, old, next)
    this.note(null, `${old ? 'edit' : 'create'} ${f}`, writeResult(f, r) + (r.diff ? '\n' + r.diff : ''))
    if (r.status === 'applied') {
      this.st.edits++
      this.changed.add(f)
      this.st.editsSinceRun++
      this.st.hasFiles = true
      if (!this.files.includes(f)) this.files.push(f)
      if (this.notes.some((n) => n.key === `read:${f}`)) this.readNote(f, true)
    }
  }

  async create() {
    let rel = this.st.newFile
    this.st.newFile = null
    if (!rel) {
      const res = await this.query(prompt('guided/new-file-path'), { room: 40, oneLine: true })
      rel = unquote(answerText(res.content).split('\n')[0].trim())
    }
    if (!rel) return 'create:'
    const abs = resolveIn(this.s.root, rel)
    const f = path.relative(this.s.root, abs)
    this.ui.step('create', f)
    if (fs.existsSync(abs)) {
      const old = fs.readFileSync(abs, 'utf8')
      const next = await this.editRewrite(f, old)
      if (next !== null) await this.apply(f, old, next)
      return `create:${f}`
    }
    const r = await this.query(prompt('guided/new-file', { file: f }), {
      room: Math.min(4096, Math.floor(this.s.strat.context / 2)),
      onToken: this.progress(`writing ${f}`),
    })
    if (r.finishReason === 'length') this.failed(f, 'the reply was cut off')
    else await this.apply(f, '', cleanCode(r.content))
    return `create:${f}`
  }

  async run() {
    const sugg = suggestCommands(this.s.root)
    const commands = sugg.map((x, i) => `${i + 1}. ${x}`).join('\n')
    const res = await this.query(prompt('guided/run', { commands }), { room: 60, oneLine: true })
    const t = answerText(res.content).trim()
    const n = sugg[Number(/^(\d+)[.):]?(\s|$)/.exec(t)?.[1]) - 1] // "2", "2.", "2. npm test"
    const cmd = n ?? cleanCommand(t)
    if (!cmd) return 'run:'
    const out = await runConfirmed(this.s, cmd, this.signal)
    const code = /^exit code (\S+)/.exec(out)?.[1]
    this.st.runs++
    this.st.editsSinceRun = 0
    this.st.lastRun = code === undefined ? null : code === '0' ? 0 : code
    this.note(null, `ran: ${cmd}`, out)
    if (this.st.lastRun) this.readFailing(out)
    return `run:${cmd}`
  }

  // A failure usually names a test file; the bug tends to be in what it imports. Show both.
  readFailing(out) {
    const seen = new Set(this.notes.filter((n) => n.key?.startsWith('read:')).map((n) => n.key.slice(5)))
    const esc = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const named = this.files.filter((f) => new RegExp(`(^|[\\s/('"])${esc(f)}($|[\\s:)'"])`, 'm').test(out)).slice(0, 2)
    const want = [...named, ...named.flatMap((f) => localImports(f, fs.readFileSync(resolveIn(this.s.root, f), 'utf8'), this.files))]
    for (const f of [...new Set(want)].filter((f) => !seen.has(f)).slice(0, 3)) this.readNote(f)
  }

  async ask() {
    const res = await this.query(prompt('guided/ask-user'), { room: 120 })
    const q = res.content.trim()
    const a = await this.ui.ask(`${c.cyan('heartcode asks:')} ${q}\n${c.magenta('> ')}`)
    this.note(null, `you asked the user: ${q}`, `The user answered: ${a ?? '(no answer)'}`)
    return `ask:${q}`
  }

  async finish() {
    this.ui.spinner('writing answer')
    let res
    try {
      res = await this.query(prompt('guided/finish'), {
        room: 1024,
        answer: true,
      })
    } catch (e) {
      // The work is done; a failed summary shouldn't fail the task.
      if (e.name === 'AbortError' || !this.st.edits) throw e
      this.ui.stopSpin()
      this.ui.warn(`could not get a summary from the model (${clip(e.message, 100)})`)
      const run = this.st.lastRun === null ? '' : ` Last command: exit ${this.st.lastRun}.`
      const text = `Changed ${[...this.changed].join(', ')}.${run}`
      this.ui.print(`${c.bold('●')} ${text}`)
      return text
    }
    this.ui.stopSpin()
    return res.content
  }
}
