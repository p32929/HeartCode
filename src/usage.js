// Tokens used and what they cost, per chat (chat.usage). Prices per million tokens come from
// models.dev's list of models (https://models.dev/api.json), kept a day in ~/.heart/prices.json,
// and so does what each model is: its context window, longest reply, and whether it calls tools,
// thinks and reads images (limitsOf). HeartCode takes a model's abilities from there.
// A model it doesn't list (a local one, a provider it doesn't know) counts tokens only.
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'
import { log } from './log.js'

const FILE = path.join(HOME, 'prices.json')
const DAY = 86_400_000
const VERSION = 3 // 2: with each model's limits; 3: and its abilities
let table = null // { v, at, providers: { id: { api, models: { id: { input, output, cache_read, cache_write, limit: { context, output }, can: { tools, thinking, images } } } } } }

// Loads the list (from the file if it's from today, else from models.dev). Never throws.
// force: fetched again however fresh the saved one is (the settings page's retry); its failure throws.
export async function loadPrices({ url = 'https://models.dev/api.json', timeout = 15_000, force = false } = {}) {
  table ??= readJson(FILE, null)
  const asked = arguments[0]?.url || force // a list from somewhere else, or asked for again: always fetched
  if (!asked && ((table?.v === VERSION && Date.now() - table.at < DAY) || process.env.HEART_NO_PRICES)) return table // tests: no network
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const providers = {}
    for (const [id, p] of Object.entries(data)) {
      const models = {}
      for (const [m, info] of Object.entries(p.models ?? {})) {
        const price = info.cost && (({ input, output, cache_read, cache_write }) => ({ input, output, cache_read, cache_write }))(info.cost)
        const limit = info.limit?.context > 0 ? { context: info.limit.context, output: info.limit.output > 0 ? info.limit.output : undefined } : undefined
        const can = { tools: info.tool_call !== false, thinking: Boolean(info.reasoning), images: Array.isArray(info.modalities?.input) ? info.modalities.input.includes('image') : Boolean(info.attachment) }
        if (price || limit) models[m] = { ...price, limit, can }
      }
      providers[id] = { api: p.api, models }
    }
    table = { v: VERSION, at: Date.now(), providers }
    writeJson(FILE, table)
  } catch (e) {
    log('prices', `could not load the price list: ${e.message}`)
    if (force) throw new Error(`couldn't reach models.dev: ${e.message}`)
  }
  return table
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// The price of a model at a provider (HeartCode's name for it and its URL), or null. The provider
// models.dev knows by that name or URL first, else any provider that lists the model.
export function priceOf(provider, baseUrl, model) {
  if (!table || !model) return null
  const all = Object.entries(table.providers)
  const ids = [model, model.split('/').pop()]
  const find = (list) => {
    for (const [, p] of list) for (const id of ids) if (p.models[id]?.input !== undefined) return (({ limit, can, ...price }) => price)(p.models[id])
    return null
  }
  const own = all.filter(ownBy(provider, baseUrl))
  return find(own) ?? find(all)
}
// models.dev's providers that are this one: by its name in HeartCode, or its URL.
const ownBy = (provider, baseUrl) => {
  const host = hostOf(baseUrl)
  return ([id, p]) => norm(id) === norm(provider) || (p.api && hostOf(p.api) === host) || (host.includes(id) && id.length > 3)
}

// models.dev's models with a size, by their names made plain (norm), the whole name and its last
// part: built once per list, so a lookup doesn't go through all of them (thousands) again.
const indexes = new WeakMap()
function indexOf(t) {
  if (indexes.has(t)) return indexes.get(t)
  const index = new Map()
  let n = 0 // its place in the list: ties go to the first, as they did before the index
  for (const entry of Object.entries(t.providers)) {
    for (const [m, info] of Object.entries(entry[1].models)) {
      if (!info.limit) continue
      const hit = { entry, info, n: n++ }
      for (const k of new Set([norm(m), norm(m.split('/').pop())])) index.has(k) ? index.get(k).push(hit) : index.set(k, [hit])
    }
  }
  indexes.set(t, index)
  return index
}

// A "…-latest" name models.dev doesn't list: the newest dated version it does list
// (magistral-small-latest → magistral-small-2509), its entries at every provider. [] if none.
function newestOf(name) {
  const base = /^(.+?)[-_.:]?latest$/i.exec(name)?.[1]
  if (!base) return []
  const re = new RegExp(`^[a-z]{0,12}${norm(base)}(\\d{4,8})$`) // a date or version after the name: 2509, 20250929; a vendor before it (mistral.magistral-small-2509)
  let best = null
  for (const [k, list] of indexOf(table)) {
    const d = re.exec(k)?.[1]
    if (d && (!best || Number(d) > Number(best.d))) best = { d, list }
  }
  return best ? [...best.list].sort((a, b) => a.n - b.n) : []
}

// What models.dev says of a model: { context, output (tokens), tools, thinking, images }, or null. Found by its name
// however it's written (google/gemini-2.5-flash, models/gemini-2.5-flash, gpt-oss:120b ≈
// gpt-oss-120b): at this provider first; else, among all that list it, the size most say (a
// proxy or a provider models.dev doesn't know serves the model at its usual size).
export function limitsOf(provider, baseUrl, model) {
  if (!table || !model) return null
  const last = (m) => m.split('/').pop()
  const want = new Set([model, model.replace(/^models\//, ''), last(model), last(model).replace(/:(free|beta|extended|nitro|floor|online|cloud)$/, '').replace(/-cloud$/, '')].map(norm))
  const own = ownBy(provider, baseUrl)
  const found = { own: [], all: [] }
  let hits = [...new Set([...want].flatMap((w) => indexOf(table).get(w) ?? []))].sort((a, b) => a.n - b.n)
  if (!hits.length) hits = newestOf(last(model)) // "magistral-small-latest" by its dated names only
  for (const { entry, info } of hits) {
    const it = { ...info.limit, ...(info.can ?? { tools: true, thinking: false, images: false }) }
    found.all.push(it)
    if (own(entry)) found.own.push(it)
  }
  const list = found.own.length ? found.own : found.all
  if (!list.length) return null
  const count = (x) => list.filter((y) => y.context === x.context).length
  const best = list.reduce((a, b) => (count(b) > count(a) || (count(b) === count(a) && b.context > a.context) ? b : a))
  return { context: best.context, output: best.output, tools: best.tools, thinking: best.thinking, images: best.images }
}

// Adds one request's usage (OpenAI's names) to the total; returns what it cost (0 if unknown).
export function addUsage(total, u, price) {
  const input = u?.prompt_tokens ?? 0
  const output = u?.completion_tokens ?? 0
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
  const written = u?.cache_write_tokens ?? 0
  let cost = 0
  if (typeof u?.cost === 'number') cost = u.cost // OpenRouter says what it charged
  else if (price) cost = ((input - cached - written) * (price.input ?? 0) + cached * (price.cache_read ?? price.input ?? 0) + written * (price.cache_write ?? price.input ?? 0) + output * (price.output ?? 0)) / 1e6
  Object.assign(total, {
    requests: (total.requests ?? 0) + 1,
    input: (total.input ?? 0) + input,
    output: (total.output ?? 0) + output,
    cached: (total.cached ?? 0) + cached,
    cost: (total.cost ?? 0) + cost,
    priced: total.priced || Boolean(price) || typeof u?.cost === 'number',
  })
  return cost
}

export const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : '$0')
