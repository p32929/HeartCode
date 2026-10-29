// Applying model edits, forgiving about the usual small-model mistakes.

const lead = (l) => /^\s*/.exec(l)[0]
const key = (l) => l.trim().replace(/\s+/g, ' ')

function trimBlank(lines) {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a].trim()) a++
  while (b > a && !lines[b - 1].trim()) b--
  return lines.slice(a, b)
}

// Replace `search` with `replace` in `text`. Exact match first, then a
// whitespace-insensitive line match (re-indenting the replacement).
export function applyEdit(text, search, replace) {
  if (!search.trim()) return { error: 'the SEARCH text is empty' }
  const exact = text.split(search).length - 1
  if (exact === 1) return { text: text.replace(search, () => replace) }
  if (exact > 1) return { error: `the SEARCH text matches ${exact} places; include more surrounding lines so it matches only one` }

  const lines = text.split('\n')
  const s = trimBlank(search.split('\n'))
  const sk = s.map(key)
  const hits = []
  for (let i = 0; i + s.length <= lines.length; i++) {
    if (sk.every((k, j) => key(lines[i + j]) === k)) hits.push(i)
  }
  if (hits.length > 1) return { error: `the SEARCH text matches ${hits.length} places; include more surrounding lines so it matches only one` }
  if (!hits.length) return { error: notFound(lines, sk) }

  const i = hits[0]
  lines.splice(i, s.length, ...reindent(s, trimBlank(replace.split('\n')), lines.slice(i, i + s.length)))
  return { text: lines.join('\n') }
}

// The model's lines `repl` replace `orig` (as it saw them, `seen`). If the
// model shifted the indentation, shift its replacement back.
export function reindent(seen, repl, orig = seen) {
  const j = seen.findIndex((l) => l.trim())
  const k = repl.findIndex((l) => l.trim())
  if (j < 0 || k < 0) return repl
  const to = lead(orig[j])
  const from = lead(repl[k])
  if (from === to) return repl
  return repl.map((l) => (l.trim() && l.startsWith(from) ? to + l.slice(from.length) : l))
}

function notFound(lines, sk) {
  const words = new Set(sk.join(' ').split(/\W+/).filter((w) => w.length > 2))
  let best = -1
  let score = 0
  lines.forEach((l, i) => {
    const sc = l.split(/\W+/).filter((w) => words.has(w)).length
    if (sc > score) [best, score] = [i, sc]
  })
  const msg = 'the SEARCH text was not found in the file'
  if (best < 0) return msg
  return `${msg}. The closest lines are around line ${best + 1}:\n${lines.slice(Math.max(0, best - 2), best + 3).join('\n')}`
}

// Parses git-conflict-style blocks. Accepts 5-9 marker chars and missing SEARCH/REPLACE words; a
// block without its final marker is a cut-off reply, left out.
export function parseBlocks(reply) {
  const blocks = []
  let cur = null
  let part = null
  for (const line of String(reply).replace(/\r\n/g, '\n').split('\n')) {
    // Markers may carry any label ("<<<<<<< SEARCH", "<<<<<<< num.js", or none).
    if (/^\s*<{5,9}(\s.*)?$/.test(line)) {
      cur = { search: [], replace: [] }
      part = 'search'
    } else if (cur && part === 'search' && /^\s*={5,9}\s*$/.test(line)) {
      part = 'replace'
    } else if (cur && /^\s*>{5,9}(\s.*)?$/.test(line)) {
      if (part === 'replace') blocks.push(join(cur))
      cur = null
    } else if (cur) {
      cur[part].push(line)
    }
  }
  // a block with no closing >>>>>>> is a reply that was cut off: its replacement is part of one (left out)
  return blocks
}

const join = (b) => ({ search: b.search.join('\n'), replace: b.replace.join('\n') })

const isFence = (l) => /^\s*(`{3,}|~{3,})/.test(l)
const firstReal = (lines) => (lines.find((l) => l.trim()) ?? '').trim()
const numbered = (lines) => {
  const real = lines.filter((l) => l.trim())
  return real.length > 0 && real.every((l) => /^\s*\d+\s*\|/.test(l))
}

// The whole reply is meant to be code. Remove what models wrap around it:
// a fence, a line of prose before it, notes after it, copied line numbers.
export function cleanCode(reply, original = '') {
  let lines = String(reply).replace(/\r\n/g, '\n').split('\n')
  const orig = original.split('\n')
  if (firstReal(lines) !== firstReal(orig)) {
    const open = lines.findIndex(isFence)
    if (open !== -1 && lines.slice(0, open).filter((l) => l.trim()).length <= 3) {
      let close = -1
      for (let i = lines.length - 1; i > open; i--) {
        if (isFence(lines[i])) {
          close = i
          break
        }
      }
      lines = lines.slice(open + 1, close === -1 ? undefined : close)
    }
  }
  if (numbered(lines) && !numbered(orig)) lines = lines.map((l) => l.replace(/^\s*\d+\s*\| ?/, ''))
  const t = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '')
  return !original || original.endsWith('\n') ? t + '\n' : t
}

const DEF = /\b(?:function|def|class|fn|func|interface|struct|enum)\s+([A-Za-z_]\w*)|\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=/g
const defNames = (t) => new Set([...t.matchAll(DEF)].map((m) => m[1] ?? m[2]))

// Definitions an edit deleted that the task doesn't name — the typical small-model rewrite
// accident (or what the task asked: the model is asked which, guided.js).
export function lostNames(old, next, task) {
  const now = defNames(next)
  return [...defNames(old)].filter((n) => !now.has(n) && !task.includes(n))
}
