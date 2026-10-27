// apply_patch: the patch format OpenAI's models (GPT-4.1+, gpt-oss, Codex) are trained to write.
// Several files in one go: added, deleted, changed, moved.
//   *** Begin Patch
//   *** Add File: hello.txt
//   +Hello
//   *** Update File: src/app.js
//   *** Move to: src/main.js        (optional)
//   @@ function main() {           (optional: a line just above, to find the right place)
//    context line
//   -removed line
//   +added line
//   *** Delete File: old.js
//   *** End Patch
// Each changed part is matched like edit_file's search text (applyEdit: exact, else ignoring
// indentation), so a slightly off context still applies.
import { applyEdit } from './edit.js'

// → [{ type: 'add' | 'delete' | 'update', path, moveTo?, content?, chunks?: [{ header, old, new }] }]
export function parsePatch(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch')
  if (i === -1) throw new Error('the patch must start with "*** Begin Patch"')
  const ops = []
  let op = null
  let chunk = null
  const newChunk = (header = '') => op.chunks.push((chunk = { header, old: [], new: [] }))
  for (i++; i < lines.length; i++) {
    const l = lines[i]
    let m
    if (l.trim() === '*** End Patch') return ops
    if ((m = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(l))) {
      op = { type: m[1].toLowerCase(), path: m[2].trim(), ...(m[1] === 'Add' && { content: [] }), ...(m[1] === 'Update' && { chunks: [] }) }
      chunk = null
      ops.push(op)
      continue
    }
    if (!op) {
      if (l.trim()) throw new Error(`line ${i + 1}: expected "*** Add File:", "*** Update File:" or "*** Delete File:", got "${l}"`)
      continue
    }
    if (op.type === 'add') {
      if (l.startsWith('+')) op.content.push(l.slice(1))
      else if (l.trim()) throw new Error(`line ${i + 1}: in an added file every line starts with "+"`)
      continue
    }
    if (op.type === 'delete') continue
    if ((m = /^\*\*\* Move to: (.+)$/.exec(l))) {
      op.moveTo = m[1].trim()
      continue
    }
    if (l.startsWith('@@')) {
      newChunk(l.replace(/^@@\s?/, '').replace(/\s*@@$/, '').trim())
      continue
    }
    if (l.trim() === '*** End of File') continue
    if (!chunk) newChunk()
    const mark = l[0]
    if (mark === '+') chunk.new.push(l.slice(1))
    else if (mark === '-') chunk.old.push(l.slice(1))
    else {
      const ctx = mark === ' ' ? l.slice(1) : l // models drop the space on blank context lines
      chunk.old.push(ctx)
      chunk.new.push(ctx)
    }
  }
  throw new Error('the patch must end with "*** End Patch"')
}

// One file's chunks applied to its text → { text } or { error }.
export function applyChunks(text, chunks) {
  let out = text
  for (const [n, ch] of chunks.entries()) {
    const label = chunks.length > 1 ? `part ${n + 1}: ` : ''
    const old = ch.old.join('\n')
    const next = ch.new.join('\n')
    if (!old.trim()) {
      // only added lines: after the @@ line, else at the end
      const at = ch.header ? out.indexOf(ch.header) : -1
      if (ch.header && at === -1) return { error: `${label}the @@ line "${ch.header}" was not found` }
      const end = at === -1 ? out.length : out.indexOf('\n', at) === -1 ? out.length : out.indexOf('\n', at) + 1
      const before = out.slice(0, end)
      out = before + (before && !before.endsWith('\n') ? '\n' : '') + next + '\n' + out.slice(end)
      continue
    }
    let r = applyEdit(out, old, next)
    if (r.error && ch.header && out.includes(ch.header)) {
      // several places match: the one after the @@ line
      const at = out.indexOf(ch.header)
      const tail = applyEdit(out.slice(at), old, next)
      if (!tail.error) r = { text: out.slice(0, at) + tail.text }
    }
    if (r.error) return { error: label + r.error.replace('SEARCH text', 'context and - lines') }
    out = r.text
  }
  return { text: out }
}
