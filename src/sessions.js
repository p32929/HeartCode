// Saved conversations: one file per chat in ~/.heart/sessions, written after every message, so a
// chat can be resumed later and rewound to any earlier message (conversation, files, or both).
import fs from 'node:fs'
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'

const DIR = path.join(HOME, 'sessions')

// A chat: what the model has seen (messages for tool mode, history for guided mode), what the
// screen showed (log), and per message ("turn") where each of those stood and the files as they
// were before HeartCode first changed them in that turn (null = the file didn't exist).
export function newChat(root) {
  const now = new Date()
  const id = `${now.toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}`
  return { id, root, created: now.toISOString(), updated: now.toISOString(), title: '', messages: null, history: [], turns: [], log: [] }
}

export function saveChat(chat) {
  const file = path.join(DIR, `${chat.id}.json`)
  const first = chat.turns[0] ?? chat.branches?.[0]?.state.turns[0] // gone back to the start: its branches remain
  if (!first) return fs.rmSync(file, { force: true }) // nothing (left) worth keeping
  chat.updated = new Date().toISOString()
  chat.title = chat.name || first.task.split('\n')[0].slice(0, 80) // its name (/rename), else the first message, even after a rewind
  writeJson(file, chat)
}

// /fork: a copy of the chat to go on with (the original stays as it is, in /resume).
export function forkChat(chat) {
  const copy = { ...structuredClone(chat), id: newChat(chat.root).id, created: new Date().toISOString() }
  copy.name = `${chat.name || chat.title || 'chat'} (fork)`
  return copy
}

// The conversation as the model saw it, for /export: [{ role, text, tools: [{ name, args, result }] }].
function entries(chat) {
  const text = (c) => (Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n') : String(c ?? ''))
  if (!chat.messages?.length) return chat.history.flatMap((h) => [{ role: 'user', text: h.task }, { role: 'assistant', text: h.answer }])
  const out = []
  const calls = new Map()
  for (const m of chat.messages.slice(1)) {
    if (m.role === 'tool') {
      const t = calls.get(m.tool_call_id)
      if (t) t.result = text(m.content)
      continue
    }
    const e = { role: m.role, text: text(m.content).trim(), tools: (m.tool_calls ?? []).map((t) => ({ name: t.function.name, args: t.function.arguments })) }
    m.tool_calls?.forEach((t, i) => calls.set(t.id, e.tools[i]))
    if (e.text || e.tools.length) out.push(e)
  }
  return out
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
const fence = (s) => { const f = '`'.repeat(Math.max(3, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${s}\n${f}` }

// format: 'md', 'html' or 'json' (the whole session file)
export function exportChat(chat, format, model = '') {
  if (format === 'json') return JSON.stringify(chat, null, 2) + '\n'
  const title = chat.name || chat.title || chat.turns[0]?.task.split('\n')[0] || 'HeartCode chat'
  const when = `${new Date(chat.created).toLocaleString()}${model ? ` · ${model}` : ''} · ${chat.root}`
  const list = entries(chat)
  if (format === 'md') {
    const body = list.map((e) => {
      const tools = e.tools.map((t) => `<details><summary>${t.name} ${esc(t.args.slice(0, 120))}</summary>\n\n${fence(t.result ?? '')}\n</details>`).join('\n')
      return [`## ${e.role === 'user' ? 'You' : 'HeartCode'}`, e.text, tools].filter(Boolean).join('\n\n')
    })
    return `# ${title}\n\n_${when}_\n\n${body.join('\n\n')}\n`
  }
  const body = list.map((e) => {
    const tools = e.tools.map((t) => `<details><summary><b>${esc(t.name)}</b> <code>${esc(t.args.slice(0, 160))}</code></summary><pre>${esc(t.result ?? '')}</pre></details>`).join('')
    return `<section class="${e.role}"><h2>${e.role === 'user' ? 'You' : 'HeartCode'}</h2>${e.text ? `<div class="text">${esc(e.text)}</div>` : ''}${tools}</section>`
  })
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { --bg: #fff; --fg: #1d1f23; --muted: #6b7080; --user: #f3f0ff; --line: #e3e5ea; --code: #f6f7f9 }
@media (prefers-color-scheme: dark) { :root { --bg: #16181d; --fg: #e6e8ec; --muted: #9aa0ad; --user: #241f36; --line: #2c3038; --code: #1e2127 } }
body { background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 16px }
header p { color: var(--muted); margin-top: -8px }
section { border-top: 1px solid var(--line); padding: 12px 0 }
section.user { background: var(--user); border-radius: 8px; padding: 12px 16px; border: 0; margin: 12px 0 }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 6px }
.text { white-space: pre-wrap; overflow-wrap: anywhere }
details { margin: 6px 0; font-size: 13px }
summary { cursor: pointer; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
pre { background: var(--code); padding: 10px; border-radius: 6px; overflow-x: auto; max-height: 400px; white-space: pre-wrap }
</style></head><body>
<header><h1>${esc(title)}</h1><p>${esc(when)}</p></header>
${body.join('\n')}
</body></html>
`
}

// One chat by its id (any folder), or null.
export function loadChat(id) {
  return /^[\w.-]+$/.test(id) ? readJson(path.join(DIR, `${id}.json`), null) : null
}

// This folder's chats, newest first.
export function listChats(root) {
  let files = []
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
  } catch {}
  return files
    .map((f) => readJson(path.join(DIR, f), null))
    .filter((c) => c && c.root === root && (c.turns?.length || c.branches?.length))
    .sort((a, b) => b.updated.localeCompare(a.updated))
}

// Puts files back as they were before turn `from` (later turns first, so the oldest copy wins).
// Returns the files touched.
export function restoreFiles(chat, from) {
  const touched = new Set()
  for (const turn of chat.turns.slice(from).reverse()) {
    for (const [rel, before] of Object.entries(turn.files)) {
      const abs = path.resolve(chat.root, rel)
      if (before === null) fs.rmSync(abs, { force: true })
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, before)
      }
      touched.add(rel)
    }
  }
  return [...touched]
}

export const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
