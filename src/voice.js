// Voice input: /voice, then Space to talk (and again to pause), Enter to finish, Esc to
// cancel. What's said shows in the input box as it's said, and stays there to read over and send.
// Recording: ffmpeg (macOS: the default microphone; Linux: PulseAudio, else ALSA). Speech to text,
// one of three ("voice": { "engine": … } in config.json; none set: Hex when it's ready, else whisper-cli):
//   - hex: the Hex app's `hex transcribe` (its Labs › Transcribe files on), with your Hex dictation
//     model ("model": an id from `hex model list`); on this computer, fast;
//   - whisper: whisper.cpp's whisper-cli and a model already on disk (~/.whisper-models,
//     ~/.heart/whisper, or "model": "/path/ggml-….bin"); nothing is downloaded;
//   - openai: OpenAI's /audio/transcriptions, with your OpenAI provider's key ("model": whisper-1 or
//     gpt-4o-transcribe); only when chosen (it's paid).
// "language": "bn", "auto"… for languages other than English.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { HOME } from './config.js'
import { runCommand } from './tools.js'
import { onPath } from './spawn.js'
import { log } from './log.js'
import { fetch } from './http.js' // not the built-in one: see http.js


// A whisper.cpp model already on disk: the configured one, else the best found (small > base > tiny).
// fast: the quickest found instead (tiny > base > small), for the words shown while you speak.
export function localModel(cfg = {}, { fast = false } = {}) {
  if (cfg.model && fs.existsSync(cfg.model) && !fast) return cfg.model
  const found = [path.join(os.homedir(), '.whisper-models'), path.join(HOME, 'whisper')].flatMap((d) => {
    try {
      return fs.readdirSync(d).filter((f) => /^ggml-.*\.bin$/.test(f)).map((f) => path.join(d, f))
    } catch {
      return []
    }
  })
  const order = fast ? ['tiny', 'base', 'small', 'medium', 'large'] : ['large', 'medium', 'small', 'base', 'tiny']
  const rank = (f) => order.findIndex((s) => path.basename(f).includes(s))
  return found.sort((a, b) => (rank(a) === -1 ? 9 : rank(a)) - (rank(b) === -1 ? 9 : rank(b)))[0] ?? (fast ? localModel(cfg) : null)
}

// How to install a program here: the usual package manager of this OS
const install = (mac, win, linux) => (process.platform === 'darwin' ? `brew install ${mac}` : process.platform === 'win32' ? `winget install ${win}` : linux)

// The microphone, as ffmpeg's input: the default device (macOS, PulseAudio/PipeWire on Linux); on
// Windows DirectShow needs a device's name, so the first microphone ffmpeg lists (kept once found)
let winMic
function micInput() {
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-i', ':default']
  if (process.platform !== 'win32') return ['-f', 'pulse', '-i', 'default']
  winMic ??= /"([^"]+)"\s*\(audio\)/.exec(spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' }).stderr ?? '')?.[1] ?? ''
  return ['-f', 'dshow', '-i', `audio=${winMic || 'default'}`]
}

// Hex's command: on the PATH, else inside the app (macOS)
const HEX_APP = '/Applications/Hex.app/Contents/MacOS/hex'
export const hexPath = () => onPath('hex') || (process.platform === 'darwin' && fs.existsSync(HEX_APP) ? HEX_APP : '')
// Hex can transcribe a file: its Labs › Transcribe files is on (asked again after a while when it was off)
let hexOn = { ok: false, at: 0 }
export function hexReady() {
  const hex = hexPath()
  if (!hex) return false
  if (!hexOn.ok && Date.now() - hexOn.at > 30_000) hexOn = { ok: /^transcribe-files\s+on\b/m.test(spawnSync(hex, ['labs', 'list'], { encoding: 'utf8', timeout: 5000 }).stdout ?? ''), at: Date.now() }
  return hexOn.ok
}
// your provider that is OpenAI's own API (its key), the one named first
const isOpenAI = (p) => {
  try {
    return /(^|\.)openai\.com$/.test(new URL(p?.baseUrl).hostname)
  } catch {
    return false
  }
}
const openaiOf = (cfg, providers) => (isOpenAI(providers[cfg.provider]) ? cfg.provider : Object.keys(providers).find((n) => isOpenAI(providers[n])))
export const ENGINES = ['hex', 'whisper', 'openai']
// the engine in use: the one chosen; else Hex when it can, else whisper-cli
export function engineOf(cfg = {}, providers = {}) {
  if (ENGINES.includes(cfg.engine)) return cfg.engine
  if (cfg.provider && openaiOf(cfg, providers)) return 'openai' // set before engines: an OpenAI provider
  return hexReady() ? 'hex' : 'whisper'
}

// Why voice can't work here, or null when it can.
export function voiceProblem(cfg = {}, providers = {}) {
  if (!onPath('ffmpeg')) return `voice input needs ffmpeg to record (${install('ffmpeg', 'ffmpeg', 'install ffmpeg with your package manager')})`
  const engine = engineOf(cfg, providers)
  if (engine === 'hex') return !hexPath() ? 'voice with Hex: Hex isn\'t installed here' : hexReady() ? null : 'voice with Hex needs its Labs › Transcribe files: run hex labs on transcribe-files'
  if (engine === 'openai') return openaiOf(cfg, providers) ? null : 'voice with OpenAI needs an OpenAI provider (api.openai.com, with its key): add it on /settings → Providers'
  if (!onPath('whisper-cli')) return `voice input needs whisper-cli (${process.platform === 'darwin' ? 'brew install whisper-cpp' : 'whisper.cpp, from github.com/ggml-org/whisper.cpp'}) and a model, or Hex (its Labs › Transcribe files on)`
  return localModel(cfg) ? null : 'voice input needs a whisper model: put a ggml-*.bin in ~/.whisper-models, or set "voice": { "model": "/path/to/ggml-….bin" }'
}

const RATE = 16000 // 16 kHz mono, 16-bit: what whisper wants

// Starts listening: the sound comes into memory as it's recorded. Returns { pcm() → what's been
// said so far (raw), seconds(), stop() → all of it, cancel() }.
export function listen() {
  // HEART_VOICE_FILE: a sound file played in at its own speed instead of the microphone (tests)
  const input = process.env.HEART_VOICE_FILE ? ['-re', '-i', process.env.HEART_VOICE_FILE] : micInput()
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const chunks = []
  let size = 0
  let err = ''
  child.stdout.on('data', (d) => (chunks.push(d), (size += d.length)))
  child.stderr.on('data', (d) => (err += d))
  child.stdin.on('error', () => {})
  // what's been said so far, in one piece (the pieces joined once, then kept joined)
  const pcm = () => {
    if (chunks.length > 1) chunks.splice(0, chunks.length, Buffer.concat(chunks))
    return chunks[0] ?? Buffer.alloc(0)
  }
  const ended = new Promise((resolve) => child.once('exit', resolve))
  return {
    pcm,
    seconds: () => size / (RATE * 2),
    async stop() {
      child.stdin.end('q') // ffmpeg stops on "q"
      const t = setTimeout(() => child.kill('SIGKILL'), 2000)
      await ended
      clearTimeout(t)
      if (size < RATE * 2 * 0.3) throw new Error(`nothing was recorded${err.trim() ? `: ${err.trim().split('\n').pop()}` : ' (does the terminal have microphone access? System Settings › Privacy & Security › Microphone)'}`)
      return pcm()
    },
    cancel() {
      child.kill('SIGKILL')
    },
  }
}

// Raw 16 kHz mono 16-bit sound as a WAV file's bytes.
export function wavOf(pcm) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

// The words in some raw sound (fast: the quickest model, for what's shown while you speak).
export async function transcribePcm(pcm, cfg = {}, providers = {}, { fast = false, signal } = {}) {
  const file = path.join(os.tmpdir(), `heartcode-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
  fs.writeFileSync(file, wavOf(pcm))
  const quick = fast && engineOf(cfg, providers) === 'whisper' // whisper: the quickest model while you speak
  return transcribe(file, quick ? { ...cfg, model: localModel(cfg, { fast: true }) } : cfg, providers, signal)
}

// Starts recording to a 16 kHz mono WAV. Returns { stop() → the file, cancel() }.
export function record() {
  const file = path.join(os.tmpdir(), `heartcode-voice-${process.pid}-${Date.now()}.wav`)
  const input = micInput()
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
    const engine = engineOf(cfg, providers)
    if (engine === 'hex') {
      const args = ['transcribe', '--json', ...(cfg.model ? ['--model', String(cfg.model)] : []), ...(cfg.language && cfg.language !== 'auto' ? ['--language', String(cfg.language)] : []), file]
      const q = (a) => `'${String(a).replace(/'/g, "'\\''")}'`
      const { code, output, stderr } = await runCommand(os.tmpdir(), [hexPath(), ...args].map(q).join(' '), { signal, timeout: 120_000, split: true })
      log('voice', `hex transcribe → exit ${code}`, output.slice(0, 2000))
      let said
      try {
        said = JSON.parse(output)
      } catch {}
      if (code !== 0 || !said || said.status === 'error') throw new Error(`Hex couldn't transcribe it: ${(said?.message ?? stderr ?? output).trim().split('\n').pop()}`)
      return clean(said.text)
    }
    if (engine === 'openai') {
      const name = openaiOf(cfg, providers)
      if (!name) throw new Error(voiceProblem(cfg, providers) ?? 'no OpenAI provider')
      const p = providers[name]
      const form = new FormData()
      form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'speech.wav')
      form.append('model', cfg.model ?? 'whisper-1')
      if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language)
      const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', body: form, headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, signal })
      if (!res.ok) throw new Error(`${name} said ${res.status}: ${(await res.text()).slice(0, 200)}`)
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
