// Memory: markdown notes, one fact per note, linked Obsidian-style with [[name]], in two places
// (each folder opens as an Obsidian vault):
//   <project>/.heartcode/memory/   about this project (scope "project", the default)
//   ~/.heart/memory/               the user's preferences that hold in every project (scope "global")
// Each note:
//   ---
//   name: tabs-not-spaces
//   description: The user wants tabs for indentation in this project
//   type: user | project | feedback | reference
//   tags: style, formatting
//   ---
//   The text. Related: [[code-style]]
// MEMORY.md, the index for people (and Obsidian), is rebuilt by code on every change. Models get
// less: the tag list in the system prompt, and with each message only the notes it matches.
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './config.js'

export const TYPES = ['user', 'project', 'feedback', 'reference']
const LINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g
export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note'

// One folder of notes.
class Notes {
  constructor(dir, scope) {
    Object.assign(this, { dir, scope })
  }

  #file(name) {
    return path.join(this.dir, `${slug(name)}.md`)
  }

  // All notes: { name, description, type, body, links, file }
  list() {
    let files = []
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    } catch {}
    return files
      .map((f) => {
        const text = fs.readFileSync(path.join(this.dir, f), 'utf8')
        const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
        const meta = Object.fromEntries((m?.[1] ?? '').split('\n').map((l) => /^(\w+):\s*(.*)$/.exec(l.trim())).filter(Boolean).map(([, k, v]) => [k, v.trim()]))
        const body = (m ? m[2] : text).trim()
        return {
          scope: this.scope,
          name: f.slice(0, -3),
          description: meta.description || body.split('\n')[0].slice(0, 120),
          type: TYPES.includes(meta.type) ? meta.type : 'project',
          tags: tagList(meta.tags).filter((x) => !TYPES.includes(x)),
          body,
          links: [...new Set([...body.matchAll(LINK)].map((x) => slug(x[1])))],
          file: path.join(this.dir, f),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  read(name) {
    const note = this.list().find((n) => n.name === slug(name))
    if (!note) return null
    const backlinks = this.list().filter((n) => n.links.includes(note.name)).map((n) => `[[${n.name}]]`)
    return { ...note, backlinks }
  }

  // Creates or replaces a note; returns its name.
  write({ name, description, type, tags, content }) {
    const n = slug(name || description)
    const old = this.read(n)
    const t = TYPES.includes(type) ? type : (old?.type ?? 'project')
    const d = String(description || old?.description || String(content).split('\n')[0]).replace(/\s+/g, ' ').trim().slice(0, 200)
    const g = (tagList(tags).length ? tagList(tags) : (old?.tags ?? [])).filter((x) => !TYPES.includes(x)) // the type is not a tag
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.#file(n), `---\nname: ${n}\ndescription: ${d}\ntype: ${t}\ntags: ${g.join(', ')}\n---\n\n${String(content ?? old?.body ?? '').trim()}\n`)
    this.changed()
    return n
  }

  delete(name) {
    try {
      fs.rmSync(this.#file(name))
    } catch {
      return false
    }
    this.changed()
    return true
  }

  // Notes with every word of the query in their name, description, tags or text; "tag:deploy" by tag.
  search(query) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
    return this.list().filter((n) =>
      words.every((w) => (w.startsWith('tag:') ? n.tags.includes(w.slice(4)) : `${n.name} ${n.description} ${n.tags.join(' ')} ${n.body}`.toLowerCase().includes(w))),
    )
  }

  // "tag (count)" for every tag: all the system prompt carries about the memory.
  tagSummary() {
    const count = new Map()
    for (const n of this.list()) for (const t of n.tags) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, k]) => `${t} (${k})`).join(', ')
  }

  relevant(text, max = 6) {
    return relevantOf(this.list(), text, max)
  }

  // [[links]] to notes that don't exist: found by code, fixed when tidying.
  brokenLinks() {
    const names = new Set(this.list().map((n) => n.name))
    return this.list().flatMap((n) => n.links.filter((l) => !names.has(l)).map((l) => ({ from: n.name, to: l })))
  }

  // The index for the system prompt: one line per note, grouped by type. '' without notes.
  index(max = 120) {
    const notes = this.list()
    const lines = []
    for (const t of TYPES) {
      const of = notes.filter((n) => n.type === t)
      if (of.length) lines.push(`${t}:`, ...of.map((n) => `- [[${n.name}]] — ${n.description}${n.tags.length ? ` #${n.tags.join(' #')}` : ''}`))
    }
    return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines (search the memory)`].join('\n') : lines.join('\n')
  }

  // Keeps MEMORY.md in step with the notes.
  changed() {
    fs.mkdirSync(this.dir, { recursive: true })
    const what = this.scope === 'global' ? 'The notes HeartCode keeps about you, for every project' : "This project's notes, kept by HeartCode"
    fs.writeFileSync(path.join(this.dir, 'MEMORY.md'), `# Memory\n\n${what}. Each line links to a note.\n\n${this.index(Infinity) || '(no notes yet)'}\n`)
  }
}

// Both memories as one: reading, searching and matching look in both (the project's note wins on
// the same name); writing goes to the scope asked for, or where the note already is.
export class Memory {
  constructor(root, globalDir = path.join(HOME, 'memory')) {
    this.project = new Notes(path.join(root, '.heartcode', 'memory'), 'project')
    this.global = new Notes(globalDir, 'global')
  }

  #in(scope) {
    return scope === 'global' ? this.global : this.project
  }

  list() {
    return [...this.project.list(), ...this.global.list()]
  }

  read(name, scope) {
    const n = slug(name)
    const note = this.list().find((x) => x.name === n && (!scope || x.scope === scope))
    if (!note) return null
    return { ...note, backlinks: this.list().filter((x) => x.links.includes(n) && x !== note).map((x) => `[[${x.name}]]`) }
  }

  write(note) {
    const where = note.scope === 'global' || note.scope === 'project' ? note.scope : (this.read(note.name)?.scope ?? 'project')
    return this.#in(where).write(note)
  }

  delete(name, scope) {
    const where = scope ?? this.read(name)?.scope
    return where ? this.#in(where).delete(name) : false
  }

  search(query) {
    return [...this.project.search(query), ...this.global.search(query)]
  }

  brokenLinks() {
    const names = new Set(this.list().map((n) => n.name))
    return this.list().flatMap((n) => n.links.filter((l) => !names.has(l)).map((l) => ({ from: n.name, to: l })))
  }

  tagSummary() {
    const count = new Map()
    for (const n of this.list()) for (const t of n.tags) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, k]) => `${t} (${k})`).join(', ')
  }

  relevant(text, max = 6) {
    return relevantOf(this.list(), text, max)
  }

  index(max) {
    return [this.project.index(max), this.global.index(max) && `global:\n${this.global.index(max)}`].filter(Boolean).join('\n')
  }
}

// The notes worth attaching to a message: the user's ways of working (user/feedback notes, a
// few), plus notes whose tags, name or description share words with it. Most relevant first.
function relevantOf(notes, text, max) {
  const words = new Set(keywords(text))
  const scored = notes.map((n) => {
    let score = 0
    for (const t of n.tags) if (keywords(t).some((w) => words.has(w))) score += 3
    for (const w of keywords(n.name)) if (words.has(w)) score += 2
    for (const w of keywords(n.description)) if (words.has(w)) score += 1
    return { n, score }
  })
  const rules = scored.filter((x) => x.n.type === 'user' || x.n.type === 'feedback').sort((a, b) => b.score - a.score).slice(0, 4)
  const matched = scored.filter((x) => x.score >= 2 && !rules.includes(x)).sort((a, b) => b.score - a.score)
  return [...rules, ...matched].slice(0, max).map((x) => x.n)
}

const tagList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\s#]+/)).map((t) => slug(t)).filter((t) => t && t !== 'note').slice(0, 5)

// Words worth matching on: lowercased, without short or very common words, plural/-ing cut off.
const STOP = new Set('the and for with this that from have what when where which into your you our are was were can will should could would about there their them then than just also only some more most very please make like want need does doing done how why who its it\'s use using'.split(' '))
function keywords(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
}
