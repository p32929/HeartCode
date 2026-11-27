// A newer HeartCode: asked of npm at every start (in the background, never waited on), shown in
// the status bar, installed with /update the way HeartCode was installed. A git checkout (npm link)
// isn't npm-installed over: it's told to git pull.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME, VERSION, readJson, writeJson } from './config.js'
import { fetch } from './http.js' // not the built-in one: see http.js

const FILE = path.join(HOME, 'update-check.json')
const PKG = fileURLToPath(new URL('..', import.meta.url))

// "0.1.38" > "0.1.37": numbers compared part by part (a pre-release tag isn't offered)
export const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split('-')[0].split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

// { current, latest, newer }: npm asked now (its answer kept for the settings page); npm out of
// reach, its last answer; null when there's none.
export async function checkUpdate() {
  let latest = readJson(FILE, {}).latest
  try {
    const r = await fetch('https://registry.npmjs.org/heartcode/latest', { signal: AbortSignal.timeout(8000) })
    latest = (await r.json()).version
    writeJson(FILE, { checked: Date.now(), latest })
  } catch {
    if (!latest) return null
  }
  return { current: VERSION, latest, newer: Boolean(latest) && newer(latest, VERSION) }
}

// How HeartCode was installed: 'git' (a checkout, linked), or the package manager that put it there.
export function installKind() {
  if (fs.existsSync(path.join(PKG, '.git')) || !PKG.split(path.sep).includes('node_modules')) return 'git'
  if (/[\\/]pnpm[\\/]/.test(PKG)) return 'pnpm'
  if (/[\\/]\.bun[\\/]/.test(PKG)) return 'bun'
  if (/[\\/]yarn[\\/]/.test(PKG)) return 'yarn'
  return 'npm'
}

export const UPDATE_COMMANDS = { npm: 'npm install -g heartcode@latest', pnpm: 'pnpm add -g heartcode@latest', yarn: 'yarn global add heartcode@latest', bun: 'bun add -g heartcode@latest' }
export const packageDir = PKG

// The whole changelog of the version on offer, newest first (scrolled in the dialog): from its npm
// package (the version you'd get; GitHub's main branch can be behind npm), else GitHub. '' if none.
// The versions since the one running are marked new.
export async function whatsNew(current, latest) {
  for (const url of [`https://cdn.jsdelivr.net/npm/heartcode@${latest}/CHANGELOG.md`, `https://unpkg.com/heartcode@${latest}/CHANGELOG.md`, 'https://raw.githubusercontent.com/p32929/HeartCode/main/CHANGELOG.md']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const text = r.ok ? await r.text() : ''
      const start = text.indexOf('\n## ')
      if (start < 0) continue
      const body = text.slice(start + 1).trim().replace(/\n {2,}(?![-*] )(?=\S)/g, ' ') // a list item's wrapped lines joined (the box wraps it to its width); a sub-item stays its own
      return body.replace(/^## (\d+\.\d+\.\d+)(.*)$/gm, (line, v, rest) => (newer(v, current) ? `## ${v}${rest} · new` : line))
    } catch {}
  }
  return ''
}
