// Logs, when they're switched on (the settings page: Logging).
// - The run's log: everything HeartCode does, as readable text. HEART_LOG_DIR (bin/heart.js sets
//   one folder per run): a file per tab (tab-1.log, tab-2.log…; heartcode.log before any tab).
//   HEART_LOG=/path/file.log: all of it in that one file.
// - Requests: each request to a model, and its reply or error, a JSON file of its own in
//   <logs>/requests/<when the run started>/, and a line for it in that folder's index.jsonl.
// Written synchronously so the last lines survive a crash.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'

export const LOG_FILE = process.env.HEART_LOG && process.env.HEART_LOG !== 'off' ? path.resolve(process.env.HEART_LOG) : null
export const LOG_DIR = !LOG_FILE && process.env.HEART_LOG !== 'off' && process.env.HEART_LOG_DIR ? path.resolve(process.env.HEART_LOG_DIR) : null
// The run's log on or off. HEART_LOG_RUN=on|off (bin/heart.js): its folder is set aside, and config.json's
// "log" switches it, also while HeartCode runs (useRequestLog); else it's on when a file or folder is given.
const AUTO = Boolean(LOG_DIR) && ['on', 'off'].includes(process.env.HEART_LOG_RUN)
export const runLog = { on: Boolean(LOG_FILE || (LOG_DIR && (!AUTO || process.env.HEART_LOG_RUN === 'on'))) }
// Where the logs go: bin/heart.js says (the system's temp folder with --temp)
export const LOGS = path.resolve(process.env.HEART_LOGS || path.join(process.env.HEART_HOME || path.join(os.homedir(), '.heart'), 'logs'))
export const REQUESTS = path.join(LOGS, 'requests')
export const DAYS = 30 // how long logs are kept, unless config.json's logDays says otherwise
const STAMP = process.env.HEART_LOG_STAMP || stamp()

export function stamp(d = new Date()) {
  return `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}-${d.getHours()}-${d.getMinutes()}-${d.getSeconds()}`.replace(/\b(\d)\b/g, '0$1')
}
// Logs older than `days` go: run folders, request folders, and the older one-file-per-run logs.
// Returns how many went.
// When a log was last written to: a folder's newest file (writing into a file leaves its folder's
// time as it was).
function lastWritten(at) {
  const s = fs.statSync(at)
  if (!s.isDirectory()) return s.mtimeMs
  let t = s.mtimeMs
  for (const f of fs.readdirSync(at)) t = Math.max(t, fs.statSync(path.join(at, f), { throwIfNoEntry: false })?.mtimeMs ?? 0)
  return t
}

export function pruneLogs(days = DAYS, before = Date.now() - days * 86_400_000) {
  let gone = 0
  for (const [dir, isLog] of [[path.join(LOGS, 'runs'), () => true], [REQUESTS, () => true], [LOGS, (f) => f.endsWith('.log')]]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const at = path.join(dir, f)
        if (!isLog(f) || at === LOG_DIR || at === requestLog.dir || lastWritten(at) >= before) continue
        fs.rmSync(at, { recursive: true, force: true })
        gone++
      }
    } catch {}
  }
  return gone
}
// The settings page's Delete all: every log but the ones being written now (this run's, and any
// touched in the last minute: another HeartCode's). Returns how many files and folders went.
export const clearLogs = () => pruneLogs(0, Date.now() - 60_000)

// How much room the logs take on disk, in bytes: { runs, requests, total } (runs: the run logs,
// and older single log files).
export function logSize() {
  const sum = (dir) => {
    let n = 0
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const at = path.join(dir, e.name)
        n += e.isDirectory() ? sum(at) : (fs.statSync(at, { throwIfNoEntry: false })?.size ?? 0)
      }
    } catch {}
    return n
  }
  let loose = 0
  try {
    for (const f of fs.readdirSync(LOGS)) if (f.endsWith('.log')) loose += fs.statSync(path.join(LOGS, f), { throwIfNoEntry: false })?.size ?? 0
  } catch {}
  const runs = sum(path.join(LOGS, 'runs')) + loose
  const requests = sum(REQUESTS)
  return { runs, requests, total: runs + requests }
}
export const logDays = (cfg) => (Number.isInteger(cfg.logDays) && cfg.logDays > 0 ? cfg.logDays : DAYS)

// Which tab this is running for (tabs.js runs each tab's work in it): its log file, its requests.
export const logContext = new AsyncLocalStorage()
const tabOf = () => logContext.getStore()?.tab ?? null

const fds = new Map()
function fdFor() {
  if (!runLog.on) return null
  const file = LOG_FILE ?? (LOG_DIR && path.join(LOG_DIR, tabOf() ? `tab-${tabOf()}.log` : 'heartcode.log'))
  if (!file) return null
  if (!fds.has(file)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fds.set(file, fs.openSync(file, 'a'))
    } catch {
      fds.set(file, null)
    }
  }
  return fds.get(file)
}

const show = (x) => (typeof x === 'string' ? x : inspect(x, { depth: 8, breakLength: 140, maxArrayLength: 200, maxStringLength: 50_000 }))

// log('http', 'POST', url, body) → "2026-10-25T08:00:00.000Z [http] POST https://… {…}"
export function log(topic, ...parts) {
  const fd = fdFor()
  if (fd === null) return
  try {
    const text = parts.map(show).join(' ').replace(/\x1b\[[0-9;]*m/g, '')
    fs.writeSync(fd, `${new Date().toISOString()} [${topic}] ${text}\n`)
  } catch {}
}

// The requests log: on, and how much of each (from config.json: logRequests, logDetail).
export const requestLog = { on: false, detail: 'full', dir: null }
export function useRequestLog(cfg) {
  if (AUTO) runLog.on = cfg.log === true
  return Object.assign(requestLog, { on: cfg.logRequests === true, detail: cfg.logDetail === 'summary' ? 'summary' : 'full' })
}
// At the start: the request log as set, and logs past their days gone.
export function useLogs(cfg) {
  useRequestLog(cfg)
  pruneLogs(logDays(cfg))
}
let count = 0
const safe = (s) => String(s ?? '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'none'

// One request, after it ended: { ok, stopped, provider, model, place, of, url, status, error, ms,
// firstTokenMs, usage, request, reply }. "full" keeps what was sent and what came back; "summary"
// only their sizes. API keys are never in it (they're headers, not the body).
export function logRequest(rec) {
  if (!requestLog.on) return
  try {
    if (!requestLog.dir) {
      let dir = path.join(REQUESTS, STAMP)
      for (let n = 2; fs.existsSync(dir); n++) dir = path.join(REQUESTS, `${STAMP}-${n}`) // another run started in the same second
      fs.mkdirSync(dir, { recursive: true })
      requestLog.dir = dir
    }
    const n = ++count
    const result = rec.ok ? 'ok' : rec.stopped ? 'stopped' : 'failed'
    const file = `${String(n).padStart(4, '0')}-${result}-${safe(rec.provider)}-${safe(rec.model)}.json`
    const { request, reply, ...summary } = rec
    const head = { n, at: new Date().toISOString(), tab: tabOf(), result, ...summary }
    const sizes = { requestChars: request ? JSON.stringify(request).length : 0, messages: request?.messages?.length ?? 0, replyChars: reply ? (reply.content ?? '').length : 0, toolCalls: reply?.toolCalls?.length ?? 0 }
    const body = requestLog.detail === 'full' ? { ...head, request, reply } : { ...head, ...sizes }
    fs.writeFileSync(path.join(requestLog.dir, file), JSON.stringify(body, null, 2))
    fs.appendFileSync(path.join(requestLog.dir, 'index.jsonl'), JSON.stringify({ file, ...head, ...sizes, errorBody: head.errorBody?.slice(0, 500) }) + '\n') // the list's line: kept short
  } catch {}
}

// The requests logged, newest first (for the settings page): each run's index.jsonl, read backwards.
export function listRequests(limit = 300) {
  const out = []
  try {
    const runs = fs.readdirSync(REQUESTS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => [d.name, fs.statSync(path.join(REQUESTS, d.name)).mtimeMs]).sort((a, b) => b[1] - a[1])
    for (const [run] of runs) {
      const lines = fs.existsSync(path.join(REQUESTS, run, 'index.jsonl')) ? fs.readFileSync(path.join(REQUESTS, run, 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []
      for (const line of lines.reverse()) {
        try {
          out.push({ run, ...JSON.parse(line) })
        } catch {}
        if (out.length >= limit) return out
      }
    }
  } catch {}
  return out
}
// One request's file, by its run folder and name (nothing outside the requests folder).
export function readRequest(run, file) {
  if (![run, file].every((x) => /^[\w.-]+$/.test(String(x ?? '')) && !/^\.+$/.test(x)) || !file.endsWith('.json')) throw new Error('no such request')
  return JSON.parse(fs.readFileSync(path.join(REQUESTS, run, file), 'utf8'))
}
