// web_fetch and web_search: a page as text, and search results, with no API key.
// Search scrapes DuckDuckGo's HTML page (asked twice when it answers with its bot check). Bing,
// Startpage and Mojeek were tried too: blocked, or junk results for scripts.
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

export const ENGINES = { duckduckgo }

// Results as text: title, URL and snippet, numbered.
export async function webSearch(query, { signal, limit = 8, engines = ENGINES } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return 'error: no query given'
  const failed = []
  for (const [name, engine] of Object.entries(engines)) {
    try {
      const hits = (await engine(q, signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000))).filter((h) => h.url && h.title)
      if (hits.length) return hits.slice(0, limit).map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n\n')
      failed.push(`${name}: no results`)
    } catch (e) {
      if (signal?.aborted) throw e
      failed.push(`${name}: ${e.message}`)
    }
  }
  return `no results for "${q}" (${failed.join('; ')}). Try other words, or web_fetch a site you know.`
}
