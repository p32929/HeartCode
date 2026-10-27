// Voice input: Ctrl+R (or /voice) records from the microphone; Enter or Ctrl+R again stops, Esc
// cancels; the words go into the input box, to read over and send.
// Recording: ffmpeg (macOS: the default microphone; Linux: PulseAudio, else ALSA). Speech to text:
//   - on this machine with whisper.cpp's whisper-cli and a model already on disk (~/.whisper-models,
//     ~/.heart/whisper, or "voice": { "model": "/path/ggml-….bin" } in config.json); nothing is
//     downloaded;
//   - or a provider's OpenAI-compatible /audio/transcriptions: "voice": { "provider": "groq",
//     "model": "whisper-large-v3" }.
// "voice": { "language": "auto" } for languages other than English (with a multilingual model).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { HOME } from './config.js'
import { runCommand } from './tools.js'
import { log } from './log.js'

const onPath = (cmd) => (process.env.PATH ?? '').split(path.delimiter).find((d) => d && fs.existsSync(path.join(d, cmd)))

// A whisper.cpp model already on disk: the configured one, else the best found (small > base > tiny).
export function localModel(cfg = {}) {
  if (cfg.model && fs.existsSync(cfg.model)) return cfg.model
  const found = [path.join(os.homedir(), '.whisper-models'), path.join(HOME, 'whisper')].flatMap((d) => {
    try {
      return fs.readdirSync(d).filter((f) => /^ggml-.*\.bin$/.test(f)).map((f) => path.join(d, f))
    } catch {
      return []
    }
  })
  const rank = (f) => ['large', 'medium', 'small', 'base', 'tiny'].findIndex((s) => path.basename(f).includes(s))
  return found.sort((a, b) => (rank(a) === -1 ? 9 : rank(a)) - (rank(b) === -1 ? 9 : rank(b)))[0] ?? null
}

// Why voice can't work here, or null when it can.
export function voiceProblem(cfg = {}, providers = {}) {
  if (!onPath('ffmpeg')) return 'voice input needs ffmpeg to record (brew install ffmpeg)'
  if (cfg.provider) return providers[cfg.provider] ? null : `voice.provider "${cfg.provider}" isn't one of your providers`
  if (!onPath('whisper-cli')) return 'voice input needs whisper-cli (brew install whisper-cpp) and a model, or "voice": { "provider": …, "model": … } in ~/.heart/config.json'
  return localModel(cfg) ? null : 'voice input needs a whisper model: put a ggml-*.bin in ~/.whisper-models, or set "voice": { "model": "/path/to/ggml-….bin" }'
}

// Starts recording to a 16 kHz mono WAV. Returns { stop() → the file, cancel() }.
export function record() {
  const file = path.join(os.tmpdir(), `heartcode-voice-${process.pid}-${Date.now()}.wav`)
  const input = process.platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':default'] : ['-f', 'pulse', '-i', 'default']
  const start = (inp) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inp, '-ac', '1', '-ar', '16000', file], { stdio: ['pipe', 'ignore', 'pipe'] })
  let child = start(input)
  let err = ''
  child.stderr.on('data', (d) => (err += d))
  child.stdin.on('error', () => {})
  const ended = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', resolve)
    })
  return {
    async stop() {
      child.stdin.end('q') // ffmpeg finishes the file on "q"
      const t = setTimeout(() => child.kill('SIGINT'), 3000)
      await ended()
      clearTimeout(t)
      if (!fs.existsSync(file) || fs.statSync(file).size < 2000) throw new Error(`nothing was recorded${err.trim() ? `: ${err.trim().split('\n').pop()}` : ' (does the terminal have microphone access? System Settings › Privacy & Security › Microphone)'}`)
      return file
    },
    cancel() {
      child.kill('SIGKILL')
      fs.rmSync(file, { force: true })
    },
  }
}

// The words in the recording (and the file is deleted).
export async function transcribe(file, cfg = {}, providers = {}, signal) {
  try {
    if (cfg.provider) {
      const p = providers[cfg.provider]
      const form = new FormData()
      form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'speech.wav')
      form.append('model', cfg.model ?? 'whisper-1')
      if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language)
      const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', body: form, headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, signal })
      if (!res.ok) throw new Error(`${cfg.provider} said ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return clean((await res.json()).text)
    }
    const model = localModel(cfg)
    const { code, output, stderr } = await runCommand(os.tmpdir(), `whisper-cli -m '${model}' -f '${file}' -nt -np -l ${cfg.language ?? 'en'} -t ${Math.max(2, Math.min(8, os.cpus().length))}`, { signal, timeout: 120_000, split: true }) // its log goes to stderr
    log('voice', `whisper-cli → exit ${code}`, output.slice(0, 2000))
    if (code !== 0) throw new Error(`whisper-cli failed: ${(stderr || output).trim().split('\n').pop()}`)
    return clean(output)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

// One line of text: whisper's line breaks joined, and what it writes for sounds that aren't words
// dropped: [BLANK_AUDIO], [Music], (wind blowing), (speaking foreign language)…
export const clean = (t) => String(t ?? '').replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
