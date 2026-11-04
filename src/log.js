// Logs, each kind switched on by itself (the settings page: Logs; config.json "logs"), all off unless
// you switch one on:
// - Text logs, one file per kind in the run's folder <logs>/runs/<when it started>/ (tools.log,
//   models.log, agent.log, errors.log, conversation.log, debug.log), each line with its tab.
//   HEART_LOG=/path/file.log: everything in that one file, whatever is switched on (for debugging).
// - Requests: each request to a model, and its reply or error, a JSON file of its own in
//   <logs>/requests/<when the run started>/, and a line for it in that folder's index.jsonl.
// Written synchronously so the last lines survive a crash.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'

export const LOG_FILE = process.env.HEART_LOG && process.env.HEART_LOG !== 'off' ? path.resolve(process.env.HEART_LOG) : null
// Where the logs go: bin/heart.js says (the system's temp folder with --temp)
export const LOGS = path.resolve(process.env.HEART_LOGS || path.join(process.env.HEART_HOME || path.join(os.homedir(), '.heart'), 'logs'))
export const REQUESTS = path.join(LOGS, 'requests')
export const DAYS = 3 // how long logs are kept, unless config.json's logDays says otherwise
const STAMP = process.env.HEART_LOG_STAMP || stamp()
// this run's folder of text logs (made with its first line)
export const LOG_DIR = process.env.HEART_LOG === 'off' ? null : path.resolve(process.env.HEART_LOG_DIR || path.join(LOGS, 'runs', STAMP))

// The kinds of text log, what each is for, and which topics (log('topic', …)) go in it. A topic not
// listed goes in debug.
export const LOG_KINDS = {
  tools: { label: 'Tools & commands', about: 'what HeartCode did on your machine: each tool call and its result, commands and background commands, MCP calls, files written', topics: ['tool', 'command', 'mcp', 'background', 'lsp', 'format', 'write', 'web', 'research', 'worktree'] },
  models: { label: 'Model choices', about: 'why a model answered or didn\'t: fallbacks, retries and quirks found', topics: ['rotate', 'retry', 'quirk'] },
  agent: { label: "Agent's decisions", about: 'why it did what it did: each task and its answer, plan-first, reviews, page checks, helpers and parts, compacting, lessons, the wrap-up', topics: ['task', 'look', 'review', 'compact', 'wrapup', 'learn', 'agent', 'director', 'guided', 'rewind', 'btw', 'parts'] },
  errors: { label: 'Errors', about: 'what went wrong: errors, crashes and warnings, with where they came from', topics: ['error', 'crash', 'warn', 'exit'] },
  conversation: { label: 'Conversation', about: 'a plain transcript: what you typed, its answers, its questions and your answers', topics: ['input', 'ask', 'answer'] },
  debug: { label: 'Debug', about: 'everything else, for a bug report: HTTP, settings, voice, Telegram, sign-ins, tabs, headless and ACP', topics: [] },
}
const KIND_OF = Object.fromEntries(Object.entries(LOG_KINDS).flatMap(([k, v]) => v.topics.map((t) => [t, k])))
export const kindOf = (topic) => KIND_OF[topic] ?? 'debug'
// which kinds are on (useRequestLog sets it from config.json)
export const logKinds = Object.fromEntries(Object.keys(LOG_KINDS).map((k) => [k, false]))
// config.json → what's on: "logs": { tools: true, … }; older ones: "log": true (every text kind),
// "logRequests": true (requests)
export const kindsOn = (cfg) => ({ ...Object.fromEntries(Object.keys(LOG_KINDS).map((k) => [k, cfg.logs?.[k] ?? cfg.log === true])), requests: cfg.logs?.requests ?? cfg.logRequests === true })

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
function fdFor(kind) {
  if (!LOG_FILE && !logKinds[kind]) return null
  const file = LOG_FILE ?? (LOG_DIR && path.join(LOG_DIR, `${kind}.log`))
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

// log('http', 'POST', url, body) → "2026-10-25T08:00:00.000Z tab 2 [http] POST https://… {…}" in the
// kind's file (debug.log here), when that kind is on
export function log(topic, ...parts) {
  const fd = fdFor(kindOf(topic))
  if (!fd) return
  try {
    const text = parts.map(show).join(' ').replace(/\x1b\[[0-9;]*m/g, '')
    fs.writeSync(fd, `${new Date().toISOString()}${tabOf() ? ` tab ${tabOf()}` : ''} [${topic}] ${text}\n`)
  } catch {}
}

// The requests log: on, and how much of each (from config.json: logRequests, logDetail).
export const requestLog = { on: false, detail: 'full', dir: null }
export function useRequestLog(cfg) {
  const on = kindsOn(cfg)
  for (const k of Object.keys(logKinds)) logKinds[k] = on[k]
  return Object.assign(requestLog, { on: on.requests, detail: cfg.logDetail === 'summary' ? 'summary' : 'full' })
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

// The runs that have text logs, newest first: { run, at, kinds: { tools: bytes, … }, current }.
export function listLogRuns() {
  const dir = path.join(LOGS, 'runs')
  const out = []
  try {
    for (const run of fs.readdirSync(dir)) {
      const at = path.join(dir, run)
      if (!fs.statSync(at).isDirectory()) continue
      const kinds = {}
      for (const f of fs.readdirSync(at)) if (f.endsWith('.log')) kinds[f.slice(0, -4)] = fs.statSync(path.join(at, f)).size
      const when = lastWritten(at)
      if (Object.keys(kinds).length) out.push({ run, at: when, kinds, current: at === LOG_DIR, live: at === LOG_DIR || Date.now() - when < 60_000 }) // live: still being written (this or another HeartCode)
    }
  } catch {}
  return out.sort((a, b) => b.at - a.at)
}
// A run's log of one kind: its last `most` bytes (a long one: from a whole line on), and its size.
export function readLog(run, kind, most = 1_000_000) {
  if (!/^[\w.-]+$/.test(String(run ?? '')) || /^\.+$/.test(run) || !/^[\w-]+$/.test(String(kind ?? ''))) throw new Error('no such log')
  const file = path.join(LOGS, 'runs', run, `${kind}.log`)
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const len = Math.min(size, most)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf8')
    return { size, cut: size > len, text: size > len ? text.slice(text.indexOf('\n') + 1) : text }
  } finally {
    fs.closeSync(fd)
  }
}
