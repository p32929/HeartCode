// How big a model's context window is, from the most to the least trusted:
//   measured        the server's own limit, from one oversized request sent on purpose (the
//                   settings page's Measure)
//   context         what the running server says (llama.cpp, LM Studio, Ollama, vLLM, a /models
//                   list), unless contextGuessed (it didn't say)
//   known           models.dev's published limits for the model: { context, output }
//   inputLimit      a limit a "too large" error stated, or a silent cut seen twice (inputLimitAt:
//                   when); dropped when a bigger request works, and after a day (it's learned
//                   again if it's still so: a refused request costs nothing)
//   rateCap         a per-minute token cap the provider stated ({ tokens, until }): your account's,
//                   not the model's, so it lasts a day
// None of them: a local model server (server: llama.cpp, lmstudio, ollama) keeps the small size
// it's assumed to run with; anything else (a provider, a proxy on your network) is assumed to take
// 128k, or twice its largest request so far (up to 1M), growing as conversations do.
// Also in the profile: server (what answered the probe), largestAccepted (the biggest request,
// in tokens the server counted, that worked), tokenRatio (the server's count / HeartCode's
// estimate), cutAt (a silent cut seen once).

export const ASSUMED_REMOTE = 128_000
export const ASSUMED_MAX = 1_000_000
export const LOCAL_SERVERS = ['llama.cpp', 'lmstudio', 'ollama']
export const RATE_CAP_MS = 86_400_000
export const LIMIT_MS = 86_400_000 // a learned limit, and a refusal learned from a provider: a day (learned again if it still holds)

// { size, sure, from }: from is measured, server, models.dev, learned, rate or assumed.
export function contextWindow(p, now = Date.now()) {
  let size
  let from
  if (p.measured > 0) [size, from] = [p.measured, 'measured']
  else if (!p.contextGuessed && p.context > 0) [size, from] = [p.context, 'server']
  else if (p.known?.context > 0) [size, from] = [p.known.context, 'models.dev']
  if (p.inputLimit > 0 && !(now - p.inputLimitAt > LIMIT_MS) && !(size <= p.inputLimit)) [size, from] = [p.inputLimit, 'learned']
  if (p.rateCap?.until > now && !(size <= p.rateCap.tokens)) [size, from] = [p.rateCap.tokens, 'rate']
  if (size) return { size, sure: true, from }
  const base = LOCAL_SERVERS.includes(p.server) ? p.context : ASSUMED_REMOTE
  return { size: Math.min(ASSUMED_MAX, Math.max(base, 2 * (p.largestAccepted ?? 0))), sure: false, from: 'assumed' }
}

// After a reply: `used` is what the server says the request had (prompt tokens), `estimate` what
// HeartCode thought it sent (images not counted as text). Updates the profile; returns what
// changed: 'cut' (a limit learned from a silent cut), 'grew' (a bigger request worked), or null.
export function learnFromUsage(p, used, estimate) {
  if (!(used > 0) || !(estimate > 0)) return null
  const expected = estimate * (p.tokenRatio ?? 1)
  // Far fewer tokens than sent: the server dropped the start (Ollama beyond its num_ctx does).
  // Seen twice at about the same size before it counts, so a provider that leaves out cached
  // tokens, or one odd count, doesn't set a wrong limit.
  if (estimate > 3000 && used >= 1024 && used < expected * 0.5) {
    if (p.cutAt && Math.abs(used - p.cutAt) / p.cutAt < 0.15) {
      p.inputLimit = Math.min(p.inputLimit ?? Infinity, Math.max(used, p.cutAt))
      p.inputLimitAt = Date.now()
      delete p.cutAt
      return 'cut'
    }
    p.cutAt = used
    return null
  }
  if (estimate > 500) {
    const r = Math.min(3, Math.max(0.3, used / estimate))
    p.tokenRatio = Math.round(((p.tokenRatio ?? r) * 0.7 + r * 0.3) * 1000) / 1000
  }
  let change = null
  // a bigger request than a learned limit worked: that limit was wrong (or is gone)
  if (p.inputLimit && used > p.inputLimit * 1.05) {
    delete p.inputLimit
    delete p.inputLimitAt
    change = 'grew'
  }
  if (p.rateCap && used > p.rateCap.tokens) {
    delete p.rateCap
    change = 'grew'
  }
  if (used > (p.largestAccepted ?? 0) * 1.1) {
    p.largestAccepted = used
    change = 'grew'
  }
  return change
}

// What the window size is based on, for /model_info and the settings page.
export function contextSource(p, cfg = {}) {
  if (cfg.context) return 'set with --context'
  const { from } = contextWindow(p)
  if (from === 'measured') return 'measured: the server said its limit when sent an oversized request'
  if (from === 'server') return `reported by the server${p.server ? ` (${p.server})` : ''}`
  if (from === 'models.dev') return "models.dev's published limit for this model"
  if (from === 'learned') return 'learned from the server refusing or cutting a bigger request'
  if (from === 'rate') return `your per-minute token cap at this provider, until ${new Date(p.rateCap.until).toLocaleString()}`
  if (LOCAL_SERVERS.includes(p.server)) return `the ${p.server} server doesn't say; assumed`
  return `the server doesn't say; assumed${p.largestAccepted ? `, and seen working up to ${p.largestAccepted} tokens` : ''} (grows as bigger requests work)`
}
