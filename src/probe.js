// Capability probes: small, automatic tests that decide how HeartCode talks to a model.
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { HOME, readJson, writeJson } from './config.js'
import { est } from './client.js'
import { contextWindow, contextSource, LOCAL_SERVERS, ASSUMED_REMOTE, LIMIT_MS } from './context.js'
import { loadPrices, limitsOf } from './usage.js'
import { applyEdit, parseBlocks } from './edit.js'
import { c } from './ui.js'
import { log } from './log.js'
import { prompt } from './prompts.js'

// One cached profile per server + model. The URL path counts: proxies serve several providers
// from one host (https://proxy.dev/groq, https://proxy.dev/openrouter).
export const profilePath = (client) => {
  const u = new URL(client.baseUrl)
  const where = u.host + u.pathname.replace(/\/v1$/, '')
  return path.join(HOME, 'models', `${where}_${client.model}`.replace(/[^\w.-]+/g, '_') + '.json')
}
// Bump when the probe learns something new, so older cached profiles are probed again once.
const PROBE_VERSION = 2
export const loadProfile = (client) => {
  const p = readJson(profilePath(client), null)
  // another model's (a model list switch once saved the first model's profile under the next one's name)
  return p?.version === PROBE_VERSION && (!p.model || p.model === client.model) ? p : null
}

// --- tiny PNG encoder, for the vision probe ---
const CRC = new Uint32Array(256).map((_, n) => {
  let v = n
  for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1
  return v
})
const crc32 = (buf) => {
  let v = 0xffffffff
  for (const b of buf) v = CRC[(v ^ b) & 0xff] ^ (v >>> 8)
  return (v ^ 0xffffffff) >>> 0
}
const pngChunk = (type, data) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}
export function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array(h).fill(row))
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

const COLORS = { red: [220, 30, 30], green: [30, 170, 60], blue: [30, 60, 220], yellow: [245, 220, 30] }
const firstInt = (t) => Number(/\d+/.exec(t)?.[0])

// Rate limits, server errors and dropped connections are waited out (with the countdown, Esc
// stops it), so a probe that starts finishes and is saved, and the model is never probed again.
// A request the server rejects (400, 404 "no endpoint supports images", …) just means "no".
const transient = (e) => !e.status || [408, 409, 429].includes(e.status) || e.status >= 500
export async function probe(client, status, signal) {
  const [retryIf, purpose] = [client.retryIf, client.purpose]
  client.retryIf = (e, attempt) => transient(e) && attempt < 8 // about 4 minutes of waiting at most
  client.purpose = 'test' // in the requests log
  try {
    return await runProbe(client, status, signal)
  } finally {
    Object.assign(client, { retryIf, purpose })
  }
}

async function runProbe(client, report = () => {}, signal) {
  const status = (label) => {
    log('probe', label)
    report(label)
  }
  const p = { version: PROBE_VERSION, model: client.model, baseUrl: client.baseUrl, probedAt: new Date().toISOString() }
  let tokens = 0
  let ms = 0
  let calls = 0
  let lastError = null
  const chat = async (body, opts) => {
    const t0 = Date.now()
    const r = await client.chat({ temperature: 0, ...body }, { signal, ...opts }) // no max_tokens: the model decides how long
    ms += Date.now() - t0
    calls++
    if (r.usage?.completion_tokens) p.usage = true
    tokens += r.usage?.completion_tokens ?? est(r.content + r.reasoning)
    if (r.thinking) p.thinking = true
    return r
  }
  const say = (user, system) =>
    chat({ messages: system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }] }).then((r) =>
      r.content.trim(),
    )
  // A rejected request (400, 422, a 404 "no endpoint supports images", …) or an unparsable reply
  // means "not supported". Dead connections, auth errors, rate limits, outages, and a model that
  // was never reachable abort the probe, so a bad profile never gets cached.
  const safe = async (fn) => {
    try {
      return Boolean(await fn())
    } catch (e) {
      if (e.name === 'AbortError' || /^cannot reach/.test(e.message)) throw e
      // no answer (a timeout, a stalled reply): nothing learned, nothing saved; an answer it can't
      // read (not JSON) counts as "not supported" below
      if (e.name === 'TimeoutError') throw new Error(`probe stopped, nothing saved: ${e.message}`)
      if ([401, 429].includes(e.status) || e.status >= 500 || ([403, 404].includes(e.status) && !calls))
        throw new Error(`probe stopped, nothing saved: ${e.message}`)
      lastError = e
      return false
    }
  }
  const trials = async (label, fns) => {
    status(label)
    let pass = 0
    for (const fn of fns) if (await safe(fn)) pass++
    return { pass, total: fns.length }
  }

  status('streaming')
  let streamed = 0
  p.stream = await safe(async () => {
    const r = await chat({ messages: [{ role: 'user', content: prompt('probe/hello') }], stream: true }, { onToken: () => streamed++ })
    return streamed > 0 || r.thinking
  })

  status('context size')
  // what the server is and says; else models.dev's published size (context.js decides between them)
  const found = await client.contextSize()
  p.server = found.server
  p.context = found.size || (LOCAL_SERVERS.includes(found.server) ? 4096 : ASSUMED_REMOTE)
  p.contextGuessed = !found.size
  await loadPrices()
  const known = limitsOf(client.provider, client.baseUrl, client.model)
  if (known) p.known = known

  p.system = await trials(
    'system prompt',
    ['What is 2 + 2?', 'Name a color.'].map((q) => async () => /banana/i.test(await say(q, prompt('probe/system')))),
  )

  p.format = await trials(
    'exact format',
    [7, 42].map((n) => async () => (await say(prompt('probe/exact-number', { n }))).replace(/[.\s`*"']/g, '') === String(n)),
  )

  const menus = [
    ['a fruit', ['a hammer', 'an apple', 'a car'], 2],
    ['an animal', ['a river', 'a chair', 'a dog'], 3],
    ['a color', ['blue', 'a table', 'a spoon'], 1],
  ]
  p.menu = await trials(
    'menu picking',
    menus.map(([what, opts, ans]) => async () => {
      const list = opts.map((o, i) => `${i + 1}. ${o}`).join('\n')
      return firstInt(await say(prompt('probe/menu', { what, list }))) === ans
    }),
  )

  status('stop sequences')
  p.stop = await safe(async () => {
    const r = await chat({ messages: [{ role: 'user', content: prompt('probe/count') }], stop: ['5'] })
    return /4/.test(r.content) && !/6/.test(r.content)
  })

  const tool = {
    type: 'function',
    function: {
      name: 'get_secret_code',
      description: prompt('probe/tool-description'),
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  }
  const toolMsg = (name) => ({ role: 'user', content: prompt('probe/tool-question', { name }) })
  const toolCall = (r, name) => {
    const call = r.toolCalls.find((t) => t.function.name === 'get_secret_code')
    try {
      return call && String(JSON.parse(call.function.arguments).name).toLowerCase().includes(name) ? call : null
    } catch {
      return null
    }
  }
  p.tools = await trials(
    'tool calls',
    ['alpha', 'falcon', 'ember'].map((n) => async () => toolCall(await chat({ messages: [toolMsg(n)], tools: [tool] }), n)),
  )
  if (p.tools.pass) {
    status('tool results')
    p.toolResult = await safe(async () => {
      const r = await chat({ messages: [toolMsg('alpha')], tools: [tool] })
      const call = toolCall(r, 'alpha')
      if (!call) return false
      const r2 = await chat({
        messages: [
          toolMsg('alpha'),
          { role: 'assistant', content: r.content || '', tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: prompt('probe/tool-result') },
        ],
        tools: [tool],
      })
      return r2.content.includes('4417')
    })
    status('streamed tool calls')
    p.toolsStream = await safe(async () => toolCall(await chat({ messages: [toolMsg('falcon')], tools: [tool], stream: true }), 'falcon'))

  }

  status('constrained output')
  const words = ['zebra-purple', 'mango-teal']
  p.constrained = await safe(async () => {
    const schema = { type: 'object', properties: { word: { type: 'string', enum: words } }, required: ['word'], additionalProperties: false }
    const r = await chat({
      messages: [{ role: 'user', content: prompt('probe/capital') }],
      response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema } },
    })
    return words.includes(JSON.parse(r.content).word)
  })

  const names = Object.keys(COLORS).sort(() => Math.random() - 0.5).slice(0, 2)
  p.vision = await trials(
    'vision',
    names.map((name) => async () => {
      const url = 'data:image/png;base64,' + solidPng(256, 256, COLORS[name]).toString('base64')
      const r = await chat({
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt('probe/image-color') }, { type: 'image_url', image_url: { url } }] }],
      })
      const t = r.content.toLowerCase()
      return t.includes(name) && Object.keys(COLORS).every((k) => k === name || !t.includes(k))
    }),
  )

  const cases = [
    {
      code: 'function add(a, b) {\n  return a + b\n}\n\nfunction sub(a, b) {\n  return a - b\n}\n',
      ask: 'Change the add function so it returns a * b instead of a + b.',
      ok: (t) => t.includes('return a * b') && t.includes('return a - b'),
    },
    {
      code: 'const greeting = "hello"\nconsole.log(greeting)\n',
      ask: 'Change the greeting from "hello" to "good morning".',
      ok: (t) => t.includes('good morning') && t.includes('console.log(greeting)'),
    },
  ]
  p.edit = await trials(
    'edit skill',
    cases.map((cs) => async () => {
      const reply = await say(prompt('probe/edit', { code: cs.code, ask: cs.ask }))
      let text = cs.code
      const blocks = parseBlocks(reply)
      for (const b of blocks) {
        const r = applyEdit(text, b.search, b.replace)
        if (r.error) return false
        text = r.text
      }
      return blocks.length > 0 && cs.ok(text)
    }),
  )

  p.speed = ms ? Math.round(tokens / (ms / 1000)) : 0
  p.latency = calls ? Math.round(ms / calls) : 0
  // Every request failed: that's a broken model or endpoint, not a weak model.
  if (!calls) throw new Error(`probe stopped, nothing saved: no request succeeded${lastError ? ` (last error: ${lastError.message})` : ''}`)
  log('probe', 'result', p)
  writeJson(profilePath(client), p)
  return p
}

const all = (s) => Boolean(s && s.total && s.pass === s.total)
const most = (s) => Boolean(s && s.total && s.pass * 3 >= s.total * 2)

// A model's profile without testing it: what models.dev says (info: limitsOf), or, for a model it
// doesn't know, plain assumptions (source 'assumed': tool calls, streaming, a 128k window) until you
// say on the settings page what it can do (set: { context, tools, thinking, images, stream },
// source 'you'). Profiles from a test (/test_model, heart probe) have no source.
export function profileFrom(client, info) {
  return { version: PROBE_VERSION, model: client.model, baseUrl: client.baseUrl, source: info ? 'models.dev' : 'assumed', at: new Date().toISOString(), usage: true, context: ASSUMED_REMOTE, contextGuessed: true, ...(info && { known: info }) }
}

// Turns a profile into decisions. Your settings for the model (p.set) come first; then, for a model
// that wasn't tested, what models.dev says; for a tested one, what the test found. Config/flags
// can override the window (--context).
export function strategy(p, cfg = {}) {
  const set = p.set ?? {}
  const said = p.source ? (p.known ?? {}) : null // not tested: models.dev's word (or nothing known)
  const tools = set.tools ?? (said ? said.tools !== false : most(p.tools) && p.toolResult)
  const thinking = set.thinking ?? (said ? Boolean(said.thinking) : Boolean(p.thinking))
  const stream = set.stream ?? (said ? true : Boolean(p.stream))
  const win = contextWindow(p)
  return {
    actions: tools ? 'tools' : 'guided',
    edits: said || all(p.edit) ? 'search_replace' : 'rewrite',
    enforce: !said && Boolean(p.constrained),
    stream,
    toolsStream: stream && (said ? true : Boolean(p.toolsStream)),
    stop: said ? !thinking : Boolean(p.stop), // stop sequences cut into a thinking model's thinking
    mergeSystem: said ? false : !most(p.system),
    vision: !(Date.now() - (p.quirks?.noImages ?? -Infinity) < LIMIT_MS) && (set.images ?? (said ? Boolean(said.images) : all(p.vision))), // its provider refused images this week: none
    thinking,
    context: cfg.context || set.context || win.size, // context.js: measured, said, models.dev, learned, or assumed
    contextSure: Boolean(cfg.context || set.context) || win.sure,
    reply: p.known?.output, // the longest reply it gives (models.dev), room kept for it
    ratio: p.tokenRatio ?? 1, // the server's tokens per estimated token
  }
}

export function describe(p, s) {
  const yn = (v) => (v ? c.green('yes') : c.red('no'))
  const score = (x) => {
    if (!x) return c.dim('–')
    const t = `${x.pass}/${x.total}`
    return x.pass === x.total ? c.green(t) : x.pass ? c.yellow(t) : c.red(t)
  }
  const context = ['context', `${s.context}${c.dim(`  (${p.set?.context ? 'set by you on /settings' : contextSource(p)}; change it on /settings)`)}`]
  // not tested: where it's from, and what it can do
  if (p.source) {
    const from = { 'models.dev': 'models.dev', you: 'you, on /settings', assumed: "nothing: it isn't in models.dev. Set what it can do on /settings" }[p.source]
    const mine = (k) => (p.set?.[k] !== undefined ? c.dim('  (set by you)') : '')
    return [['from', from], context, ['tool calls', yn(s.actions === 'tools') + mine('tools')], ['thinking', yn(s.thinking) + mine('thinking')], ['images', yn(s.vision) + (Date.now() - (p.quirks?.noImages ?? -Infinity) < LIMIT_MS ? c.dim('  (its provider refused an image today)') : mine('images'))], ['streaming', yn(s.stream) + mine('stream')]]
      .map(([k, v]) => `  ${c.dim(k.padEnd(15))} ${v}`)
      .join('\n')
  }
  const rows = [
    ['streaming', yn(p.stream) + (p.thinking ? c.dim('  (thinking model)') : '')],
    context,
    ['system prompt', score(p.system)],
    ['exact format', score(p.format)],
    ['menu picking', score(p.menu)],
    ['stop sequences', yn(p.stop) + (!p.stop && p.thinking ? c.dim('  (they cut into the thinking; not used)') : '')],
    ['tool calls', score(p.tools) + (p.tools?.pass ? c.dim(`  uses results: ${p.toolResult ? 'yes' : 'no'} · streamed: ${p.toolsStream ? 'yes' : 'no'}`) : '')],
    ['constrained', yn(p.constrained)],
    ['vision', score(p.vision)],
    ['edit skill', score(p.edit)],
    ['speed', `${p.speed} tok/s` + (p.latency ? c.dim(`  · ${(p.latency / 1000).toFixed(1)}s per reply`) : '')],
  ]
  const lines = rows.map(([k, v]) => `  ${c.dim(k.padEnd(15))} ${v}`)
  lines.push(
    `  ${c.bold('→')} actions: ${c.cyan(s.actions)} · edits: ${c.cyan(s.edits)}` +
      `${s.enforce ? ' · enforced answers' : ''}${s.vision ? ' · images' : ''}${s.mergeSystem ? ' · system→user' : ''}`,
  )
  return lines.join('\n')
}
