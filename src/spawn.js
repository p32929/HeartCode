// Starting and stopping other programs the same way on every OS.
// Windows: npm, npx and most tools installed by npm are .cmd files, which Node won't start without a
// shell (EINVAL, or ENOENT for a bare "npx"); they go through cmd.exe, each word quoted for it. And a
// program started through a shell is stopped with its whole tree (taskkill /T): killing only the
// shell would leave the program itself running.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WIN = process.platform === 'win32'

// cmd.exe's quoting: a word with spaces or its special characters in double quotes ("" for a quote;
// backslashes at its end doubled, or the last one would hide the closing quote from the program)
const quote = (w) => (w === '' || /[\s"&|<>^()%!,;=]/.test(w) ? `"${String(w).replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"` : String(w))

// spawn(command, args, options), started through cmd.exe on Windows (spawnCmdSync: spawnSync's)
const viaCmd = (run) => (command, args = [], opts = {}) => (WIN ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(quote).join(' ')}"`], { ...opts, windowsVerbatimArguments: true }) : run(command, args, opts))
export const spawnCmd = viaCmd(nodeSpawn)
export const spawnCmdSync = viaCmd(spawnSync)

// A program's path on the PATH, or '' (Windows: with its extension, .exe, .cmd…, as PATHEXT lists them)
const EXTS = WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : ['']
export function onPath(cmd) {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue
    for (const e of EXTS) {
      const p = path.join(d, cmd + e)
      try {
        if (fs.statSync(p).isFile()) return p
      } catch {}
    }
  }
  return ''
}

// Stops a program and what it started: its process group elsewhere (when it was started detached),
// its process tree on Windows. sig 0: only whether it's still there. False when nothing was there.
export function killTree(pid, sig = 'SIGTERM', group = !WIN) {
  if (!pid) return false
  try {
    if (sig === 0) return process.kill(group ? -pid : pid, 0)
    if (WIN) return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).status === 0
    process.kill(group ? -pid : pid, sig)
    return true
  } catch {
    return false
  }
}
