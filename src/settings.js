// The settings page: a small web server on this machine (127.0.0.1 only) where everything but
// the chat can be changed: providers and their keys, the model, settings, MCP servers, hooks,
// keys, colors, skills. Open with `heartcode settings` or /settings. A secret token in
// the link guards it (another site, or another user on this machine, can't use it); API keys
// are never sent to the page, only their first and last characters.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { HOME, saveConfig, readJson, writeJson } from './config.js'
import { DEFAULT_SERVERS } from './mcp.js'
import { sections, BUILTIN_PROMPTS } from './prompts.js'
import { Client } from './client.js'
import { clip } from './tools.js'
import { loadProfile, strategy, profilePath, profileFrom } from './probe.js'
import { loadPrices, priceOf, limitsOf } from './usage.js'
import { THEMES, PERMISSIONS } from './ui.js'
import { loadSkills, frontMatter } from './skills.js'
import { log, LOGS, REQUESTS, useRequestLog, listRequests, readRequest, pruneLogs, logDays } from './log.js'

const PAGE = new URL('./settings.html', import.meta.url)
const EFFORTS = ['default', 'low', 'medium', 'high']
const TOGGLES = { autoCompact: 'compact the conversation when the context is 70% full', director: 'let the model add skills, MCP servers and change settings when asked', format: "run the project's formatter on every file HeartCode writes", lsp: "show the model a language server's errors after each edit" }
// The Logging page's: both off unless switched on; how much of each request ("full" or "summary")
const LOG_SWITCHES = ['log', 'logRequests']
const DETAILS = ['full', 'summary']
// Files in ~/.heart the page edits as text: [name, what it is, JSON?]
const FILES = [
  ['mcp.json', 'MCP servers: programs that give the model more tools', true, '{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },\n    "docs": { "url": "https://mcp.example.com/mcp" }\n  }\n}'],
  ['hooks.json', 'Your commands, run before or after the model uses a tool (one can block it)', true, '{\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "run_command", "hooks": [{ "type": "command", "command": "./check-command.sh" }] }\n    ]\n  }\n}'],
  ['keybindings.json', 'Your own keys: an action, or a /command to send', true, '{\n  "ctrl+o": "cycle_permissions",\n  "ctrl+g": "/toggle_thinking"\n}'],
  ['theme.json', 'Your own colors, on top of the theme you chose', true, '{\n  "brand": "#ff6b9d",\n  "background": "#101014"\n}'],
  ['format.json', 'The formatter to run on each kind of file HeartCode writes', true, '{\n  ".go": "gofmt -w {file}",\n  ".py": "ruff format {file}"\n}'],
  ['HEARTCODE.md', 'Your instructions for every project (like AGENTS.md, for all of them)', false, '- Answer briefly.\n- Use pnpm, not npm.'],
]
// The prompts the page edits: every section of these files (prompts/*.md); the system prompts first.
const PROMPT_FILES = ['agent', 'guided', 'compact', 'probe']
const FIRST = { 'agent/system': 'System prompt (models with tool calls)', 'guided/system': 'System prompt (guided mode: models without tool calls)' }
const ownPrompts = (file) => path.join(HOME, 'prompts', `${file}.md`)
const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p)
const varsOf = (text) => new Set([...text.matchAll(/\{\{\s*(?:#if\s+)?(\w+)\s*\}\}/g)].map((m) => m[1]).filter((v) => v !== 'else'))
// built-in sections with their notes (the <!-- … --> under a heading, never sent)
function builtinPrompts(file) {
  const raw = fs.readFileSync(path.join(BUILTIN_PROMPTS, `${file}.md`), 'utf8')
  const notes = new Map([...raw.matchAll(/^## (\S+)\s*\n+<!--([\s\S]*?)-->/gm)].map((m) => [m[1], m[2].trim()]))
  return [...sections(raw)].map(([name, text]) => ({ name, text, note: notes.get(name) ?? '' }))
}
function prompts() {
  const out = PROMPT_FILES.flatMap((file) => {
    const own = sections(fs.existsSync(ownPrompts(file)) ? fs.readFileSync(ownPrompts(file), 'utf8') : '')
    return builtinPrompts(file).map((b) => ({ id: `${file}/${b.name}`, title: FIRST[`${file}/${b.name}`] ?? null, note: b.note, builtin: b.text, text: own.get(b.name) ?? b.text, changed: own.has(b.name) }))
  })
  return [...out.filter((p) => p.title), ...out.filter((p) => !p.title)]
}
// ~/.heart/prompts/<file>.md: the user's sections, one changed (text) or put back (null)
function setPrompt(file, name, text) {
  const f = ownPrompts(file)
  const own = sections(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  if (text === null) own.delete(name)
  else own.set(name, text.trim())
  if (!own.size) return fs.rmSync(f, { force: true })
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, `# ${file}.md: your changes to HeartCode's prompts (the settings page; prompts/README.md in HeartCode)\n\n` + [...own].map(([n, t]) => `## ${n}\n\n${t}\n`).join('\n'))
}

// MCP servers: built in, yours (mcp.json); each on or off.
function mcpServers() {
  const own = readJson(path.join(HOME, 'mcp.json'), {})?.mcpServers ?? {}
  const from = Object.fromEntries(Object.keys(DEFAULT_SERVERS).map((n) => [n, 'built in']))
  const all = structuredClone(DEFAULT_SERVERS)
  for (const [n, c] of Object.entries(own)) all[n] = { ...all[n], ...c }
  return Object.entries(all).map(([name, c]) => ({ name, from: from[name] ?? 'yours', on: !c.disabled, what: c.url ?? [c.command, ...(c.args ?? [])].filter(Boolean).join(' '), description: c.description ?? '' }))
}

// The model list: #1 is the model (cfg.provider/model), the rest cfg.rotation.then, in order.
const ROTATION = { on: ['failure', 'retries', 'any'], next: ['first', 'stay'] }
const rotationOf = (cfg) => ({ on: 'failure', retries: 2, next: 'first', ...cfg.rotation, then: (cfg.rotation?.then ?? []).filter((t) => cfg.providers[t.provider]) })

const mask = (k) => (k ? (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '…') : '')
const safeName = (n) => String(n ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
const skillsDir = () => path.join(HOME, 'skills')

// cfg: the running HeartCode's config (changed in place, and saved). apply(what): after a change,
// to bring it into the running sessions ('model', 'setting:<name>', 'theme', 'mcp', 'skill', 'keys').
export function startSettings({ cfg, apply = () => {}, port = 0 } = {}) {
  const token = crypto.randomBytes(24).toString('hex')
  const changed = (what) => {
    try {
      apply(what)
    } catch (e) {
      log('web', `applying ${what}: ${e.stack}`)
    }
  }
  const save = (what) => (saveConfig(cfg), changed(what))

  // the page listens (GET /api/events): a model's profile as it changes, a request as it's logged
  const listeners = new Set()
  const emit = (event, data) => {
    for (const res of listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // A request logged (by this HeartCode or another one running): sent to the page as it's written.
  let watcher = null
  const read = new Map() // each run's index.jsonl → how much of it was sent already
  const watchRequests = () => {
    if (watcher) return
    try {
      // the logs folder (not requests/, which may not be there yet, or be deleted with old logs)
      fs.mkdirSync(LOGS, { recursive: true })
      for (const run of fs.existsSync(REQUESTS) ? fs.readdirSync(REQUESTS) : []) read.set(path.join(REQUESTS, run, 'index.jsonl'), fs.statSync(path.join(REQUESTS, run, 'index.jsonl'), { throwIfNoEntry: false })?.size ?? 0)
      watcher = fs.watch(LOGS, { recursive: true }, (_, name) => {
        const file = name && path.join(LOGS, name)
        if (!file?.endsWith('index.jsonl') || path.dirname(path.dirname(file)) !== REQUESTS) return
        try {
          const text = fs.readFileSync(file, 'utf8')
          const from = read.get(file) ?? 0
          read.set(file, Buffer.byteLength(text))
          const fresh = Buffer.from(text).subarray(from).toString('utf8')
          for (const line of fresh.split('\n').filter(Boolean)) emit('request', { run: path.basename(path.dirname(file)), ...JSON.parse(line) })
        } catch {}
      })
      watcher.on('error', () => {})
    } catch {}
  }
  // What a model is, for the page: { source, mode, context, sure, thinking, vision, stream, set }, or
  // null (not looked up yet). source: models.dev, you (set on this page), assumed (models.dev doesn't
  // know it: set it up), or tested (an older profile from a test).
  const clientFor = (t) => cfg.providers[t.provider] && new Client({ baseUrl: cfg.providers[t.provider].baseUrl, apiKey: cfg.providers[t.provider].apiKey, model: t.model, provider: t.provider })
  const testedOf = (t) => {
    const c = clientFor(t)
    const p = c && loadProfile(c)
    if (!p) return null
    const known = limitsOf(t.provider, c.baseUrl, t.model) ?? p.known
    const st = strategy({ ...p, known, source: p.source === 'assumed' && known ? 'models.dev' : p.source })
    return { source: p.source === 'assumed' && known ? 'models.dev' : (p.source ?? 'tested'), mode: st.actions, context: st.context, sure: st.contextSure, thinking: st.thinking, vision: st.vision, stream: st.stream, set: p.set ?? {} }
  }
  const knownOf = (t) => {
    const p = cfg.providers[t.provider]
    return (p && limitsOf(t.provider, p.baseUrl, t.model)) ?? null
  }
  const priceFor = (t) => {
    const p = cfg.providers[t.provider]
    const x = p && priceOf(t.provider, p.baseUrl, t.model)
    return x && (x.input != null || x.output != null) ? { input: x.input ?? null, output: x.output ?? null } : null
  }
  const testNews = (key, t) => emit('test', { key, tested: t ? testedOf(t) : null, known: t ? knownOf(t) : null })
  // A model in your list gets its profile from models.dev at once (nothing is sent to the model); one
  // models.dev doesn't know is marked so, for you to set up.
  async function test(list) {
    await loadPrices()
    for (const t of list) {
      const c = clientFor(t)
      if (!c || loadProfile(c)) continue
      writeJson(profilePath(c), profileFrom(c, limitsOf(t.provider, c.baseUrl, t.model)))
      testNews(`${t.provider}/${t.model}`, t)
    }
  }


  // A failed request in a few words: its status and what the server said (its JSON's message).
  const whyFailed = (e) => {
    let said = String(e.body ?? '').trim()
    try {
      const j = [JSON.parse(said)].flat()[0]
      said = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null) ?? (typeof j?.detail === 'string' ? j.detail : null) ?? j?.message ?? j?.title ?? said
    } catch {}
    if (!said || /^\s*</.test(said)) said = e.message.replace(/^\d+ from \S+: /, '')
    return clip(`${e.status ? `${e.status}: ` : ''}${said}`, 300)
  }

  const state = () => ({
    providers: Object.entries(cfg.providers)
      .filter(([n]) => n !== cfg.adhoc)
      .map(([name, p]) => ({ name, baseUrl: p.baseUrl, key: mask(p.apiKey), list: p.list !== false, added: p.models ?? [] })),
    provider: cfg.provider ?? null,
    model: cfg.model ?? null,
    order: [...(cfg.providers[cfg.provider] && cfg.model ? [{ provider: cfg.provider, model: cfg.model }] : []), ...rotationOf(cfg).then].map((t) => ({ ...t, tested: testedOf(t), known: knownOf(t), price: priceFor(t) })),
    rotation: (({ then, ...opts }) => opts)(rotationOf(cfg)),
    settings: { permissions: cfg.permissions ?? 'all', effort: cfg.effort ?? 'default', theme: cfg.theme ?? 'dark', context: cfg.context ?? null, ...Object.fromEntries(Object.keys(TOGGLES).map((k) => [k, cfg[k] !== false])), ...Object.fromEntries(LOG_SWITCHES.map((k) => [k, cfg[k] === true])), logDetail: cfg.logDetail === 'summary' ? 'summary' : 'full', logDays: logDays(cfg) },
    logs: { runs: tilde(path.join(LOGS, 'runs')), requests: tilde(REQUESTS) },
    voice: cfg.voice ? JSON.stringify(cfg.voice, null, 2) : '',
    choices: { permissions: PERMISSIONS, effort: EFFORTS, theme: Object.keys(THEMES), toggles: TOGGLES },
    files: FILES.map(([name, about, json, example]) => ({ name, about, json, example, text: fs.existsSync(path.join(HOME, name)) ? fs.readFileSync(path.join(HOME, name), 'utf8') : '' })),
    skills: [...loadSkills(null).values()].map((s) => ({ name: s.name, description: s.description, use: s.use, mine: s.file.startsWith(skillsDir() + path.sep), text: fs.readFileSync(s.file, 'utf8') })),
    mcp: mcpServers(),
    prompts: prompts(),
    home: tilde(HOME),
  })

  const routes = {
    'GET /api/state': () => state(),
    'POST /api/provider': ({ name, baseUrl, apiKey, keepKey, was }) => {
      name = safeName(name)
      if (!name) throw new Error('a name is needed')
      baseUrl = String(baseUrl ?? '').trim()
      if (!/^https?:\/\//i.test(baseUrl)) baseUrl = (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(baseUrl) ? 'http://' : 'https://') + baseUrl
      try {
        if (!new URL(baseUrl).hostname) throw new Error()
      } catch {
        throw new Error(`"${baseUrl}" is not a URL`)
      }
      baseUrl = baseUrl.replace(/\/+$/, '')
      const old = cfg.providers[was ?? name]
      const key = keepKey ? old?.apiKey : String(apiKey ?? '').trim() || undefined
      if (was && was !== name) {
        delete cfg.providers[was]
        if (cfg.provider === was) cfg.provider = name
        for (const t of cfg.rotation?.then ?? []) if (t.provider === was) t.provider = name
      }
      cfg.providers[name] = { ...old, baseUrl, apiKey: key } // its list switch and added models stay
      if (!key) delete cfg.providers[name].apiKey
      save('model')
      return state()
    },
    'POST /api/provider/delete': ({ name }) => {
      if (!cfg.providers[name]) throw new Error(`no provider "${name}"`)
      delete cfg.providers[name]
      if (cfg.rotation?.then) cfg.rotation.then = cfg.rotation.then.filter((t) => t.provider !== name)
      if (cfg.provider === name) {
        const [first, ...rest] = cfg.rotation?.then ?? [] // the next in the list becomes #1
        Object.assign(cfg, { provider: first?.provider, model: first?.model })
        if (cfg.rotation) cfg.rotation.then = rest
      }
      save('model')
      return state()
    },
    // a provider's models, and what's known about each (for the page's tooltip): what the provider
    // says (name, context, owner, date, description, price), HeartCode's price list, its own test
    // Its model list switched off: HeartCode never asks it for its models; only the ones added by name show.
    'POST /api/provider/list': ({ name, on }) => {
      const p = cfg.providers[name]
      if (!p) throw new Error(`no provider "${name}"`)
      if (on) delete p.list
      else p.list = false
      save('provider')
      return state()
    },
    // A model added by its name (one the provider doesn't list, or its list is off): remembered.
    'POST /api/provider/added': ({ name, model, remove }) => {
      const p = cfg.providers[name]
      if (!p) throw new Error(`no provider "${name}"`)
      model = String(model ?? '').trim()
      if (!model) throw new Error('a model is needed')
      const rest = (p.models ?? []).filter((m) => m !== model)
      p.models = remove ? rest : [...rest, model]
      if (!p.models.length) delete p.models
      save('provider')
      return state()
    },
    'POST /api/models': async ({ name }) => {
      const p = cfg.providers[name]
      if (!p) throw new Error(`no provider "${name}"`)
      if (p.list === false) return { models: [], details: {}, off: true }
      const entries = await new Client({ baseUrl: p.baseUrl, apiKey: p.apiKey }).modelEntries()
      await loadPrices().catch(() => null)
      const num = (...xs) => xs.map(Number).find((x) => x > 0)
      const details = Object.fromEntries(entries.map((m) => {
        const id = String(m.id ?? m.name)
        const perMillion = (x) => Number((Number(x) * 1e6).toPrecision(6)) // OpenRouter: per token
        const listed = m.pricing && { input: perMillion(m.pricing.prompt), output: perMillion(m.pricing.completion) }
        const price = priceOf(name, p.baseUrl, id) ?? (listed && Number.isFinite(listed.input) ? listed : null)
        const profile = loadProfile(new Client({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: id }))
        return [id, {
          name: m.name && m.name !== id ? String(m.name) : undefined,
          context: num(m.context_length, m.context_window, m.max_model_len, m.max_context_length, m.top_provider?.context_length),
          owner: m.owned_by && m.owned_by !== 'system' ? String(m.owned_by) : undefined,
          created: num(m.created) && Number(m.created) > 946684800 ? Number(m.created) * 1000 : undefined, // seconds; 2000 or later
          description: m.description ? String(m.description).slice(0, 400) : undefined,
          price: price ? { input: price.input, output: price.output } : undefined,
          tested: profile ? { mode: strategy(profile).actions, context: profile.context, thinking: Boolean(profile.thinking), vision: strategy(profile).vision } : undefined,
        }]
      }))
      return { models: entries.map((m) => String(m.id ?? m.name)), details }
    },
    'POST /api/model': ({ provider, model }) => {
      if (!cfg.providers[provider]) throw new Error(`no provider "${provider}"`)
      if (!String(model ?? '').trim()) throw new Error('a model is needed')
      Object.assign(cfg, { provider, model: String(model).trim() })
      if (cfg.rotation?.then) cfg.rotation.then = cfg.rotation.then.filter((t) => t.provider !== provider || t.model !== cfg.model) // #1 now, not also further down
      save('model')
      test([{ provider, model: cfg.model }])
      return state()
    },
    // the model list, in order (#1 is the model), and when to go on to the next
    'POST /api/order': ({ list, on, retries, next }) => {
      if (!Array.isArray(list)) throw new Error('a list of models is needed')
      const seen = new Set()
      const clean = list.map((t) => ({ provider: String(t?.provider ?? ''), model: String(t?.model ?? '').trim() }))
      for (const t of clean) {
        if (!cfg.providers[t.provider]) throw new Error(`no provider "${t.provider}"`)
        if (!t.model) throw new Error('a model is needed')
        if (seen.has(`${t.provider}/${t.model}`)) throw new Error(`${t.provider} · ${t.model} is in the list twice`)
        seen.add(`${t.provider}/${t.model}`)
      }
      const opts = { ...rotationOf(cfg), ...(on !== undefined && { on }), ...(retries !== undefined && { retries: Number(retries) }), ...(next !== undefined && { next }) }
      if (!ROTATION.on.includes(opts.on)) throw new Error(`move on: ${ROTATION.on.join(', ')}`)
      if (!Number.isInteger(opts.retries) || opts.retries < 1 || opts.retries > 20) throw new Error('tries before moving on: 1 to 20')
      if (!ROTATION.next.includes(opts.next)) throw new Error(`a new message starts with: ${ROTATION.next.join(', ')}`)
      // an empty list: no model (HeartCode says so until one is chosen)
      const changed1 = cfg.provider !== clean[0]?.provider || cfg.model !== clean[0]?.model
      Object.assign(cfg, { provider: clean[0]?.provider, model: clean[0]?.model })
      cfg.rotation = { on: opts.on, retries: opts.retries, next: opts.next, then: clean.slice(1) }
      saveConfig(cfg)
      changed(changed1 ? 'model' : 'setting:rotation')
      test(clean)
      return state()
    },
    // models.dev again (one model, or all of yours): its list fetched anew, and each model's profile
    // takes what it says now (one it didn't know before becomes "from models.dev"; your own settings
    // for it stay above). A running HeartCode takes it at once.
    // Test: one short message to the model, to see that it answers (key, access, name, the server
    // itself). In the requests log as a model test. Never throws: { ok, ms, reply } or { ok: false, error }.
    'POST /api/try': async ({ provider, model } = {}) => {
      const c = clientFor({ provider, model: String(model ?? '') })
      if (!c || !model) return { ok: false, error: `no provider "${provider}"` }
      c.purpose = 'test'
      const t0 = Date.now()
      try {
        const r = await c.chat({ messages: [{ role: 'user', content: 'Reply with just the word OK.' }], stream: true }, { signal: AbortSignal.timeout(90_000) })
        const reply = (r.content || '').trim()
        if (!reply && !r.toolCalls.length) return { ok: false, ms: Date.now() - t0, error: `it answered with nothing${r.usage?.completion_tokens ? ` (${r.usage.completion_tokens} tokens it said it wrote)` : ''}` }
        return { ok: true, ms: Date.now() - t0, reply: reply.slice(0, 80) }
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, status: e.status ?? null, error: e.name === 'TimeoutError' ? 'no answer within 90 seconds' : whyFailed(e) }
      }
    },
    'POST /api/models-dev': async ({ provider, model } = {}) => {
      await loadPrices({ force: true })
      const list = provider && model ? [{ provider, model: String(model) }] : state().order.map(({ provider, model }) => ({ provider, model }))
      let found = 0
      for (const t of list) {
        const c = clientFor(t)
        if (!c) continue
        const known = limitsOf(t.provider, c.baseUrl, t.model)
        if (known) found++
        const p = loadProfile(c)
        if (!p) writeJson(profilePath(c), profileFrom(c, known))
        else if (p.source && known) writeJson(profilePath(c), { ...p, known, source: p.source === 'assumed' ? 'models.dev' : p.source })
        testNews(`${t.provider}/${t.model}`, t)
      }
      changed('profile')
      return { ...state(), found, of: list.length }
    },
    // What a model can do, set by you (a model models.dev doesn't know, or to correct it): its
    // context window (null: as found) and tool calls, thinking, images, streaming. Kept in its profile,
    // above what models.dev says; a running HeartCode takes it at once.
    'POST /api/model-setup': async ({ provider, model, context, tools, thinking, images, stream }) => {
      const t = { provider, model: String(model ?? '').trim() }
      const c = clientFor(t)
      if (!c) throw new Error(`no provider "${provider}"`)
      if (!t.model) throw new Error('a model is needed')
      if (context !== null && context !== undefined && !(Number.isInteger(context) && context >= 512 && context <= 100_000_000)) throw new Error('the context window: a whole number of tokens (512 or more), or empty')
      for (const [k, v] of Object.entries({ tools, thinking, images, stream })) if (typeof v !== 'boolean') throw new Error(`${k}: yes or no`)
      await loadPrices()
      const p = loadProfile(c) ?? profileFrom(c, limitsOf(t.provider, c.baseUrl, t.model))
      p.set = { ...(context ? { context } : {}), tools, thinking, images, stream }
      if (p.source === 'assumed') p.source = 'you'
      writeJson(profilePath(c), p)
      changed('profile')
      testNews(`${provider}/${t.model}`, t)
      return state()
    },
    // Measure a tested model's window: one oversized request (client.measureContext); the limit the
    // server says is kept in its profile, above every other source. A running HeartCode uses it at once.
    'POST /api/measure': async ({ provider, model }) => {
      const t = { provider, model: String(model ?? '') }
      const c = clientFor(t)
      if (!c) throw new Error(`no provider "${provider}"`)
      await loadPrices()
      const p = loadProfile(c) ?? profileFrom(c, limitsOf(t.provider, c.baseUrl, t.model))
      const r = await c.measureContext()
      if (r.error) throw new Error(`couldn't measure it: ${r.error}`)
      Object.assign(p, { measured: r.limit ?? r.over, measuredAt: new Date().toISOString() })
      writeJson(profilePath(c), p)
      changed('profile')
      testNews(`${provider}/${t.model}`, t)
      return { ...state(), measured: r }
    },
    'POST /api/setting': ({ name, value }) => {
      if (name === 'permissions' && !PERMISSIONS.some(([p]) => p === value)) throw new Error('permissions: all, commands, ask or plan')
      if (name === 'permissions' && value === 'plan') throw new Error("HeartCode doesn't start in plan mode (Shift+Tab gets there)")
      if (name === 'effort' && !EFFORTS.includes(value)) throw new Error(`effort: ${EFFORTS.join(', ')}`)
      if (name === 'theme' && !THEMES[value]) throw new Error(`theme: ${Object.keys(THEMES).join(', ')}`)
      if (name === 'context' && value !== null && !(Number(value) > 0)) throw new Error('context: a number of tokens, or empty for what the model says')
      if ((name in TOGGLES || LOG_SWITCHES.includes(name)) && typeof value !== 'boolean') throw new Error(`${name}: on or off`)
      if (name === 'logDays' && !(Number.isInteger(value) && value >= 1 && value <= 3650)) throw new Error('logDays: a whole number of days, 1 to 3650')
      if (name === 'logDetail' && !DETAILS.includes(value)) throw new Error(`logDetail: ${DETAILS.join(' or ')}`)
      if (!['permissions', 'effort', 'theme', 'context', 'logDetail', 'logDays', ...Object.keys(TOGGLES), ...LOG_SWITCHES].includes(name)) throw new Error(`no setting "${name}"`)
      cfg[name] = name === 'effort' && value === 'default' ? undefined : name === 'context' ? (value === null ? undefined : Number(value)) : value
      save(`setting:${name}`)
      if (name === 'logRequests' || name === 'logDetail') useRequestLog(cfg) // from the next request (a running HeartCode takes it in too: applySettings)
      if (name === 'logDays') pruneLogs(value) // older ones go now
      return state()
    },
    // The requests log: the newest first; one in full
    'GET /api/requests': () => ({ items: listRequests() }),
    'POST /api/request': ({ run, file }) => readRequest(run, file),
    'POST /api/voice': ({ text }) => {
      cfg.voice = String(text ?? '').trim() ? JSON.parse(text) : undefined
      save('setting:voice')
      return state()
    },
    'POST /api/file': ({ name, text }) => {
      const f = FILES.find(([n]) => n === name)
      if (!f) throw new Error(`not a settings file: ${name}`)
      const file = path.join(HOME, name)
      if (!String(text ?? '').trim()) fs.rmSync(file, { force: true })
      else {
        if (f[2])
          try {
            JSON.parse(text)
          } catch (e) {
            throw new Error(`${name} isn't saved: ${e.message}`) // a broken one isn't saved
          }
        fs.mkdirSync(HOME, { recursive: true })
        fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 })
      }
      changed({ 'mcp.json': 'mcp', 'keybindings.json': 'keys', 'theme.json': 'theme' }[name] ?? `file:${name}`)
      return state()
    },
    'POST /api/mcp/toggle': ({ name, on }) => {
      if (!mcpServers().some((m) => m.name === name)) throw new Error(`no MCP server "${name}"`)
      const file = path.join(HOME, 'mcp.json')
      const data = readJson(file, null) ?? {}
      if (fs.existsSync(file) && !readJson(file, null)) throw new Error("mcp.json isn't valid JSON: fix it below first")
      const servers = (data.mcpServers ??= {})
      if (on) {
        if (servers[name]) delete servers[name].disabled
        if (servers[name] && !Object.keys(servers[name]).length) delete servers[name] // only the "off" was ours
      } else servers[name] = { ...servers[name], disabled: true }
      writeJson(file, data)
      changed('mcp')
      return state()
    },
    // a server of yours, from the form: a command on this machine, or a remote URL
    'POST /api/mcp/add': ({ name, command, url }) => {
      name = safeName(name)
      if (!name) throw new Error('a name is needed')
      const words = String(command ?? '').match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^(["'])(.*)\1$/, '$2')) ?? []
      url = String(url ?? '').trim()
      if (!words.length === !url) throw new Error('give a command, or a URL')
      if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error(`"${url}" is not a URL`)
      const file = path.join(HOME, 'mcp.json')
      if (fs.existsSync(file) && !readJson(file, null)) throw new Error("mcp.json isn't valid JSON: fix it first")
      const data = readJson(file, null) ?? {}
      const servers = (data.mcpServers ??= {})
      if (servers[name] && !servers[name].disabled && (servers[name].command || servers[name].url)) throw new Error(`there's a server "${name}" already`)
      servers[name] = url ? { url } : { command: words[0], args: words.slice(1) }
      writeJson(file, data)
      changed('mcp')
      return state()
    },
    'POST /api/mcp/remove': ({ name }) => {
      const file = path.join(HOME, 'mcp.json')
      const data = readJson(file, null)
      if (!data?.mcpServers?.[name]) throw new Error(`no server "${name}" of yours`)
      delete data.mcpServers[name]
      writeJson(file, data)
      changed('mcp')
      return state()
    },
    'POST /api/prompt': ({ id, text }) => {
      const [file, name] = String(id ?? '').split('/')
      const b = PROMPT_FILES.includes(file) && builtinPrompts(file).find((x) => x.name === name)
      if (!b) throw new Error(`no prompt "${id}"`)
      if (text === null || String(text).trim() === b.text.trim()) setPrompt(file, name, null) // as built in: nothing of yours to keep
      else {
        if (!String(text ?? '').trim()) throw new Error('a prompt can\'t be empty (Reset puts the built-in one back)')
        const known = varsOf(b.text)
        const unknown = [...varsOf(text)].filter((v) => !known.has(v))
        if (unknown.length) throw new Error(`HeartCode doesn't fill in ${unknown.map((v) => `{{${v}}}`).join(', ')} here${known.size ? `; it fills in ${[...known].map((v) => `{{${v}}}`).join(', ')}` : ''}`)
        setPrompt(file, name, text)
      }
      changed('prompts')
      return state()
    },
    'POST /api/skill': ({ name, text, was }) => {
      name = safeName(name)
      if (!name) throw new Error('a name is needed')
      if (!String(text ?? '').trim()) throw new Error('a skill needs its text')
      const { meta } = frontMatter(text)
      if (meta.name && safeName(meta.name) !== name) throw new Error(`the text says name: ${meta.name}, but the skill is called ${name}`)
      if (was && was !== name) removeSkill(was)
      const dir = path.join(skillsDir(), name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), text.endsWith('\n') ? text : text + '\n')
      changed('skill')
      return state()
    },
    'POST /api/skill/delete': ({ name }) => {
      if (!removeSkill(name)) throw new Error(`no skill "${name}" of yours`)
      changed('skill')
      return state()
    },
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
      res.end(type === 'application/json' ? JSON.stringify(body) : body)
    }
    try {
      // only as 127.0.0.1 or localhost (a site renamed to this address can't reach it), and only with the token
      const { port: p } = server.address()
      if (![`127.0.0.1:${p}`, `localhost:${p}`].includes(req.headers.host)) return send(403, { error: 'wrong host' })
      const url = new URL(req.url, `http://${req.headers.host}`)
      if (url.pathname === '/favicon.ico') return res.writeHead(204).end() // the browser asks, without the token
      const given = url.pathname === '/' || url.pathname === '/api/events' ? url.searchParams.get('t') : req.headers['x-heart-token']
      if (!given || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return send(403, url.pathname === '/' ? 'Open the link HeartCode printed (it has the key to this page).' : { error: 'no token' }, url.pathname === '/' ? 'text/plain' : 'application/json')
      if (url.pathname === '/' && req.method === 'GET') return send(200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8')
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' })
        res.write(': listening\n\n')
        listeners.add(res)
        watchRequests()
        const beat = setInterval(() => res.write(': still here\n\n'), 25_000) // through proxies and sleep
        req.on('close', () => (clearInterval(beat), listeners.delete(res)))
        return
      }
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) return send(404, { error: 'not found' })
      let raw = ''
      for await (const ch of req) {
        raw += ch
        if (raw.length > 1_000_000) return send(413, { error: 'too big' })
      }
      if (req.method === 'POST' && !/^application\/json/.test(req.headers['content-type'] ?? '')) return send(415, { error: 'JSON only' })
      send(200, await route(raw ? JSON.parse(raw) : {}))
    } catch (e) {
      send(400, { error: e.message })
    }
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`
      log('web', `settings page at 127.0.0.1:${server.address().port}`)
      // models.dev's list (its sizes for your models, whether their providers' lists are on or not):
      // loaded now, and your models' lines brought up to date when it's in
      loadPrices().then(() => {
        for (const t of state().order) testNews(`${t.provider}/${t.model}`, t)
      test(state().order) // any without a profile yet
      })
      resolve({ url, server, close: () => (watcher?.close(), server.closeAllConnections?.(), server.close()) })
    })
  })
}

function removeSkill(name) {
  const dir = path.join(skillsDir(), safeName(name))
  const file = path.join(skillsDir(), `${safeName(name)}.md`)
  for (const f of [dir, file]) if (safeName(name) && fs.existsSync(f)) return fs.rmSync(f, { recursive: true, force: true }), true
  return false
}
