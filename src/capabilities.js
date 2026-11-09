// What each feature that leans on an outside tool, package or service needs, and whether it's here.
// One place so the settings page can gray a feature out and name what's missing, and /doctor can list
// the same in the CLI. Pure checks (looking on PATH and in a couple of app folders): no network.
// We only name what's needed — not how to install it, since that differs from one OS to the next.
import fs from 'node:fs'
import path from 'node:path'
import { voiceProblem } from './voice.js'
import { onPath } from './spawn.js'

const exists = (p) => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}
const chromeHere = () =>
  onPath('google-chrome') ||
  onPath('chromium') ||
  onPath('chrome') ||
  onPath('chrome.exe') ||
  ['/Applications/Google Chrome.app', '/Applications/Chromium.app', '/Applications/Microsoft Edge.app', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].some(exists)

// Each feature that needs something external: { id, name, what, ok, need }. `ok` false means the
// feature can't run as things are; `need` names what to install to make it work.
export function capabilities(cfg = {}) {
  const caps = []
  const vp = voiceProblem(cfg.voice ?? {}, cfg.providers ?? {})
  let need = ''
  if (vp) {
    if (/ffmpeg/.test(vp)) need = 'ffmpeg, and a whisper model (or a transcription provider)'
    else if (/whisper-cli/.test(vp)) need = 'whisper (whisper-cli) and a model — or a transcription provider'
    else need = 'a whisper model — or a transcription provider'
  }
  caps.push({ id: 'voice', name: 'Voice input', what: 'Dictate a message — Space in an empty box, or /voice.', ok: !vp, need })
  const chrome = chromeHere()
  const npx = onPath('npx')
  caps.push({
    id: 'browser',
    name: 'Browser',
    what: 'The browser tools: the model opens a page in a real browser, uses it, reads the console and takes screenshots.',
    ok: chrome && npx,
    need: !npx ? 'Node.js' : !chrome ? 'Google Chrome' : '',
  })
  caps.push({ id: 'git', name: 'Install skills from GitHub', what: '/install_skill and git-based imports clone a repo.', ok: onPath('git'), need: onPath('git') ? '' : 'git' })
  return caps
}
