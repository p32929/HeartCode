#!/usr/bin/env node
// `heart` (and `heartcode`): what `npm start` installs. Then HeartCode itself (heartcode.js).
//   heart                     this folder
//   heart .                   this folder
//   heart ~/code/my-app       that folder (a folder: a file is an error)
//   heart ~/code/my-app "fix the failing test" -m …   then anything heartcode takes (heart --help)
//   heart --temp …            a throwaway ~/.heart: only your config.json (providers, keys), the
//                             models' test results and prices copied in; deleted when HeartCode
//                             quits; your own is never written to
// Logs, when they're switched on (the settings page: Logging): each run's log in
// ~/.heart/logs/runs/<day-month-year-hour-min-sec>/, a file per tab ("log": true in config.json);
// each request to a model in ~/.heart/logs/requests/<same>/, a file per request ("logRequests").
// Kept for logDays days (30 unless changed). HEART_LOG=/path/file.log logs this run in that one file
// anyway; HEART_LOG=off: no run log.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}
if (Number(process.versions.node.split('.')[0]) < 20) fail(`HeartCode needs Node.js 20 or newer (you have ${process.version}): https://nodejs.org`)

const args = process.argv.slice(2)
const realHome = process.env.HEART_HOME || path.join(os.homedir(), '.heart')
const stamp = (() => {
  const d = new Date()
  return `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}-${d.getHours()}-${d.getMinutes()}-${d.getSeconds()}`.replace(/\b(\d)\b/g, '0$1')
})()

// --temp: HeartCode's folder is a new one in the system's temp folder
const temp = args.includes('--temp')
if (temp) {
  args.splice(args.indexOf('--temp'), 1)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-temp-'))
  // your providers and keys; what HeartCode learned about each model and prices (or it tests them again)
  for (const f of ['config.json', 'models', 'prices.json']) if (fs.existsSync(path.join(realHome, f))) fs.cpSync(path.join(realHome, f), path.join(dir, f), { recursive: true })
  process.env.HEART_HOME = dir
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
}

// a folder first: HeartCode opens it (subcommands and options go straight through)
const SUBCOMMANDS = ['probe', 'models', 'providers', 'config', 'settings']
const first = args[0]
if (first && !first.startsWith('-') && !SUBCOMMANDS.includes(first)) {
  const where = path.resolve(first.replace(/^~(?=\/|$)/, os.homedir()))
  const stat = fs.statSync(where, { throwIfNoEntry: false })
  if (stat?.isDirectory()) args.splice(0, 1, '-C', where)
  else if (stat) fail(`${first} is a file: heart opens a folder (heart path/to/folder)`)
  else if (/^(\.|~|\/)|[\\/]/.test(first)) fail(`no such folder: ${first}`)
  // else: words, a task to run (heart "fix the failing test")
}

// the run's log, if switched on (not for -p/--print: its callers set HEART_LOG themselves if they
// want one; nor for --help and --version); requests are logged by HeartCode itself (src/log.js)
const logOn = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.HEART_HOME || realHome, 'config.json'), 'utf8')).log === true
  } catch {
    return false
  }
})()
const logs = temp ? path.join(os.tmpdir(), 'heart-temp-logs') : path.join(realHome, 'logs')
process.env.HEART_LOGS ??= logs
let runStamp = stamp
for (let n = 2; ['runs', 'requests'].some((d) => fs.existsSync(path.join(logs, d, runStamp))); n++) runStamp = `${stamp}-${n}` // two runs in the same second
process.env.HEART_LOG_STAMP ??= runStamp
// The run's folder is set aside either way (made with its first line): the Logging page's switch
// turns the log on or off while HeartCode runs (src/log.js, HEART_LOG_RUN).
if (!process.env.HEART_LOG && !process.env.HEART_LOG_DIR && !args.some((a) => ['-p', '--print', '-h', '--help', '-v', '--version'].includes(a))) {
  process.env.HEART_LOG_DIR = path.join(logs, 'runs', runStamp) // old ones: deleted after logDays (src/log.js)
  process.env.HEART_LOG_RUN = logOn ? 'on' : 'off' // how it starts
}

process.argv = [process.argv[0], fileURLToPath(new URL('./heartcode.js', import.meta.url)), ...args]
await import('./heartcode.js')
