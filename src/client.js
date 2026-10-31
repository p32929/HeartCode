// OpenAI-compatible chat client: plain fetch, SSE streaming, <think> stripping.
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { log, logRequest, requestLog } from './log.js'

export const est = (text) => Math.ceil(String(text ?? '').length / 3.5)
// An error that may go away by itself: a rate limit, a server error or overload, a timeout, no
// connection (no status). Anything else (a wrong model name, key or request) won't.
// A 403 that is a web page, not the API's own (JSON) answer, comes from a gateway or proxy in
// front of it, often for a moment (seen: the same request working a second later): an outage too.
export const outage = (e) => !e.status || [408, 409, 429].includes(e.status) || e.status >= 500 || (e.status === 403 && e.page)
// The model can't be used as it's set up (a wrong key, no access to it, no such model): waiting
// won't help, but the next one in the list may work.
export const unusable = (e) => [401, 403, 404].includes(e.status) && !outage(e)
// A request's messages, estimated: an image's data isn't text (about 800 tokens, not its base64)
export function estMessages(messages) {
  let images = 0
  const text = JSON.stringify(messages ?? [], (k, v) => (k === 'url' && typeof v === 'string' && v.startsWith('data:') ? (images++, '') : v))
  return est(text) + images * 800
}
// A request's size in a model's tokens, estimated: its messages and tools, by that model's ratio of
// counted to estimated tokens (context.js). The same measure decides when to compact (agent.js) and
// whether a request fits the model the list moves on to.
export const tokensOf = (messages, tools, ratio = 1) => Math.round((estMessages(messages) + (tools?.length ? est(JSON.stringify(tools)) : 0)) * ratio)
// The share of a model's window a conversation may take: the rest is room for the reply. Past it,
// the conversation is compacted first.
export const COMPACT_SHARE = 0.85

// "Request too large" (the context window, or a provider's per-request or per-minute input cap):
// the same request can never work, so it isn't retried; the caller sends less. Returns the
// limit in tokens (from the message; else 3/4 of what was sent, but not below what is known to
// work), or null for other errors.
export function inputLimit(e, sent, known = 0) {
  const big =
    e.status === 413 ||
    (e.status >= 400 && e.status < 500 && /\b(request|prompt|input|message|messages|context|payload|body)\b[^.]{0,30}\btoo (large|long|big)|reduce the length|reduce your message|context length|context window|context size|too many (input )?tokens|exceeds? the (maximum|available|context)|maximum (number of )?(input |context )?tokens/i.test(e.message))
  if (!big) return null
  const n = Number(LIMIT_IN_MESSAGE.map((re) => re.exec(e.message)?.[1]).find(Boolean))
  return n > 0 ? n : Math.max(Math.floor(sent * 0.75), known)
}

// The limit when the error states it: { tokens, rate } (rate: a per-minute cap on your account,
// not the model's window), or null (no number in it: nothing is learned from a guess).
export function limitSaid(e) {
  if (!inputLimit(e, 0)) return null
  const n = Number(LIMIT_IN_MESSAGE.map((re) => re.exec(e.message)?.[1]).find(Boolean))
  return n > 0 ? { tokens: n, rate: /per (minute|hour|day)|tokens per (min|hour|day)|\bTP[MHD]\b|rate.?limit|quota/i.test(e.message) } : null
}

// How servers say the limit: OpenAI and vLLM, Mistral, llama.cpp, Anthropic-style, Gemini,
// "context window of N", Groq's per-request cap ("Limit N").
const LIMIT_IN_MESSAGE = [
  /maximum context length is (\d+)/i,
  /(\d+) maximum context length/i,
  /available context size \((\d+)/i,
  /> ?(\d+) maximum/i,
  /allowed \((\d+)\)/i,
  /context (?:window|length|size) (?:of|is) (\d+)/i,
  /\bLimit (\d+)/,
]

// A model's window from a /models entry, whatever the provider calls it. OpenRouter/Together:
// context_length (and top_provider.context_length) · vLLM: max_model_len · Groq: context_window ·
// Mistral: max_context_length · LiteLLM: max_input_tokens · Gemini: inputTokenLimit.
export function windowOf(m) {
  if (!m) return undefined
  return m.context_length ?? m.top_provider?.context_length ?? m.max_model_len ?? m.context_window ?? m.max_context_length ?? m.max_input_tokens ?? m.inputTokenLimit ?? m.context_size ?? m.n_ctx ?? m.meta?.n_ctx_train
}

export function normalizeBaseUrl(url) {
  const u = new URL(url)
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/v1'
  return u.toString().replace(/\/+$/, '')
}

// Removes the thinking some models put in the normal content: a <think> block the reply starts
// with (still open: all of it so far). A reply that only mentions the tag later keeps its text. A
// closing tag with no opening one counts only for a model that thinks (some leave the opening out).
export function stripThink(text, thinks = false) {
  const t = String(text ?? '')
  const lead = /^\s*<think>[\s\S]*?(<\/think>|$)/.exec(t)
  if (lead) return t.slice(lead[0].length).trimStart()
  const close = thinks && !t.includes('<think>') ? t.indexOf('</think>') : -1
  return close !== -1 ? t.slice(close + 8).trimStart() : t
}

// What can be shown so far while streaming: holds back a half-received "<think>".
function visible(full, thinks) {
  let v = stripThink(full, thinks)
  for (let k = 7; k > 0; k--) {
    if (v.endsWith('<think>'.slice(0, k))) return v.slice(0, -k)
  }
  return v
}

// The text inside the <think> block the reply starts with, so far (an unclosed one counts),
// holding back a half-received "</think>".
export function thinkOf(full) {
  const m = /^\s*<think>/.exec(full)
  if (!m) return ''
  const close = full.indexOf('</think>', m[0].length)
  if (close !== -1) return full.slice(m[0].length, close)
  let rest = full.slice(m[0].length)
  for (let k = 8; k > 0; k--) {
    if (rest.endsWith('</think>'.slice(0, k))) return rest.slice(0, -k)
  }
  return rest
}

// The conversation as the model asked now can take it. It may have been written with others (the
// model list moving on, helpers), so: images only for a model that sees them (else a note), tool
// calls only for one that calls tools (else as text), tool call ids in one form every provider
// takes (9 letters and digits), tool arguments always JSON, and only its own thinking sent back.
// can: { vision, actions } (the model's abilities); the saved conversation stays as it is.
export const writtenBy = new WeakMap() // an assistant message → the model that wrote it
const IMAGE_NOTE = "(an image is here, but you can't see images: to know what's in it, ask a model that can, with the agent tool's images)"
const callId = (id) => (/^[A-Za-z0-9]{9}$/.test(id) ? id : createHash('sha256').update(String(id)).digest('hex').slice(0, 9))
const asJson = (a) => {
  try {
    JSON.parse(a || '{}')
    return a || '{}'
  } catch {
    return '{}'
  }
}
export function fitFor(messages, can, model) {
  const tools = can.actions !== 'guided'
  return messages.map((m) => {
    let x = { ...m }
    if (x.reasoning_content && writtenBy.has(m) && writtenBy.get(m) !== model) delete x.reasoning_content
    if (Array.isArray(x.content) && !can.vision) x.content = x.content.map((p) => (p.type === 'image_url' ? IMAGE_NOTE : (p.text ?? ''))).join('\n')
    if (!tools && x.role === 'tool') return { role: 'user', content: `(the result of your earlier tool call)\n${x.content}` }
    if (!tools && x.tool_calls) {
      const { tool_calls, ...rest } = x
      return { ...rest, content: [x.content, ...tool_calls.map((c) => `(called ${c.function.name} ${c.function.arguments || '{}'})`)].filter(Boolean).join('\n') }
    }
    if (x.tool_calls) x.tool_calls = x.tool_calls.map((c) => ({ ...c, id: callId(c.id), function: { ...c.function, arguments: asJson(c.function.arguments) } }))
    if (x.role === 'tool') x.tool_call_id = callId(x.tool_call_id)
    return x
  })
}

// Refusals a provider may make of one part of a request, learned when sending it without that
// part works (then kept in the model's profile for a day): temperature, reasoning_effort, the
// usage in a stream, the thinking sent back, the tools' full schemas, images.
export const QUIRKS = ['noTemperature', 'noEffort', 'noStreamUsage', 'noReasoningBack', 'simpleSchemas', 'noImages', 'noParallel']

export class Client {
  constructor({ baseUrl, apiKey, model, provider, timeout = 600_000 } = {}) {
    this.provider = provider // its name in config.json, for the requests log
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.apiKey = apiKey
    this.model = model
    this.timeout = timeout
    this.quirks = {}
    this.retryBase = 1000 // first wait before retrying a failed request (then ×2 each time)
    // how long a streamed reply may go without sending anything before it counts as stalled (then
    // tried again, or the next model asked); a reply that keeps coming has no limit, however long
    this.idleMs = 150_000
    this.tokenRatio = 1 // the server's token count / est(): calibrated from usage (context.js)
    this.knownGood = 0 // the biggest request known to work, in tokens
    this.onUsage = null // (prompt tokens the server counted, estimate of what was sent): learns the window
    this.speed = { tokens: 0, ms: 0 } // generated tokens and time, for the average tok/s
    this.rotation = null // setRotation
  }

  // Models to go on to when one fails (the settings page's numbered list), in order and round
  // again: list [{ provider, baseUrl, apiKey, model }] (#1 is this client's own), on: when to move
  // on ('failure': rate limits, server errors, timeouts, no connection; 'retries': after `retries`
  // failed tries of the same one; 'any': any error), next: what a new message starts with ('first' or
  // 'stay' on the one that worked). onSwitch(target): a different model answered than before.
  setRotation(list, { on = 'failure', retries = 2, next = 'first' } = {}) {
    if (!list || list.length < 2) {
      const t = list?.[0] ?? this.rotation?.list[0] // one model: that one (a new #1 from the settings page too)
      if (t && (t.model !== this.model || normalizeBaseUrl(t.baseUrl) !== this.baseUrl || t.apiKey !== this.apiKey)) this.#use(t)
      this.rotation = null
      return
    }
    const was = this.rotation
    list = list.map((t) => ({ ...t, quirks: was?.list.find((x) => x.baseUrl === t.baseUrl && x.model === t.model)?.quirks ?? {} }))
    if (!was) list[0].quirks = this.quirks
    this.rotation = { list, on, retries, next, at: 0, good: list[0] }
    this.#use(list[0])
  }
  get target() {
    return this.rotation?.list[this.rotation.at] ?? null
  }
  // The model in use answers but gives nothing usable (agent.js: empty replies, again and again):
  // the next one in the list takes over. False when there's no list.
  moveOn(why) {
    if (!this.rotation) return false
    this.#next(why)
    return true
  }
  #next(why, pick) {
    const r = this.rotation
    r.at = pick ? pick() : (r.at + 1) % r.list.length
    log('rotate', `${why} → ${r.list[r.at].provider} · ${r.list[r.at].model}`)
    this.#use(r.list[r.at])
  }
  // Which model of the list to go on to after this one failed, for one request (tried: the places
  // tried, down: the providers that answered with an error, 400 or above). A provider that answered
  // with an error isn't asked again through its next model: the next one is from another provider.
  // When every provider has failed, the models not tried yet, in order; when all have been tried,
  // simply the next one (round again).
  #pick(e, tried, down) {
    const r = this.rotation
    tried.add(r.at)
    if (e?.status >= 400) down.add(r.list[r.at].provider)
    const n = r.list.length
    const after = (ok) => {
      for (let k = 1; k <= n; k++) if (ok((r.at + k) % n)) return (r.at + k) % n
      return -1
    }
    let i = after((i) => !tried.has(i) && !down.has(r.list[i].provider))
    if (i < 0) i = after((i) => !tried.has(i))
    if (i < 0) {
      tried.clear() // all tried: round again
      i = (r.at + 1) % n
    }
    return i
  }
  // A new message: back to #1 (unless it stays on the one that worked)
  newMessage() {
    const r = this.rotation
    if (r && r.next === 'first' && r.at) this.#use(r.list[(r.at = 0)])
  }
  // onUse(target): the model the next request goes to changed (its abilities and profile follow)
  #use(t) {
    const changed = this.model !== t.model || this.baseUrl !== normalizeBaseUrl(t.baseUrl)
    Object.assign(this, { baseUrl: normalizeBaseUrl(t.baseUrl), apiKey: t.apiKey, model: t.model, provider: t.provider })
    this.quirks = t.quirks ?? (t.quirks = {})
    if (changed) this.onUse?.(t)
  }
  // After a failure: go on to the next model? (then it's tried at once)
  #rotate(e, tries, pick) {
    const r = this.rotation
    if (!r) return false
    // at any failure; "after retries": a failure waiting can fix (a rate limit, an outage) is tried again first
    if (r.on === 'retries' && outage(e) && tries < r.retries) return false
    r.at = pick ? pick() : (r.at + 1) % r.list.length
    log('rotate', `${e.message.slice(0, 200)} → ${r.list[r.at].provider} · ${r.list[r.at].model}`)
    this.#use(r.list[r.at])
    return true
  }

  // The requests log (src/log.js): one request to the model, how it ended, and where it is in your
  // list of models (#2 of 3: a fallback).
  #record(req, sent, { error, reply, firstAt } = {}) {
    if (error) error.recorded = true
    if (!requestLog.on) return
    const r = this.rotation
    logRequest({
      ok: !error,
      stopped: error?.name === 'AbortError',
      purpose: this.purpose ?? 'chat',
      provider: this.provider ?? null,
      model: this.model,
      place: r ? r.at + 1 : 1,
      of: r ? r.list.length : 1,
      url: `${this.baseUrl}/chat/completions`,
      status: error ? (error.status ?? null) : 200,
      error: error?.message,
      errorBody: error?.body,
      ms: Date.now() - sent,
      firstTokenMs: firstAt ? firstAt - sent : undefined,
      usage: reply?.usage,
      finishReason: reply?.finishReason,
      request: req,
      reply: reply && { content: reply.content, reasoning: reply.reasoning, toolCalls: reply.toolCalls, ...(reply.raw && { raw: reply.raw }) }, // raw: the stream as it came, for a reply with nothing in it
    })
  }

  get tps() {
    return this.speed.ms ? Math.round(this.speed.tokens / (this.speed.ms / 1000)) : 0
  }

  async #fetch(url, init = {}, { signal, timeout = this.timeout } = {}) {
    const limit = AbortSignal.timeout(timeout)
    const headers = { 'content-type': 'application/json', ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }) }
    const t0 = Date.now()
    log('http', `→ ${init.method ?? 'GET'} ${url}`, init.body ?? '')
    let res
    try {
      res = await fetch(url, { ...init, headers, signal: signal ? AbortSignal.any([signal, limit]) : limit })
    } catch (e) {
      log('http', `✗ ${url} after ${Date.now() - t0}ms: ${e.name} ${e.cause?.code ?? ''} ${e.message}`)
      if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e
      throw new Error(`cannot reach ${url} (${e.cause?.code || e.cause?.message || e.message})`)
    }
    log('http', `← ${res.status} ${url} in ${Date.now() - t0}ms`)
    if (!res.ok) {
      let body = await res.text().catch(() => '')
      log('http', `error body: ${body.slice(0, 5000)}`)
      const raw = body.slice(0, 20_000)
      const page = /^\s*</.test(body) // proxies and gateways answer with a web page
      if (page) body = /<title>([^<]*)/i.exec(body)?.[1]?.trim() ?? 'an HTML error page'
      const err = new Error(`${res.status} from ${url}: ${body.slice(0, 300)}${!raw.trim() ? '(the server gave no reason)' : ''}`)
      err.status = res.status
      err.page = page
      err.body = raw // all of it, for the requests log
      err.retryAfter = res.headers.get('retry-after') ?? /"retryDelay":\s*"(\d+)s"/.exec(body)?.[1] // Gemini says it in the body
      throw err
    }
    return res
  }

  async #json(url, init, timeout = 5000) {
    return (await this.#fetch(url, init, { timeout })).json()
  }

  async listModels(timeout = 10_000) {
    return (await this.modelEntries(timeout)).map((m) => m.id ?? m.name)
  }
  // The server's own entries for its models ({ id, owned_by, context_length, pricing… }, as it sends them).
  async modelEntries(timeout = 10_000) {
    const data = await this.#json(this.baseUrl + '/models', undefined, timeout)
    // { result: [...] } (Cloudflare's shape): there the id is an internal one and the name is the model's
    if (Array.isArray(data.result)) return data.result.filter((m) => m?.name).map((m) => ({ ...m, id: m.name }))
    return (data.data ?? data.models ?? []).filter((m) => m && (m.id ?? m.name))
  }

  // Best effort: asks the server how big the loaded context window is.
  // What the server is, and the window it says: { size, server }. server: llama.cpp, lmstudio,
  // ollama, ollama-cloud, vllm, or null (a provider or proxy that doesn't say what it is). Only a
  // server that is one of these is treated as a model server on this machine or network; its
  // address (localhost, 192.168…) says nothing (a proxy there may serve Gemini).
  async contextSize() {
    const root = this.baseUrl.replace(/\/v1$/, '')
    const host = new URL(root).hostname
    const n = (x) => (Number(x) > 0 ? Number(x) : undefined)
    const tries = [
      async () => {
        const p = await this.#json(root + '/props')
        if (p.default_generation_settings || 'n_ctx' in p) return { size: n(p.default_generation_settings?.n_ctx ?? p.n_ctx), server: 'llama.cpp' }
      },
      async () => {
        const m = await this.#json(`${root}/api/v0/models/${encodeURIComponent(this.model)}`)
        return { size: n(m.loaded_context_length ?? m.max_context_length), server: 'lmstudio' }
      },
      async () => {
        // Ollama (it answers /api/version), or Ollama's cloud (ollama.com): the window of the model
        // as loaded now, else its num_ctx, else on this machine Ollama's default and in the cloud
        // the model's own length
        const cloud = host === 'ollama.com' || host.endsWith('.ollama.com')
        if (!cloud) await this.#json(root + '/api/version')
        const ps = cloud ? null : await this.#json(root + '/api/ps').catch(() => null)
        const loaded = ps?.models?.find((m) => m.name === this.model || m.model === this.model)?.context_length
        const s = await this.#json(root + '/api/show', { method: 'POST', body: JSON.stringify({ model: this.model }) }).catch(() => null)
        const set = /num_ctx\s+(\d+)/.exec(s?.parameters ?? '')?.[1]
        const trained = Object.entries(s?.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1]
        return { size: n(loaded) ?? n(set) ?? (cloud ? n(trained) : s ? 4096 : undefined), server: cloud ? 'ollama-cloud' : 'ollama' }
      },
      async () => {
        const d = await this.#json(this.baseUrl + '/models')
        const m = (d.data ?? d.models ?? []).find((x) => x.id === this.model || x.name === this.model)
        return { size: n(windowOf(m)), server: m?.owned_by === 'vllm' || m?.max_model_len ? 'vllm' : null }
      },
      async () => ({ size: n(windowOf(await this.#json(`${this.baseUrl}/models/${encodeURIComponent(this.model)}`))), server: null }),
    ]
    let server = null
    for (const t of tries) {
      try {
        const r = await t()
        if (r?.server) server ??= r.server
        if (r?.size) return { size: r.size, server: server ?? r.server ?? null }
      } catch {}
    }
    return { size: undefined, server }
  }

  // The settings page's Measure: one request far bigger than any window (about 2.2 million
  // tokens), which servers refuse with their limit in the error ("maximum context length is
  // 131072"). Refused requests aren't charged. If it's accepted (a window that big), it's stopped
  // at once. Returns { limit } | { over } (it took that many) | { error }. Not logged: it's 4 MB.
  async measureContext({ signal, tokens = 2_200_000 } = {}) {
    const headers = { 'content-type': 'application/json', ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }) }
    const body = JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'a '.repeat(tokens) }], stream: true })
    const stop = new AbortController()
    let res
    try {
      res = await fetch(this.baseUrl + '/chat/completions', { method: 'POST', headers, body, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]) })
    } catch (e) {
      return { error: `couldn't send it: ${e.cause?.code || e.cause?.message || e.message}` }
    }
    if (res.ok) {
      stop.abort()
      return { over: tokens }
    }
    const text = await res.text().catch(() => '')
    const e = Object.assign(new Error(`${res.status} ${text.slice(0, 4000)}`), { status: res.status })
    const said = limitSaid(e)
    log('measure', `${this.model}: ${res.status}`, text.slice(0, 1000))
    if (said && !said.rate) return { limit: said.tokens }
    const why = /^\s*</.test(text) ? (/<title>([^<]*)/i.exec(text)?.[1]?.trim() ?? 'an HTML error page') : (() => {
      try {
        const j = JSON.parse(text)
        return j.error?.message ?? j.error ?? j.message ?? text
      } catch {
        return text
      }
    })()
    return { error: `${res.status}: ${String(why).slice(0, 300)}${said?.rate ? ' (a per-minute cap on your account, not the window)' : ''}` }
  }

  // Returns { content, reasoning, toolCalls, usage, finishReason, thinking }.
  // While streaming, onToken gets answer text and onReasoning gets thinking text.
  // With this.onRetry set (during tasks), any failure is retried after 1s, 2s, 4s, … (capped at
  // 60s, or the server's Retry-After) until it works or the signal aborts. onRetry(error, ms,
  // attempt) reports each wait; onRetry(null) reports the recovery.
  async chat(body, opts = {}) {
    this.refresh?.() // the settings and this model's profile as they are now (bin/heartcode.js)
    if (!this.onRetry) {
      return await this.#timed(body, opts)
    }
    let tries = 0 // of the model being tried now
    let round = 0 // models tried since the last wait (a whole round of them failing: a short pause)
    let hard = true // every failure in this round was one that waiting can't fix (see outage)
    let rounds = 0 // whole rounds of the list that failed
    const tried = new Set() // places in the model list tried for this request
    const down = new Set() // providers that answered it with an error (400 or above): their other models are skipped
    for (let attempt = 0; ; attempt++) {
      // The list moved on to a model whose window can't hold this request (a smaller one): not sent
      // to it as it is; the caller compacts the conversation for that model, then sends it (fit: the
      // caller can; agent.js).
      if (attempt && opts.fit && this.can?.context && tokensOf(body.messages, body.tools, this.tokenRatio) > this.can.context * COMPACT_SHARE) {
        throw Object.assign(new Error(`the conversation is too big for ${this.provider} · ${this.model} (~${tokensOf(body.messages, body.tools, this.tokenRatio)} tokens; its window is ${this.can.context})`), { tooBig: true })
      }
      try {
        const r = await this.#timed(body, { ...opts, once: true })
        if (attempt) this.onRetry(null)
        const rot = this.rotation
        if (rot && rot.good !== rot.list[rot.at]) this.onSwitch?.((rot.good = rot.list[rot.at]))
        return r
      } catch (e) {
        if (e.name === 'AbortError' || opts.signal?.aborted) throw e
        this.onFail?.(e, { provider: this.provider, model: this.model }) // counted for orchestration
        // With a list of models, any failure makes way for the next one (another provider's first).
        // Without one, only what waiting can fix is tried again.
        if (!(this.rotation?.list.length > 1) && !outage(e)) throw e
        if (this.retryIf && !this.retryIf(e, tries)) throw e // headless: --max-retries for one model
        hard &&= !outage(e)
        tries++
        if (this.#rotate(e, tries, () => this.#pick(e, tried, down))) {
          tries = 0
          // ponytail: a 1s pause after a whole round fails (no connection at all: not thousands of
          // requests a minute); the user chose "round again at once"
          if (++round >= this.rotation.list.length) {
            if (hard) throw e // every model refused it outright: going round again won't change that
            if (this.retryIf && !this.retryIf(e, ++rounds)) throw e // headless: --max-retries whole rounds
            hard = true
            round = 0
            this.onRetry(e, 1000, attempt + 1, this.target)
            await sleep(1000, null, { signal: opts.signal })
          } else this.onRetry(e, 0, attempt + 1, this.target)
          continue
        }
        // a server error or no connection, again and again (not a rate limit, which is waited out)
        if (e.status !== 429 && tries >= 8) throw e
        const wait = Math.min(Number(e.retryAfter) * 1000 || this.retryBase * 2 ** (tries - 1), 60_000)
        log('retry', `attempt ${attempt + 1} failed, waiting ${wait}ms: ${e.message}`)
        this.onRetry(e, wait, attempt + 1)
        await sleep(wait, null, { signal: opts.signal })
      }
    }
  }

  // inFlight: when the request being waited on now was sent (null between requests), for the spinner.
  async #timed(body, opts) {
    this.inFlight = Date.now()
    try {
      return await this.#chat(body, opts)
    } catch (e) {
      if (!e.recorded && this.last) this.#record(this.last.req, this.last.sent, { error: e }) // failed while the reply streamed in
      throw e
    } finally {
      this.inFlight = null
    }
  }

  // One request. Without `once`, rate limits and server errors get three quiet retries.
  async #chat(body, { onToken, onReasoning, onToolDelta, signal, once } = {}) {
    const req = { model: this.model, ...body }
    const can = this.can && { ...this.can, vision: this.can.vision && !this.quirks.noImages }
    if (can && req.messages) req.messages = fitFor(req.messages, can, this.model)
    if (can?.actions === 'guided') delete req.tools
    const thinks = Boolean(this.can?.thinking)
    // The model's thinking on its earlier steps (agent.js keeps it as reasoning_content): sent by the
    // name this provider sends it by (reasoning_content: DeepSeek, vLLM…; reasoning: OpenRouter,
    // Ollama), or not at all if it refused it once.
    if (req.messages?.some((m) => m.reasoning_content)) {
      const field = this.quirks.noReasoningBack ? null : (this.quirks.reasoningField ?? 'reasoning_content')
      req.messages = req.messages.map(({ reasoning_content, ...m }) => (reasoning_content && field ? { ...m, [field]: reasoning_content } : m))
    }
    if (this.quirks.simpleSchemas && req.tools) req.tools = req.tools.map((t) => ({ ...t, function: { ...t.function, parameters: simpleSchema(t.function.parameters) } }))
    if (this.quirks.noTemperature) delete req.temperature
    if (this.effort && !this.quirks.noEffort) req.reasoning_effort = this.effort
    if (req.stream && !this.quirks.noStreamUsage) req.stream_options = { include_usage: true } // token counts for the status bar
    if (req.tools?.length && !this.quirks.noParallel) req.parallel_tool_calls = true // several calls in one reply (llama.cpp's default is one)
    let res
    let sent
    let firstAt
    // a stream that stops sending: stalled (see idleMs)
    const idle = req.stream ? new AbortController() : null
    let timer
    const poke = () => {
      if (!idle) return
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(Object.assign(new Error(`${this.model} sent nothing for ${this.idleMs / 1000}s`), { name: 'TimeoutError' })), this.idleMs)
      timer.unref?.()
    }
    const stop = idle ? (signal ? AbortSignal.any([signal, idle.signal]) : idle.signal) : signal
    try {
      for (let attempt = 0; ; attempt++) {
        sent = Date.now()
        this.last = { req, sent }
        try {
          poke()
          res = await this.#fetch(this.baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify(req) }, { signal: stop, timeout: idle ? 86_400_000 : this.timeout })
          break
        } catch (e) {
          this.#record(req, sent, { error: e })
          // Rate limits and server errors, the same set the OpenAI SDKs retry: wait (Retry-After, else 2s, 4s, 8s).
          if (once || !outage(e) || !e.status || attempt === 3 || signal?.aborted) throw e
          const wait = Math.min(Number(e.retryAfter) * 1000 || 2000 * 2 ** attempt, 30_000)
          log('retry', `quiet retry ${attempt + 1} in ${wait}ms: ${e.message}`)
          await sleep(wait, null, { signal })
        }
      }
    } catch (e) {
      clearTimeout(timer)
      // A provider that refuses one part of the request (400, or 422 from the ones that check
      // requests against a schema): the same request without that part. Learned (onLearn: kept in
      // the model's profile) only when that works; else it's put back and the refusal stands. The
      // part the error names first; with none named, images (a model listed as seeing them that
      // doesn't take them here), then the thinking sent back.
      const refused = e.status === 400 || e.status === 422
      if (!refused || inputLimit(e, 1)) throw e // "too large": the caller sends less
      const said = String(e.body ?? e.message)
      const without = async (quirk) => {
        this.quirks[quirk] = true
        log('quirk', `${this.model}: sending it without what ${quirk} leaves out`)
        try {
          const r = await this.#chat(body, { onToken, onReasoning, onToolDelta, signal, once })
          this.onLearn?.(quirk)
          return r
        } catch (e2) {
          if (e2.status === 400 || e2.status === 422) delete this.quirks[quirk]
          throw e2.status === 400 || e2.status === 422 ? e : e2
        }
      }
      const reasoningSent = !this.quirks.noReasoningBack && req.messages?.some((m) => m.reasoning_content || m.reasoning)
      const imagesSent = !this.quirks.noImages && req.messages?.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))
      if (/temperature/i.test(said) && 'temperature' in req && !this.quirks.noTemperature) return without('noTemperature')
      if (/reasoning_effort/.test(said) && 'reasoning_effort' in req && !this.quirks.noEffort) return without('noEffort')
      if (/stream_options/.test(said) && req.stream_options && !this.quirks.noStreamUsage) return without('noStreamUsage')
      if (/parallel_tool_calls/.test(said) && req.parallel_tool_calls && !this.quirks.noParallel) return without('noParallel')
      if (reasoningSent && /reasoning(?!_effort)/i.test(said)) return without('noReasoningBack')
      if (imagesSent && /image|vision|multimodal|modalit|content.{0,20}(type|part)/i.test(said)) return without('noImages')
      if (req.tools?.length && !this.quirks.simpleSchemas && /schema|function_declarations|parameters|additionalProperties|exclusiveM|minItems|unknown name|invalid.{0,40}(tool|function)|tools\[/i.test(said)) return without('simpleSchemas')
      if (imagesSent) return without('noImages')
      if (reasoningSent) return without('noReasoningBack')
      if (req.parallel_tool_calls && !this.quirks.noParallel) return without('noParallel') // refused without naming it
      throw e
    }
    // Tokens the last request used (prompt + reply): what the status bar shows against the context size.
    // Speed counts from the first streamed token (or the request, if not streaming) to the end.
    const count = (r) => {
      if (r.usage?.prompt_tokens) this.onUsage?.(r.usage.prompt_tokens, estMessages(req.messages) + est(JSON.stringify(req.tools ?? '')))
      this.lastTokens = r.usage?.total_tokens || estMessages(req.messages) + est(r.content + r.reasoning)
      const out = r.usage?.completion_tokens || est(r.content + r.reasoning + r.toolCalls.map((t) => t.function.arguments).join(''))
      this.onSpend?.(r.usage?.prompt_tokens || r.usage?.completion_tokens ? r.usage : { prompt_tokens: estMessages(req.messages), completion_tokens: out, estimated: true }) // usage and cost (usage.js)
      const ms = Date.now() - (firstAt ?? sent)
      if (out > 0 && ms > 0) {
        this.speed.tokens += out
        this.speed.ms += ms
      }
      log('reply', `${this.model} in ${Date.now() - sent}ms`, { content: r.content, reasoning: r.reasoning, toolCalls: r.toolCalls, usage: r.usage, finishReason: r.finishReason })
      this.#record(req, sent, { reply: r, firstAt })
      return r
    }
    if (!body.stream) {
      const data = await res.json()
      const choice = data.choices?.[0] ?? {}
      const msg = choice.message ?? {}
      this.#reasoningField(msg)
      return count(done(textOf(msg.content), msg.reasoning_content ?? msg.reasoning ?? msg.thinking ?? '', msg.tool_calls ?? [], data.usage, choice.finish_reason, thinks))
    }

    poke()
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let content = ''
    let reasoning = ''
    let emitted = ''
    let thought = ''
    let usage
    let finishReason
    const calls = []
    let raw = '' // the stream as it came (its start), kept for a reply that turns out empty
    // A reply going round (a small model repeating itself, which could fill the window): checked
    // every 2000 characters of its thinking, its text and each call's arguments; cut where it began.
    let looped = null
    const checked = new Map()
    const watch = (what, text) => {
      if (looped || text.length - (checked.get(what) ?? 0) < 2000) return
      checked.set(what, text.length)
      const at = loopStart(text)
      if (at >= 0) looped = { what, at, sample: text.slice(-200).replace(/\s+/g, ' ').trim().slice(0, 120) }
    }
    const emit = (v) => {
      if (onToken && v.startsWith(emitted) && v.length > emitted.length) {
        onToken(v.slice(emitted.length))
        emitted = v
      }
    }
    for (;;) {
      let value, end
      try {
        ;({ value, done: end } = await reader.read())
      } catch (e) {
        clearTimeout(timer)
        throw e
      }
      poke()
      firstAt ??= Date.now()
      if (end) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (raw.length < 100_000 && line) raw += line + '\n'
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (chunk.error) {
          // an error sent in the stream: its status from its code, else a "too large" one as 400
          // (sent smaller, not again as it is), else a server error (tried again, a few times)
          clearTimeout(timer)
          const said = chunk.error.message ?? JSON.stringify(chunk.error)
          const code = Number(chunk.error.code ?? chunk.error.status)
          const err = Object.assign(new Error(`server error: ${said}`), { body: payload })
          err.status = code >= 400 && code < 600 ? code : 502
          if (err.status === 502 && inputLimit({ status: 400, message: said }, 1)) err.status = 400
          throw err
        }
        if (chunk.usage) usage = chunk.usage
        const ch = chunk.choices?.[0]
        if (!ch) continue
        if (ch.finish_reason) finishReason = ch.finish_reason
        const d = ch.delta ?? ch.message ?? {} // some proxies send the whole message in a chunk
        this.#reasoningField(d)
        if (Array.isArray(d.content)) d.content = textOf(d.content)
        const r = d.reasoning_content || d.reasoning || d.thinking
        if (r) {
          reasoning += r
          onReasoning?.(r)
          watch('reasoning', reasoning)
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? (tc.id ? calls.length : Math.max(calls.length - 1, 0))
          const call = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
          if (tc.id) call.id = tc.id
          if (tc.function?.name) call.function.name ||= tc.function.name
          if (tc.function?.arguments) call.function.arguments += tc.function.arguments
          onToolDelta?.(call.function.name, call.function.arguments)
          watch(`call ${i}`, call.function.arguments)
        }
        if (d.content) {
          content += d.content
          const t = thinkOf(content)
          if (onReasoning && t.length > thought.length && t.startsWith(thought)) {
            onReasoning(t.slice(thought.length))
            thought = t
          }
          emit(visible(content, thinks))
          watch('content', content)
        }
        if (looped) break
      }
      if (looped) {
        await reader.cancel().catch(() => {}) // the server stops generating
        break
      }
    }
    clearTimeout(timer)
    if (looped) {
      log('reply', `${this.model}: went into a loop in its ${looped.what} (cut after ${looped.at} characters): "${looped.sample}"`)
      if (looped.what === 'reasoning') reasoning = reasoning.slice(0, looped.at)
      if (looped.what === 'content') content = content.slice(0, looped.at)
    }
    const result = done(content, reasoning, looped ? [] : calls.filter(Boolean), usage, looped ? 'loop' : finishReason, thinks) // a call cut short isn't made
    if (looped) result.looped = looped.sample
    emit(result.content)
    if (!result.content.trim() && !result.toolCalls.length && !result.reasoning) {
      result.raw = raw // nothing read from it: what came, for the requests log
      log('reply', `${this.model}: an empty reply${usage?.completion_tokens ? ` of ${usage.completion_tokens} tokens` : ''}; the stream:`, raw.slice(0, 4000))
    }
    return count(result)
  }

  // The name this provider gives the model's thinking, to send it back by the same one.
  #reasoningField(d) {
    if (this.quirks.reasoningField) return
    if (d.reasoning_content) this.quirks.reasoningField = 'reasoning_content'
    else if (typeof d.reasoning === 'string' && d.reasoning) this.quirks.reasoningField = 'reasoning'
  }
}

// Where a text started going round: its newest 200 characters are already there 6+ times in its
// last 12,000 (a phrase or a block of up to 2000 characters, repeated). -1: it isn't.
export function loopStart(text) {
  if (text.length < 2000) return -1
  const probe = text.slice(-200)
  const win = text.slice(-12_000)
  let n = 0
  let first = -1
  for (let i = win.indexOf(probe); i !== -1; i = win.indexOf(probe, i + 1)) {
    n++
    if (first < 0) first = i
  }
  return n >= 6 ? text.length - win.length + first : -1
}

// A tool's arguments as the most limited providers take them (Gemini's function declarations):
// only types, properties, required, items, enum and descriptions; a choice of types (anyOf, oneOf,
// ["string", "null"]) becomes its first real one.
const KEEP = new Set(['type', 'properties', 'required', 'items', 'enum', 'description'])
export function simpleSchema(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return x
  const alt = x.anyOf ?? x.oneOf
  if (alt?.length) {
    const pick = alt.find((a) => a?.type !== 'null') ?? alt[0]
    return simpleSchema({ ...pick, ...(x.description && { description: x.description }) })
  }
  const out = {}
  for (const [k, v] of Object.entries(x)) {
    if (!KEEP.has(k)) continue
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v ?? {}).map(([n, s]) => [n, simpleSchema(s)]))
    else if (k === 'items') out.items = simpleSchema(Array.isArray(v) ? v[0] : v)
    else if (k === 'type' && Array.isArray(v)) out.type = v.find((y) => y !== 'null') ?? 'string'
    else out[k] = v
  }
  out.type ??= out.properties ? 'object' : 'string'
  if (Array.isArray(out.required) && out.properties) out.required = out.required.filter((r) => r in out.properties)
  return out
}

// Message content as text: a string, or a list of parts ({ type: 'text', text }).
const textOf = (c) => (Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('') : (c ?? ''))

function done(raw, reasoning, toolCalls, usage, finishReason, thinks) {
  const calls = toolCalls.filter((c) => c?.function?.name)
  calls.forEach((c, i) => (c.id ||= callId(`${Date.now()}_${i}_${Math.random()}`)))
  return {
    content: stripThink(raw, thinks),
    reasoning: (reasoning || thinkOf(raw)).trim(),
    toolCalls: calls,
    usage,
    finishReason,
    thinking: Boolean(reasoning) || /<\/?think>/.test(raw),
  }
}
