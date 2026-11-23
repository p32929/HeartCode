// A folder's own HeartCode setup (.heartcode/hooks.json and mcp.json run commands, .heartcode/prompts
// steer the model) is used only once you said yes to it, for these files as they are: a cloned
// repo's would otherwise run its commands at your first message. Kept in ~/.heart/trusted.json
// (folder → a hash of those files); changed files are asked about again. Headless (-p) and editors
// (ACP) use it as it is: whoever runs them there chose that folder (as Claude Code's -p does).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HOME, readJson, writeJson } from './config.js'

const FILE = path.join(HOME, 'trusted.json')
export const trustAll = { on: false } // headless and ACP
const NAMES = ['hooks.json', 'mcp.json', 'prompts']

// the setup files this folder has (relative paths)
export function setupFiles(root) {
  const dir = path.join(root, '.heartcode')
  const out = []
  for (const n of NAMES) {
    const p = path.join(dir, n)
    const st = fs.statSync(p, { throwIfNoEntry: false })
    if (st?.isFile()) out.push(n)
    else if (st?.isDirectory()) for (const f of fs.readdirSync(p).sort()) if (f.endsWith('.md')) out.push(`${n}/${f}`)
  }
  return out.map((f) => `.heartcode/${f}`)
}

const hashOf = (root, files) => {
  const h = crypto.createHash('sha256')
  for (const f of files) h.update(`${f}\0`).update(fs.readFileSync(path.join(root, f)))
  return h.digest('hex')
}

export function trusted(root) {
  if (trustAll.on || !root) return true
  const files = setupFiles(root)
  if (!files.length) return true
  try {
    return readJson(FILE, {})[path.resolve(root)] === hashOf(root, files)
  } catch {
    return false
  }
}

export function trust(root) {
  const all = readJson(FILE, {})
  all[path.resolve(root)] = hashOf(root, setupFiles(root))
  writeJson(FILE, all)
}
