import readline from 'node:readline'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { log } from './log.js'
import { HOME } from './config.js'
import { record, transcribe, voiceProblem } from './voice.js'

const color = (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR
// 24-bit where the terminal says so, else the nearest of 256 (Terminal.app, xterm-256color), else 16.
const depth = !color ? 0 : /truecolor|24bit/i.test(process.env.COLORTERM ?? '') ? 3 : /256/.test(process.env.TERM ?? '') || process.env.TERM_PROGRAM === 'Apple_Terminal' ? 2 : 1
const to256 = ([r, g, b]) => {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) return r < 8 ? 16 : r > 238 ? 231 : 232 + Math.round(((r - 8) / 247) * 23)
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
// Each style switches itself off with its own code (not a full reset), so styles nest.
const sgr = (on, off) => (s) => (color ? `\x1b[${on}m${s}\x1b[${off}m` : String(s))
const fg = (hex, basic) => sgr(depth === 3 ? `38;2;${rgb(hex).join(';')}` : depth === 2 ? `38;5;${to256(rgb(hex))}` : basic, 39)
const bg = (hex, basic) => sgr(depth === 3 ? `48;2;${rgb(hex).join(';')}` : depth === 2 ? `48;5;${to256(rgb(hex))}` : basic, 49)

// Themes: a color per kind of thing, and four shades of white/grey for importance (the number is
// the 16-color fallback), and the background (none: the terminal's own). The settings page picks one;
// ~/.heart/theme.json changes any color on top of it: { "brand": "#ff6b9d", "background": "#101014" }
export const THEMES = {
  dark: {
    background: [null],
    bright: ['#f5f5f7', 97], // what the user typed, things to read first
    text: ['#d4d4d8', 39], // the model's answer
    muted: ['#9aa0aa', 37], // secondary: labels, descriptions, the spinner
    faint: ['#6b7280', 90], // hints, tool results, line numbers
    ghost: ['#3f4451', 90], // rules and borders
    brand: ['#ff6b9d', 35], // HeartCode's ♥, the selection marker
    accent: ['#7aa2f7', 34], // tool steps, headings
    info: ['#7dcfff', 36], // file paths, model names
    think: ['#a8a29e', 37], // the model's thinking
    ok: ['#9ece6a', 32],
    warn: ['#e0af68', 33],
    err: ['#f7768e', 31],
    select: ['#2a2f3a', 47], // the highlighted row in menus and pickers (a background)
  },
  light: {
    background: ['#fafbfc', 107],
    bright: ['#1f2328', 30],
    text: ['#24292f', 39],
    muted: ['#57606a', 90],
    faint: ['#6e7781', 90],
    ghost: ['#c8ced6', 37],
    brand: ['#d6336c', 35],
    accent: ['#0969da', 34],
    info: ['#0b6e8a', 36],
    think: ['#6e7781', 90],
    ok: ['#1a7f37', 32],
    warn: ['#9a6700', 33],
    err: ['#cf222e', 31],
    select: ['#dbe4f0', 47],
  },
  midnight: {
    background: ['#1a1b26', 40],
    bright: ['#e6e9f5', 97],
    text: ['#c0caf5', 39],
    muted: ['#9aa5ce', 37],
    faint: ['#636d96', 90],
    ghost: ['#343a55', 90],
    brand: ['#ff7ab2', 35],
    accent: ['#7aa2f7', 34],
    info: ['#7dcfff', 36],
    think: ['#a9b1d6', 37],
    ok: ['#9ece6a', 32],
    warn: ['#e0af68', 33],
    err: ['#f7768e', 31],
    select: ['#2f3549', 47],
  },
  mono: Object.fromEntries(['bright', 'text', 'muted', 'faint', 'ghost', 'brand', 'accent', 'info', 'think', 'ok', 'warn', 'err', 'select'].map((k) => [k, [null, { bright: 1, faint: 2, ghost: 2, select: 7 }[k] ?? 39]])), // no colors, just bold and dim
}
export const c = { bold: sgr(1, 22), italic: sgr(3, 23) }
export let background = '' // the theme's background, as an escape sequence ('' = the terminal's)
// Each palette color's opening sequence, to recolor what's already on screen (UI.recolor).
export const themeCodes = () => Object.fromEntries(Object.keys(THEMES.dark).filter((k) => k !== 'background').map((k) => [k, c[k]('\0').split('\0')[0]]))
export function setTheme(name = 'dark') {
  const own = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(HOME, 'theme.json'), 'utf8'))
    } catch {
      return {}
    }
  })()
  const t = { ...(THEMES[name] ?? THEMES.dark) }
  for (const [k, v] of Object.entries(own)) if (t[k] && /^#[0-9a-f]{6}$/i.test(v)) t[k] = [v, t[k][1]]
  const [bgHex, bgBasic] = t.background ?? [null]
  delete t.background
  background = color && bgHex ? bg(bgHex, bgBasic)('\0').split('\0')[0] : ''
  for (const [k, [hex, basic]] of Object.entries(t)) {
    if (!hex) c[k] = k === 'select' ? sgr(7, 27) : basic === 1 ? sgr(1, 22) : basic === 2 ? sgr(2, 22) : (s) => String(s)
    else c[k] = (k === 'select' ? bg : fg)(hex, basic)
  }
  // Older names, used across the code base, mapped onto the palette.
  Object.assign(c, { dim: c.muted, cyan: c.info, magenta: c.brand, green: c.ok, red: c.err, yellow: c.warn, blue: c.accent })
  return THEMES[name] ? name : 'dark'
}
setTheme()

// keybindings.json: { "ctrl+o": "cycle_permissions", "ctrl+g": "/toggle_thinking", "shift+tab": "none" }.
// Actions: stop, cycle_permissions, newline, clear_input, scroll_up, scroll_down, voice, new_tab,
// close_tab, next_tab, prev_tab, tab_1…tab_9, none (turns a
// built-in key off); anything else is sent as typed (a /command or a message). Ctrl+C stays Ctrl+C.
export const keyId = (key, s = '') => [key.ctrl && 'ctrl', key.meta && 'alt', key.shift && 'shift', key.name ?? s].filter(Boolean).join('+').toLowerCase()
// Ctrl+R records; Ctrl+T, Ctrl+Q, Ctrl+N/P (or Ctrl+PgDn/PgUp), Alt+1…9: tabs. keybindings.json can move them.
export const DEFAULT_KEYS = { 'ctrl+r': 'voice', 'ctrl+t': 'new_tab', 'ctrl+q': 'close_tab', 'ctrl+n': 'next_tab', 'ctrl+p': 'prev_tab', 'ctrl+pagedown': 'next_tab', 'ctrl+pageup': 'prev_tab', ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`alt+${n}`, `tab_${n}`])) }
export function loadKeys(file = path.join(HOME, 'keybindings.json')) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') log('keys', `${file}: ${e.message}`)
  }
  // "Ctrl+P", "ctrl-p", "esc" → "ctrl+p", "escape"
  return Object.fromEntries(Object.entries(raw.bindings ?? raw).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, '').replace(/-(?=.)/g, '+').replace(/\besc\b/, 'escape').replace(/\b(option|meta|cmd)\b/, 'alt').replace(/\benter\b/, 'return'), v.trim()]))
}

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Emoji_Presentation}/u // ♥ © etc. are 1 cell; 😀 is 2

// "503 from https://…: {"error":{"message":"overloaded"}}" → "503 overloaded"
export function shortError(err) {
  if (!err.status) return err.message.replace(/\s+/g, ' ').slice(0, 120)
  const body = err.message.slice(err.message.indexOf(': ') + 2)
  let said = body
  try {
    const j = JSON.parse(body)
    said = j.error?.message ?? j.message ?? (typeof j.error === 'string' ? j.error : body)
  } catch {}
  return `${err.status} ${String(said).replace(/\s+/g, ' ')}`.trim().slice(0, 120)
}

// Terminals speaking the kitty keyboard protocol (HeartCode turns it on) or xterm's modifyOtherKeys
// report keys as CSI sequences that readline doesn't know. Back to the legacy bytes, except that
// Enter with any modifier (Shift, Ctrl, Alt, Cmd) becomes "\n": a new line in the input.
export function legacyKeys(text) {
  return text.replace(/\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)*)?u|\x1b\[27;(\d+);(\d+)~/g, (m, k1, m1, m2, k2) => {
    const code = Number(k1 ?? k2)
    const mods = Number(m1 ?? m2 ?? 1) - 1 // shift 1, alt 2, ctrl 4, super 8
    const [shift, alt, ctrl] = [mods & 1, mods & 2, mods & 4]
    if (code === 13) return mods ? '\n' : '\r'
    if (code === 9) return shift ? '\x1b[Z' : '\t'
    if (code === 27) return '\x1b'
    if (code === 127 || code === 8) return (alt ? '\x1b' : '') + (ctrl ? '\x17' : '\x7f')
    if (code < 32 || (code >= 0xe000 && code <= 0xf8ff) || code > 0x10ffff) return '' // keypad, F13+, …
    let ch = String.fromCodePoint(code)
    if (ctrl && /^[a-z@[\\\]^_ ]$/i.test(ch)) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f)
    else if (shift) ch = ch.toUpperCase()
    return (alt ? '\x1b' : '') + ch
  })
}

// The terminal's input, passed through legacyKeys (holding back a sequence split across reads).
function keyStream(input) {
  const proxy = new PassThrough()
  proxy.isTTY = true
  proxy.setRawMode = (on) => input.setRawMode?.(on)
  proxy.on('pause', () => input.pause())
  proxy.on('resume', () => input.resume())
  const dec = new StringDecoder('utf8')
  let held = ''
  let timer
  const send = (text) => text && proxy.write(legacyKeys(text))
  // bound to where it was made: a tab's keys are logged in that tab's log (src/log.js)
  input.on('data', AsyncLocalStorage.bind((d) => {
    clearTimeout(timer)
    let text = held + dec.write(d)
    const part = /\x1b\[[0-9;:]*$/.exec(text)
    held = part ? part[0] : ''
    if (part) {
      text = text.slice(0, part.index)
      timer = setTimeout(() => send(held, (held = '')), 50)
    }
    send(text)
  }))
  input.on('end', () => proxy.end())
  return proxy
}

// Where each character of the input goes on screen: rows of at most `cols` cells, the prompt
// first, later lines indented under it. Returns the rows (with the prompt's colors) and the
// cursor's row and column.
function layoutInput(prompt, line, cursor, cols) {
  const pw = width(prompt.replace(/\x1b\[[0-9;]*m/g, ''))
  const rows = [{ text: prompt, w: pw }]
  let cur = { row: 0, col: pw }
  const pad = ' '.repeat(Math.min(pw, cols - 1))
  for (let i = 0; i <= line.length; i++) {
    if (i === cursor) cur = { row: rows.length - 1, col: rows.at(-1).w }
    if (i === line.length) break
    const ch = String.fromCodePoint(line.codePointAt(i))
    if (ch.length === 2) i++
    if (ch === '\n') {
      rows.push({ text: pad, w: pad.length })
      continue
    }
    const shown = ch === '\t' ? '    ' : ch
    const w = width(shown)
    if (rows.at(-1).w + w > cols) rows.push({ text: '', w: 0 })
    rows.at(-1).text += shown
    rows.at(-1).w += w
  }
  if (cur.col >= cols) cur = { row: cur.row + 1, col: 0 }
  return { rows: rows.map((r) => r.text), cur }
}

export const width = (str) => {
  let w = 0
  for (const ch of str) w += WIDE.test(ch) ? 2 : 1
  return w
}

// The styles a piece of text leaves switched on: { fg, bg, bold, italic } (each a code or '').
function sgrState(state = {}, text) {
  const st = { ...state }
  for (const [, params] of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const n = params.split(';')
    for (let i = 0; i < n.length; i++) {
      const v = Number(n[i] || 0)
      if (v === 0) Object.assign(st, { fg: '', bg: '', bold: '', italic: '' })
      else if (v === 38 || v === 48) {
        const len = n[i + 1] === '2' ? 5 : 3
        st[v === 38 ? 'fg' : 'bg'] = n.slice(i, i + len).join(';')
        i += len - 1
      } else if (v === 39) st.fg = ''
      else if (v === 49) st.bg = ''
      else if (v === 1) st.bold = '1'
      else if (v === 22) st.bold = ''
      else if (v === 3) st.italic = '3'
      else if (v === 23) st.italic = ''
      else if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) st.fg = String(v)
    }
  }
  return st
}
const sgrPrefix = (st = {}) => [st.fg, st.bg, st.bold, st.italic].filter(Boolean).map((x) => `\x1b[${x}m`).join('')

// Cuts a colored line to `cols` cells.
function fit(line, cols) {
  return wrapAnsi(line, cols)[0]
}

// The picker's rows for a filter: matching items under their group headers.
function pickView(items, filter) {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = []
  let group
  for (const it of items) {
    const text = `${it.group ?? ''} ${it.label} ${it.desc ?? ''}`.toLowerCase()
    if (!words.every((w) => text.includes(w))) continue
    if (it.group && it.group !== group) rows.push({ header: true, value: (group = it.group) })
    rows.push({ value: it.checked === undefined ? it.label : `${it.checked ? '◉' : '○'} ${it.label}`, desc: it.desc, item: it })
  }
  return rows
}

// Splits one line into screen rows of at most `cols` cells, keeping colors across the breaks.
export function wrapAnsi(line, cols) {
  const rows = []
  let row = ''
  let width = 0
  let style = ''
  const sgr = /\x1b\[[0-9;]*m/y // any length: 24-bit colors are ~19 characters
  for (let i = 0; i < line.length; ) {
    sgr.lastIndex = i
    const esc = sgr.exec(line)
    if (esc) {
      row += esc[0]
      style = esc[0] === '\x1b[0m' ? '' : style + esc[0]
      i += esc[0].length
      continue
    }
    const ch = String.fromCodePoint(line.codePointAt(i))
    const w = WIDE.test(ch) ? 2 : ch === '\t' ? 4 : 1
    if (width + w > cols) {
      rows.push(row + (style ? '\x1b[0m' : ''))
      row = style
      width = 0
    }
    row += ch === '\t' ? '    ' : ch
    width += w
    i += ch.length
  }
  rows.push(row)
  return rows
}

// Streams text as an indented, word-wrapped block: "<marker>first line\n  next line".
// Leading/trailing blank lines are dropped; runs of blank lines collapse to one.
export class Block {
  constructor(write, { marker = '  ', markerStyle = (x) => x, style = (x) => x, width = (process.stdout.columns || 100) - 1 } = {}) {
    Object.assign(this, { write, marker, markerStyle, style, width: Math.max(20, width) })
    this.indent = ' '.repeat(marker.length)
    this.col = 0
    this.started = false
    this.newlines = 0
  }
  push(text) {
    let out = ''
    for (const ch of text) {
      if (ch === '\r') continue
      if (ch === '\n') {
        if (this.started) this.newlines++
        continue
      }
      if (!this.started) {
        if (ch === ' ' || ch === '\t') continue
        this.write(this.markerStyle(this.marker))
        this.col = this.marker.length
        this.started = true
      } else if (this.newlines) {
        out += '\n'.repeat(Math.min(this.newlines, 2)) + this.indent
        this.col = this.indent.length
        this.newlines = 0
      } else if (this.col >= this.width || (ch === ' ' && this.col >= this.width - 12)) {
        out += '\n' + this.indent
        this.col = this.indent.length
        if (ch === ' ') continue
      }
      out += ch
      this.col++
    }
    if (out) this.write(this.style(out))
  }
  end() {
    if (this.started && !this.ended) this.write('\n')
    this.ended = true
  }
}

const MENU_ROWS = 8
const INPUT_ROWS = 3 // the input box shows at most this many rows; the rules say what's hidden

// Best matches first: the exact name, then names starting with it, then a word of the name
// starting with it (/mcp → /login_mcp), then anywhere in it, then starts of its words in order
// (/sm or /semo → /select_model). A leading "/" doesn't count.
export function rank(items, typed, key = (x) => x.value) {
  const t = typed.toLowerCase().replace(/^\//, '')
  // t split into prefixes of the words, in order (words may be skipped)
  const initials = (words, t) => !t || words.some((w, i) => [...Array(Math.min(w.length, t.length))].some((_, n) => w.startsWith(t.slice(0, n + 1)) && initials(words.slice(i + 1), t.slice(n + 1))))
  const score = (x) => {
    const k = key(x).toLowerCase().replace(/^\//, '')
    const words = k.split(/[_\-./\s:]+/).filter(Boolean)
    if (k === t) return 0
    if (k.startsWith(t)) return 1
    if (words.some((w) => w.startsWith(t))) return 2
    if (k.includes(t)) return 3
    return t.length > 1 && words.length > 1 && initials(words, t) ? 4 : -1
  }
  return items
    .map((x, i) => ({ x, i, s: score(x) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i) // same score: keep the list's order
    .map((r) => r.x)
}

// What runs without asking. Shift+Tab cycles through them.
export const PERMISSIONS = [
  ['all', 'do everything without asking'],
  ['commands', 'apply edits; ask before running commands'],
  ['ask', 'ask before every edit and command'],
  ['plan', 'plan first: look around without changing anything, then approve the plan'],
]

export class UI {
  constructor({ yes = false, input = process.stdin, output = process.stdout } = {}) {
    this.permission = yes ? 'all' : 'ask' // see PERMISSIONS
    this.onPermission = null
    this.onEscape = null // Esc while a task runs // called when the user switches mode (Shift+Tab or "don't ask again")
    this.input = input
    this.out = output
    this.queue = []
    this.ahead = [] // messages typed (and sent with Enter) while HeartCode was working
    this.isCommand = (l) => l.startsWith('/') // the app's: only real commands (a path like /Users/… is a message)
    this.keys = { ...DEFAULT_KEYS, ...loadKeys() }
    this.waiters = []
    this.closed = false
    this.rl = null
    this.onInterrupt = null
    this.timer = null
    this.label = ''
    this.showThinking = true
    this.tail = ''
    // suggest(line, cursor) → [{ value, desc, start, end, space, insertOnly }] for the menu under the prompt
    this.suggest = null
    this.status = null // () → the status bar line (full screen only)
    this.header = null // (cols) → lines pinned to the top (full screen only)
    this.menu = { on: false, items: [], sel: 0, off: null }
    this.full = false
    this.log = [''] // full-screen transcript, one entry per line
    this.scroll = 0
    this.asking = false
    this.frame = 0
  }

  // One model reply: thinking (dim, its own block) kept apart from the answer.
  // who: the model thinking, named over its thinking (helpers say their own: helperUI in agent.js)
  response(who) {
    const t0 = Date.now()
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1)
    const write = (x) => this.write(x)
    let think = null
    let text = null
    let thought = false
    const summary = () => {
      if (thought && !this.showThinking) this.print(c.faint(c.italic(`✻ ${who ? `${who} ` : ''}thought for ${secs()}s`)))
    }
    return {
      think: (t) => {
        if (!t || text) return
        thought = true
        if (!this.showThinking) return this.spinner(`thinking · ${secs()}s`)
        if (!think) {
          this.gap()
          this.print(c.faint(c.italic(`✻ ${who ? `${who} is thinking` : 'Thinking'}…`)))
          think = new Block(write, { style: (x) => c.think(c.italic(x)) })
        }
        think.push(t)
      },
      text: (t) => {
        if (!t) return
        if (!text) {
          think?.end()
          this.gap()
          summary()
          text = new Block(write, { marker: '● ', markerStyle: (x) => c.bright(c.bold(x)), style: c.text })
        }
        text.push(t)
      },
      end: () => {
        if (text) text.end()
        else if (think) think.end()
        else summary()
        this.afterBlock = Boolean(text || think)
      },
    }
  }

  #rl() {
    if (this.rl) return this.rl
    const terminal = Boolean(this.input.isTTY && this.out.isTTY)
    const input = terminal ? keyStream(this.input) : this.input
    // escapeCodeTimeout: how long a lone Esc waits to be the start of a key's sequence. Readline's
    // 500ms made Esc Esc and a letter typed right after one Alt+letter: the letter was lost and the
    // input not cleared. Sequences come in one piece (and keyStream holds a split one for 50ms).
    this.rl = readline.createInterface({ input, output: this.out, terminal, historySize: 0, escapeCodeTimeout: 50 }) // HeartCode keeps its own history (below)
    // Our own line queue, so piped input isn't lost between questions.
    this.rl.on('line', (l) => {
      if (this.sent !== undefined) [l, this.sent] = [this.sent, undefined] // readline mangles multi-line text
      const w = this.waiters.shift()
      w ? w(l) : this.queue.push(l)
    })
    this.rl.on('close', () => {
      this.closed = true
      this.cancelAsk()
    })
    this.rl.on('SIGINT', () => (this.onInterrupt ? this.onInterrupt() : process.exit(130)))
    if (terminal) this.#keys(this.rl)
    return this.rl
  }

  // Full-screen mode: the alternate screen, the conversation on top, the input pinned to the
  // bottom row, the spinner and the suggestion menu just above the input. PgUp/PgDn scroll.
  fullscreen() {
    if (this.full || !(this.input.isTTY && this.out.isTTY)) return
    this.full = true
    // alternate screen · kitty keyboard protocol (Shift/Cmd+Enter are told apart) · bracketed paste
    this.out.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[>1u\x1b[?2004h')
    this.out.on('resize', () => this.render())
    this.#rl()
    process.on('exit', () => this.leaveFullscreen())
  }

  // Hands the terminal to another program (an editor) and takes it back afterwards.
  async outside(fn) {
    const wasFull = this.full
    if (wasFull) this.out.write('\x1b[?2004l\x1b[<u\x1b[?1049l')
    this.rl?.pause()
    this.input.setRawMode?.(false)
    try {
      return await fn()
    } finally {
      this.input.setRawMode?.(true)
      this.rl?.resume()
      if (wasFull) {
        this.out.write('\x1b[?1049h\x1b[>1u\x1b[?2004h')
        this.render()
      }
    }
  }

  // Back to the normal screen, leaving the conversation in the terminal's scrollback.
  leaveFullscreen() {
    if (!this.full) return
    this.full = false
    this.out.write('\x1b[?2004l\x1b[<u\x1b[?1049l' + this.log.join('\n').replace(/\n+$/, '') + '\n')
  }

  // After a theme change: what's on screen already, in the new colors (before/after: themeCodes()).
  recolor(before, after) {
    const swap = new Map(Object.keys(before).filter((k) => before[k] && before[k] !== after[k]).map((k) => [before[k], after[k]]))
    if (swap.size) {
      const re = new RegExp([...swap.keys()].map((x) => x.replace(/[[\]\\^$.|?*+()]/g, '\\$&')).join('|'), 'g')
      this.log = this.log.map((l) => l.replace(re, (m) => swap.get(m)))
      if (this.rl) this.rl.setPrompt(this.rl._prompt.replace(re, (m) => swap.get(m))) // the input's ♥, while it waits
      if (this.mainPrompt) this.mainPrompt = this.mainPrompt.replace(re, (m) => swap.get(m)) // and while it works
      this.wrapped = []
    }
    this.render()
  }

  // Replaces the conversation on screen (resuming or rewinding a session).
  setLog(lines) {
    this.log = lines?.length ? [...lines] : ['']
    if (this.log.at(-1) !== '') this.log.push('')
    this.wrapped = []
    this.scroll = 0
    this.tail = '\n\n'
    this.render()
  }

  // Wipes the conversation off the screen (full screen) or the terminal.
  clear() {
    this.tail = ''
    if (!this.full) return this.out.isTTY && this.out.write('\x1b[2J\x1b[3J\x1b[H')
    this.log = ['']
    this.sgr = {}
    this.wrapped = []
    this.scroll = 0
    this.render()
  }

  // The conversation as screen rows (wrapped to the width; cached per line).
  #rows(cols) {
    if (this.wrapCols !== cols) [this.wrapped, this.wrapCols] = [[], cols]
    const out = []
    this.log.forEach((line, i) => {
      const w = this.wrapped[i]
      if (!w || w.src !== line) this.wrapped[i] = { src: line, rows: wrapAnsi(line, cols) }
      out.push(...this.wrapped[i].rows)
    })
    return out
  }

  // Layout, top to bottom: header · conversation · spinner/menu · rule · input · rule · status bar.
  render() {
    if (!this.full || this.out.hidden) return // a tab in the background draws when it's shown
    const { out, rl, menu } = this
    const rows = out.rows || 24
    const cols = out.columns || 80
    // The input box: the rows around the cursor, at most INPUT_ROWS; the rules count the rest.
    const typing = !this.asking && rl && this.mainPrompt // working: what's typed meanwhile shows in the box
    const input = this.asking || typing ? layoutInput(this.asking ? rl._prompt : this.mainPrompt, rl.line, rl.cursor, cols) : { rows: [''], cur: { row: 0, col: 0 } }
    const first = Math.max(0, Math.min(input.cur.row - INPUT_ROWS + 1, input.rows.length - INPUT_ROWS))
    const box = input.rows.slice(first, first + INPUT_ROWS)
    const inputRows = box.length
    const hiddenBelow = input.rows.length - first - box.length
    const rule = c.ghost('─'.repeat(cols))
    const note = (n, arrow) => c.ghost('── ') + c.faint(`${arrow} ${n} more line${n > 1 ? 's' : ''}`) + c.ghost(` ${'─'.repeat(Math.max(0, cols - 18 - String(n).length))}`)
    const below = [hiddenBelow ? note(hiddenBelow, '↓') : rule, ...(this.status ? [fit(' ' + this.status(), cols)] : [])] // under the input
    const bottom = []
    if (this.timer && !this.asking) {
      // since the message was sent, and (while waiting on the model) since this request was sent
      const since = (t) => {
        const secs = Math.floor((Date.now() - t) / 1000)
        return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
      }
      const request = this.requestSince?.()
      const extra = this.busySince ? ` · total ${since(this.busySince)}${request ? ` · waiting for model ${since(request)}` : ''} · Esc to stop` : ''
      bottom.push(fit(`${c.brand(FRAMES[this.frame % FRAMES.length])} ${c.muted(this.#label())}${c.faint(extra)}`, cols))
    }
    if (this.scroll) bottom.push(c.dim(`  ↓ ${this.scroll} more lines below · PgDn`))
    if (this.noticeText) bottom.push(fit(`${c.warn('!')} ${c.muted(this.noticeText)}`, cols))
    if (menu.on) bottom.push(...this.#menuLines(cols))
    bottom.push(first ? note(first, '↑') : rule)
    const head = [...(this.tabBar?.(cols) ?? []), ...(this.header?.(cols) ?? [])].map((l) => fit(l, cols))
    const inputTop = rows - below.length - inputRows + 1 // first row of the input
    const avail = Math.max(0, inputTop - 1 - bottom.length - head.length)
    const all = this.#rows(cols)
    this.scroll = Math.min(this.scroll, Math.max(0, all.length - avail))
    const top = Math.max(0, all.length - avail - this.scroll)
    const view = all.slice(top, top + avail)
    // a theme with a background: every row painted with it (a style ending its own background goes back to it)
    const row = background ? (line) => `${background}${line.replace(/\x1b\[(0|49)?m/g, (m) => m + background)}\x1b[K\x1b[0m` : (line) => `${line}\x1b[0m\x1b[K`
    let s = '\x1b[?25l'
    for (let r = 0; r < inputTop - 1; r++) {
      const i = r - head.length
      const line = i < 0 ? head[r] : i < avail ? (view[i] ?? '') : bottom[i - avail]
      s += `\x1b[${r + 1};1H${row(line)}`
    }
    box.forEach((line, i) => (s += `\x1b[${inputTop + i};1H${row(line)}`))
    below.forEach((line, i) => (s += `\x1b[${inputTop + inputRows + i};1H${row(line)}`))
    if (this.asking || typing) s += `\x1b[${inputTop + input.cur.row - first};${input.cur.col + 1}H\x1b[?25h`
    else s += `\x1b[${inputTop};1H`
    out.write(s)
  }


  // Keys while the prompt is up: PgUp/PgDn scroll; with the menu open, ↑↓ choose, Tab completes,
  // Enter picks (and runs a command), Esc hides it.
  #keys(rl) {
    const out = rl._writeToOutput.bind(rl)
    rl._writeToOutput = (t) => (this.full ? undefined : out(t)) // in full screen, render() draws the input
    const write = rl._ttyWrite.bind(rl)
    rl._ttyWrite = (s, key = {}) => {
      if (!this.full) return write(s, key)
      const bound = !(key.ctrl && key.name === 'c') && this.keys[keyId(key, s)] // ~/.heart/keybindings.json
      if (this.recording) { // Enter or the voice key: done; Esc: never mind; the rest waits
        if (key.name === 'escape') this.recording.end(false)
        else if (key.name === 'return' || bound === 'voice') this.recording.end(true)
        return
      }
      // a fixed dialog (pick(…, { fixed })): only its keys, nothing typed and no shortcuts
      if (this.menu.pick?.fixed && !['up', 'down', 'return', 'escape'].includes(key.name) && !(key.ctrl && key.name === 'c')) return
      if (bound) return this.#action(bound, write)
      if (!this.asking && !(key.ctrl && key.name === 'c')) return this.#typeAhead(s, key, write)
      if (key.name === 'tab' && key.shift) return this.setPermission(PERMISSIONS[(PERMISSIONS.findIndex(([p]) => p === this.permission) + 1) % PERMISSIONS.length][0])
      // A new line instead of sending: Shift/Ctrl/Alt/Cmd+Enter (arrive as "\n" or ESC+Enter),
      // Ctrl+J, "\" right before Enter, and line breaks inside a paste.
      if (key.name === 'paste-start' || key.name === 'paste-end') {
        this.pasting = key.name === 'paste-start'
        return
      }
      if ((key.name === 'return' || key.name === 'enter') && !this.menu.pick) {
        const backslash = key.name === 'return' && !key.meta && rl.line[rl.cursor - 1] === '\\'
        if (this.pasting || key.name === 'enter' || key.meta || backslash) {
          const at = rl.cursor - (backslash ? 1 : 0)
          rl.line = rl.line.slice(0, at) + '\n' + rl.line.slice(rl.cursor)
          rl.cursor = at + 1
          this.menu.items = []
          return this.render()
        }
      }
      if (key.name === 'pageup' || key.name === 'pagedown') {
        const page = Math.max(1, (this.out.rows || 24) - 4)
        this.scroll = Math.max(0, this.scroll + (key.name === 'pageup' ? page : -page))
        return this.render()
      }
      const m = this.menu
      const it = m.on && m.items[m.sel]
      if (this.noticeText && !(key.ctrl && key.name === 'c')) this.notice('') // any key dismisses a notice
      // Esc in a typed question (a name, a key, "your answer"): cancels it, as an empty answer would
      if (key.name === 'escape' && !this.histOn && !m.pick) {
        rl.line = ''
        rl.cursor = 0
        return this.waiters.shift()?.(null)
      }

      // Esc twice with text in the input: clear it.
      if (key.name === 'escape' && !m.pick && rl.line) {
        const twice = key.sequence === '\x1b\x1b' || Date.now() - (this.lastEscape ?? 0) < 800 // a lone Esc also comes with meta set
        this.lastEscape = twice ? 0 : Date.now()
        if (twice) {
          this.clearInput()
          return this.refreshMenu()
        }
        // the first Esc still closes the suggestion menu (below)
      }
      // Esc twice on an empty input: whatever onDoubleEscape returns is sent (e.g. "/rewind").
      else if (key.name === 'escape' && !m.pick && !rl.line && this.onDoubleEscape) {
        const twice = key.sequence === '\x1b\x1b' || Date.now() - (this.lastEscape ?? 0) < 800 // a lone Esc also comes with meta set
        this.lastEscape = twice ? 0 : Date.now()
        if (twice) {
          rl.line = this.onDoubleEscape()
          this.sent = rl.line
          return write('\r', { name: 'return' })
        }
        return
      }
      if (m.pick) {
        if (key.name === 'up' || key.name === 'down') return this.#move(key.name === 'up' ? -1 : 1)
        if (key.name === 'tab') return
        if (m.pick.multi && key.name === 'space' && it) {
          it.item.checked = !it.item.checked // Space ticks; Enter takes the ticked ones
          return this.refreshMenu()
        }
        if (key.name === 'escape' || (key.name === 'return' && it)) {
          const ticked = m.pick.items.filter((x) => x.checked)
          m.pick.chosen = key.name !== 'return' ? null : m.pick.multi ? (ticked.length ? ticked : [it.item]) : it.item
          rl.line = ''
          rl.cursor = 0
          return write('\r', { name: 'return' })
        }
        if (key.name === 'return') return // nothing matches the filter
        write(s, key)
        return this.refreshMenu()
      }
      // ↑/↓: between the lines of a multi-line input, then through earlier messages (unless the
      // suggestion menu is open and the user hasn't started going through history).
      if ((key.name === 'up' || key.name === 'down') && this.histOn && !key.ctrl && !key.meta && (!it || this.histAt >= 0)) {
        if (this.#moveLine(key.name === 'up' ? -1 : 1)) return this.render()
        this.#browse(key.name === 'up' ? 1 : -1)
        return this.refreshMenu()
      }
      if (key.name !== 'up' && key.name !== 'down') this.histAt = -1 // typing ends the browsing
      if (it && (key.name === 'up' || key.name === 'down')) {
        m.sel = (m.sel + (key.name === 'up' ? m.items.length - 1 : 1)) % m.items.length
        return this.render()
      }
      if (it && key.name === 'escape') {
        m.off = rl.line
        return this.refreshMenu()
      }
      // Tab only completes the text: the menu closes (no list of a command's choices pops up); Enter runs it
      if (m.on && key.name === 'tab') {
        if (!it) return
        this.#accept(it)
        m.off = rl.line
        return this.refreshMenu()
      }
      if (it && key.name === 'return' && rl.line.slice(it.start, it.end) !== it.value) {
        this.#accept(it)
        if (it.insertOnly) return
      }
      if (key.name === 'return') {
        m.items = []
        this.sent = rl.line
      }
      write(s, key)
      if (m.on) this.refreshMenu()
      else this.render()
    }
  }

  // Typing while HeartCode works: the text stays in the box; Enter sends it, to the running task
  // (it reads it before its next step; takeAhead) or as the next message. Esc stops the task.
  #typeAhead(s, key, write) {
    const rl = this.rl
    if (key.name === 'escape') return this.onEscape?.()
    if (key.name === 'tab' && key.shift) return this.setPermission(PERMISSIONS[(PERMISSIONS.findIndex(([p]) => p === this.permission) + 1) % PERMISSIONS.length][0])
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scroll = Math.max(0, this.scroll + (key.name === 'pageup' ? 1 : -1) * Math.max(1, (this.out.rows || 24) - 4))
      return this.render()
    }
    if (key.name === 'return' && !key.meta && !this.pasting) {
      const line = rl.line.trim()
      rl.line = ''
      rl.cursor = 0
      if (/^\/btw\b/.test(line) && this.onBtw) this.onBtw(line.replace(/^\/btw\b/, '').trim()) // answered now, beside the task
      else if (line) {
        this.ahead.push(line)
        this.print(`${c.faint(' ↳')} ${c.muted(line.split('\n')[0])} ${c.faint(this.isCommand(line) ? '(runs when this is done)' : '(goes to the model at its next step, or runs next)')}`)
      }
      return this.render()
    }
    if (['up', 'down', 'tab'].includes(key.name) || key.name === 'paste-start' || key.name === 'paste-end') {
      if (key.name.startsWith('paste')) this.pasting = key.name === 'paste-start'
      return
    }
    if (this.pasting && key.name === 'return') {
      rl.line = rl.line.slice(0, rl.cursor) + '\n' + rl.line.slice(rl.cursor)
      rl.cursor++
    } else write(s, key)
    this.render()
  }

  // A key from keybindings.json: an action, or text to send (a /command, a message).
  #action(what, write) {
    const rl = this.rl
    const m = this.menu
    switch (what) {
      case 'none':
        return
      case 'new_tab':
      case 'close_tab':
      case 'next_tab':
      case 'prev_tab':
        return this.onTab?.(what)
      case 'voice': // the words go where the cursor is, in the box (also while it works)
        if (m.pick || (this.asking && !this.histOn)) return
        return this.dictate().then((text) => {
          if (!text) return
          const pad = rl.line && !/\s$/.test(rl.line.slice(0, rl.cursor)) ? ' ' : ''
          rl.line = rl.line.slice(0, rl.cursor) + pad + text + rl.line.slice(rl.cursor)
          rl.cursor += pad.length + text.length
          this.render()
        })
      case 'stop':
        return this.asking ? undefined : this.onEscape?.()
      case 'cycle_permissions':
        return this.setPermission(PERMISSIONS[(PERMISSIONS.findIndex(([p]) => p === this.permission) + 1) % PERMISSIONS.length][0])
      case 'newline':
        rl.line = rl.line.slice(0, rl.cursor) + '\n' + rl.line.slice(rl.cursor)
        rl.cursor++
        return this.render()
      case 'clear_input':
        this.clearInput()
        return this.refreshMenu()
      default:
        if (/^tab_\d$/.test(what)) return this.onTab?.(what)
        break
      case 'scroll_up':
      case 'scroll_down':
        this.scroll = Math.max(0, this.scroll + (what === 'scroll_up' ? 1 : -1) * Math.max(1, (this.out.rows || 24) - 4))
        return this.render()
    }
    if (!this.asking) {
      this.ahead.push(what)
      return this.print(`${c.faint(' ↳')} ${c.muted(what)} ${c.faint('(runs when this is done)')}`)
    }
    if (!this.histOn || m.pick) return // only at the main prompt, not in a question or picker
    rl.line = what
    this.sent = what
    m.items = []
    write('\r', { name: 'return' })
  }

  // Records until Enter (or the voice key) and returns the words, or null (Esc, or it failed: said
  // in a notice). voiceConfig() → { voice, providers }: set by the app.
  async dictate() {
    if (this.recording) return null
    const { voice = {}, providers = {} } = this.voiceConfig?.() ?? {}
    const problem = voiceProblem(voice, providers)
    if (problem) return this.notice(problem, 8000), null
    const rec = record()
    const t0 = Date.now()
    const keep = !this.asking // working: the spinner line stays the task's
    const show = () => this.notice(`● recording ${Math.floor((Date.now() - t0) / 1000)}s · Enter or Ctrl+R to stop · Esc to cancel`, 60 * 60_000)
    show()
    const tick = setInterval(show, 1000)
    const go = await new Promise((resolve) => (this.recording = { end: resolve }))
    clearInterval(tick)
    this.recording = null
    if (!go) {
      rec.cancel()
      this.notice('')
      return null
    }
    try {
      const file = await rec.stop()
      this.notice('transcribing…', 60 * 60_000)
      const text = await transcribe(file, voice, providers)
      log('voice', text)
      this.notice(text ? '' : 'heard nothing', 3000)
      return text || null
    } catch (e) {
      log('voice', e.message)
      this.notice(e.message, 8000)
      return null
    } finally {
      if (keep) this.render()
    }
  }

  // Messages typed while working that can go to the running task now (not commands); taken.
  takeAhead() {
    const out = this.ahead.filter((l) => !this.isCommand(l))
    this.ahead = this.ahead.filter((l) => this.isCommand(l))
    return out
  }

  #accept(it) {
    const rl = this.rl
    const v = it.value + (it.space ? ' ' : '')
    rl.line = rl.line.slice(0, it.start) + v + rl.line.slice(it.end)
    rl.cursor = it.start + v.length
    rl._refreshLine()
    this.refreshMenu()
  }

  // Picker: move the highlight, skipping group headers.
  #move(d) {
    const m = this.menu
    for (let i = 0, n = m.items.length; i < n; i++) {
      m.sel = (m.sel + d + n) % n
      if (!m.items[m.sel].header) break
    }
    this.render()
  }

  refreshMenu() {
    const m = this.menu
    if (!m.on || !this.rl) return
    const line = this.rl.line
    if (m.pick) {
      const was = m.items[m.sel]?.item
      m.items = pickView(m.pick.items, line)
      const keep = m.items.findIndex((x) => x.item && x.item === (was ?? m.pick.items.find((i) => i.current)))
      // typing: the first whose name matches (a filter also matches descriptions: typing "no"
      // must not leave "Yes" chosen because its description says "knows")
      const words = line.toLowerCase().split(/\s+/).filter(Boolean)
      const named = words.length && line !== m.pick.typed ? m.items.findIndex((x) => x.item && words.every((w) => x.item.label.toLowerCase().includes(w))) : -1
      m.pick.typed = line
      m.sel = named !== -1 ? named : keep !== -1 ? keep : Math.max(0, m.items.findIndex((x) => !x.header))
      return this.render()
    }
    const items = m.off === line ? [] : (this.suggest?.(line, this.rl.cursor) ?? [])
    if (m.off !== line) m.off = null
    if (items.length !== m.items.length || items.some((x, i) => x.value !== m.items[i].value)) m.sel = 0
    m.items = items
    this.render()
  }

  #menuLines(cols) {
    const m = this.menu
    const width = cols - 1
    const max = m.pick ? Math.max(5, (this.out.rows || 24) - 8) : MENU_ROWS
    const first = Math.max(0, Math.min(m.sel - max + 1, m.items.length - max))
    const shown = m.items.slice(first, first + max)
    const pad = m.items.some((x) => x.header) ? '  ' : ''
    const w = Math.min(Math.max(0, ...shown.filter((x) => !x.header).map((x) => x.value.length)), 48)
    const lines = shown.map((x, i) => {
      if (x.header) return c.accent(c.bold(x.value.slice(0, width)))
      const plain = `${x.value.padEnd(w)}  ${x.desc ?? ''}`.slice(0, width - 2 - pad.length)
      const name = plain.slice(0, w)
      if (first + i !== m.sel) return `${pad}  ${c.text(name)}${c.faint(plain.slice(w))}`
      const row = `${c.brand('❯')} ${c.bright(c.bold(name))}${c.muted(plain.slice(w))}`
      return pad + c.select(row + ' '.repeat(Math.max(0, width - pad.length - 2 - plain.length))) // the whole row lit
    })
    const more = m.items.length - first - shown.length
    if (more > 0) lines.push(c.faint(`  … ${more} more`))
    const how = m.pick?.multi ? '↑↓ move · Space tick · Enter take the ticked ones · Esc cancel · type to filter' : '↑↓ move · Enter choose · Esc cancel · type to filter'
    if (m.pick) lines.unshift(c.faint(m.items.length ? how : `nothing matches "${this.rl.line}" · Esc cancel`))
    return lines
  }


  // initial: text already typed in, ready to edit. suggest: show the suggestion menu while typing.
  // A one-line message just above the input until `ms` pass or a key is pressed ('' hides it).
  notice(text, ms = 2000) {
    this.noticeText = text
    clearTimeout(this.noticeTimer)
    if (text) this.noticeTimer = setTimeout(() => this.notice(''), ms)
    this.render()
  }

  // Empties the input (Ctrl+C or Esc Esc with text in it).
  clearInput() {
    if (!this.rl) return
    this.rl.line = ''
    this.rl.cursor = 0
    this.histAt = -1
    this.render()
  }

  // ↑/↓ inside a multi-line input: to the line above/below, same column. false at the first/last line.
  #moveLine(d) {
    const rl = this.rl
    const lines = rl.line.split('\n')
    if (lines.length < 2) return false
    let i = 0
    let start = 0
    while (i < lines.length - 1 && start + lines[i].length < rl.cursor) start += lines[i++].length + 1
    const j = i + d
    if (j < 0 || j >= lines.length) return false
    const col = rl.cursor - start
    const to = lines.slice(0, j).reduce((n, l) => n + l.length + 1, 0)
    rl.cursor = to + Math.min(col, lines[j].length)
    return true
  }

  // Earlier messages: d = 1 older, -1 newer; past the newest comes back what was being typed.
  #browse(d) {
    const rl = this.rl
    const h = this.history()
    const at = Math.max(-1, Math.min(h.length - 1, this.histAt + d))
    if (at === this.histAt) return
    if (this.histAt === -1) this.draft = rl.line
    this.histAt = at
    rl.line = at === -1 ? (this.draft ?? '') : h[h.length - 1 - at]
    // going back: cursor on the last line; going forward: on the first, so ↑/↓ walk its lines next
    const nl = rl.line.indexOf('\n')
    rl.cursor = d > 0 || nl === -1 ? rl.line.length : nl
    if (this.menu.on) this.menu.off = rl.line // a recalled "/command" doesn't open the menu
  }

  // Sent messages, oldest first, kept in ~/.heart/history.json across runs.
  history() {
    if (!this.sentHistory) {
      try {
        this.sentHistory = JSON.parse(fs.readFileSync(path.join(HOME, 'history.json'), 'utf8')).filter((x) => typeof x === 'string')
      } catch {
        this.sentHistory = []
      }
    }
    return this.sentHistory
  }

  remember(line) {
    const h = this.history()
    if (!line.trim() || h.at(-1) === line) return
    h.push(line)
    if (h.length > 500) h.splice(0, h.length - 500)
    try {
      fs.mkdirSync(HOME, { recursive: true })
      fs.writeFileSync(path.join(HOME, 'history.json'), JSON.stringify(h), { mode: 0o600 })
    } catch {}
  }

  // history: this prompt's messages go into ↑/↓ history (only the main prompt, never answers like keys).
  ask(prompt, { initial = '', suggest = false, history = false } = {}) {
    this.stopSpin()
    const rl = this.#rl()
    if (history) this.mainPrompt = prompt
    if (history && this.ahead.length) {
      const l = this.ahead.shift()
      log('input', `${prompt.trim()} ${l} (typed while working)`)
      this.write(prompt.replace(/^ /, '') + c.bright(l) + '\n')
      return Promise.resolve(l)
    }
    // a question in the middle of work: what's being typed for later waits until it's answered
    const draft = !history && rl.line ? [rl.line, (rl.line = ''), (rl.cursor = 0)][0] : ''
    if (this.queue.length) {
      const l = this.queue.shift()
      log('input', `${prompt.trim()} ${/api key/i.test(prompt) && l ? `${l.slice(0, 4)}…(${l.length} chars)` : l}`) // never log keys
      this.write(prompt + l + '\n')
      return Promise.resolve(l)
    }
    if (this.closed) return Promise.resolve(null)
    this.menu.on = Boolean(suggest && (this.suggest || this.menu.pick) && this.full)
    this.histOn = history
    this.histAt = -1
    this.draft = ''
    if (this.full) {
      this.asking = true
      this.render() // cursor to the input row
    }
    rl.setPrompt(prompt)
    rl.prompt()
    if (initial && rl.terminal) rl.write(initial)
    if (this.menu.on) this.refreshMenu()
    else this.render()
    return new Promise((resolve) =>
      this.waiters.push((l) => {
        this.menu.items = []
        this.menu.on = false
        if (history && l) this.remember(l)
        this.histOn = false
        const said = this.menu.pick ? (this.menu.pick.chosen?.label ?? '(cancelled)') : (l ?? '(cancelled)')
        log('input', `${prompt.trim()} ${/api key/i.test(prompt) && l ? `${l.slice(0, 4)}…(${l.length} chars)` : said}`) // never log keys
        if (l !== null && !rl.terminal) this.out.write(l + '\n')
        if (this.full) {
          this.asking = false
          this.scroll = 0
          const pick = this.menu.pick
          const echo = prompt.replace(/^ /, '') // the input's margin isn't part of the conversation
          this.inputMark = this.log.length - 1 // where this message starts, for /rewind
          const picked = Array.isArray(pick?.chosen) ? pick.chosen.map((x) => x.label).join(', ') : pick?.chosen?.label
          if (pick?.quiet) this.render()
          else if (pick) this.write(echo + (picked ?? c.dim('cancelled')) + '\n')
          else if (l !== null) this.write(echo + c.bright(l.replace(/\n/g, '\n' + ' '.repeat(width(echo.replace(/\x1b\[[0-9;]*m/g, ''))))) + '\n')
          else this.render()
        }
        if (draft) [rl.line, rl.cursor] = [draft, draft.length]
        resolve(l)
      }),
    )
  }

  cancelAsk() {
    for (const w of this.waiters.splice(0)) w(null)
  }

  // Interactive list: type to filter, ↑↓ move, Enter chooses, Esc cancels (→ null).
  // items: [{ label, desc?, group?, current? }]; without full screen, a numbered list.
  // multi: tick several with Space; returns the ticked items (an array), or null.
  // quiet: the question and answer aren't left in the conversation (a question before it starts).
  // fixed: a dialog: no typing to filter, no other keys meanwhile.
  async pick(title, items, { filter = '', multi = false, quiet = false, fixed = false } = {}) {
    if (!this.full) {
      items.forEach((it, i) => this.print(`  ${i + 1}. ${it.group ? `${it.group} · ` : ''}${it.label}${it.desc ? '  ' + c.dim(it.desc) : ''}`))
      const a = await this.ask(`${title} ${c.dim(multi ? '(numbers, like 1,3)' : '(number)')}: `)
      if (!multi) return items[Number(a) - 1] ?? null
      const chosen = String(a ?? '').split(/[\s,]+/).map((n) => items[Number(n) - 1]).filter(Boolean)
      return chosen.length ? chosen : null
    }
    if (multi) for (const it of items) it.checked ??= false
    this.menu.pick = { items, chosen: null, multi, quiet, fixed }
    try {
      await this.ask(`${c.bold(title)} ${c.dim('›')} `, { suggest: true, initial: filter })
      return this.menu.pick.chosen
    } finally {
      this.menu.pick = null
    }
  }

  setPermission(mode) {
    log('permissions', mode)
    if (mode === 'plan' && this.permission !== 'plan') this.beforePlan = this.permission // what plan mode asks like, and goes back to
    this.permission = mode
    this.onPermission?.(mode)
    this.render()
  }

  // kind: 'edit', 'command' or 'read'. true = yes, false = no, string = "no, and here is why"
  // kind 'read' (web search and fetch): asked like a command, but never in plan mode, which is for
  // looking around. Otherwise plan mode asks as the mode before it did (only reading tools get here).
  async confirm(question, kind = 'edit') {
    if (kind === 'read' && this.permission === 'plan') return true
    const mode = this.permission === 'plan' ? (this.beforePlan ?? 'ask') : this.permission
    if (mode === 'all' || (mode === 'commands' && kind === 'edit')) return true
    if (this.full) {
      const opts = [
        { label: 'Yes', value: true },
        { label: "Yes, and don't ask again", value: 'all' },
        { label: 'No', value: false },
        { label: 'No, and tell the model what to do instead', value: 'why' },
      ]
      const a = (await this.pick(`${c.yellow('?')} ${question}`, opts))?.value ?? false
      if (a === 'all') this.setPermission('all')
      if (a !== 'why') return Boolean(a)
      return (await this.ask(`${c.bold('What should it do instead?')} `))?.trim() || false
    }
    const a = await this.ask(`${c.yellow('?')} ${question} ${c.dim('[Y/n or type feedback]')} `)
    if (a === null) return false
    const t = a.trim()
    if (/^(y|yes)?$/i.test(t)) return true
    if (/^(n|no)$/i.test(t)) return false
    return t
  }

  write(s) {
    if (!this.full) this.stopSpin() // inline, the spinner shares the line; full screen it has its own row
    if (!s) return
    this.tail = (this.tail + s.replace(/\x1b\[[0-9;]*m/g, '')).slice(-2)
    if (!this.full) return this.out.write(s)
    // The screen draws each line on its own, so a style still open at a line break is reopened
    // on the next line (a multi-line thinking block stays grey and italic).
    const parts = s.replace(/\r/g, '').split('\n')
    parts.forEach((part, k) => {
      if (k) this.log.push(sgrPrefix(this.sgr))
      this.log[this.log.length - 1] += part
      this.sgr = sgrState(this.sgr, part)
    })
    if (!this.pending) {
      this.pending = true
      setImmediate(() => {
        this.pending = false
        this.render()
      })
    }
  }
  // A blank line before a new block, unless there already is one.
  gap() {
    if (this.tail && this.tail !== '\n\n') this.write(this.tail.endsWith('\n') ? '\n' : '\n\n')
  }
  print(s = '') {
    this.write(s + '\n')
  }
  step(name, detail = '') {
    if (this.afterBlock) this.gap()
    this.afterBlock = false
    this.print(`${c.accent('●')} ${c.accent(c.bold(name))} ${c.info(detail)}`)
  }
  result(text) {
    this.print(`  ${c.ghost('⎿')} ${c.faint(text)}`)
  }
  warn(text) {
    log('warn', text)
    this.print(`${c.warn('!')} ${c.warn(text)}`)
  }

  spinner(label) {
    this.label = label
    if (!this.out.isTTY || this.timer) return
    let i = 0
    const tick = () => {
      this.frame++
      if (this.full) this.render()
      else this.out.write(`\r\x1b[K${c.magenta(FRAMES[i++ % FRAMES.length])} ${c.dim(this.#label())}`)
    }
    this.timer = setInterval(tick, 80)
    tick()
  }
  // The spinner's text; a function label is re-read every frame (for countdowns).
  #label() {
    return typeof this.label === 'function' ? this.label() : this.label
  }

  // A request failed and will be retried in `ms`: show why and count down. null = it worked again.
  // next: the model it goes on to (the model list on the settings page)
  retrying(err, ms, attempt, next) {
    if (!err) {
      if (this.beforeRetry !== undefined) this.spinner(this.beforeRetry)
      this.beforeRetry = undefined
      return
    }
    this.beforeRetry ??= typeof this.label === 'function' ? 'thinking' : this.label || 'thinking'
    const until = Date.now() + ms
    const why = shortError(err)
    const secs = () => Math.max(0, Math.ceil((until - Date.now()) / 1000))
    if (next) return this.spinner(() => `${c.yellow('⚠')} ${why} · trying ${next.provider} · ${next.model}${secs() ? ` in ${secs()}s (all failed once)` : ''} (attempt ${attempt})`)
    this.spinner(() => `${c.yellow('⚠')} retrying in ${secs()}s (attempt ${attempt}) · ${why}`)
  }

  stopSpin() {
    if (!this.timer) return
    if (this.busySince) return void (this.label = 'working') // still busy: keep spinning, generically
    clearInterval(this.timer)
    this.timer = null
    if (this.full) this.render()
    else this.out.write('\r\x1b[K')
  }

  // Full screen: from the moment work starts until it's done (a task, a probe, a command), the
  // spinner row stays on, whatever gets printed meanwhile. It steps aside while asking the user.
  busy() {
    if (!this.full) return
    this.busySince = Date.now()
    this.spinner('working')
  }
  idle() {
    this.busySince = null
    this.stopSpin()
  }

  close() {
    this.busySince = null // closing ends any work in progress: the spinner stops too
    this.stopSpin()
    this.rl?.close()
    this.leaveFullscreen()
  }
}

// Line diff: trims the common prefix/suffix, then LCS on what is left.
export function diffLines(a, b) {
  const A = a.split('\n')
  const B = b.split('\n')
  let p = 0
  while (p < A.length && p < B.length && A[p] === B[p]) p++
  let s = 0
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++
  const x = A.slice(p, A.length - s)
  const y = B.slice(p, B.length - s)
  const mid = []
  if (x.length * y.length > 4e6) {
    // ponytail: huge rewrites shown as remove-all/add-all; real Myers diff if that matters
    for (const l of x) mid.push(['-', l])
    for (const l of y) mid.push(['+', l])
  } else {
    const m = y.length + 1
    const dp = new Uint32Array((x.length + 1) * m)
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        dp[i * m + j] = x[i] === y[j] ? dp[(i + 1) * m + j + 1] + 1 : Math.max(dp[(i + 1) * m + j], dp[i * m + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        mid.push([' ', x[i++]])
        j++
      }
      else if (dp[(i + 1) * m + j] >= dp[i * m + j + 1]) mid.push(['-', x[i++]])
      else mid.push(['+', y[j++]])
    }
    while (i < x.length) mid.push(['-', x[i++]])
    while (j < y.length) mid.push(['+', y[j++]])
  }
  return [...A.slice(0, p).map((l) => [' ', l]), ...mid, ...A.slice(A.length - s).map((l) => [' ', l])]
}

export function renderDiff(ops, title, useColor = color, context = 3, maxLines = 200) {
  const show = new Array(ops.length).fill(false)
  ops.forEach(([t], i) => {
    if (t === ' ') return
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) show[k] = true
  })
  const add = ops.filter(([t]) => t === '+').length
  const del = ops.filter(([t]) => t === '-').length
  const paintIf = (f, s) => (useColor ? f(s) : s)
  const out = [paintIf(c.ghost, '── ') + paintIf((x) => c.info(c.bold(x)), title) + ' ' + paintIf(c.ok, `+${add}`) + ' ' + paintIf(c.err, `-${del}`)]
  let gap = false
  let n = 0
  for (let i = 0; i < ops.length; i++) {
    if (!show[i]) {
      gap = true
      continue
    }
    if (gap && out.length > 1) out.push(paintIf(c.ghost, '  ⋯'))
    gap = false
    if (++n > maxLines) {
      out.push(paintIf(c.faint, `  … ${ops.slice(i).filter(([t]) => t !== ' ').length} more changed lines`))
      break
    }
    const [t, l] = ops[i]
    out.push(t === '+' ? paintIf(c.ok, `+ ${l}`) : t === '-' ? paintIf(c.err, `- ${l}`) : paintIf(c.faint, `  ${l}`))
  }
  return out.join('\n')
}
