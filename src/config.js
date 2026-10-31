import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = process.env.HEART_HOME || path.join(os.homedir(), '.heart')
export const CONFIG_FILE = path.join(HOME, 'config.json')

const SETTINGS = ['context', 'effort', 'permissions', 'autoCompact', 'director', 'theme', 'format', 'lsp', 'voice', 'queue', 'rotation', 'log', 'logRequests', 'logDetail', 'logDays']
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
  } else if (apiKey && cfg.providers[cfg.provider] && !cfg.providers[cfg.provider].apiKey) {
    cfg.providers[cfg.provider].apiKey = apiKey
  }
  const model = flags.model || process.env.HEART_MODEL
  if (model && !isAuto(model)) Object.assign(cfg, parseModel(model, cfg.providers, cfg.provider))
  // -m / an ad-hoc URL pins the chosen model for this run (a session of one): cfg.session, below
  if ((baseUrl || (model && !isAuto(model))) && cfg.providers[cfg.provider] && cfg.model) cfg.session = [{ provider: cfg.provider, model: cfg.model }]
  synced(cfg, readJson(CONFIG_FILE, {}))
  return cfg
}

// What a cfg stands for in config.json (the run-only provider and model left out).
function saved(cfg) {
  const providers = byName(cfg.providers)
  if (cfg.adhoc) delete providers[cfg.adhoc]
  // a run-only provider (-m URL) or models chosen for this session (cfg.session, /select_model) aren't
  // saved as the current model: the pin is local, it must not become everyone's #1 on disk
  const keep = (cfg.adhoc && cfg.provider === cfg.adhoc) || cfg.session?.length ? fromFile() : null // a run-only provider or a model set chosen for this session isn't saved as the current
  const out = { providers, provider: keep?.provider ?? cfg.provider, model: keep?.model ?? cfg.model }
  for (const k of SETTINGS) if (cfg[k] !== undefined) out[k] = cfg[k]
  return JSON.parse(JSON.stringify(out))
}

// Several HeartCodes (and the settings page in each) keep a copy of the settings. A save writes only
// what this one changed since it last read or wrote the file, onto the file as it is now, and
// takeIn brings in what the others changed: no copy undoes another's change with an old value.
// file: config.json as last read or written here; mine: what this run's cfg stood for then (a -m
// model for this run is no change of its own, so a save doesn't write it as #1).
let file = null
let mine = null
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const keysOf = (...objs) => [...new Set(objs.flatMap((o) => Object.keys(o ?? {})))]
const synced = (cfg, disk) => ((file = disk), (mine = saved(cfg)))

export function saveConfig(cfg) {
  const out = saved(cfg)
  const was = mine ?? {}
  const disk = readJson(CONFIG_FILE, {})
  for (const k of keysOf(out, was)) {
    if (k === 'providers') {
      // provider by provider: a key changed here and a provider added elsewhere both stay
      const ps = { ...disk.providers }
      for (const n of keysOf(out.providers, was.providers)) if (!same(out.providers?.[n], was.providers?.[n])) out.providers?.[n] === undefined ? delete ps[n] : (ps[n] = out.providers[n])
      disk.providers = byName(ps)
    } else if (!same(out[k], was[k])) out[k] === undefined ? delete disk[k] : (disk[k] = out[k])
  }
  writeJson(CONFIG_FILE, disk)
  synced(cfg, disk)
}

// What others changed in config.json since this run last read or wrote it, into cfg (the run-only
// provider stays). The keys that changed: a running HeartCode applies them (the model list…).
// what a changed key of config.json means to a running HeartCode (applySettings)
export const whatOf = (k) => (['provider', 'model', 'providers'].includes(k) ? 'model' : k === 'rotation' ? 'setting:rotation' : `setting:${k}`)
export function takeIn(cfg) {
  const disk = readJson(CONFIG_FILE, null)
  if (!disk || same(disk, file)) return []
  // doesn't move it (its provider/model stay); everything else is still taken in
  const takes = (k) => k === 'providers' || k === 'provider' || k === 'model' || SETTINGS.includes(k)
  const keys = keysOf(disk, file).filter((k) => takes(k) && !same(disk[k], file?.[k]))
  for (const k of keys) {
    const value = k === 'providers' ? { ...byName(disk.providers), ...(cfg.adhoc && { [cfg.adhoc]: cfg.providers[cfg.adhoc] }) } : disk[k]
    value === undefined ? delete cfg[k] : (cfg[k] = value)
  }
  file = disk
  mine = saved(cfg)
  return keys
}
