// Each model's track record from real work: what it finished and what it failed at, kept across
// projects in ~/.heart/records.json. On unless config.json's "trackRecord" is false (the settings
// page: General). Where HeartCode picks a model by ranking (the next one after a failure, a
// handover, helpers by score), a model that keeps doing well moves up and one that keeps failing
// moves down; a model that has failed most of its work doesn't start a message while another can.
import fs from 'node:fs'
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'
import { log } from './log.js'

const FILE = path.join(HOME, 'records.json')
// what each event adds: [good, bad]
const WEIGHT = { done: [1, 0], helped: [1, 0], 'review-no': [0, 1], handover: [0, 1], 'helper-failed': [0, 1], 'bad-reply': [0, 0.5], 'not-proven': [0, 1], 'no-answer': [0, 1] }
export const records = { on: true }
export const useRecords = (cfg) => (records.on = cfg.trackRecord !== false)
const key = (t) => `${t.provider}/${t.model}`

// read again only when the file changed (other tabs and runs write it too)
let cache = { at: null, all: {} }
function all() {
  const st = fs.statSync(FILE, { throwIfNoEntry: false })
  const at = st ? `${st.mtimeMs}:${st.size}` : ''
  if (cache.at !== at) cache = { at, all: readJson(FILE, {}) }
  return cache.all
}

// One event for a model ({ provider, model }). Older events fade (each new one counts a little more
// than the last: after about 25 more, an event counts half), so a model that got better shows it.
export function record(t, what) {
  if (!records.on || !t?.model || !WEIGHT[what]) return
  const [good, bad] = WEIGHT[what]
  log('agent', `track record: ${key(t)} ${what}`)
  try {
    const now = readJson(FILE, {})
    const r = now[key(t)] ?? { good: 0, bad: 0 }
    now[key(t)] = { good: r.good * 0.97 + good, bad: r.bad * 0.97 + bad, at: Date.now() }
    writeJson(FILE, now)
  } catch {}
}

export const recordOf = (t) => all()[key(t)] ?? null
export const forgetRecords = () => fs.rmSync(FILE, { force: true })

// How often it failed, from 0 to 1 (0.5 with no record either way); null: too little to tell, or off
function failRate(t) {
  const r = records.on ? recordOf(t) : null
  if (!r || r.good + r.bad < 3) return null
  return (r.bad + 1) / (r.good + r.bad + 2)
}
// failed most of its work (3.5 events' worth after fading: about 4 recent ones): last wherever
// HeartCode picks
export const unreliable = (t) => (failRate(t) ?? 0) >= 0.7 && recordOf(t).good + recordOf(t).bad >= 3.5

// A ranking score (scoreOf: lower is better, Infinity: not ranked) moved by the record: a model
// that never failed ×0.3, one that always does ×1.7, no record ×1. A model not ranked with a good
// record comes before the other unranked ones.
export function withRecord(t, rank) {
  const f = failRate(t)
  if (f === null) return rank
  if (rank === Infinity) return f < 0.5 ? 1 + f : Infinity
  return rank * (0.3 + 1.4 * f)
}

// Sorts [{ t, score }] (score: scoreOf's) best first: the unreliable last, then by score with the record
export const byRecord = (a, b) => {
  const ua = unreliable(a.t)
  const ub = unreliable(b.t)
  if (ua !== ub) return ua ? 1 : -1
  const x = withRecord(a.t, a.score)
  const y = withRecord(b.t, b.score)
  return x === y ? 0 : x < y ? -1 : 1
}
