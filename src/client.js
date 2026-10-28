// OpenAI-compatible chat client: plain fetch, SSE streaming, <think> stripping.
import { setTimeout as sleep } from 'node:timers/promises'
import { log, logRequest, requestLog } from './log.js'

export const est = (text) => Math.ceil(String(text ?? '').length / 3.5)
// An error that may go away by itself: a rate limit, a server error or overload, a timeout, no
// connection (no status). Anything else (a wrong model name, key or request) won't.
export const outage = (e) => !e.status || [408, 409, 429].includes(e.status) || e.status >= 500
// The model can't be used as it's set up (a wrong key, no access to it, no such model): waiting
// won't help, but the next one in the list may work.
export const unusable = (e) => [401, 403, 404].includes(e.status)
// A request's messages, estimated: an image's data isn't text (about 800 tokens, not its base64)
export function estMessages(messages) {
  let images = 0
  const text = JSON.stringify(messages ?? [], (k, v) => (k === 'url' && typeof v === 'string' && v.startsWith('data:') ? (images++, '') : v))
  return est(text) + images * 800
}

// "Request too large" (the context window, or a provider's per-request or per-minute input cap):
// the same request can never work, so it isn't retried; the caller sends less. Returns the
// limit in tokens (from the message; else 3/4 of what was sent, but not below what is known to
// work), or null for other errors.
export function inputLimit(e, sent, known = 0) {
  const big =
    e.status === 413 ||
    (e.status >= 400 && e.status < 500 && /too large|too long|reduce the length|reduce your message|context length|context window|context size|too many tokens|exceeds? the (maximum|available|context)|maximum (number of )?tokens/i.test(e.message))
  if (!big) return null
  const n = Number(LIMIT_IN_MESSAGE.map((re) => re.exec(e.message)?.[1]).find(Boolean))
  return n > 0 ? n : Math.max(Math.floor(sent * 0.75), known)
}

// The limit when the error states it: { tokens, rate } (rate: a per-minute cap on your account,
// not the model's window), or null (no number in it: nothing is learned from a guess).
export function limitSaid(e) {
  if (!inputLimit(e, 0)) return null
  const n = Number(LIMIT_IN_MESSAGE.map((re) => re.exec(e.message)?.[1]).find(Boolean))
  return n > 0 ? { tokens: n, rate: /per minute|tokens per min|\bTPM\b|rate.?limit/i.test(e.message) } : null
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

export function isLocal(url) {
  const h = new URL(url).hostname
  return /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
}

// Removes reasoning blocks some models put inside the normal content.
export function stripThink(text) {
  let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '')
  const open = t.indexOf('<think>')
  if (open !== -1) t = t.slice(0, open)
  const close = t.indexOf('</think>')
  if (close !== -1) t = t.slice(close + 8)
  return t.trimStart()
}

// What can be shown so far while streaming: holds back a half-received "<think>".
function visible(full) {
  let v = stripThink(full)
  for (let k = 7; k > 0; k--) {
    if (v.endsWith('<think>'.slice(0, k))) return v.slice(0, -k)
  }
  return v
}

// The text inside <think> blocks so far (an unclosed one counts), holding back a half-received "</think>".
export function thinkOf(full) {
  let out = ''
  let i = 0
  for (;;) {
    const open = full.indexOf('<think>', i)
    if (open === -1) return out
    const close = full.indexOf('</think>', open + 7)
    if (close === -1) {
      let rest = full.slice(open + 7)
      for (let k = 8; k > 0; k--) {
        if (rest.endsWith('</think>'.slice(0, k))) {
          rest = rest.slice(0, -k)
          break
        }
      }
      return out + rest
    }
    out += full.slice(open + 7, close)
    i = close + 8
  }
}

export class Client {
  constructor({ baseUrl, apiKey, model, provider, timeout = 600_000 } = {}) {
    this.provider = provider // its name in config.json, for the requests log
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.apiKey = apiKey
    this.model = model
    this.timeout = timeout
    this.quirks = {}
    this.retryBase = 1000 // first wait before retrying a failed request (then ×2 each time)
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
      if (this.rotation) this.#use(this.rotation.list[0])
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
    const r = this.rotation
    if (!r) return false
    r.at = (r.at + 1) % r.list.length
    log('rotate', `${why} → ${r.list[r.at].provider} · ${r.list[r.at].model}`)
    this.#use(r.list[r.at])
    return true
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
  #rotate(e, tries) {
    const r = this.rotation
    if (!r) return false
    if (!(r.on === 'any' || (r.on === 'failure' && (outage(e) || unusable(e))) || (r.on === 'retries' && (tries >= r.retries || unusable(e))))) return false
    r.at = (r.at + 1) % r.list.length
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
      if (/^\s*</.test(body)) body = /<title>([^<]*)/i.exec(body)?.[1]?.trim() ?? 'an HTML error page' // proxies and gateways
      const err = new Error(`${res.status} from ${url}: ${body.slice(0, 300)}`)
      err.status = res.status
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
    // "too large": never retried as is; the limit is learned and the caller sends less
    const tooLarge = (e) => {
      const limit = inputLimit(e, Math.round(estMessages(body.messages) * this.tokenRatio), this.knownGood)
      if (!limit) return false
      e.inputLimit = limit // this request is sent smaller
      // remembered only when the server said the number (a guess isn't); a per-minute cap apart
      const said = limitSaid(e)
      log('limit', `request too large; ${said ? `the server says ${said.tokens}${said.rate ? ' per minute' : ''}` : `no limit given, trying ~${limit}`}`)
      if (said) this.onInputLimit?.(said.tokens, { rate: said.rate })
      return true
    }
    if (!this.onRetry) {
      try {
        return await this.#timed(body, opts)
      } catch (e) {
        tooLarge(e)
        throw e
      }
    }
    let tries = 0 // of the model being tried now
    let round = 0 // models tried since the last wait (a whole round of them failing: a short pause)
    let hard = true // every failure in this round was one that waiting can't fix (see outage)
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.#timed(body, { ...opts, once: true })
        if (attempt) this.onRetry(null)
        const rot = this.rotation
        if (rot && rot.good !== rot.list[rot.at]) this.onSwitch?.((rot.good = rot.list[rot.at]))
        return r
      } catch (e) {
        if (e.name === 'AbortError' || opts.signal?.aborted) throw e
        if (tooLarge(e)) throw e // the caller shrinks the conversation and sends again
        if (this.retryIf && !this.retryIf(e, attempt)) throw e
        // A bad request (400…): the same request fails the same way every time, so it isn't sent
        // again. It stops here, unless the model list moves on at any error (the settings page). A
        // model that can't be used (a wrong key or name: 401, 403, 404) makes way for the next one
        // in the list; a whole round of those stops too, rather than going round.
        if (!outage(e) && !(unusable(e) && this.rotation) && this.rotation?.on !== 'any') throw e
        hard &&= !outage(e)
        tries++
        if (this.#rotate(e, tries)) {
          tries = 0
          // ponytail: a 1s pause after a whole round fails (no connection at all: not thousands of
          // requests a minute); the user chose "round again at once"
          if (++round >= this.rotation.list.length) {
            if (hard) throw e // every model refused it outright: going round again won't change that
            hard = true
            round = 0
            this.onRetry(e, 1000, attempt + 1, this.target)
            await sleep(1000, null, { signal: opts.signal })
          } else this.onRetry(e, 0, attempt + 1, this.target)
          continue
        }
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
    let res
    let sent
    let firstAt
    try {
      for (let attempt = 0; ; attempt++) {
        sent = Date.now()
        this.last = { req, sent }
        try {
          res = await this.#fetch(this.baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify(req) }, { signal })
          break
        } catch (e) {
          this.#record(req, sent, { error: e })
          // Rate limits and server errors, the same set the OpenAI SDKs retry: wait (Retry-After, else 2s, 4s, 8s).
          if (once || !([408, 409, 429].includes(e.status) || e.status >= 500) || attempt === 3 || signal?.aborted) throw e
          const wait = Math.min(Number(e.retryAfter) * 1000 || 2000 * 2 ** attempt, 30_000)
          log('retry', `quiet retry ${attempt + 1} in ${wait}ms: ${e.message}`)
          await sleep(wait, null, { signal })
        }
      }
    } catch (e) {
      // Some APIs reject parameters older servers need; learn once and retry. (Refused: 400, or 422
      // from the ones that check requests against a schema, like Mistral.)
      const refused = e.status === 400 || e.status === 422
      const said = e.body ?? e.message
      if (refused && /temperature/.test(e.message) && 'temperature' in body && !this.quirks.noTemperature) {
        this.quirks.noTemperature = true
        log('quirk', 'server rejects temperature')
        return this.#chat(body, { onToken, onReasoning, onToolDelta, signal, once })
      }
      for (const [quirk, param] of [['noEffort', 'reasoning_effort'], ['noStreamUsage', 'stream_options']]) {
        if (refused && param in req && new RegExp(param).test(e.message) && !this.quirks[quirk]) {
          this.quirks[quirk] = true
          log('quirk', `server rejects ${param}; dropping it`)
          return this.#chat(body, { onToken, onReasoning, onToolDelta, signal, once })
        }
      }
      // The thinking sent back, or the tools' arguments (JSON schemas with keys a provider doesn't
      // take: Gemini's "Unknown name additionalProperties"), refused: sent without it, or with
      // simpler schemas, from now on with this model.
      const reasoningSent = !this.quirks.noReasoningBack && body.messages?.some((m) => m.reasoning_content)
      const noReasoning = () => {
        this.quirks.noReasoningBack = true
        log('quirk', 'server rejects the thinking sent back; not sending it')
        return this.#chat(body, { onToken, onReasoning, onToolDelta, signal, once })
      }
      if (refused && reasoningSent && /reasoning(?!_effort)/i.test(said)) return noReasoning()
      if (refused && body.tools?.length && !this.quirks.simpleSchemas && /schema|function_declarations|parameters|additionalProperties|exclusiveM|minItems|unknown name|invalid.{0,40}(tool|function)|tools\[/i.test(said)) {
        this.quirks.simpleSchemas = true
        log('quirk', 'server rejects the tools\' schemas; sending simpler ones')
        return this.#chat(body, { onToken, onReasoning, onToolDelta, signal, once })
      }
      if (refused && reasoningSent && /extra|unknown|unrecognized|not permitted|additional propert/i.test(said)) return noReasoning()
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
      return count(done(textOf(msg.content), msg.reasoning_content ?? msg.reasoning ?? msg.thinking ?? '', msg.tool_calls ?? [], data.usage, choice.finish_reason))
    }

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
    const emit = (v) => {
      if (onToken && v.startsWith(emitted) && v.length > emitted.length) {
        onToken(v.slice(emitted.length))
        emitted = v
      }
    }
    for (;;) {
      const { value, done: end } = await reader.read()
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
        if (chunk.error) throw new Error(`server error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`)
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
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? (tc.id ? calls.length : Math.max(calls.length - 1, 0))
          const call = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
          if (tc.id) call.id = tc.id
          if (tc.function?.name) call.function.name ||= tc.function.name
          if (tc.function?.arguments) call.function.arguments += tc.function.arguments
          onToolDelta?.(call.function.name, call.function.arguments)
        }
        if (d.content) {
          content += d.content
          const t = thinkOf(content)
          if (onReasoning && t.length > thought.length && t.startsWith(thought)) {
            onReasoning(t.slice(thought.length))
            thought = t
          }
          emit(visible(content))
        }
      }
    }
    const result = done(content, reasoning, calls.filter(Boolean), usage, finishReason)
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

function done(raw, reasoning, toolCalls, usage, finishReason) {
  const calls = toolCalls.filter((c) => c?.function?.name)
  calls.forEach((c, i) => (c.id ||= `call_${Date.now()}_${i}`))
  return {
    content: stripThink(raw),
    reasoning: (reasoning || thinkOf(raw)).trim(),
    toolCalls: calls,
    usage,
    finishReason,
    thinking: Boolean(reasoning) || /<\/?think>/.test(raw),
  }
}
