// Research: every web page and search HeartCode reads for a project, kept in
// <project>/.heartcode/research/ as Markdown (one file per page, the whole page), so nothing it looked
// up is lost: helpers' pages too. The same URL always maps to the same file (fetched again: replaced).
//   ---
//   url: https://…
//   title: …
//   fetched: 2026-10-31
//   query: what it was looking for
//   used_for: what it turned out to be used for (set when the task wraps up)
//   ---
//   # Title
//   the page as Markdown
// INDEX.md lists them for people (and Obsidian); the model is given matching titles with each message
// and reads a file when it needs the detail. The folder ignores itself in git (raw pages can be big;
// the notes they lead to in .heartcode/memory are what's worth committing).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { keywords } from './memory.js'
import { projectDir } from './config.js'

export const researchDir = (root) => projectDir(root, 'research')
const slugOf = (s, n) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n).replace(/-+$/, '')
const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8)
const today = () => new Date().toISOString().slice(0, 10)
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// The file a page is kept in: its address, readable ("react.dev--learn-start-a-new-react-project.md").
export function pageFile(url) {
  let host = 'page'
  let rest = String(url)
  try {
    const u = new URL(url)
    host = u.hostname.replace(/^www\./, '')
    rest = u.pathname + u.search
  } catch {}
  const name = `${host.toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(0, 60) || 'page'}--${slugOf(rest, 200) || 'index'}`
  return `${name.length > 110 ? `${name.slice(0, 100).replace(/-+$/, '')}-${hash(url)}` : name}.md`
}
const searchFile = (query) => `search--${slugOf(query, 90) || hash(query)}.md`

function write(root, file, meta, body) {
  const dir = researchDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# HeartCode research: raw pages, kept out of git (the notes in ../memory are what to commit)\n*\n')
  const head = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${oneLine(v)}`)
  fs.writeFileSync(path.join(dir, file), `---\n${head.join('\n')}\n---\n\n${String(body).trim()}\n`)
  rebuildIndex(root)
  return { file: path.relative(root, path.join(dir, file)), bodyLine: head.length + 4 } // bodyLine: the page's first line in the file
}

// A fetched page (text: as Markdown). Returns { file (relative to the project), bodyLine }.
export function savePage(root, { url, title, text, query }) {
  const file = pageFile(url)
  const was = read(root, file)
  return write(root, file, { url, title: title || url, fetched: today(), query: query || was?.query, used_for: was?.used_for }, text)
}

// A search's results (text: as the model was given them).
export function saveSearch(root, query, text) {
  return write(root, searchFile(query), { kind: 'search', title: `Search: ${query}`, query, fetched: today() }, text)
}

function parse(root, name) {
  const abs = path.join(researchDir(root), name)
  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const meta = Object.fromEntries((m?.[1] ?? '').split('\n').map((l) => /^(\w+):\s*(.*)$/.exec(l.trim())).filter(Boolean).map(([, k, v]) => [k, v.trim()]))
  return { ...meta, name, file: path.relative(root, abs), kind: meta.kind || 'page', size: text.length }
}
const read = (root, name) => parse(root, name)

// Every saved page and search: { name, file, url, title, fetched, query, used_for, kind, size }, newest first.
export function listResearch(root) {
  let names = []
  try {
    names = fs.readdirSync(researchDir(root)).filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
  } catch {}
  return names
    .map((n) => parse(root, n))
    .filter(Boolean)
    .sort((a, b) => String(b.fetched).localeCompare(String(a.fetched)) || a.name.localeCompare(b.name))
}

// Saved research that matches a text (a task, a search query): pages first, the best matches first.
// A word in the title, the query that found it or what it was used for counts most; in the address, less.
export function findResearch(root, text, max = 6) {
  const words = new Set(keywords(text))
  if (!words.size) return []
  return listResearch(root)
    .map((r) => {
      let score = 0
      for (const w of new Set([...keywords(r.title), ...keywords(r.query), ...keywords(r.used_for)])) if (words.has(w)) score += 2
      for (const w of new Set(keywords(r.url))) if (words.has(w)) score += 1
      return { r, score: score - (r.kind === 'search' ? 1 : 0) }
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.r)
}

// The file a model names: its name, or its path in the project ("…/research/x.md").
const nameOf = (file) => path.basename(String(file ?? '').trim())

// Kept: what it was used for goes in its header (and the index).
export function markUsed(root, file, usedFor) {
  const r = read(root, nameOf(file))
  if (!r) return false
  const abs = path.join(researchDir(root), r.name)
  const text = fs.readFileSync(abs, 'utf8')
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const { name, file: _f, size, ...meta } = r
  write(root, r.name, { ...meta, used_for: usedFor || meta.used_for || 'yes' }, body)
  return true
}

export function removeResearch(root, file) {
  const r = read(root, nameOf(file))
  if (!r) return false
  fs.rmSync(path.join(researchDir(root), r.name), { force: true })
  rebuildIndex(root)
  return true
}

function rebuildIndex(root) {
  const all = listResearch(root)
  const line = (r) => `- ${r.fetched ?? ''} · [${r.title || r.name}](${r.name})${r.url ? ` · ${r.url}` : ''}${r.used_for ? ` · used for: ${r.used_for}` : ''}`
  const pages = all.filter((r) => r.kind !== 'search')
  const searches = all.filter((r) => r.kind === 'search')
  fs.writeFileSync(
    path.join(researchDir(root), 'INDEX.md'),
    `# Research\n\nWhat HeartCode read on the web for this project, newest first. Each page is kept whole in its file; the notes it led to are in ../memory.\n\n## Pages\n\n${pages.map(line).join('\n') || '(none yet)'}\n\n## Searches\n\n${searches.map(line).join('\n') || '(none yet)'}\n`,
  )
}
