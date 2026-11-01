// Commands that keep running (a dev server, a watcher, a long build): run_command with background
// true starts one and answers after a few seconds with what it printed so far; the background tool
// (and /background) reads what it printed since, lists them, stops one. Each runs in its own process
// group, its output going to a file; all of them are stopped when HeartCode exits.
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

// Started, and after `wait` ms: { job, output } (what it printed so far).
export async function startJob(root, command, { wait = 3000 } = {}) {
  fs.mkdirSync(DIR, { recursive: true })
  const id = ++made
  const file = path.join(DIR, `${process.pid}-${id}.log`)
  const fd = fs.openSync(file, 'w')
  const child = spawn(command, { cwd: root, shell: true, detached: group, stdio: ['ignore', fd, fd], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
  fs.closeSync(fd)
  const job = { id, command, root, pid: child.pid, file, started: Date.now(), code: null, read: 0, exited: false, told: false }
  jobs.set(id, job)
  child.on('error', (e) => fs.appendFileSync(file, `\n${e.message}\n`))
  child.on('exit', (code, sig) => Object.assign(job, { code: code ?? sig, exited: true, ended: Date.now() }))
  child.unref()
  log('background', `#${id} started: ${command} (pid ${child.pid})`)
  await new Promise((r) => setTimeout(r, wait))
  return { job, output: newOutput(job) }
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

// Stopped (if it still runs) and taken off the list; its log file stays.
export function removeJob(job) {
  stopJob(job)
  jobs.delete(job.id)
  log('background', `#${job.id} removed: ${job.command}`)
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
