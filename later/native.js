// Native provider APIs: Anthropic's Messages API and Gemini's generateContent. HeartCode speaks
// OpenAI's chat format everywhere; for these the request is turned into theirs, and the streamed
// reply back into OpenAI's (text, thinking, tool calls, usage). A provider gets one by its URL
// (api.anthropic.com, generativelanguage.googleapis.com without /openai), or "api" in its config.
// ponytail: Bedrock and Vertex aren't here; Bedrock's OpenAI-compatible endpoint
// (https://bedrock-runtime.<region>.amazonaws.com/openai/v1 with a Bedrock API key) works as is.

export const APIS = ['anthropic', 'gemini']

export function detectApi(url) {
  if (/(^|\.)anthropic\.com$/.test(new URL(url).hostname)) return 'anthropic'
  if (/generativelanguage\.googleapis\.com$/.test(new URL(url).hostname) && !/\/openai/.test(url)) return 'gemini'
  return undefined
}

export function authHeaders(api, key) {
  if (api === 'anthropic') return { 'anthropic-version': '2023-06-01', ...(key && { 'x-api-key': key }) }
  if (api === 'gemini') return key ? { 'x-goog-api-key': key } : {}
  return key ? { authorization: `Bearer ${key}` } : {}
}

export const modelsUrl = (api, base) => `${base}/models${api === 'anthropic' ? '?limit=1000' : api === 'gemini' ? '?pageSize=1000' : ''}`

// What their APIs need back on the next request but OpenAI's format has no place for: Anthropic's
// thinking blocks and Gemini's thought signatures, by the id of the reply's first tool call.
// ponytail: in memory only; a resumed chat sends its old tool calls without them (both APIs accept that
// for finished turns).
const extra = new Map()

const BUDGET = { low: 2048, medium: 8192, high: 24_000 } // thinking tokens per reasoning effort
const textOf = (content) => (Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(content ?? ''))
const partsOf = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }])
const dataUrl = (url) => /^data:([^;]+);base64,(.*)$/s.exec(url ?? '')
const parseJson = (text) => {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}
// consecutive messages of one role become one (both APIs want turns to alternate)
const pusher = (list, key) => (role, items) => {
  if (!items.length) return
  if (list.at(-1)?.role === role) list.at(-1)[key].push(...items)
  else list.push({ role, [key]: items })
}

// → { url, body } for one chat request (req: OpenAI's body, with the model)
export function toNative(api, client, req) {
  return api === 'anthropic' ? toAnthropic(client, req) : toGemini(client, req)
}

function toAnthropic(client, req) {
  const system = []
  const messages = []
  const push = pusher(messages, 'content')
  for (const m of req.messages) {
    if (m.role === 'system') system.push({ type: 'text', text: textOf(m.content) })
    else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) || '(no output)' }])
    else if (m.role === 'assistant') {
      const calls = m.tool_calls ?? []
      push('assistant', [
        ...(extra.get(calls[0]?.id) ?? []),
        ...(m.content?.trim() ? [{ type: 'text', text: m.content }] : []),
        ...calls.map((t) => ({ type: 'tool_use', id: t.id, name: t.function.name, input: parseJson(t.function.arguments) })),
      ])
    } else {
      push('user', partsOf(m.content).flatMap((p) => {
        if (p.type === 'text') return p.text ? [{ type: 'text', text: p.text }] : []
        const d = dataUrl(p.image_url?.url ?? p.image_url)
        return d ? [{ type: 'image', source: { type: 'base64', media_type: d[1], data: d[2] } }] : [{ type: 'image', source: { type: 'url', url: p.image_url?.url ?? p.image_url } }]
      }))
    }
  }
  // prompt caching: the system prompt and the conversation so far are read from the cache next time
  if (system.length) system.at(-1).cache_control = { type: 'ephemeral' }
  const last = messages.at(-1)?.content.findLast((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
  if (last) last.cache_control = { type: 'ephemeral' }
  // max_tokens: Anthropic requires it (the only API here that does); the model's maximum, learned
  // from its error when 32000 is too many
  const max = client.maxOutput ?? 32_000
  const body = { model: req.model, max_tokens: max, messages, stream: true, ...(system.length && { system }) }
  if (req.tools?.length) body.tools = req.tools.map(({ function: f }) => ({ name: f.name, description: f.description ?? '', input_schema: f.parameters ?? { type: 'object', properties: {} } }))
  if (req.stop) body.stop_sequences = [req.stop].flat()
  if (req.reasoning_effort && !client.quirks.noThinking) body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.min(BUDGET[req.reasoning_effort] ?? 8192, max - 1024)) }
  else if (req.temperature !== undefined) body.temperature = req.temperature // not allowed with thinking
  return { url: `${client.baseUrl}/messages`, body }
}

function toGemini(client, req) {
  const contents = []
  const push = pusher(contents, 'parts')
  const names = new Map() // tool call id → its function's name (Gemini answers by name)
  const system = []
  for (const m of req.messages) {
    if (m.role === 'system') system.push({ text: textOf(m.content) })
    else if (m.role === 'tool') push('user', [{ functionResponse: { name: names.get(m.tool_call_id) ?? 'tool', response: { result: textOf(m.content) } } }])
    else if (m.role === 'assistant') {
      const calls = m.tool_calls ?? []
      for (const t of calls) names.set(t.id, t.function.name)
      push('model', [
        ...(m.content?.trim() ? [{ text: m.content }] : []),
        ...calls.map((t, i) => ({ functionCall: { name: t.function.name, args: parseJson(t.function.arguments) }, ...(i === 0 && extra.has(t.id) && { thoughtSignature: extra.get(t.id) }) })),
      ])
    } else {
      push('user', partsOf(m.content).flatMap((p) => {
        if (p.type === 'text') return p.text ? [{ text: p.text }] : []
        const d = dataUrl(p.image_url?.url ?? p.image_url)
        return d ? [{ inlineData: { mimeType: d[1], data: d[2] } }] : []
      }))
    }
  }
  const generationConfig = {}
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.stop) generationConfig.stopSequences = [req.stop].flat()
  if (!client.quirks.noThinking) generationConfig.thinkingConfig = { includeThoughts: true, ...(req.reasoning_effort && { thinkingBudget: BUDGET[req.reasoning_effort] ?? 8192 }) }
  const body = { contents, generationConfig, ...(system.length && { systemInstruction: { parts: system } }) }
  if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map(({ function: f }) => ({ name: f.name, description: f.description ?? '', parametersJsonSchema: f.parameters ?? { type: 'object', properties: {} } })) }]
  return { url: `${client.baseUrl}/models/${encodeURIComponent(req.model).replace(/%2F/g, '/')}:streamGenerateContent?alt=sse`, body }
}

// A 400 that one of these APIs sends when something HeartCode sent can be fixed: learns it on the
// client and says so (true), so the request goes again.
export function learnFrom(api, client, e) {
  if (e.status !== 400) return false
  const max = /max_tokens: \d+ > (\d+)/.exec(e.message)
  if (api === 'anthropic' && max && Number(max[1]) !== client.maxOutput) return (client.maxOutput = Number(max[1])), true
  if (/think|budget/i.test(e.message) && !client.quirks.noThinking) return (client.quirks.noThinking = true), true
  return false
}

// Their server-sent events, as objects.
async function* events(res) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      try {
        yield JSON.parse(line.slice(5))
      } catch {}
    }
  }
}

// The streamed reply → { content, reasoning, toolCalls, usage (OpenAI's names), finishReason }
export async function fromNative(api, res, { onToken, onReasoning, onToolDelta, onFirst } = {}) {
  const out = { content: '', reasoning: '', toolCalls: [], usage: undefined, finishReason: undefined }
  const text = (t) => t && ((out.content += t), onToken?.(t))
  const think = (t) => t && ((out.reasoning += t), onReasoning?.(t))
  let first = true
  if (api === 'anthropic') {
    const blocks = []
    let u = {}
    for await (const ev of events(res)) {
      if (first) (onFirst?.(), (first = false))
      if (ev.type === 'error') throw new Error(`server error: ${ev.error?.message ?? JSON.stringify(ev.error)}`)
      if (ev.type === 'message_start') u = { ...ev.message?.usage }
      if (ev.type === 'message_delta') {
        Object.assign(u, Object.fromEntries(Object.entries(ev.usage ?? {}).filter(([, v]) => v != null)))
        out.finishReason = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length', stop_sequence: 'stop' }[ev.delta?.stop_reason] ?? ev.delta?.stop_reason
      }
      if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block, json: '' }
      if (ev.type !== 'content_block_delta') continue
      const b = blocks[ev.index]
      const d = ev.delta
      if (d.type === 'text_delta') text(d.text)
      else if (d.type === 'thinking_delta') (think(d.thinking), (b.thinking = (b.thinking ?? '') + d.thinking))
      else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature
      else if (d.type === 'input_json_delta') (b.json += d.partial_json, onToolDelta?.(b.name, b.json))
    }
    out.toolCalls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.json || JSON.stringify(b.input ?? {}) } }))
    const thoughts = blocks.filter((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking').map(({ json, ...b }) => b)
    if (thoughts.length && out.toolCalls.length) extra.set(out.toolCalls[0].id, thoughts)
    const cached = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const prompt = (u.input_tokens ?? 0) + cached
    if (prompt || u.output_tokens) out.usage = { prompt_tokens: prompt, completion_tokens: u.output_tokens ?? 0, total_tokens: prompt + (u.output_tokens ?? 0), prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 }, cache_write_tokens: u.cache_creation_input_tokens ?? 0 }
    return out
  }
  // Gemini
  for await (const ch of events(res)) {
    if (first) (onFirst?.(), (first = false))
    if (ch.error) throw new Error(`server error: ${ch.error.message ?? JSON.stringify(ch.error)}`)
    const u = ch.usageMetadata
    if (u) {
      const done = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
      out.usage = { prompt_tokens: u.promptTokenCount ?? 0, completion_tokens: done, total_tokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + done, prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount ?? 0 } }
    }
    const cand = ch.candidates?.[0]
    if (cand?.finishReason) out.finishReason = { STOP: 'stop', MAX_TOKENS: 'length' }[cand.finishReason] ?? cand.finishReason.toLowerCase()
    for (const p of cand?.content?.parts ?? []) {
      if (p.functionCall) {
        const id = p.functionCall.id || `call_${Date.now().toString(36)}_${out.toolCalls.length}`
        const args = JSON.stringify(p.functionCall.args ?? {})
        out.toolCalls.push({ id, type: 'function', function: { name: p.functionCall.name, arguments: args } })
        if (p.thoughtSignature && out.toolCalls.length === 1) extra.set(id, p.thoughtSignature)
        onToolDelta?.(p.functionCall.name, args)
      } else if (p.thought) think(p.text)
      else text(p.text)
    }
  }
  if (out.toolCalls.length && out.finishReason === 'stop') out.finishReason = 'tool_calls'
  return out
}
