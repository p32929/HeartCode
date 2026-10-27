// /reset: HeartCode's own files in ~/.heart back to how they were before you changed anything.
// Three levels, each including the one before. A project's own .heartcode/ is never touched.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HOME, CONFIG_FILE, readJson, writeJson } from './config.js'

export const RESETS = [
  {
    level: 'settings',
    label: 'Settings',
    desc: 'permissions, theme, effort, the toggles, the model list, voice; your keys, colors, formatters, prompts, MCP servers and hooks. Your providers, keys and model stay.',
    files: ['keybindings.json', 'theme.json', 'format.json', 'prompts', 'mcp.json', 'hooks.json'],
  },
  {
    level: 'providers',
    label: 'Settings and providers',
    desc: 'the above, and your providers with their API keys, MCP sign-ins, what HeartCode learned about each model, prices',
    files: ['config.json', 'mcp-auth.json', 'models', 'prices.json'],
  },
  {
    level: 'everything',
    label: 'Everything',
    desc: `the above, and your sessions, global memory, skills, instructions (HEARTCODE.md), history, logs: all of ${HOME}`,
    files: null, // the whole folder
  },
]

// What a level removes, for the question (the files that are there).
export function resetPaths(level) {
  const upto = RESETS.slice(0, RESETS.findIndex((r) => r.level === level) + 1)
  if (upto.at(-1).files === null) return fs.existsSync(HOME) ? fs.readdirSync(HOME).map((f) => path.join(HOME, f)) : []
  return upto.flatMap((r) => r.files).map((f) => path.join(HOME, f)).filter((f) => fs.existsSync(f))
}

export function reset(level) {
  if (!RESETS.some((r) => r.level === level)) throw new Error(`no reset "${level}"`)
  const files = resetPaths(level)
  if (level === 'settings') {
    // config.json: only who answers stays (providers, keys, the model)
    const cfg = readJson(CONFIG_FILE, null)
    if (cfg) writeJson(CONFIG_FILE, Object.fromEntries(Object.entries(cfg).filter(([k]) => ['providers', 'provider', 'model'].includes(k))))
  }
  for (const f of files) fs.rmSync(f, { recursive: true, force: true })
  return files
}

// A code to type before resetting: 4 letters and digits that can't be mistaken for each other.
export const resetCode = () => Array.from(crypto.randomBytes(4), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('')
