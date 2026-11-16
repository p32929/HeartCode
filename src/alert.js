// Notifications on this computer: a sound and/or a desktop notification when a task finishes,
// fails, or waits for an answer. Off until switched on (settings: Notifications;
// cfg.alerts: { sound, popup, events: { done, failed, waiting } }). The interactive CLI only: a
// caller of -p has its own. HeartCode's own sound, a heartbeat made here (no sound files shipped):
// "lub-dub" rising when done, falling when it failed, twice when it waits for you.
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './config.js'
import { log } from './log.js'
import { onPath, spawnCmd } from './spawn.js'

const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'

// beats: [Hz, ms, pause after in ms]
const BEATS = {
  done: [[220, 120, 90], [262, 160, 0]],
  failed: [[196, 140, 100], [147, 220, 0]],
  waiting: [[220, 100, 70], [262, 130, 260], [220, 100, 70], [262, 130, 0]],
}

// A beat: a low thump (a quick attack, a slight fall in pitch, a fast fade) with two overtones, so
// laptop speakers play it too. 16-bit mono WAV.
export function heartbeat(beats, rate = 22050) {
  const parts = []
  for (const [f, ms, pause] of beats) {
    const n = Math.round((rate * ms) / 1000)
    let phase = 0
    for (let i = 0; i < n; i++) {
      const t = i / n
      phase += (2 * Math.PI * f * (1 - 0.15 * t)) / rate
      const env = Math.min(1, i / (rate * 0.005)) * Math.exp(-5 * t)
      parts.push(env * 0.55 * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)) / 1.75)
    }
    for (let i = 0; i < Math.round((rate * pause) / 1000); i++) parts.push(0)
  }
  const b = Buffer.alloc(44 + parts.length * 2)
  b.write('RIFF', 0), b.writeUInt32LE(36 + parts.length * 2, 4), b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16), b.writeUInt16LE(1, 20), b.writeUInt16LE(1, 22), b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28), b.writeUInt16LE(2, 32), b.writeUInt16LE(16, 34)
  b.write('data', 36), b.writeUInt32LE(parts.length * 2, 40)
  parts.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), 44 + i * 2))
  return b
}

function soundFile(event) {
  const file = path.join(HOME, 'sounds', `heartbeat-${event}-1.wav`) // -1: made again if the sound changes
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, heartbeat(BEATS[event] ?? BEATS.done))
  }
  return file
}

// started and left: never waited on
const start = (cmd, args, env) => {
  const p = spawnCmd(cmd, args, { stdio: 'ignore', detached: !WIN, windowsHide: true, env: { ...process.env, ...env } })
  p.on('error', (e) => log('alert', `${cmd}: ${e.message}`))
  p.unref()
}

export function playSound(event) {
  const file = soundFile(event)
  if (MAC) return start('afplay', [file])
  if (WIN) return start('powershell', ['-NoProfile', '-Command', '(New-Object Media.SoundPlayer $env:HC_SOUND).PlaySync()'], { HC_SOUND: file })
  const player = ['paplay', 'pw-play', 'aplay'].find((p) => onPath(p))
  if (player) start(player, player === 'aplay' ? ['-q', file] : [file])
  else log('alert', 'no sound player found (paplay, pw-play or aplay)')
}

// title and text go as arguments or the environment, never into a script's source
export function showPopup(title, text) {
  text = String(text).slice(0, 240)
  if (MAC) return start('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text])
  if (WIN) return start('powershell', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(6000, $env:HC_TITLE, $env:HC_TEXT, 'None'); Start-Sleep 7; $n.Dispose()"], { HC_TITLE: title, HC_TEXT: text })
  if (onPath('notify-send')) start('notify-send', ['-a', 'HeartCode', title, text])
  else log('alert', 'no notify-send: no desktop notification')
}

export const ALERT_EVENTS = ['done', 'failed', 'waiting']
const TITLES = { done: 'HeartCode: done', failed: 'HeartCode: failed', waiting: 'HeartCode is waiting for you' }

// An event, if switched on: never waits, never throws
export function alert(cfg, event, text) {
  const a = cfg?.alerts
  if (!a || (!a.sound && !a.popup) || a.events?.[event] === false) return
  try {
    if (a.sound) playSound(event)
    if (a.popup) showPopup(TITLES[event] ?? 'HeartCode', String(text).replace(/^\S+ /, '').split('\n').filter((l) => l.trim()).slice(0, 2).join(' — '))
  } catch (e) {
    log('alert', `${event}: ${e.message}`)
  }
}
