// A model's profile (what it can do: models.dev's word, or your settings) and how HeartCode talks to it.
import fs from 'node:fs'
import path from 'node:path'
import { HOME, readJson } from './config.js'
import { contextWindow, contextSource, ASSUMED_REMOTE, LIMIT_MS } from './context.js'
import { c } from './ui.js'

// One cached profile per server + model. The URL path counts: proxies serve several providers
// from one host (https://proxy.dev/groq, https://proxy.dev/openrouter).
export const profilePath = (client) => {
  const u = new URL(client.baseUrl)
  const where = u.host + u.pathname.replace(/\/v1$/, '')
  return path.join(HOME, 'models', `${where}_${client.model}`.replace(/[^\w.-]+/g, '_') + '.json')
}
// Bump when a profile's shape changes, so older saved ones are made again once.
const PROBE_VERSION = 2
// Kept in memory by file and its time: a page listing thousands of models reads only the ones that
// changed (a test, a setup, another HeartCode), not every file every time.
const profiles = new Map() // file → { at: its mtime, p }
export const loadProfile = (client) => {
  const file = profilePath(client)
  const st = fs.statSync(file, { throwIfNoEntry: false })
  if (!st) return profiles.delete(file), null
  const at = `${st.mtimeMs}:${st.size}` // the size too: a file system that keeps times to the second
  let hit = profiles.get(file)
  if (hit?.at !== at) profiles.set(file, (hit = { at, p: readJson(file, null) }))
  const p = hit.p && structuredClone(hit.p) // a copy, as a read gave: a caller may change it before writing
  // another model's (a model list switch once saved the first model's profile under the next one's name)
  return p?.version === PROBE_VERSION && (!p.model || p.model === client.model) ? p : null
}

// A model's profile: what models.dev says (info: limitsOf), or, for a model it doesn't know, plain
// assumptions (source 'assumed': tool calls, streaming, a 128k window) until you say on the settings
// page what it can do (set: { context, tools, thinking, images, stream }, source 'you').
export function profileFrom(client, info) {
  return { version: PROBE_VERSION, model: client.model, baseUrl: client.baseUrl, source: info ? 'models.dev' : 'assumed', at: new Date().toISOString(), usage: true, context: ASSUMED_REMOTE, contextGuessed: true, ...(info && { known: info }) }
}

// Turns a profile into decisions: your settings for the model (p.set) first, then what models.dev
// says. Config/flags can override the window (--context).
export function strategy(p, cfg = {}) {
  const set = p.set ?? {}
  const said = p.known ?? {}
  const thinking = set.thinking ?? Boolean(said.thinking)
  const win = contextWindow(p)
  return {
    actions: (set.tools ?? said.tools !== false) ? 'tools' : 'guided',
    stream: set.stream ?? true,
    stop: !thinking, // stop sequences cut into a thinking model's thinking
    vision: !(Date.now() - (p.quirks?.noImages ?? -Infinity) < LIMIT_MS) && (set.images ?? Boolean(said.images)), // its provider refused images this week: none
    thinking,
    context: cfg.context || set.context || win.size, // context.js: measured, said, models.dev, learned, or assumed
    contextSure: Boolean(cfg.context || set.context) || win.sure,
    reply: p.known?.output, // the longest reply it gives (models.dev), room kept for it
    ratio: p.tokenRatio ?? 1, // the server's tokens per estimated token
  }
}

export function describe(p, s) {
  const yn = (v) => (v ? c.green('yes') : c.red('no'))
  const context = ['context', `${s.context}${c.dim(`  (${p.set?.context ? 'set on /settings' : contextSource(p)}; change it on /settings)`)}`]
  const from = { 'models.dev': 'models.dev', you: '/settings (set by hand)', assumed: "nothing: it isn't in models.dev. Set what it can do on /settings" }[p.source] ?? 'an earlier test'
  const mine = (k) => (p.set?.[k] !== undefined ? c.dim('  (set by hand)') : '')
  return [['from', from], context, ['tool calls', yn(s.actions === 'tools') + mine('tools')], ['thinking', yn(s.thinking) + mine('thinking')], ['images', yn(s.vision) + (Date.now() - (p.quirks?.noImages ?? -Infinity) < LIMIT_MS ? c.dim('  (its provider refused an image today)') : mine('images'))], ['streaming', yn(s.stream) + mine('stream')]]
    .map(([k, v]) => `  ${c.dim(k.padEnd(15))} ${v}`)
    .join('\n')
}
