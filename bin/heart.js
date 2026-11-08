#!/usr/bin/env node
// `heart` (and `heartcode`): what `npm start` installs. Then HeartCode itself (heartcode.js).
//   heart                     this folder
//   heart .                   this folder
//   heart ~/code/my-app       that folder (a folder: a file is an error)
//   heart ~/code/my-app "fix the failing test" -m …   then anything heartcode takes (heart --help)
//   heart --temp …            a throwaway ~/.heart, shared by the --temp runs going on at once:
//                             your config.json (providers, keys), the models' test results and
//                             prices copied in; deleted when the last of them quits; your own is
//                             never written to
// Logs, each kind switched on by itself (the settings page: Logs; "logs" in config.json), all off
// by default: text logs in ~/.heart/logs/runs/<day-month-year-hour-min-sec>/, a file per kind
// (tools.log, models.log, agent.log, errors.log, conversation.log, debug.log); each request to a
// model in ~/.heart/logs/requests/<same>/, a file per request. Kept for logDays days (3 unless
// changed). HEART_LOG=/path/file.log logs everything of this run in that one file; HEART_LOG=off: none.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}
if (Number(process.versions.node.split('.')[0]) < 22) fail(`HeartCode needs Node.js 22 or newer (this is ${process.version}): https://nodejs.org`)

const args = process.argv.slice(2)
const realHome = process.env.HEART_HOME || path.join(os.homedir(), '.heart')
const stamp = (() => {
  const d = new Date()
  return `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}-${d.getHours()}-${d.getMinutes()}-${d.getSeconds()}`.replace(/\b(\d)\b/g, '0$1')
})()

// --temp: HeartCode's folder is one in the system's temp folder, shared by every --temp run going
// on at the same time (a setting changed in one reaches the others, as ~/.heart's do for the real
// ones). The first one makes it, the last one to quit deletes it. Each run's pid is a file in
// .runs/ (a run that crashed leaves one: its process is gone, so it doesn't count).
const temp = args.includes('--temp')
if (temp) {
  args.splice(args.indexOf('--temp'), 1)
  const dir = path.join(os.tmpdir(), `heart-temp-${os.userInfo().username}`)
  const runs = path.join(dir, '.runs')
  const alive = (pid) => {
    try {
      return process.kill(Number(pid), 0), true
    } catch (e) {
      return e.code === 'EPERM'
    }
  }
  const others = () => (fs.existsSync(runs) ? fs.readdirSync(runs).filter((pid) => Number(pid) !== process.pid && (alive(pid) || (fs.rmSync(path.join(runs, pid), { force: true }), false))) : [])
  if (!others().length) {
    fs.rmSync(dir, { recursive: true, force: true }) // left by a crashed run: from your settings again
    fs.mkdirSync(runs, { recursive: true })
    // your providers and keys; what HeartCode learned about each model and prices (or it tests them again)
    for (const f of ['config.json', 'models', 'prices.json', 'memory']) if (fs.existsSync(path.join(realHome, f))) fs.cpSync(path.join(realHome, f), path.join(dir, f), { recursive: true })
  }
  fs.writeFileSync(path.join(runs, String(process.pid)), '')
  process.env.HEART_HOME = dir
  process.env.HEART_TEMP = '1' // the project's .heartcode folders too: copies in here (config.js projectDir)
  process.on('exit', () => {
    fs.rmSync(path.join(runs, String(process.pid)), { force: true })
    if (!others().length) fs.rmSync(dir, { recursive: true, force: true })
  })
  process.once('SIGINT', () => process.exit(130)) // Ctrl+C (heart settings, -p): through 'exit', so the folder goes too
}

// a folder first: HeartCode opens it (subcommands and options go straight through)
const SUBCOMMANDS = ['models', 'providers', 'config', 'settings']
const first = args[0]
if (first && !first.startsWith('-') && !SUBCOMMANDS.includes(first)) {
  const where = path.resolve(first.replace(/^~(?=\/|$)/, os.homedir()))
  const stat = fs.statSync(where, { throwIfNoEntry: false })
  if (stat?.isDirectory()) args.splice(0, 1, '-C', where)
  else if (stat) fail(`${first} is a file: heart opens a folder (heart path/to/folder)`)
  else if (/^(\.|~|\/)|[\\/]/.test(first)) fail(`no such folder: ${first}`)
  // else: words, a task to run (heart "fix the failing test")
}

// where the logs go, and this run's name for its folders (src/log.js: each kind of log is switched on
// by itself in config.json's "logs", also while HeartCode runs)
const logs = temp ? path.join(process.env.HEART_HOME, 'logs') : path.join(realHome, 'logs') // --temp: deleted with its folder
process.env.HEART_LOGS ??= logs
let runStamp = stamp
for (let n = 2; ['runs', 'requests'].some((d) => fs.existsSync(path.join(logs, d, runStamp))); n++) runStamp = `${stamp}-${n}` // two runs in the same second
process.env.HEART_LOG_STAMP ??= runStamp

process.argv = [process.argv[0], fileURLToPath(new URL('./heartcode.js', import.meta.url)), ...args]
await import('./heartcode.js')
