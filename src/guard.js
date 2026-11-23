// HeartCode is never stopped by a command it runs. A model freeing a port (`lsof -ti :3000 | xargs
// kill -9` lists every process with a connection to it, HeartCode's own too), `pkill -f node`,
// `killall node`, `kill -9 -1`: each would kill HeartCode with it. The commands it runs (macOS, Linux)
// find kill, pkill and killall in a folder of HeartCode's first on their PATH (and `kill`, a shell
// builtin, as a function before the command): these leave out HeartCode, the programs it runs in
// (its terminal, its launcher) and "every process"; the rest are stopped as asked.
// ponytail: an absolute /bin/kill still gets through; Windows' taskkill isn't covered.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { HOME } from './config.js'

const WIN = process.platform === 'win32'
const DIR = path.join(HOME, 'guard')
const VERSION = 3 // the scripts are written again when this changes

// HeartCode and the processes above it (its launcher, the shell, the terminal), not pid 1
function protectedPids() {
  const pids = [process.pid]
  try {
    let p = process.ppid
    for (let i = 0; i < 8 && p > 1; i++) {
      pids.push(p)
      p = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    }
  } catch {}
  return pids
}

// what both scripts share: the real kill, and the check of one target
const COMMON = `KILL=/bin/kill; [ -x "$KILL" ] || KILL=/usr/bin/kill
mine() { for p in $HEART_PIDS; do [ "$1" = "$p" ] || [ "$1" = "-$p" ] && return 0; done; return 1; }
`
const KILL = `#!/bin/sh
# HeartCode's kill: as kill, but never HeartCode itself (HEART_PIDS) nor every process (-1)
${COMMON}sig=""
case "$1" in -l|-L) exec "$KILL" "$@";; -s|-n) sig="$1 $2"; shift 2;; -*) sig="$1"; shift;; esac
[ "$1" = "--" ] && shift
out=""; for a in "$@"; do
  case "$a" in -1|0|-0) echo "kill $a: that's every process (HeartCode too): not sent" >&2; continue;; esac
  if mine "$a"; then echo "kill $a: that's HeartCode itself (the program running this command): not stopped" >&2; continue; fi
  out="$out $a"
done
[ -n "$out" ] || exit 1
exec "$KILL" $sig $out
`
// pkill and killall: the processes they'd match (pgrep), without HeartCode's, stopped with kill
const MATCH = (name, toPgrep) => `#!/bin/sh
# HeartCode's ${name}: as ${name}, but never HeartCode itself (HEART_PIDS)
${COMMON}sig="-TERM"
case "$1" in -[0-9]*|-[A-Z]*) sig="$1"; shift;; -s|--signal) sig="-$2"; shift 2;; esac
pids=$(${toPgrep} | tr '\\n' ' ')
out=""; for p in $pids; do mine "$p" && { echo "${name}: left out HeartCode itself (pid $p)" >&2; continue; }; out="$out $p"; done
[ -n "$out" ] || exit 1
exec "$KILL" $sig $out
`
const SCRIPTS = {
  kill: KILL,
  pkill: MATCH('pkill', 'pgrep "$@"'),
  killall: MATCH('killall', 'for n in "$@"; do case "$n" in -*) ;; *) pgrep -x "$n";; esac; done'),
}

let made = null
// The environment and the command, guarded: { env, command }. Nothing changes on Windows.
export function guarded(command, env = process.env) {
  if (WIN) return { env, command }
  try {
    made ??= (() => {
      const stamp = path.join(DIR, `.v${VERSION}`)
      if (!fs.existsSync(stamp)) {
        fs.mkdirSync(DIR, { recursive: true })
        for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(DIR, name), text, { mode: 0o755 })
        fs.writeFileSync(path.join(DIR, 'env.sh'), `kill() { "${DIR}/kill" "$@"; }\n`)
        // zsh reads $ZDOTDIR/.zshenv first, always: the function, then back to your own startup files
        fs.writeFileSync(path.join(DIR, '.zshenv'), `kill() { "${DIR}/kill" "$@"; }\nunset ZDOTDIR\n[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\n`)
        fs.writeFileSync(stamp, '')
      }
      return protectedPids().join(' ')
    })()
  } catch {
    return { env, command }
  }
  const fn = `() {  "${DIR}/kill" "$@"; }` // the shell's own kill in shells it starts too (bash: exported functions, both formats; BASH_ENV)
  return {
    env: { ...env, PATH: `${DIR}${path.delimiter}${env.PATH ?? ''}`, HEART_PIDS: made, 'BASH_FUNC_kill%%': fn, 'BASH_FUNC_kill()': fn, BASH_ENV: path.join(DIR, 'env.sh'), ENV: path.join(DIR, 'env.sh'), ZDOTDIR: DIR },
    command: `kill() { "${DIR}/kill" "$@"; }\n${command}`, // the shell's own kill, too
  }
}
