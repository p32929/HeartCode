import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = process.env.HEART_HOME || path.join(os.homedir(), '.heart')
export const CONFIG_FILE = path.join(HOME, 'config.json')

const SETTINGS = ['context', 'effort', 'permissions', 'autoCompact', 'director', 'theme', 'format', 'lsp', 'voice', 'rotation', 'log', 'logRequests', 'logDetail', 'logDays']
const LOCAL_NAMES = { 11434: 'ollama', 1234: 'lmstudio', 8080: 'llamacpp' }

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// HeartCode's version, from package.json (npm version changes it there).
export const VERSION = readJson(fileURLToPath(new URL('../package.json', import.meta.url)), {}).version ?? '0.0.0'

// A config file the user writes (hooks.json, mcp.json): one that doesn't parse is skipped, but
// said (takeConfigErrors, shown before the next message), never silently ignored.
const configErrors = new Map() // file → { message, stamp, shown }
export function readConfig(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback
  const text = fs.readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (e) {
    const stamp = fs.statSync(file).mtimeMs
    if (configErrors.get(file)?.stamp !== stamp) configErrors.set(file, { message: `${file} isn't valid JSON (${e.message}); it's skipped until it's fixed`, stamp, shown: false })
    return fallback
  }
}
export function takeConfigErrors() {
  const out = [...configErrors.values()].filter((e) => !e.shown)
  for (const e of out) e.shown = true
  return out.map((e) => e.message)
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

// A short name for a URL: https://api.groq.com/openai/v1 → groq, https://proxy.dev/groq → groq.
export function providerName(url) {
  const u = new URL(url)
  if (/^(localhost|127\.|0\.0\.0\.0)/.test(u.hostname)) return LOCAL_NAMES[u.port] ?? `local-${u.port || 80}`
  const seg = u.pathname.split('/').filter((s) => s && !/^(v\d+\w*|api|openai)$/i.test(s)).pop()
  if (seg) return seg.toLowerCase()
  const parts = u.hostname.split('.').filter((p) => !['api', 'www', 'integrate', 'generativelanguage'].includes(p))
  return (parts.length > 1 ? parts.at(-2) : parts[0]) || u.hostname
}

function fromFile() {
  const file = readJson(CONFIG_FILE, {})
  const cfg = { ...file, providers: { ...file.providers }, adhoc: null }
  if (file.baseUrl && !file.providers) {
    // config from before providers existed
    const name = providerName(file.baseUrl)
    cfg.providers[name] = { baseUrl: file.baseUrl, apiKey: file.apiKey }
    cfg.provider = name
  }
  delete cfg.baseUrl
  delete cfg.apiKey
  return cfg
}

// cfg: { providers: {name: {baseUrl, apiKey}}, provider, model, context, adhoc }
// flags > env > ~/.heart/config.json. A URL from flags or env becomes a provider for this run
// only (cfg.adhoc), unless saved.
// The model name that means your list: #1, then the next when one fails (also: no model given;
// "default" is its old name). Any other model given for a run (-m, HEART_MODEL, a URL of its own)
// is that model alone: fixed (--fallback-model adds others after it).
export const AUTO_MODEL = 'auto'
export const isAuto = (m) => m === AUTO_MODEL || m === 'default'

// A model as given (-m, --fallback-model, /model): "provider/model" (as opencode writes it; split at
// the first "/", provider names have none), the older "provider model", or a model of `current`.
export function parseModel(v, providers, current) {
  v = String(v).trim()
  const spaced = /^(\S+)\s+(.+)$/.exec(v)
  if (spaced && providers[spaced[1]]) return { provider: spaced[1], model: spaced[2] }
  const i = v.indexOf('/')
  if (i > 0 && providers[v.slice(0, i)]) return { provider: v.slice(0, i), model: v.slice(i + 1) }
  return { provider: current, model: v }
}

// providers by name, A to Z: every list of them (settings page, `heart providers`, pickers) follows
export const byName = (providers) => Object.fromEntries(Object.entries(providers ?? {}).sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })))

export function loadConfig(flags = {}) {
  const file = fromFile()
  const cfg = { providers: byName(file.providers), provider: file.provider, model: file.model, adhoc: null }
  for (const k of SETTINGS) cfg[k] = flags[k] ?? file[k]
  if (cfg.context) cfg.context = Number(cfg.context)

  const baseUrl = flags.baseUrl || process.env.HEART_BASE_URL || process.env.OPENAI_BASE_URL
  const apiKey = flags.apiKey || process.env.HEART_API_KEY || process.env.OPENAI_API_KEY
  if (baseUrl) {
    const name = providerName(baseUrl)
    cfg.providers[name] = { baseUrl, apiKey }
    if (cfg.provider !== name) cfg.model = undefined
    cfg.provider = name
    cfg.adhoc = name
    cfg.fixed = true
  } else if (apiKey && cfg.providers[cfg.provider] && !cfg.providers[cfg.provider].apiKey) {
    cfg.providers[cfg.provider].apiKey = apiKey
  }
  const model = flags.model || process.env.HEART_MODEL
  if (model && !isAuto(model)) Object.assign(cfg, parseModel(model, cfg.providers, cfg.provider), { fixed: true })
  return cfg
}

export function saveConfig(cfg) {
  const providers = byName(cfg.providers)
  if (cfg.adhoc) delete providers[cfg.adhoc]
  const keep = cfg.adhoc && cfg.provider === cfg.adhoc ? fromFile() : null // the run-only provider isn't saved as current
  const out = { providers, provider: keep ? keep.provider : cfg.provider, model: keep ? keep.model : cfg.model }
  for (const k of SETTINGS) if (cfg[k] !== undefined) out[k] = cfg[k]
  writeJson(CONFIG_FILE, out)
}
