// web_fetch and web_search: a page as text, and search results, with no API key.
// Search asks several engines at once and puts their results together (webSearch): public SearXNG
// instances (the list from searx.space), Mwmbl, DuckDuckGo's HTML page, and for coding questions
// Stack Overflow, npm and GitHub. Bing, Startpage, Mojeek, Google and Brave were tried too: blocked
// (Brave refuses Node's connections), or junk results for scripts. When none can be reached, the
// model is told "search is unreachable", so it stops searching instead of trying other words.
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'
// ponytail: scraping, no API; add a keyed backend (Brave, Tavily) if DuckDuckGo blocks for good.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
const HEADERS = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' }
export const decode = (s) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })

// HTML → readable text: scripts, styles and page furniture dropped; headings, list items, links
// and code blocks kept in a markdown-ish form.
export function htmlToText(html, base) {
  let h = String(html)
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1]?.trim() ?? '')
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(h)?.[0] // the page's content, when it marks it
  if (main && main.length > 500) h = main
  h = h
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|title|nav|footer|iframe|template|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, code) => `\n\`\`\`\n${code.replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => {
      const text = t.replace(/<[^>]+>/g, '').trim()
      if (!text) return ''
      let url = decode(href)
      try {
        url = new URL(url, base).href
      } catch {}
      return /^https?:/.test(url) && text !== url ? `[${text}](${url})` : text
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|dd|dt)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, '')
  const text = decode(h)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n\s*\n(?=- )/g, '\n') // list items one per line
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return title && !text.startsWith(`# ${title}`) ? `# ${title}\n\n${text}` : text
}

const MAX = 10_000 // a part and its note fit in a tool result (agent.js keeps 12,000 characters of one)

// A page's text, from `start` (characters), for the model.
export async function webFetch(url, { start = 0, signal } = {}) {
  let u
  try {
    u = new URL(/^\w+:\/\//.test(url) ? url : `https://${url}`)
  } catch {
    return `error: "${url}" is not a URL`
  }
  if (!/^https?:$/.test(u.protocol)) return 'error: only http and https URLs can be fetched'
  const res = await fetch(u, { headers: HEADERS, redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
  const type = res.headers.get('content-type') ?? ''
  if (!/text|json|xml|javascript|markdown/.test(type) && type) return `error: ${u.href} is ${type.split(';')[0]}, not text (${res.status})`
  const body = await res.text()
  const text = /html/.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body, res.url) : body
  const from = Math.max(0, Number(start) || 0)
  const part = text.slice(from, from + MAX)
  const more = from + MAX < text.length ? `\n\n… (${text.length} characters in all; call web_fetch with start: ${from + MAX} for more)` : ''
  return `${res.ok ? '' : `error: HTTP ${res.status}\n`}${res.url !== u.href ? `(redirected to ${res.url})\n` : ''}${part || '(empty page)'}${more}`
}

const strip = (s) => decode(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

async function duckduckgo(query, signal) {
  let html = ''
  for (let i = 0; i < 2; i++) {
    const res = await fetch(process.env.HEART_SEARCH_URL || 'https://html.duckduckgo.com/html/', { // HEART_SEARCH_URL: a stand-in (tests)
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded', referer: 'https://html.duckduckgo.com/' },
      body: new URLSearchParams({ q: query, b: '' }),
      signal,
    })
    html = await res.text()
    if (res.status !== 202) break // 202: its bot check
    if (i === 0) await new Promise((r) => setTimeout(r, 1500))
    else throw new Error('DuckDuckGo is asking for a captcha')
  }
  const out = []
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g)) {
    let url = decode(m[1])
    const wrapped = /[?&]uddg=([^&]+)/.exec(url) // a DuckDuckGo redirect link
    if (wrapped) url = decodeURIComponent(wrapped[1])
    if (/duckduckgo\.com\/y\.js/.test(url)) continue // an ad
    out.push({ title: strip(m[2]), url, snippet: strip(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(m[3])?.[1] ?? '') })
  }
  return out
}

// SearXNG: the healthy public instances from searx.space (kept a day in ~/.heart/searx.json),
// fastest first; the ones that gave good results go first (kept there too), the ones that failed
// or answered empty sit out ten minutes. Five are asked at a time (5 s each), the next five when
// none answers well, through the whole list if need be; fewer than ten good results: pages 2 and 3
// too. Everything they find is put together, best match first. Their JSON output is off on almost all of them, and many
// answer a GET empty: the results page is asked for the way its form does (POST).
const SEARX_FILE = path.join(HOME, 'searx.json')
const answered = readJson(SEARX_FILE, {}).good ?? [] // instances that gave good results, latest first (kept)
const resting = new Map() // instance → until when it's left out
async function searxInstances(signal) {
  const saved = readJson(SEARX_FILE, null)
  if (saved?.list?.length && Date.now() - saved.at < 86_400_000) return saved.list
  try {
    const d = await (await fetch('https://searx.space/data/instances.json', { headers: HEADERS, signal })).json()
    const list = Object.entries(d.instances ?? {})
      .filter(([, i]) => i.network_type === 'normal' && i.http?.status_code === 200 && (i.uptime?.uptimeDay ?? 0) >= 90 && i.timing?.search?.all?.median)
      .sort((a, b) => a[1].timing.search.all.median - b[1].timing.search.all.median)
      .map(([u]) => u.replace(/\/?$/, '/'))
    if (list.length) writeJson(SEARX_FILE, { ...readJson(SEARX_FILE, {}), at: Date.now(), list })
    return list.length ? list : (saved?.list ?? [])
  } catch (e) {
    if (saved?.list?.length) return saved.list // searx.space is down: the older list
    throw new Error(`searx.space: ${e.message}`)
  }
}
async function searxAt(base, query, signal, page = 1) {
  // as its own search form sends it: a GET is refused or answered empty by many instances' limiter
  const res = await fetch(`${base}search`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: query, category_general: '1', language: 'en', ...(page > 1 && { pageno: String(page) }) }), signal })
  if (!res.ok) throw new Error(`${base} answered ${res.status}`)
  const html = await res.text()
  const out = []
  for (const block of html.split('<article class="result').slice(1)) {
    const a = /<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!a || !/^https?:\/\//.test(decode(a[1]))) continue
    out.push({ title: strip(a[2]), url: decode(a[1]), snippet: strip(/<p class="content">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '') })
  }
  return out
}
// How well a result matches the query: the share of its words (3+ letters) in its title, snippet
// and address. Junk (an instance passing on an engine that answers scripts with whatever matches one
// word) scores low.
function relevance(words, h) {
  if (!words.length) return 1
  const text = `${h.title} ${h.snippet} ${h.url}`.toLowerCase()
  return words.filter((w) => text.includes(w)).length / words.length
}
async function searx(query, signal) {
  const all = await searxInstances(signal)
  const order = [...answered.filter((u) => all.includes(u)), ...all.filter((u) => !answered.includes(u) && !((resting.get(u) ?? 0) > Date.now()))]
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]{2,}/gu) ?? [])]
  const errors = []
  const merged = new Map() // address → { hit, score, from: how many instances had it }
  const worked = [] // instances that gave good results for this query
  const good = () => [...merged.values()].filter((x) => x.score >= 0.5).length
  const add = (hits) => {
    for (const h of hits) {
      const key = h.url.replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '')
      const had = merged.get(key)
      merged.set(key, had ? { ...had, from: had.from + 1 } : { hit: h, score: relevance(words, h), from: 1 })
    }
  }
  // Asks these instances at once (page `page`); once one has answered, the others get 1.5 s more.
  const round = (batch, page) =>
    new Promise((resolve) => {
      const stop = new AbortController()
      const each = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(5000)].filter(Boolean))
      let left = batch.length
      let grace = null
      const done = () => (clearTimeout(grace), stop.abort(), resolve())
      for (const u of batch) {
        searxAt(u, query, each, page)
          .then((hits) => {
            const mean = hits.slice(0, 5).reduce((t, h) => t + relevance(words, h), 0) / Math.max(1, Math.min(5, hits.length))
            if (page === 1) {
              if (!hits.length || mean < 0.5) resting.set(u, Date.now() + 600_000) // empty or junk: others first for a while
              else worked.push(u)
            }
            add(hits)
            if (hits.length) grace ??= setTimeout(done, 1500)
          })
          .catch((e) => {
            errors.push(e.message)
            if (page === 1) resting.set(u, Date.now() + 600_000)
          })
          .finally(() => --left === 0 && done())
      }
    })
  // five at a time until some answer well; none of the five: the next five
  for (let i = 0; i < order.length && !worked.length; i += 5) {
    await round(order.slice(i, i + 5), 1)
    if (signal?.aborted) break
  }
  // not many good ones on the first page: pages 2 and 3 from the ones that answered, all at once
  if (worked.length && good() < 10 && !signal?.aborted) await Promise.all([2, 3].map((page) => round(worked.slice(0, 3), page)))
  if (worked.length) {
    answered.splice(0, answered.length, ...worked, ...answered.filter((x) => !worked.includes(x)).slice(0, 20 - worked.length))
    writeJson(SEARX_FILE, { ...readJson(SEARX_FILE, {}), good: answered }) // the next HeartCode starts with them
  }
  // best match first; found by more instances breaks a tie
  if (merged.size) return [...merged.values()].sort((a, b) => b.score - a.score || b.from - a.from).map((x) => x.hit)
  if (errors.length && errors.length >= order.length) throw new Error(`no instance answered (${errors[0]}…)`)
  return []
}

// Mwmbl: an open-source, non-profit engine with its own index; a JSON API, no key. Fast, and
// always there; smaller than the big engines.
async function mwmbl(query, signal) {
  const res = await fetch(`https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(query)}`, { headers: { ...HEADERS, accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`Mwmbl answered ${res.status}`)
  const text = (parts) => (Array.isArray(parts) ? parts.map((p) => p.value ?? '').join('') : String(parts ?? ''))
  return (await res.json()).map((r) => ({ title: decode(text(r.title)), url: r.url, snippet: decode(text(r.extract)) }))
}

// Stack Overflow's questions (the Stack Exchange API, no key): for errors and how-to questions.
async function stackoverflow(query, signal) {
  const res = await fetch(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=5&site=stackoverflow&q=${encodeURIComponent(query)}`, { headers: { ...HEADERS, accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`Stack Exchange answered ${res.status}`)
  return ((await res.json()).items ?? []).map((i) => ({ title: decode(i.title), url: i.link, snippet: `${i.is_answered ? 'answered' : 'no accepted answer'} · score ${i.score} · ${(i.tags ?? []).join(', ')}` }))
}

// npm's package search: for libraries and tools.
async function npm(query, signal) {
  const res = await fetch(`https://registry.npmjs.org/-/v1/search?size=5&text=${encodeURIComponent(query)}`, { headers: { ...HEADERS, accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`npm answered ${res.status}`)
  return ((await res.json()).objects ?? []).map(({ package: p }) => ({ title: `${p.name} (npm package, ${p.version})`, url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`, snippet: p.description ?? '' }))
}

// GitHub's repository search (no key: a few requests a minute): for projects and examples.
async function github(query, signal) {
  const res = await fetch(`https://api.github.com/search/repositories?per_page=5&q=${encodeURIComponent(query)}`, { headers: { ...HEADERS, accept: 'application/vnd.github+json' }, signal })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return ((await res.json()).items ?? []).map((r) => ({ title: `${r.full_name} (GitHub, ${r.stargazers_count}★)`, url: r.html_url, snippet: r.description ?? '' }))
}

// All asked at once; a search fails only when every one does. Public instances of the open-source
// engines come and go (on 2026-10-31 most LibreY, Whoogle and 4get ones were down or blocked, so
// they aren't here), and DuckDuckGo is blocked on some networks.
export const ENGINES = { searx, mwmbl, duckduckgo, stackoverflow, npm, github }
const SIDE = new Set(['stackoverflow', 'npm', 'github']) // for coding questions: a few each, when they match
const GENERAL = new Set(['searx', 'duckduckgo']) // the broadest: waited for a while even when the fast ones have answered

// Results as text: title, URL, where they came from and snippet, numbered. The engines are asked
// together; once enough good results are in, the slower ones get 2 s more. Each result is scored on
// its own (the query's words in it), one that several engines found ranks higher.
let unreachableUntil = 0 // search couldn't be reached: said at once for a while, without waiting again
let unreachableWhy = ''
export async function webSearch(query, { signal, limit = 10, engines = ENGINES } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return 'error: no query given'
  if (Date.now() < unreachableUntil && engines === ENGINES) return unreachableWhy
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]{2,}/gu) ?? [])]
  const failed = []
  const merged = new Map()
  const stop = new AbortController()
  const each = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(25_000)].filter(Boolean))
  const good = () => [...merged.values()].filter((x) => x.score >= 0.5).length
  await new Promise((resolve) => {
    const names = Object.keys(engines)
    let left = names.length
    let answered = 0
    let general = 0
    let grace = null
    const done = () => (clearTimeout(grace), resolve())
    for (const name of names) {
      engines[name](q, each)
        .then((hits) => {
          hits = hits.filter((h) => h.url && h.title)
          if (SIDE.has(name)) hits = hits.slice(0, 3)
          if (!hits.length) return failed.push(`${name}: no results`)
          answered++
          if (GENERAL.has(name)) general++
          for (const h of hits) {
            const key = h.url.replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '')
            const had = merged.get(key)
            if (!had) merged.set(key, { hit: h, score: relevance(words, h), from: [name] })
            else if (!had.from.includes(name)) had.from.push(name)
          }
          // enough: the slower ones get a little more (a general engine, the best results, up to 12 s)
          if (answered >= 2 && good() >= limit) {
            clearTimeout(grace)
            grace = setTimeout(done, general ? 2000 : 12_000)
          }
        })
        .catch((e) => failed.push(`${name}: ${e.name === 'AbortError' || /aborted/.test(e.message) ? (signal?.aborted ? 'stopped' : 'too slow') : e.message}`))
        .finally(() => --left === 0 && done())
    }
  })
  stop.abort() // the slow ones: not waited for
  if (signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
  // ranked by the query's words in each, a word that few results have weighing more ("tailwind"
  // over "latest"), and by how many engines found it
  const all = [...merged.values()]
  const textOf = (h) => `${h.title} ${h.snippet} ${h.url}`.toLowerCase()
  const weight = Object.fromEntries(words.map((w) => [w, Math.log(1 + all.length / (1 + all.filter((x) => textOf(x.hit).includes(w)).length))]))
  const total = words.reduce((t, w) => t + weight[w], 0) || 1
  const ranked = all.map((x) => ({ ...x, rank: words.reduce((t, w) => t + (textOf(x.hit).includes(w) ? weight[w] : 0), 0) / total + 0.15 * (x.from.length - 1) })).sort((a, b) => b.rank - a.rank)
  if (ranked.length) {
    unreachableUntil = 0
    return ranked
      .slice(0, limit)
      .map(({ hit: h, from }, i) => `${i + 1}. ${h.title}\n   ${h.url} (${from.join(', ')})${h.snippet ? `\n   ${h.snippet}` : ''}`)
      .join('\n\n')
  }
  // can't be reached: every engine failed on the network itself (not public instances being busy)
  const unreachable = failed.length && failed.every((f) => !/no instance answered|no results/.test(f) && /timeout|too slow|aborted|fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|network/i.test(f))
  if (unreachable) {
    unreachableWhy = `error: web search can't be reached from here right now (${failed.join('; ')}). Don't search again in this task: web_fetch pages you know (official docs, sites you can name), or go on with what you know.`
    if (engines === ENGINES) unreachableUntil = Date.now() + 5 * 60_000
    return unreachableWhy
  }
  return `no results for "${q}" (${failed.join('; ')}). Try other words, or web_fetch a site you know.`
}
