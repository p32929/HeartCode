// What each model did with the jobs handed to it, kept in ~/.heart/model-stats.json ("provider
// model" → its last jobs, oldest first): { at, job (its few words), about (the start of its prompt),
// ms, ok (it gave an answer), check ('pass' |
// 'fail' | absent: nothing to run), why (what failed) }. The orchestrator sees each model's recent
// record and the jobs most like the one it's handing out, so it learns from what really happened.
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'

const FILE = path.join(HOME, 'model-stats.json')
const KEEP = 40 // per model: recent ones count, old ones drop off (a model that got better or worse shows it)

export const loadStats = () => readJson(FILE, {})

// read, add, write: other HeartCodes may be adding too (ponytail: last writer wins on a clash)
export function record(key, job) {
  const all = loadStats()
  all[key] = [...(all[key] ?? []), { at: Date.now(), ...job }].slice(-KEEP)
  writeJson(FILE, all)
}

export function forget(key) {
  const all = loadStats()
  delete all[key]
  writeJson(FILE, all)
}

const secs = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// A model's record in numbers: { jobs, passed, failed, unchecked, lost, ms } (lost: no answer)
export function summary(list = []) {
  const done = list.filter((j) => j.ok)
  return { jobs: list.length, passed: list.filter((j) => j.check === 'pass').length, failed: list.filter((j) => j.check === 'fail').length, unchecked: done.filter((j) => !j.check).length, lost: list.length - done.length, ms: done.length ? median(done.map((j) => j.ms)) : null }
}

// ... in words, for the orchestrator: "of its last 7 jobs: 5 passed their check, 1 failed it, 1 gave no answer; ~40 s each"
export function recordLine(list) {
  const s = summary(list)
  if (!s.jobs) return ''
  const parts = [s.passed && `${s.passed} passed ${s.passed === 1 ? 'its check' : 'their checks'}`, s.failed && `${s.failed} failed ${s.failed === 1 ? 'its check' : 'their checks'}`, s.unchecked && `${s.unchecked} unchecked`, s.lost && `${s.lost} gave no answer`].filter(Boolean)
  return `of its last ${s.jobs} job${s.jobs === 1 ? '' : 's'}: ${parts.join(', ')}${s.ms != null ? `; ~${secs(s.ms)} each` : ''}`
}

// The past jobs most like this text (by the words they share), newest first among equals: lines for
// the orchestrator. names: the models it can hand to now ("provider model").
const words = (t) => new Set(String(t ?? '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) ?? [])
const COMMON = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'make', 'from', 'into', 'your', 'you', 'can', 'please', 'want', 'need', 'all', 'are', 'not', 'its', 'it.', 'add', 'use', 'have', 'will'])
export function similar(text, names, n = 6, all = loadStats()) {
  const want = [...words(text)].filter((w) => !COMMON.has(w))
  if (!want.length) return ''
  const ago = (at) => ((d) => (d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`))((Date.now() - at) / 86_400_000)
  const found = names.flatMap((name) => (all[name] ?? []).map((j) => ({ name, j, score: ((w) => want.filter((x) => w.has(x)).length)(words(`${j.job} ${j.about ?? ''}`)) })))
    .filter((x) => x.score >= Math.min(2, want.length))
    .sort((a, b) => b.score - a.score || b.j.at - a.j.at)
    .slice(0, n)
  return found.map(({ name, j }) => `- "${String(j.job).slice(0, 90)}" (${ago(j.at)}) → ${name}: ${!j.ok ? `no answer${j.why ? ` (${j.why.slice(0, 60)})` : ''}` : j.check === 'pass' ? 'its check passed' : j.check === 'fail' ? 'its check failed' : 'answered, unchecked'}${j.ok ? `, ${secs(j.ms)}` : ''}`).join('\n')
}
