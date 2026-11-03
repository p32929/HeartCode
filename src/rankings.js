// What each model is good at, from public rankings (LMArena: people comparing two models' answers
// to the same prompt, by skill): overall, coding, web apps, images. Fetched once a week into
// ~/.heart/rankings.json (with an orchestrator, or Update model info); a model is matched to its entry by name.
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'
import { log } from './log.js'
import { readParquet } from './parquet.js'

const FILE = path.join(HOME, 'rankings.json')
const WEEK = 7 * 24 * 3600_000
const VERSION = 2 // 2: with each model's score; an older file is fetched again
const FILES = 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main' // one Parquet file per ranking: text, webdev, vision, agent

// The lists kept (ranking:category): shown on Your models and to the orchestrator
const LISTS = ['text:overall', 'text:coding', 'webdev:webdev', 'vision:overall']

export const loadRankings = () => readJson(FILE, null)

// One ranking (text, webdev…), every category in it: { 'text:coding': [{ name, rank, score, votes }], … } (score: its rating there)
async function fetchRanking(config, signal) {
  const res = await fetch(`${FILES}/${config}/latest-00000-of-00001.parquet`, { signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) })
  if (!res.ok) throw new Error(`rankings ${config}: HTTP ${res.status}`)
  const out = {}
  for (const r of readParquet(Buffer.from(await res.arrayBuffer()), ['model_name', 'rank', 'category', 'rating', 'vote_count'])) (out[`${config}:${r.category}`] ??= []).push({ name: r.model_name, rank: r.rank, score: Math.round(r.rating), votes: r.vote_count })
  return out
}

// The rankings: fetched when there are none or they're a week old (then the old ones are used
// meanwhile, refreshed behind). null when there are none and fetching failed.
let refreshing = null
export async function rankings({ signal, onWait, now = false } = {}) {
  const have = loadRankings()
  if (have && have.v === VERSION && Date.now() - have.fetched < WEEK && !now) return have
  refreshing ??= (async () => {
    const wanted = new Set(LISTS)
    const all = Object.assign({}, ...(await Promise.all([...new Set([...wanted].map((p) => p.split(':')[0]))].map((c) => fetchRanking(c, have ? undefined : signal)))))
    const lists = Object.fromEntries(Object.entries(all).filter(([k]) => wanted.has(k)))
    const out = { v: VERSION, fetched: Date.now(), source: 'LMArena (huggingface.co/datasets/lmarena-ai/leaderboard-dataset)', lists }
    writeJson(FILE, out)
    log('fit', `rankings fetched: ${Object.entries(lists).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
    return out
  })().finally(() => (refreshing = null))
  if (have && !now) {
    refreshing.catch((e) => log('fit', `rankings not refreshed: ${e.message}`))
    return have
  }
  onWait?.()
  try {
    return await refreshing
  } catch (e) {
    if (signal?.aborted) throw e
    log('fit', `no rankings: ${e.message}`)
    return null
  }
}

// A name as words: "models/gemini-3.6-flash" and "Gemini 3.6 Flash (High)" are both "gemini 3 6 flash"
const DROP = new Set(['latest', 'preview', 'free', 'it', 'instruct', 'exp', 'chat'])
const WORDS = new Map() // name → its words: thousands of models are matched against hundreds of entries, each parsed once
export const words = (name) => {
  const k = String(name)
  if (!WORDS.has(k)) WORDS.set(k, toWords(k))
  return WORDS.get(k)
}
const toWords = (name) =>
  name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^.*\//, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !DROP.has(w) && !/^\d{4}$/.test(w)) // dated versions (2512, 0127)

// Where a model stands in a list, 0 (best) to 1 (last); null when it isn't in it. Its entry: the
// same words, or those followed only by its size ("nemotron 3 super" = "Nemotron 3 Super 120B A12B"),
// maybe after the maker's name; of several (High, Low…), the best.
export function place(model, list) {
  const mine = words(model)
  if (!mine.length || !list?.length) return null
  const size = /^(\d+|[abmkt])$/
  const at = list.filter((e) => {
    const theirs = words(e.name)
    // from their first word, or their second (a maker's name first: "NVIDIA-Nemotron-3-Super-120B-A12B")
    return [0, 1].some((from) => theirs.length >= from + mine.length && mine.every((w, i) => theirs[from + i] === w) && theirs.slice(from + mine.length).every((w) => size.test(w)))
  })
  return at.length ? Math.min(...at.map((e) => e.rank)) / list.length : null
}

// A model's place in one list ('text:coding'…), for showing: { rank, of, as, score, votes } (as: its name there); null when not in it
export function rankIn(model, key, data) {
  const list = data?.lists[key]
  const at = list?.filter((e) => place(model, [e]) != null)
  if (!at?.length) return null
  const best = at.reduce((a, b) => (b.rank < a.rank ? b : a))
  return { rank: best.rank, of: list.length, as: best.name, score: best.score, votes: best.votes }
}
