// Every command run_command runs: started here, waited on for as long as the model chose, and if
// it's still running then, it carries on in the background (nothing ever blocks HeartCode); the
// background tool (and /background) reads what it printed since, waits on it, lists them, stops
// one. Each runs in its own process group, its output going to a file; all of them are stopped when
// HeartCode exits.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { HOME } from './config.js'
import { log } from './log.js'

const DIR = path.join(HOME, 'outputs', 'background')
const jobs = new Map() // id → { id, command, root, pid, file, started, code, read, exited }
let made = 0

const plain = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')
const group = process.platform !== 'win32'
const kill = (job, sig) => {
  try {
    group ? process.kill(-job.pid, sig) : process.kill(job.pid, sig)
    return true
  } catch {
    return false
  }
}

// Started (it runs on; waitFor waits on it).
export function startJob(root, command) {
  fs.mkdirSync(DIR, { recursive: true })
  const id = ++made
  const file = path.join(DIR, `${process.pid}-${id}.log`)
  const fd = fs.openSync(file, 'w')
  const child = spawn(command, { cwd: root, shell: true, detached: group, stdio: ['ignore', fd, fd], env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } })
  fs.closeSync(fd)
  const job = { id, command, root, pid: child.pid, file, started: Date.now(), code: null, read: 0, exited: false, told: false }
  jobs.set(id, job)
  job.over = new Promise((r) => {
    const end = (code) => r(Object.assign(job, { code, exited: true, ended: Date.now() }))
    child.on('error', (e) => (fs.appendFileSync(file, `\n${e.message}\n`), end('error')))
    child.on('exit', (code, sig) => end(code ?? sig))
  })
  child.unref()
  log('background', `#${id} started: ${command} (pid ${child.pid})`)
  return job
}

// Until it exits, `ms` pass or `signal` aborts, whichever comes first.
export function waitFor(job, ms, signal) {
  if (job.exited || signal?.aborted) return Promise.resolve()
  return new Promise((r) => {
    const done = () => (clearTimeout(t), signal?.removeEventListener('abort', done), r())
    const t = setTimeout(done, ms)
    job.over.then(done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// What it printed since the last look (the last `most` characters of it).
export function newOutput(job, most = 4000) {
  let text = ''
  try {
    const all = fs.readFileSync(job.file)
    text = plain(all.subarray(job.read).toString('utf8'))
    job.read = all.length
  } catch {}
  return text.length > most ? `…${text.slice(-most)}` : text
}

// Its last `n` lines, read from the end of its file (a long log isn't read whole).
export function tailLines(job, n) {
  let text = ''
  try {
    const fd = fs.openSync(job.file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, 64 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    fs.closeSync(fd)
    text = plain(buf.toString('utf8'))
  } catch {}
  return text.split('\n').filter((l, i, all) => l.trim() || i < all.length - 1).slice(-n)
}

export const listJobs = (root) => [...jobs.values()].filter((j) => !root || j.root === root)
export const getJob = (id) => jobs.get(Number(String(id).replace(/^#/, '')))
export const runningJobs = (root) => listJobs(root).filter((j) => !j.exited)

export function stopJob(job) {
  if (job.exited) return false
  kill(job, 'SIGTERM')
  setTimeout(() => kill(job, 'SIGKILL'), 2000).unref()
  log('background', `#${job.id} stopped: ${job.command}`)
  return true
}

// Stopped (if it still runs) and taken off the list; its log file stays. True when it had exited
// but left processes running (`server &`): those are stopped too.
export function removeJob(job) {
  const left = job.exited && group && kill(job, 0)
  if (left) kill(job, 'SIGTERM')
  stopJob(job)
  jobs.delete(job.id)
  log('background', `#${job.id} removed: ${job.command}`)
  return left
}

// The ones that ended since they were last told about (for the model's next step).
export function newlyEnded(root) {
  const out = listJobs(root).filter((j) => j.exited && !j.told)
  for (const j of out) j.told = true
  return out
}

export const jobLine = (j) => `#${j.id} ${j.command} · ${j.exited ? `exited with ${j.code}` : 'running'} · ${ago(j)} · output: ${j.file}`
export const ago = (j) => {
  const s = Math.round(((j.ended ?? Date.now()) - j.started) / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 360) / 10}h`
}

// Nothing outlives HeartCode.
process.on('exit', () => {
  for (const j of jobs.values()) if (!j.exited) kill(j, 'SIGTERM')
})
