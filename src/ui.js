import readline from 'node:readline'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { log } from './log.js'
import { HOME } from './config.js'
import { listen, transcribePcm, voiceProblem } from './voice.js'

export const color = (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR
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
// Actions: stop, send_first, send_all, queue_mode, cycle_permissions, newline, clear_input, scroll_up, scroll_down (a page),
// scroll_line_up, scroll_line_down (3 lines), scroll_top, scroll_bottom, voice, new_tab,
// close_tab, next_tab, prev_tab, tab_1…tab_9, none (turns a
// built-in key off); anything else is sent as typed (a /command or a message). Ctrl+C stays Ctrl+C.
const CONTROL_KEYS = { '\x1c': 'ctrl+\\', '\x1d': 'ctrl+]', '\x1e': 'ctrl+^', '\x1f': 'ctrl+_' } // no name from readline
export const keyId = (key, s = '') => CONTROL_KEYS[key.sequence ?? s] ?? [key.ctrl && 'ctrl', key.meta && 'alt', key.shift && 'shift', key.name ?? s].filter(Boolean).join('+').toLowerCase()
// The built-in keys use Alt/Option, not Ctrl, so they don't clash with the shell and readline (Ctrl+N/P
// history, Ctrl+T transpose, Ctrl+Q flow-control, Ctrl+\ quit). On macOS Terminal.app, Alt keys need
// "Use Option as Meta key" on (Settings → Profiles → Keyboard); Ctrl+PgUp/PgDn cycle tabs without it.
// While it works, Enter queues a message; Alt+S stops the answer and sends the first queued one,
// Alt+A all of them (as one message); Alt+M switches what goes when an answer is done (all or the
// next one). /voice records (Space in an empty box, or a key in keybindings.json); Alt+T, Alt+W,
// Alt+N/P (or Ctrl+PgDn/PgUp), Alt+1…9: tabs; Shift+↑↓ and Alt+↑↓ scroll the conversation (as
// PgUp/PgDn and the mouse wheel do), Alt+Shift+↑↓ (or Ctrl+Home/End) to its top and bottom.
// keybindings.json can move any of them.
export const DEFAULT_KEYS = { 'ctrl+o': '/toggle_thinking', 'alt+b': 'background_log', 'alt+s': 'send_first', 'alt+a': 'send_all', 'alt+m': 'queue_mode', 'shift+up': 'scroll_line_up', 'shift+down': 'scroll_line_down', 'alt+up': 'scroll_up', 'alt+down': 'scroll_down', 'alt+shift+up': 'scroll_top', 'alt+shift+down': 'scroll_bottom', 'ctrl+home': 'scroll_top', 'ctrl+end': 'scroll_bottom', 'alt+t': 'new_tab', 'alt+w': 'close_tab', 'alt+n': 'next_tab', 'alt+p': 'prev_tab', 'ctrl+pagedown': 'next_tab', 'ctrl+pageup': 'prev_tab', ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`alt+${n}`, `tab_${n}`])) }
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

// mouse reports (SGR), with moves while a button is down (for selecting text)
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l'

// The system clipboard (pbcopy, clip, wl-copy, xclip, xsel); else the terminal's (OSC 52). Over SSH,
// the terminal's only: the system's would be the remote machine's, not the one you're at.
export function copyText(text) {
  const remote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT)
  const tools = remote ? [] : process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '-b', '-i']]
  for (const [cmd, ...args] of tools) if (spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0) return 'system'
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  return 'osc'
}

// The cells from…to (columns, to excluded) of a colored line, shown reversed (a selection).
function highlight(line, from, to) {
  let col = 0
  let on = false
  let out = ''
  for (const [, esc, ch] of line.matchAll(/(\x1b\[[0-9;]*m)|([^\x1b])/gs)) {
    if (esc) {
      out += esc + (on && /^\x1b\[0?m$/.test(esc) ? '\x1b[7m' : '') // a reset inside keeps it reversed
      continue
    }
    if (!on && col >= from && col < to) (out += '\x1b[7m'), (on = true)
    if (on && col >= to) (out += '\x1b[27m'), (on = false)
    out += ch
    col += width(ch)
  }
  return out + (on ? '\x1b[27m' : '')
}

// The characters in columns from…to of plain text.
function sliceCols(text, from, to) {
  let col = 0
  let out = ''
  for (const ch of text) {
    if (col >= from && col < to) out += ch
    col += width(ch)
  }
  return out
}
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

// 75000 → "1 minute 15 seconds"; the two biggest units: "5 hours 33 minutes", "2 days 3 hours"
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const units = [['day', Math.floor(s / 86400)], ['hour', Math.floor(s / 3600) % 24], ['minute', Math.floor(s / 60) % 60], ['second', s % 60]]
  const first = units.findIndex(([, n]) => n)
  if (first < 0) return '0 seconds'
  return units.slice(first, first + 2).filter(([, n]) => n).map(([u, n]) => `${n} ${u}${n === 1 ? '' : 's'}`).join(' ')
}
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
    if (ctrl && /^[-/]$/.test(ch)) return '\x1f' // Ctrl+- / Ctrl+/ (and with Shift: Ctrl+_), as terminals send them
    if (ctrl && /^[a-z@[\\\]^_ ]$/i.test(ch)) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f)
    else if (shift) ch = ch.toUpperCase()
    return (alt ? '\x1b' : '') + ch
  })
}

// The terminal's input, passed through legacyKeys (holding back a sequence split across reads).
// Mouse reports (SGR, full screen turns them on) are taken out, to onMouse(button, x, y, released).
function keyStream(input, onMouse) {
  const proxy = new PassThrough()
  proxy.isTTY = true
  proxy.setRawMode = (on) => input.setRawMode?.(on)
  proxy.on('pause', () => input.pause())
  proxy.on('resume', () => input.resume())
  const dec = new StringDecoder('utf8')
  let held = ''
  let timer
  const mouse = (m, b, x, y, end) => (onMouse?.(Number(b), Number(x), Number(y), end === 'm'), '')
  const send = (text) => (text = text.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, mouse)) && proxy.write(legacyKeys(text))
  // bound to where it was made: a tab's keys are logged in that tab's log (src/log.js)
  input.on('data', AsyncLocalStorage.bind((d) => {
    clearTimeout(timer)
    let text = held + dec.write(d)
    const part = /\x1b\[<?[0-9;:]*$/.exec(text)
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

// wrapAnsi at spaces: a word moves to the next row whole (one longer than a row is still cut)
export function wrapWords(line, cols) {
  const width = (x) => x.replace(/\x1b\[[0-9;]*m/g, '').length
  const rows = []
  let row = ''
  for (const word of line.split(/(?<= )/)) {
    if (width(row.trim()) && width(row + word.trimEnd()) > cols) {
      const style = (row.match(/\x1b\[[0-9;]*m/g) ?? []).reduce((st, e) => (e === '\x1b[0m' ? '' : st + e), '') // colors still on: carried to the next row
      rows.push(row.trimEnd() + (style ? '\x1b[0m' : ''))
      row = style
    }
    row += word
  }
  rows.push(row)
  return rows.flatMap((r) => wrapAnsi(r, cols))
}

// Streams text as an indented, word-wrapped block: "<marker>first line\n  next line".
// Leading/trailing blank lines are dropped; runs of blank lines collapse to one.
export class Block {
  constructor(write, { marker = '  ', markerStyle = (x) => x, style = (x) => x, width = (process.stdout.columns || 100) - 1 } = {}) {
    Object.assign(this, { write, marker, markerStyle, style, width: Math.max(20, width) })
    this.indent = ' '.repeat(marker.length)
    this.hang = '' // more indent for a wrapped line (a list item's text)
    this.col = 0
    this.started = false
    this.newlines = 0
  }
  push(text, style = this.style) {
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
        out += '\n' + this.indent + this.hang
        this.col = this.indent.length + this.hang.length
        if (ch === ' ') continue
      }
      out += ch
      this.col++
    }
    if (out) this.write(out.split('\n').map((l) => l && style(l)).join('\n')) // styled per row, so a row's colors stand alone
  }
  end() {
    if (this.started && !this.ended) this.write('\n')
    this.ended = true
  }
}

// The model's Markdown, drawn as it streams in: headings, lists, quotes, code blocks, rules,
// **bold**, *italic* and `code`. Into a Block (which wraps); held back only while a line's start
// or a "*" could still be a marker. Tables and links stay as written.
export class Markdown {
  constructor(block, base = (x) => x) {
    Object.assign(this, { block, base, buf: '', sol: true, fence: false, bold: false, ital: false, code: false, line: null, prev: ' ' })
  }
  push(t) {
    this.buf += t
    this.#run(false)
  }
  end() {
    this.#run(true)
    this.block.end()
  }
  #style() {
    let f = this.line ?? this.base
    if (this.code || this.fence) return c.info
    if (this.bold) f = ((g) => (x) => c.bold(c.bright(g(x))))(f)
    if (this.ital) f = ((g) => (x) => c.italic(g(x)))(f)
    return f
  }
  #out(x, style = this.#style()) {
    if (x) this.block.push(x, style)
  }
  // a line's start: what kind of line it is (false: not known yet)
  #lineStart(s, final) {
    const nl = s.indexOf('\n')
    const head = nl < 0 ? s : s.slice(0, nl)
    const whole = nl >= 0 || final
    if (!whole && /^\s*(#{0,6}|[-*+_]|\d{1,3}[.)]?|>|`{1,2}|([-*_]\s*){1,}|```.*)$/.test(head)) return false // could still be a marker
    const b = this.block
    b.hang = ''
    this.line = null
    if (/^\s*```/.test(head)) {
      this.fence = !this.fence
      return nl < 0 ? s.length : nl + 1 // the fence line itself isn't shown
    }
    if (this.fence) return 0
    if (whole && /^\s*([-*_])(\s*\1){2,}\s*$/.test(head)) {
      this.#out('─'.repeat(Math.min(40, b.width - b.indent.length)), c.ghost)
      return head.length
    }
    let m
    if ((m = /^(#{1,6})\s+/.exec(head))) {
      this.line = (x) => c.bold(c.bright(x))
      return m[0].length
    }
    if ((m = /^(\s*)[-*+]\s+/.exec(head))) {
      b.hang = m[1] + '  '
      this.#out(m[1] + '• ', c.accent)
      return m[0].length
    }
    if ((m = /^(\s*)(\d{1,3})[.)]\s+/.exec(head))) {
      b.hang = m[1] + ' '.repeat(m[2].length + 2)
      this.#out(`${m[1]}${m[2]}. `, c.accent)
      return m[0].length
    }
    if ((m = /^\s*>\s?/.exec(head))) {
      b.hang = '  '
      this.line = (x) => c.faint(c.italic(x))
      this.#out('│ ', c.ghost)
      return m[0].length
    }
    return 0
  }
  #run(final) {
    let s = this.buf
    let text = ''
    const flush = () => (this.#out(text), (text = ''))
    let i = 0
    while (i < s.length) {
      if (this.sol) {
        const n = this.#lineStart(s.slice(i), final)
        if (n === false) break
        this.sol = false
        i += n
        continue
      }
      const ch = s[i]
      if (ch === '\n') {
        text += ch
        flush()
        Object.assign(this, { sol: true, bold: false, ital: false, code: false, line: null, prev: ' ' })
        i++
        continue
      }
      if (this.fence) {
        text += ch
        i++
        continue
      }
      if (ch === '\\' && /[*_`\\#>-]/.test(s[i + 1] ?? '')) {
        text += s[i + 1]
        this.prev = s[i + 1]
        i += 2
        continue
      }
      if (ch === '`') {
        flush()
        this.code = !this.code
        this.prev = ch
        i++
        continue
      }
      if (!this.code && (ch === '*' || ch === '_')) {
        if (i + 1 >= s.length && !final) break // "*" or "**"? wait for the next character
        const next = s[i + 1] ?? ' '
        if (next === ch) {
          // ** always; __ only around words (not snake__case)
          const after = s[i + 2] ?? ' '
          if (ch === '*' || (this.bold ? !/\w/.test(after) : !/\w/.test(this.prev))) {
            flush()
            this.bold = !this.bold
            this.prev = ch
            i += 2
            continue
          }
        } else if (ch === '*' && (this.ital ? !/\s/.test(this.prev) : /[\s(]/.test(this.prev) && !/\s/.test(next))) {
          flush()
          this.ital = !this.ital
          this.prev = ch
          i++
          continue
        }
      }
      text += ch
      this.prev = ch
      i++
    }
    flush()
    this.buf = s.slice(i) // what's held back
  }
}

// Screen lines saved before answers were drawn as Markdown (older sessions and tabs): the answer's
// and the thinking's own text (not tool output, not code) gets its **bold**, `code`, # headings and
// - bullets drawn now. Already drawn lines have none of these left in that color.
export function markdownRows(lines) {
  const fgOf = (f) => /^\x1b\[(38;[0-9;]*)m/.exec(f('x'))?.[1]
  const base = new Set([fgOf(c.text), fgOf(c.think)].filter(Boolean))
  const info = fgOf(c.info)
  if (!base.size) return lines
  let bold = false
  let fence = false
  return lines.map((line) => {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '')
    if (!plain.trim()) return (bold = false), line
    if (/^[●\s]*```/.test(plain)) return (fence = !fence), line
    if (fence) return line
    const toks = [...line.matchAll(/(\x1b\[[0-9;]*m)|([^\x1b])/gs)]
    const vis = toks.filter((t) => t[2]).map((t) => t[2])
    let fg = ''
    let start = true
    let code = false
    let skip = 0
    let k = -1
    let out = bold ? '\x1b[1m' : ''
    for (const [, esc, ch] of toks) {
      if (esc) {
        const m = /^\x1b\[(38;[0-9;]*|39)m$/.exec(esc)
        if (m) fg = m[1] === '39' ? '' : m[1]
        out += code && m ? `\x1b[${info}m` : esc
        continue
      }
      k++
      if (!base.has(fg) || !info) {
        out += ch
        continue
      }
      if (skip) {
        skip--
        continue
      }
      if (start && ch !== ' ') {
        start = false
        const hashes = /^#{1,6} /.exec(vis.slice(k, k + 7).join(''))
        if (hashes) {
          skip = hashes[0].length - 1
          out += '\x1b[1m'
          continue
        }
        if ('-*+'.includes(ch) && vis[k + 1] === ' ') {
          out += '•'
          continue
        }
      }
      if (ch === '`') {
        code = !code
        out += `\x1b[${code ? info : fg}m`
        continue
      }
      if (!code && ch === '*' && vis[k + 1] === '*') {
        bold = !bold
        out += bold ? '\x1b[1m' : '\x1b[22m'
        skip = 1
        continue
      }
      out += ch
    }
    return out
  })
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

let drewLast = null // the UI (tab) that last drew the screen: only its own last frame can be diffed against
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
    this.freed = [] // asks waiting for the one on screen (a command's picker beside a task's question)
    this.closed = false
    this.rl = null
    this.onInterrupt = null
    this.timer = null
    this.label = ''
    this.showThinking = false // all of it as it comes (Ctrl+O); off: its last two lines, live, above the spinner
    this.thinkTail = '' // the thinking coming in now, for those two lines
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
    this.dialog = null // a box over the screen (the background commands' logs)
  }

  // A dialog: a box in the middle, 70% of the screen each way, the conversation going on around it;
  // drawn again twice a second while it's open. { title, draw(w, h) → lines, key?(key), click?(col, row),
  // close?(), toggle?: the key action that closes it too }. While it's open every key is its own (Ctrl+C
  // aside); Esc, or a click outside it, closes it.
  setDialog(dialog) {
    const was = this.dialog
    this.dialog = dialog
    clearInterval(this.dialogTimer)
    this.dialogTimer = dialog ? setInterval(() => this.render(), 500) : null
    this.dialogTimer?.unref()
    if (was && was !== dialog) was.close?.()
    this.render()
  }
  // Text to read (a command's answer: /help, /context, /diff…) in a dialog: ↑/↓, PgUp/PgDn, Home/End
  // and the wheel scroll it, Esc closes it. Without the full screen: printed.
  showText(title, text) {
    if (!this.full) return this.print(text)
    const all = String(text).split('\n')
    let top = 0
    let page = 10
    let total = 0
    this.setDialog({
      title,
      key: (key) => {
        const by = { up: key.wheel ? -3 : -1, down: key.wheel ? 3 : 1, pageup: -page, pagedown: page, home: -1e9, end: 1e9 }[key.name]
        if (by) top = Math.max(0, Math.min(top + by, total - page))
      },
      draw: (w, h) => {
        const rows = all.flatMap((l) => wrapWords(l, w))
        total = rows.length
        page = h - 2
        top = Math.max(0, Math.min(top, total - page))
        const shown = rows.slice(top, top + page)
        const where = total > page ? `${top + 1}–${Math.min(total, top + page)} of ${total} lines · ↑/↓ PgUp/PgDn scroll · ` : ''
        return [...shown, '', c.faint(`${where}Esc close`)]
      },
    })
  }

  // where it is: { x, y, w, h } (screen cells, from 0; the inside, without the border)
  #dialogBox(cols, rows) {
    const w = Math.max(30, Math.floor(cols * 0.7))
    const h = Math.max(8, Math.floor(rows * 0.7))
    return { x: Math.floor((cols - w) / 2) + 1, y: Math.floor((rows - h) / 2) + 1, w: Math.min(w, cols) - 2, h: Math.min(h, rows) - 2 }
  }
  // d: { title, lines(w, h) → lines (at most h), fill?: always 70% tall too (a log), cursor?(w) →
  // { row, col } in the lines (else hidden) }. The box is 70% of the screen wide, as tall as what's in
  // it (70% at most), in the middle, with a margin inside.
  #drawDialog(cols, rows, d) {
    const PX = 2 // the margin inside: columns each side
    const PY = 1 // and rows above and below
    const max = this.#dialogBox(cols, rows)
    const name = String(d.title ?? '')
    const iwMax = max.w - 2 * PX
    const w = iwMax
    const lines = d.lines(w, max.h - 2 * PY).slice(0, max.h - 2 * PY)
    const h = d.fill ? max.h - 2 * PY : lines.length
    const W = w + 2 * PX
    const x = Math.floor((cols - W - 2) / 2) + 1
    const y = Math.floor((rows - h - 2 * PY - 2) / 2) + 1
    this.dialogAt = { x, y, W, H: h + 2 * PY, cx: x + 1 + PX, cy: y + 1 + PY } // for the mouse (screen cells, from 1)
    const paint = (t) => (background ? `${background}${t.replace(/\x1b\[(0|49)?m/g, (m) => m + background)}\x1b[0m` : `${t}\x1b[0m`)
    const pad = (t, n) => {
      const cut = fit(t, n)
      return cut + ' '.repeat(Math.max(0, n - width(cut.replace(/\x1b\[[0-9;]*m/g, ''))))
    }
    const title = name ? ` ${width(name) > W - 6 ? `${fit(name, W - 7)}…` : name} ` : '' // too long: cut (a question shows all of it inside)
    const row = (i, t) => `\x1b[${y + i};${x}H${paint(t)}`
    let out = row(0, c.brand('╭─') + c.bold(title) + c.brand('─'.repeat(Math.max(0, W - width(title) - 1)) + '╮'))
    const blank = c.brand('│') + ' '.repeat(W) + c.brand('│')
    for (let i = 0; i < PY; i++) out += row(1 + i, blank)
    for (let i = 0; i < h; i++) out += row(1 + PY + i, c.brand('│') + ' '.repeat(PX) + pad(lines[i] ?? '', w) + ' '.repeat(PX) + c.brand('│'))
    // what's in it can be selected (copied), all but its last line (the keys)
    const last = lines.findLastIndex((l) => String(l ?? '').trim())
    for (let i = 0; i < Math.min(h, last); i++) this.regions.set(y + 1 + PY + i, { x: x + 1 + PX, text: fit(lines[i] ?? '', w).replace(/\x1b\[[0-9;]*m/g, '').trimEnd() })
    for (let i = 0; i < PY; i++) out += row(1 + PY + h + i, blank)
    out += row(2 + 2 * PY + h - 1, c.brand('╰' + '─'.repeat(W) + '╯'))
    const cur = d.cursor?.(w)
    return [out, cur ? `\x1b[${y + 1 + PY + cur.row};${x + 1 + PX + Math.min(cur.col, w - 1)}H\x1b[?25h` : '\x1b[?25l']
  }

  // The question being asked, as a dialog: its title; what's typed (the filter, or the answer) with the
  // cursor; a picker's choices. A short list (a few, one to choose) is shown as cards: the name, its
  // description under it. A permission (confirm) shows what just happened (the change or command it
  // asks about) above the choices. A picker's body (pick's option): a few lines saying what's going on.
  #question() {
    const rl = this.rl
    const m = this.menu
    const plain = (t) => String(t ?? '').replace(/\x1b\[[0-9;]*m/g, '')
    const title = plain(rl._prompt).replace(/\s*›?\s*$/, '').replace(/:\s*$/, '').trim()
    const field = (w) => {
      const pre = '› '
      const room = w - pre.length - 1
      const from = Math.max(0, rl.cursor - room)
      return { text: c.brand(pre) + c.bright(rl.line.slice(from, from + room)), col: pre.length + rl.cursor - from }
    }
    const padTo = (t, n) => t + ' '.repeat(Math.max(0, n - width(plain(t))))
    const pick = m.pick
    const choices = pick ? m.items.filter((x) => !x.header) : []
    const cards = pick && !pick.multi && pick.items.length <= 6 && !m.items.some((x) => x.header)
    const body = pick?.body ? String(pick.body).split('\n') : []
    const hint = pick ? (pick.fixed ? '↑↓ move · Enter choose · Esc close' : pick.multi ? '↑↓ move · Space tick · Ctrl+A all · Ctrl+N none · Enter take · Esc cancel · type to filter' : `↑↓ move · Enter choose · Esc cancel${cards ? '' : ' · type to filter'}`) : 'Enter send · Esc cancel'
    let at = 0
    const long = (w) => width(title) > w // too long for the border: all of it inside too
    return {
      title: title.length > 200 ? title.slice(0, 200) : title,
      cursor: (w) => (pick?.fixed || (cards && pick) ? null : { row: at, col: field(w).col }),
      lines: (w, h) => {
        const head = long(w) ? [...wrapAnsi(c.bold(title), w).map((l) => l), ''] : []
        const text = body.flatMap((l) => wrapAnsi(/^https?:\/\/\S+$/.test(l.trim()) ? c.info(l) : c.muted(l), w)) // an address in its link color
        const intro = [...head, ...text, ...(text.length ? [''] : [])]
        if (!pick) {
          const recent = this.askAbout ? this.#recent(w, Math.min(8, h - intro.length - 5)) : []
          const top = [...recent, ...(recent.length ? [c.ghost('─'.repeat(w)), ''] : []), ...intro]
          at = top.length
          return [...top, field(w).text, '', c.faint(hint)]
        }
        let list
        if (cards) {
          list = choices.length
            ? choices.flatMap((x, i) => {
                const on = m.items[m.sel] === x
                const name = on ? `${c.brand('❯')} ${c.bright(c.bold(x.item.label))}` : `  ${c.text(x.item.label)}`
                const desc = x.item.desc ? (on ? `  ${c.muted(x.item.desc)}` : `  ${c.faint(x.item.desc)}`) : null
                const rows = [name, ...(desc ? [desc] : [])].map((r) => (on ? c.select(padTo(r, w)) : r))
                return i < choices.length - 1 && choices.some((y) => y.item.desc) ? [...rows, ''] : rows // a gap between cards that have two lines
              })
            : [c.faint(`nothing matches "${rl.line}"`)]
        }
        const filter = pick.fixed || cards ? [] : [field(w).text, c.ghost('─'.repeat(w))]
        const room = h - intro.length - filter.length - 2
        if (!cards) list = m.items.length ? this.#menuLines(w, Math.max(1, Math.min(room - (m.items.length > room ? 1 : 0), m.items.length))).slice(1) : [c.faint(`nothing matches "${rl.line}"`)]
        const recent = this.askAbout ? this.#recent(w, Math.min(8, room - list.length - 1)) : []
        const top = [...recent, ...(recent.length ? [c.ghost('─'.repeat(w)), ''] : []), ...intro]
        at = top.length
        return [...top, ...filter, ...list, '', c.faint(hint)]
      },
    }
  }

  // The last `n` rows of this task's output at width w (what a question in the middle of the work is about).
  #recent(w, n) {
    if (n <= 0) return []
    const out = []
    const from = Math.max(0, (this.inputMark ?? 0) + 1) // this task's: from after your message
    for (let i = this.log.length - 1; i >= from && out.length < n; i--) out.unshift(...wrapAnsi(this.log[i], w))
    while (out.length && !out[0].trim()) out.shift()
    return out.slice(-n)
  }

  // One model reply: thinking (dim, its own block) kept apart from the answer.
  // who: the model thinking, named over its thinking (helpers say their own: helperUI in agent.js)
  response(who) {
    const t0 = Date.now()
    const secs = () => duration(Date.now() - t0)
    const write = (x) => this.write(x)
    let think = null
    let text = null
    let thought = '' // all of it so far: shown whole when Ctrl+O switches to all of it midway
    const summary = () => {
      this.thinkTail = ''
      if (thought.trim() && !think) {
        // what it thought stays in the conversation: its last two lines (all of it: Ctrl+O)
        const last = thought.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2)
        this.print(c.faint(c.italic(`✻ ${who ? `${who} ` : ''}thought for ${secs()} · Ctrl+O shows all of it`)))
        this.print(c.think(c.italic(last.map((l) => `  ${l}`).join('\n'))))
        this.lastThought = { who, text: thought } // Ctrl+O shows it, now that it's over (showLastThought)
      }
    }
    return {
      think: (t) => {
        if (!t || text) return
        thought += t
        if (!this.showThinking && !think) {
          this.thinkTail = thought.slice(-4000) // its last two lines, live (render)
          return this.spinner(`thinking · ${secs()}`)
        }
        if (!think) {
          this.thinkTail = ''
          this.gap()
          this.print(c.faint(c.italic(`✻ ${who ? `${who} is thinking` : 'Thinking'}…`)))
          const style = (x) => c.think(c.italic(x))
          think = new Block(write, { style })
          if (color) think = new Markdown(think, style)
          return think.push(thought) // what came before the switch too
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
          if (color) text = new Markdown(text, c.text) // plain text (piped, NO_COLOR) stays as the model wrote it
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

  // The thinking that was shown as two lines, all of it (Ctrl+O after it's over): true when there was some
  showLastThought() {
    const t = this.lastThought
    if (!t?.text.trim()) return false
    this.lastThought = null
    this.print(c.faint(c.italic(`✻ ${t.who ? `${t.who}'s` : 'The'} thinking, all of it:`)))
    this.print(c.think(c.italic(t.text.trim().replace(/^/gm, '  '))))
    return true
  }

  #rl() {
    if (this.rl) return this.rl
    const terminal = Boolean(this.input.isTTY && this.out.isTTY)
    const input = terminal ? keyStream(this.input, (...a) => this.#mouse(...a)) : this.input
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
  // mouse: HeartCode takes the mouse (the wheel scrolls the conversation, dragging copies); off,
  // the terminal keeps it, so text is selected and copied the terminal's own way (over SSH too).
  fullscreen({ mouse = false } = {}) {
    if (this.full || !(this.input.isTTY && this.out.isTTY)) return
    this.full = true
    this.mouseOn = mouse ? MOUSE_ON : ''
    // alternate screen · kitty keyboard protocol (Shift/Cmd+Enter are told apart) · bracketed paste
    // · mouse reports (SGR), when HeartCode takes the mouse
    this.out.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[>1u\x1b[?2004h' + this.mouseOn)
    this.frame0 = null
    this.out.on('resize', () => this.render())
    this.#rl()
    process.on('exit', () => this.leaveFullscreen())
  }

  // Hands the terminal to another program (an editor) and takes it back afterwards.
  async outside(fn) {
    const wasFull = this.full
    if (wasFull) this.out.write(MOUSE_OFF + '\x1b[?2004l\x1b[<u\x1b[?1049l')
    this.rl?.pause()
    this.input.setRawMode?.(false)
    try {
      return await fn()
    } finally {
      this.input.setRawMode?.(true)
      this.rl?.resume()
      if (wasFull) {
        this.out.write('\x1b[?1049h\x1b[>1u\x1b[?2004h' + this.mouseOn)
        this.frame0 = null
        this.render()
      }
    }
  }

  // Taking the mouse, or giving it back to the terminal, now (the settings page's switch)
  setMouse(on) {
    this.mouseOn = on ? MOUSE_ON : ''
    if (this.full) this.out.write(on ? MOUSE_ON : MOUSE_OFF)
  }

  // The mouse: the wheel scrolls the conversation; dragging selects in it, copied when let go
  // (the terminal can't select itself while HeartCode takes the mouse). A click or a key clears it.
  // The mouse: the wheel scrolls (a dialog's own text, else the conversation); dragging selects, copied
  // when let go: in the conversation (it stays selected as it scrolls), in a dialog, the header's
  // folder, the input box or the status bar; a double click copies the word under it (an address, a
  // path, a model's name). The terminal can't select itself while HeartCode takes the mouse
  // (Shift+drag, or Option+drag on macOS, still lets it). A click or a key clears a selection.
  #mouse(b, x, y, up) {
    if (!this.full) return
    const modal = Boolean(this.dialog || (this.asking && !this.histOn && this.rl))
    if (b & 64) {
      if ((b & 0xc3) !== 64 && (b & 0xc3) !== 65) return
      if (this.dialog) return this.dialog.key?.({ name: b & 1 ? 'down' : 'up', wheel: true }), this.render()
      return this.#wheel(b & 1 ? -1 : 1) // 64 up, 65 down
    }
    if ((b & 3) !== 0 && !up) return // the left button only (a release says 3 in some terminals)
    const press = !(b & 32) && !up
    if (press) {
      const twice = this.lastClick && Date.now() - this.lastClick.t < 450 && this.lastClick.x === x && this.lastClick.y === y
      this.lastClick = { t: Date.now(), x, y }
      if (twice) return this.#copyWord(x, y)
      this.sel = null
      this.ssel = null
      this.flash = null
      const d = this.dialogAt
      if (modal && d && (x < d.x || y < d.y || x > d.x + d.W + 1 || y > d.y + d.H + 1)) return this.dialog ? this.setDialog(null) : this.render() // outside a dialog: closed (a question stays)
      if (!modal && y <= 3 && this.onTabClick) return this.onTabClick(x - 1) // the tab bar's 3 rows
      if (modal || this.regions?.has(y)) {
        // a dialog, the header, the input, the status bar: a screen selection (a click without a drag: the dialog's own)
        this.ssel = { a: { x, y }, b: { x, y }, moved: false, rows: this.regions, inDialog: modal }
        return this.render()
      }
    }
    if (this.ssel) {
      const sel = this.ssel
      if (x !== sel.b.x || y !== sel.b.y) Object.assign(sel, { b: { x, y }, moved: true })
      if (up) {
        this.ssel = null
        const text = sel.moved && this.#selectedRows(sel).map((r) => r.text.trimEnd()).join('\n').trim()
        if (text) this.#copied(text)
        else if (sel.inDialog && this.dialog && this.dialogAt) this.dialog.click?.(x - this.dialogAt.cx, y - this.dialogAt.cy)
        else if (sel.inDialog) return this.render()
        if (text) this.flash = sel // left lit a moment, so you see what was copied
        if (text) setTimeout(() => this.flash === sel && ((this.flash = null), this.render()), 700).unref?.()
      }
      return this.render()
    }
    if (modal) return
    const v = this.viewAt
    if (!v) return
    const r = Math.min(Math.max(y - 1 - v.first, 0), v.avail - 1) // a drag past the edge stops at it
    const at = { row: v.top + Math.min(r, Math.max(0, v.count - 1)), col: x - 1 }
    if (press) {
      // a press: starts a selection, inside the conversation only
      this.sel = y - 1 >= v.first && y - 1 < v.first + v.count ? { a: at, b: at, moved: false } : null
      return this.render()
    }
    if (!this.sel) return
    if (at.row !== this.sel.b.row || at.col !== this.sel.b.col) Object.assign(this.sel, { b: at, moved: true })
    if (up) {
      const text = this.sel.moved && this.#selected()
      if (!text) this.sel = null
      else this.#copied(text)
    }
    this.render()
  }
  #copied(text) {
    this.notice(`copied ${text.length} character${text.length === 1 ? '' : 's'}${copyText(text) === 'osc' ? ' (through the terminal)' : ''}`)
  }
  // A double click: the word under it (no spaces; quotes and brackets around it left out), copied.
  #copyWord(x, y) {
    this.sel = null
    let row = this.regions?.get(y)
    const v = this.viewAt
    if (!row && v && !this.dialog && y - 1 >= v.first && y - 1 < v.first + v.count) row = { x: 1, text: (this.#rows(this.out.columns || 80)[v.top + y - 1 - v.first] ?? '').replace(/\x1b\[[0-9;]*m/g, '') }
    if (!row) return
    const cells = [] // [char, its column]
    let col = row.x
    for (const ch of row.text) cells.push([ch, col]), (col += width(ch))
    const at = cells.findIndex(([, cx], i) => x >= cx && x < (cells[i + 1]?.[1] ?? cx + 1))
    if (at === -1 || /\s/.test(cells[at][0])) return
    let s = at
    let e = at
    while (s > 0 && !/\s/.test(cells[s - 1][0])) s--
    while (e < cells.length - 1 && !/\s/.test(cells[e + 1][0])) e++
    while (s < e && /["'`(\[{<]/.test(cells[s][0])) s++
    while (e > s && /["'`)\]}>,;:.!?]/.test(cells[e][0]) && !/^https?:\/\/\S+\/$/.test(cells.slice(s, e + 1).map((c) => c[0]).join(''))) e--
    let word = cells.slice(s, e + 1).map((c) => c[0]).join('')
    if (row.path && /[\\/~…]/.test(word)) word = row.path // the folder in the header: all of it, not what fits
    this.#copied(word)
    const sel = { a: { x: cells[s][1], y }, b: { x: cells[e][1], y }, rows: new Map([[y, row]]) }
    this.flash = sel
    setTimeout(() => this.flash === sel && ((this.flash = null), this.render()), 700).unref?.()
    this.render()
  }
  #selRange() {
    const { a, b } = this.sel
    return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a]
  }
  #selected() {
    const [s, e] = this.#selRange()
    const all = this.#rows(this.out.columns || 80)
    const lines = []
    for (let r = s.row; r <= e.row; r++) lines.push(sliceCols((all[r] ?? '').replace(/\x1b\[[0-9;]*m/g, ''), r === s.row ? s.col : 0, r === e.row ? e.col + 1 : Infinity).trimEnd())
    return lines.join('\n').trim()
  }

  // Sends a line at the main prompt as if typed; what was typed there comes back at the next prompt.
  submit(line) {
    this.kept = this.rl.line
    this.rl.line = line
    this.sent = line
    this.menu.items = []
    this.ttyWrite('\r', { name: 'return' })
  }

  // The conversation scrolls (rows up, negative: down); the tabs, the input and the status bar stay.
  scrollBy(n) {
    if (!this.full || this.out.hidden) return
    this.scroll = Math.max(0, this.scroll + n) // Infinity: the top (render keeps it in range)
    this.render()
  }
  // The wheel: a line per event when they come in a stream (a trackpad, a wheel spun fast), three for a
  // lone notch; the screen drawn once a frame however many come (each its own drawing was jerky)
  #wheel(dir) {
    if (!this.full || this.out.hidden) return
    const now = Date.now()
    const step = now - (this.wheelAt ?? 0) < 60 ? 1 : 3
    this.wheelAt = now
    this.scroll = Math.max(0, this.scroll + dir * step)
    this.wheelDraw ??= setTimeout(() => ((this.wheelDraw = null), this.render()), 16)
  }
  page() {
    return Math.max(1, (this.out.rows || 24) - 4)
  }

  // Back to the normal screen, leaving the conversation in the terminal's scrollback.
  leaveFullscreen() {
    if (!this.full) return
    this.full = false
    this.out.write(MOUSE_OFF + '\x1b[?2004l\x1b[<u\x1b[?1049l' + this.log.join('\n').replace(/\n+$/, '') + '\n')
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
    this.log = lines?.length ? markdownRows(lines) : ['']
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
    // A question (a picker, a permission, something to type) is a dialog over the screen; the input
    // box behind it stays as it was.
    const asked = this.asking && !this.histOn && rl
    // The input box: the rows around the cursor, at most INPUT_ROWS; the rules count the rest.
    const typing = !this.asking && rl && this.mainPrompt // working: what's typed meanwhile shows in the box
    const input = asked ? layoutInput(this.mainPrompt ?? ' ', '', 0, cols) : this.asking || typing ? layoutInput(this.asking ? rl._prompt : this.mainPrompt, rl.line, rl.cursor, cols) : { rows: [''], cur: { row: 0, col: 0 } }
    const first = Math.max(0, Math.min(input.cur.row - INPUT_ROWS + 1, input.rows.length - INPUT_ROWS))
    const box = input.rows.slice(first, first + INPUT_ROWS)
    const inputRows = box.length
    const hiddenBelow = input.rows.length - first - box.length
    const rule = c.ghost('─'.repeat(cols))
    const note = (n, arrow) => c.ghost('── ') + c.faint(`${arrow} ${n} more line${n > 1 ? 's' : ''}`) + c.ghost(` ${'─'.repeat(Math.max(0, cols - 18 - String(n).length))}`)
    const statusText = this.status?.(cols) // the status bar (may be several lines, or '' when turned off)
    const below = [hiddenBelow ? note(hiddenBelow, '↓') : rule, ...(statusText ? statusText.split('\n').map((l) => fit(' ' + l, cols)) : [])]
    const bottom = []
    if (this.timer && !this.asking) {
      // the spinner on its own line; the timer (and Esc) on the next, so neither line is crammed
      const request = this.requestSince?.()
      const timer = this.busySince ? `responding ${duration(this.worked())}${request ? ` · waiting for model ${duration(Date.now() - request)}` : ''} · Esc to stop${this.thinkTail ? ' · Ctrl+O shows all thinking' : ''}` : ''
      if (this.thinkTail) {
        // the thinking's last two lines (long ones wrapped), dim, changing as it comes
        const w = Math.max(20, cols - 6)
        const lines = this.thinkTail.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).flatMap((l) => l.match(new RegExp(`.{1,${w}}(\\s|$)|.{${w}}`, 'g')) ?? [l]).map((l) => l.trim()).filter(Boolean)
        for (const l of lines.slice(-2)) bottom.push(fit(`  ${c.think(c.italic(l))}`, cols))
      }
      bottom.push(fit(`${c.brand(FRAMES[this.frame % FRAMES.length])} ${c.muted(this.#label())}`, cols))
      if (timer) bottom.push(fit(`  ${c.faint(timer)}`, cols))
    }
    if (this.scroll) bottom.push(c.dim(`  ↓ ${Number.isFinite(this.scroll) ? this.scroll : 'more'} lines below · held here while you read · Alt+Shift+↓ to the bottom`))
    if (this.ahead.length) {
      const key = (k, d) => `${c.muted(k)} ${c.faint(d)}`
      const sep = c.ghost(' · ')
      bottom.push(fit(`  ${c.bright(`queued ${this.ahead.length}`)}${sep}${c.faint(`when done: ${this.queueMode === 'one' ? 'one by one' : 'all together'}`)}${sep}${[key('Alt+S', 'send first now'), key('Alt+A', 'send all now'), key('Alt+M', 'change when done')].join(sep)}`, cols))
      for (const [i, l] of this.ahead.slice(0, 5).entries()) bottom.push(fit(`  ${c.accent(`${i + 1}.`)} ${c.muted(l.replace(/\s+/g, ' '))}`, cols))
      if (this.ahead.length > 5) bottom.push(c.faint(`  … ${this.ahead.length - 5} more`))
    }
    if (this.noticeText) bottom.push(fit(this.noticeMark ? `${c.warn(this.noticeMark)} ${c.muted(this.noticeText)}` : `  ${c.muted(this.noticeText)}`, cols))
    if (menu.on && !asked) bottom.push(...this.#menuLines(cols))
    bottom.push(first ? note(first, '↑') : rule)
    const head = [...(this.tabBar?.(cols) ?? []), ...(this.header?.(cols) ?? [])].map((l) => fit(l, cols))
    const inputTop = rows - below.length - inputRows + 1 // first row of the input
    const avail = Math.max(0, inputTop - 1 - bottom.length - head.length)
    const all = this.#rows(cols)
    // scrolled up: what you're reading stays put while new lines come in below (back at the bottom: it follows again)
    if (this.scroll && this.rowsWere && this.rowsCols === cols && all.length > this.rowsWere) this.scroll += all.length - this.rowsWere
    ;[this.rowsWere, this.rowsCols] = [all.length, cols]
    this.scroll = Math.min(this.scroll, Math.max(0, all.length - avail))
    const top = Math.max(0, all.length - avail - this.scroll)
    const view = all.slice(top, top + avail)
    this.viewAt = { top, first: head.length, avail, count: view.length } // where the conversation is, for the mouse
    if (this.sel) {
      const [s, e] = this.#selRange()
      for (let i = Math.max(0, s.row - top); i <= Math.min(view.length - 1, e.row - top); i++) view[i] = highlight(view[i], top + i === s.row ? s.col : 0, top + i === e.row ? e.col + 1 : Infinity)
    }
    // a theme with a background: every row painted with it (a style ending its own background goes back to it)
    let row = background ? (line) => `${background}${line.replace(/\x1b\[(0|49)?m/g, (m) => m + background)}\x1b[K\x1b[0m` : (line) => `${line}\x1b[0m\x1b[K`
    let s = '\x1b[?25l'
    // a dialog open: everything behind it dimmed
    if (this.dialog || asked) {
      const plainRow = row
      row = (line) => plainRow(`\x1b[2m${line.replace(/\x1b\[(0|22)?m/g, (m) => m + '\x1b[2m')}`)
    }
    // only the rows that changed since the last frame are written (scrolling rewrote the whole screen
    // every time); a dialog or a selection over it, or a resize: all of them
    const overlay = Boolean(this.dialog || asked || this.ssel || this.flash)
    const was = !overlay && !this.frameOverlay && this.frameSize === `${rows}x${cols}` && drewLast === this ? this.frame0 : null // another tab drew since: all of it
    const frame = []
    const put = (r, line, always = false) => {
      const text = row(line)
      frame[r] = text
      if (always || was?.[r] !== text) s += `\x1b[${r};1H${text}`
    }
    for (let r = 0; r < inputTop - 1; r++) {
      const i = r - head.length
      put(r + 1, i < 0 ? head[r] : i < avail ? (view[i] ?? '') : bottom[i - avail])
    }
    // the input and what's under it, every time: readline clears from the cursor down on its own (Enter)
    box.forEach((line, i) => put(inputTop + i, line, true))
    below.forEach((line, i) => put(inputTop + inputRows + i, line, true))
    ;[this.frame0, this.frameOverlay, this.frameSize] = [frame, overlay, `${rows}x${cols}`]
    drewLast = this
    // what can be selected besides the conversation (screen rows from 1): the header's first line (the
    // project's folder), the input box, the status bar; with a dialog open, only what's in it
    const plain = (t) => String(t ?? '').replace(/\x1b\[[0-9;]*m/g, '')
    const tabRows = this.tabBar?.(cols)?.length ?? 0
    this.regions = new Map()
    if (this.header && head[tabRows] !== undefined) this.regions.set(tabRows + 1, { x: 1, text: plain(head[tabRows]), path: this.folder }) // path: the whole folder (shown cut when long)
    box.forEach((line, i) => this.regions.set(inputTop + i, { x: 1, text: plain(line) }))
    below.slice(1).forEach((line, i) => this.regions.set(inputTop + inputRows + 1 + i, { x: 1, text: plain(line) }))
    let cursor
    if (this.dialog || asked) {
      this.regions = new Map()
      const [box, cur] = this.#drawDialog(cols, rows, this.dialog ? { title: this.dialog.title, fill: this.dialog.fill, lines: (w, h) => this.dialog.draw(w, h) } : this.#question())
      s += box
      cursor = cur // a question: its cursor in the box; else hidden
    } else {
      this.dialogAt = null
      cursor = this.asking || typing ? `\x1b[${inputTop + input.cur.row - first};${input.cur.col + 1}H\x1b[?25h` : `\x1b[${inputTop};1H`
    }
    out.write(s + this.#screenSelection() + cursor)
  }

  // A selection outside the conversation (in a dialog, the header, the input, the status bar), or a
  // word just double-clicked: drawn reversed over what's there.
  #screenSelection() {
    const sel = this.ssel ?? this.flash
    if (!sel) return ''
    let out = ''
    for (const { y, x, text } of this.#selectedRows(sel)) out += `\x1b[${y};${x}H\x1b[7m${text}\x1b[27m`
    return out
  }
  // The rows a screen selection covers: [{ y, x, text }] (x: where the selected part starts).
  #selectedRows(sel) {
    const [a, b] = sel.a.y < sel.b.y || (sel.a.y === sel.b.y && sel.a.x <= sel.b.x) ? [sel.a, sel.b] : [sel.b, sel.a]
    const out = []
    for (let y = a.y; y <= b.y; y++) {
      const r = sel.rows?.get(y) ?? this.regions?.get(y)
      if (!r) continue
      const end = r.x + width(r.text) // just past its last cell
      const from = Math.max(r.x, y === a.y ? a.x : r.x)
      const to = Math.min(end, y === b.y ? b.x + 1 : end)
      if (to > from) out.push({ y, x: from, text: sliceCols(r.text, from - r.x, to - r.x) })
    }
    return out
  }


  // Keys while the prompt is up: PgUp/PgDn scroll; with the menu open, ↑↓ choose, Tab completes,
  // Enter picks (and runs a command), Esc hides it.
  #keys(rl) {
    const out = rl._writeToOutput.bind(rl)
    rl._writeToOutput = (t) => (this.full ? undefined : out(t)) // in full screen, render() draws the input
    const write = rl._ttyWrite.bind(rl)
    this.ttyWrite = write
    rl._ttyWrite = (s, key = {}) => {
      if (!this.full) return write(s, key)
      if (this.sel || this.ssel) (this.sel = this.ssel = null), this.render() // a key ends a selection
      const bound = !(key.ctrl && key.name === 'c') && this.keys[keyId(key, s)] // ~/.heart/keybindings.json
      // a dialog: its keys, all of them; Esc (or its own key) closes it; Ctrl+C still stops and quits
      if (this.dialog && !(key.ctrl && key.name === 'c')) {
        if (key.name === 'escape' || (bound && bound === this.dialog.toggle)) return this.setDialog(null)
        return this.dialog.key?.(key, s), this.render()
      }
      if (this.recording) return this.recording.key(key, bound) // voice: Space, Enter, Esc; the rest waits
      // a fixed dialog (pick(…, { fixed })): only its keys, nothing typed and no shortcuts
      if (this.menu.pick?.fixed && !['up', 'down', 'return', 'escape'].includes(key.name) && !(key.ctrl && key.name === 'c')) return
      // In a multi-select: Ctrl+A ticks all, Ctrl+N unticks all (before tab shortcuts claim Ctrl+N)
      if (this.menu.pick?.multi && key.ctrl && (key.name === 'a' || key.name === 'n')) {
        for (const x of this.menu.pick.items) if (!x.only) x.checked = key.name === 'a'
        return this.refreshMenu()
      }
      // Option+← sends what Alt+B does in many terminals (Esc b): with text in the box, it's the word jump
      if (bound === 'background_log' && this.rl.line) return write(s, key)

      if (bound) return this.#action(bound, write)
      // Space in an empty box starts voice straight away — no /voice needed (only when it's set up,
      // and not in a menu or a mid-task yes/no question, where Space types a space as usual)
      if (key.name === 'space' && !this.rl.line && !this.menu.pick && !(this.asking && !this.histOn) && this.voiceReady()) return this.#action('voice', write)
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
      if (key.name === 'pageup' || key.name === 'pagedown') return this.scrollBy(key.name === 'pageup' ? this.page() : -this.page())
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
        if (m.pick.multi && key.name === 'space' && it && !it.item.only) {
          it.item.checked = !it.item.checked // Space ticks; Enter takes the ticked ones; Ctrl+A/N all/none (handled earlier, before tab shortcuts)
          return this.refreshMenu()
        }
        if (key.name === 'escape' || (key.name === 'return' && it)) {
          const ticked = m.pick.items.filter((x) => x.checked)
          m.pick.chosen = key.name !== 'return' ? null : m.pick.multi ? (ticked.length && !it.item.only ? ticked : [it.item]) : it.item // only: an entry that stands alone (Enter on it takes just it)
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

  // Typing while HeartCode works: the text stays in the box; Enter queues it (shown above the
  // Esc to stop a running task asks for a second Esc within 2.5s first, so a stray tap doesn't kill
  // the work. (Flushing the queue with send_first/send_all still stops at once — that's deliberate.)
  escStop() {
    if (!this.onEscape) return
    if (Date.now() - (this.escArm ?? 0) < 2500) return (this.escArm = 0), this.onEscape()
    this.escArm = Date.now()
    this.notice('Press Esc again to stop', 2500)
  }

  // input), sent when the answer is done, or at once with send_first / send_all. Esc stops the task.
  #typeAhead(s, key, write) {
    const rl = this.rl
    const m = this.menu
    const it = m.on && m.items[m.sel] // a suggestion is highlighted (commands/@files show while working too)
    if (key.name === 'escape') {
      if (m.on) return (m.off = rl.line), this.#suggestWhileWorking() // first Esc just closes the suggestions
      return this.escStop()
    }
    if (key.name === 'tab' && key.shift) return this.setPermission(PERMISSIONS[(PERMISSIONS.findIndex(([p]) => p === this.permission) + 1) % PERMISSIONS.length][0])
    if (key.name === 'pageup' || key.name === 'pagedown') return this.scrollBy(key.name === 'pageup' ? this.page() : -this.page())
    if (it && (key.name === 'up' || key.name === 'down')) {
      m.sel = (m.sel + (key.name === 'up' ? m.items.length - 1 : 1)) % m.items.length
      return this.render()
    }
    if (m.on && key.name === 'tab') {
      if (it) (this.#accept(it), (m.off = rl.line))
      return this.#suggestWhileWorking()
    }
    if (key.name === 'return' && !key.meta && !this.pasting) {
      if (it && rl.line.slice(it.start, it.end) !== it.value) this.#accept(it) // complete first, then send on the next Enter
      if (it && rl.line.slice(it.start, it.end) !== it.value + (it.space ? ' ' : '')) return
      const line = rl.line.trim()
      rl.line = ''
      rl.cursor = 0
      m.items = []
      m.off = null
      if (line && !this.onNow?.(line)) this.ahead.push(line) // a command that leaves the conversation alone runs now, beside the task (onNow); the rest when it's done (the queue)
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
    this.#suggestWhileWorking()
  }

  // Commands and @files suggested while the model works (type-ahead), the same menu as at the prompt.
  #suggestWhileWorking() {
    const rl = this.rl
    const before = rl.line.slice(0, rl.cursor)
    this.menu.on = this.full && !this.pasting && this.menu.off !== rl.line && (/^\/\S*$/.test(rl.line.trimStart()) || /(^|\s)@\S*$/.test(before))
    if (this.menu.off !== rl.line) this.menu.off = this.menu.on ? this.menu.off : null
    if (this.menu.on) this.refreshMenu()
    else (this.menu.items = []), this.render()
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
      case 'voice':
        if (m.pick || (this.asking && !this.histOn)) return
        return this.dictateIn()
      case 'background_log':
        return this.onPanel?.()
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
      case 'send_first':
      case 'send_all':
        if (!this.ahead.length) return this.notice('Nothing queued: while it works, type a message and press Enter', 2500)
        this.sendNow = what === 'send_all' ? 'all' : 'first'
        if (this.asking && !this.histOn) this.cancelAsk() // a question in the middle of the work: answered no
        return this.onEscape?.() // stops the answer; the next prompt takes the queue (ask)
      case 'queue_mode':
        this.queueMode = this.queueMode === 'one' ? 'all' : 'one'
        this.onQueueMode?.(this.queueMode)
        return this.notice(`When an answer is done: ${this.queueMode === 'all' ? 'all queued messages go together' : 'the next queued message goes'}`, 2500)
      default:
        if (/^tab_\d$/.test(what)) return this.onTab?.(what)
        break
      case 'scroll_up':
      case 'scroll_down':
        return this.scrollBy(what === 'scroll_up' ? this.page() : -this.page())
      case 'scroll_line_up':
      case 'scroll_line_down':
        return this.scrollBy(what === 'scroll_line_up' ? 3 : -3)
      case 'scroll_top':
      case 'scroll_bottom':
        return this.scrollBy(what === 'scroll_top' ? Infinity : -Infinity)
    }
    if (!this.asking) {
      this.ahead.push(what)
      return this.render()
    }
    if (!this.histOn || m.pick) return // only at the main prompt, not in a question or picker
    rl.line = what
    this.sent = what
    m.items = []
    write('\r', { name: 'return' })
  }

  // Voice: listening at once; the words go where the cursor is, in the box (also while it works), and
  // on Enter they're sent: at the prompt as if Enter was pressed, while it works as a message typed
  // then (a command that can run beside the task runs; the rest waits in the queue).
  async dictateIn(send = true) {
    const text = await this.dictate()
    if (!text) return
    const rl = this.rl
    const pad = rl.line && !/\s$/.test(rl.line.slice(0, rl.cursor)) ? ' ' : ''
    rl.line = rl.line.slice(0, rl.cursor) + pad + text + rl.line.slice(rl.cursor)
    rl.cursor += pad.length + text.length
    if (!send) return this.render()
    if (this.asking && this.histOn) {
      this.sent = rl.line
      this.menu.items = []
      return this.ttyWrite('\r', { name: 'return' })
    }
    if (this.asking) return this.render() // a question's answer: in its box, to check and send
    const line = rl.line.trim()
    rl.line = ''
    rl.cursor = 0
    if (line && !this.onNow?.(line)) this.ahead.push(line)
    this.render()
  }

  // Voice mode (/voice, or a key bound to voice): Space to talk, Space again to pause (and again to go on), Enter
  // (or the voice key) to finish, Esc to cancel. While you speak, what's been heard so far shows in
  // the input box (where the cursor was), redone about every second with the quickest model; a
  // stretch you pause or finish is done again with the best one. Returns the words, or null (Esc,
  // or it failed: said in a notice); the box is as it was, for the caller to put them in.
  // Is voice set up and usable (a provider/whisper and its key)? Space-to-talk and the header hint
  // only show up when it is; otherwise Space types a space as normal.
  voiceReady() {
    const { voice = {}, providers = {} } = this.voiceConfig?.() ?? {}
    return !voiceProblem(voice, providers)
  }

  // voiceConfig() → { voice, providers }: set by the app.
  async dictate() {
    if (this.recording) return null
    const { voice = {}, providers = {} } = this.voiceConfig?.() ?? {}
    const problem = voiceProblem(voice, providers)
    if (problem) return this.notice(problem, 8000), null
    const rl = this.rl
    const base = { line: rl?.line ?? '', cursor: rl?.cursor ?? 0 }
    const keep = !this.asking // working: the spinner line stays the task's
    const every = voice.provider ? 3000 : 900 // a provider's API is asked less often than whisper here
    let said = '' // the stretches finished (paused), as the best model heard them
    let live = '' // the stretch going on, as heard so far
    let mic = null
    let busy = Promise.resolve() // a stretch being transcribed (one at a time, in order)
    let failed = null
    let finishing = false
    const words = () => [said, live].filter(Boolean).join(' ')
    const showBox = () => {
      if (!rl) return
      const before = base.line.slice(0, base.cursor)
      const t = words()
      const pad = t && before && !/\s$/.test(before) ? ' ' : ''
      rl.line = before + pad + t + base.line.slice(base.cursor)
      rl.cursor = before.length + pad.length + t.length
    }
    const draw = () => {
      showBox()
      const keys = 'Enter to send · Esc to cancel'
      if (finishing) return this.notice('transcribing the last part… (Esc cancels)', 60 * 60_000, '')
      this.notice(mic ? `${c.red('●')} listening ${Math.floor(mic.seconds())}s · Space to pause · ${keys}` : `paused · Space to go on · ${keys}`, 60 * 60_000, '')
    }
    const heard = (pcm, fast) =>
      transcribePcm(pcm, voice, providers, { fast }).catch((e) => {
        log('voice', e.message)
        failed = e.message
        return null
      })
    // while a stretch goes on: what's been said of it so far, again and again
    const follow = async (m) => {
      while (mic === m) {
        await new Promise((r) => setTimeout(r, every))
        if (mic !== m || m.seconds() < 0.6) continue
        const t = await heard(m.pcm(), true)
        if (mic === m && t !== null) (live = t), draw()
      }
    }
    const start = () => {
      failed = null
      mic = listen()
      follow(mic)
      draw()
    }
    // a pause: that stretch, done again with the best model, kept
    const pause = () => {
      const m = mic
      mic = null
      draw()
      busy = busy.then(async () => {
        const pcm = await m.stop().catch((e) => ((failed = e.message), null))
        const t = pcm && (await heard(pcm, false))
        said = [said, t ?? live].filter(Boolean).join(' ')
        live = ''
        draw()
      })
    }
    start() // listening at once: the key that got here was the go-ahead
    const tick = setInterval(() => mic && draw(), 1000)
    let go = await new Promise((resolve) => {
      this.recording = {
        key: (key, bound) => {
          if (key.name === 'escape') resolve(false)
          else if (key.name === 'return' || bound === 'voice') resolve(true)
          else if (key.name === 'space') mic ? pause() : start()
        },
      }
    })
    clearInterval(tick)
    // the last part being transcribed: keys still wait (an Enter now would send half of it); Esc cancels
    this.recording = { key: (key) => key.name === 'escape' && (go = false) }
    if (!go) mic?.cancel(), (mic = null)
    else if (mic) (finishing = true), pause()
    await busy
    this.recording = null
    if (rl) [rl.line, rl.cursor] = [base.line, base.cursor] // the caller puts the words in
    const text = go ? words().trim() : ''
    log('voice', go ? text : '(cancelled)')
    this.notice(go && !text ? failed ?? 'heard nothing' : '', failed ? 8000 : 3000)
    if (keep) this.render()
    return text || null
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

  #menuLines(cols, rows) {
    const m = this.menu
    const width = cols - 1
    const max = rows ?? (m.pick ? Math.max(5, (this.out.rows || 24) - 8) : MENU_ROWS)
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
    const how = m.pick?.multi ? '↑↓ move · Space tick · Ctrl+A all · Ctrl+N none · Enter take · Esc cancel · type to filter' : '↑↓ move · Enter choose · Esc cancel · type to filter'
    if (m.pick) lines.unshift(c.faint(m.items.length ? how : `nothing matches "${this.rl.line}" · Esc cancel`))
    return lines
  }


  // initial: text already typed in, ready to edit. suggest: show the suggestion menu while typing.
  // A one-line message just above the input until `ms` pass or a key is pressed ('' hides it).
  // mark: what goes before it ('!' a warning; '' none, for a state like voice listening)
  notice(text, ms = 2000, mark = '!') {
    this.noticeText = text
    this.noticeMark = mark
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
  // One question on screen at a time: a command run beside a task (onNow) and the task can both ask.
  async #free() {
    while (this.full && this.asking) await new Promise((r) => this.freed.push(r))
  }

  ask(prompt, { initial = '', suggest = false, history = false } = {}) {
    if (this.dialog && !history) this.setDialog(null) // a question (a permission, a picker) needs you: the dialog makes way
    if (this.full && this.asking) return this.#free().then(() => this.ask(prompt, { initial, suggest, history }))
    if (history && this.kept) [initial, this.kept] = [initial || this.kept, ''] // typed before a submit()
    this.stopSpin()
    const rl = this.#rl()
    if (history) this.mainPrompt = prompt
    if (history && this.ahead.length) {
      // all: every queued message as one (commands stay, run after, one each); else the first one
      const how = this.sendNow ?? (this.queueMode === 'one' ? 'first' : 'all')
      this.sendNow = null
      const msgs = this.ahead.filter((x) => !this.isCommand(x))
      const together = how === 'all' && msgs.length > 1
      const l = together ? msgs.join('\n\n') : this.ahead.shift()
      if (together) this.ahead = this.ahead.filter((x) => this.isCommand(x))
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
    if (this.busySince && !history) this.onWaiting?.(prompt) // asked mid-task: you may be away (Telegram)
    this.menu.on = Boolean(suggest && (this.suggest || this.menu.pick) && this.full)
    this.histOn = history
    this.histAt = -1
    this.draft = ''
    if (this.full) {
      this.asking = true
      this.askedAt = Date.now()
      this.render() // cursor to the input row
    }
    rl.setPrompt(prompt)
    rl.prompt(true) // keep the cursor where it is: text typed while the model worked stays put, cursor and all (rl.prompt() would snap it to 0)
    // put in the box as it is: typed in (rl.write), each line break would be an Enter
    if (initial && rl.terminal && this.full) [rl.line, rl.cursor] = [initial, initial.length]
    else if (initial && rl.terminal) rl.write(initial.replace(/\n/g, ' '))
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
          if (this.busySince) this.waited += Date.now() - this.askedAt // waiting on you isn't HeartCode working
          this.scroll = 0
          const pick = this.menu.pick
          const echo = prompt.replace(/^ /, '') // the input's margin isn't part of the conversation
          this.inputMark = this.log.length - 1 // where this message starts, for /rewind
          const picked = Array.isArray(pick?.chosen) ? pick.chosen.map((x) => x.label).join(', ') : pick?.chosen?.label
          if (pick?.quiet) this.render()
          else if (pick) this.write(echo + (picked ?? c.dim(pick.closedAs ?? 'cancelled')) + '\n')
          else if (l !== null && history && this.isCommand(l.trim()) && !/^\s*\/skill:/.test(l)) this.notice(/^\S+/.exec(l.trim())[0], 3000, '›') // a command isn't part of the conversation: its name for a moment (not its arguments: maybe a key)
          else if (l !== null) this.write(echo + c.bright(l.replace(/\n/g, '\n' + ' '.repeat(width(echo.replace(/\x1b\[[0-9;]*m/g, ''))))) + '\n')
          else this.render()
        }
        if (draft) [rl.line, rl.cursor] = [draft, draft.length]
        resolve(l)
        this.freed.shift()?.()
      }),
    )
  }

  // as: what the dialog it closes says it came to (the default: cancelled)
  cancelAsk(as) {
    if (as && this.menu.pick) this.menu.pick.closedAs = as
    for (const w of this.waiters.splice(0)) w(null)
  }

  // Interactive list: type to filter, ↑↓ move, Enter chooses, Esc cancels (→ null).
  // items: [{ label, desc?, group?, current? }]; without full screen, a numbered list.
  // multi: tick several with Space; returns the ticked items (an array), or null.
  // quiet: the question and answer aren't left in the conversation (a question before it starts).
  // fixed: a dialog: no typing to filter, no other keys meanwhile.
  async pick(title, items, { filter = '', multi = false, quiet = false, fixed = false, body = '' } = {}) {
    if (!this.full) {
      items.forEach((it, i) => this.print(`  ${i + 1}. ${it.group ? `${it.group} · ` : ''}${it.label}${it.desc ? '  ' + c.dim(it.desc) : ''}`))
      const a = await this.ask(`${title} ${c.dim(multi ? '(numbers, like 1,3)' : '(number)')}: `)
      if (!multi) return items[Number(a) - 1] ?? null
      const chosen = String(a ?? '').split(/[\s,]+/).map((n) => items[Number(n) - 1]).filter(Boolean)
      return chosen.length ? chosen : null
    }
    await this.#free()
    if (multi) for (const it of items) if (!it.only) it.checked ??= false
    this.menu.pick = { items, chosen: null, multi, quiet, fixed, body }
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
      this.askAbout = true // the dialog shows what it's about (the diff, the command) above the choices
      try {
        return await this.#confirmFull(question)
      } finally {
        this.askAbout = false
      }
    }
    const a = await this.ask(`${c.yellow('?')} ${question} ${c.dim('[Y/n or type feedback]')} `)
    if (a === null) return false
    const t = a.trim()
    if (/^(y|yes)?$/i.test(t)) return true
    if (/^(n|no)$/i.test(t)) return false
    return t
  }
  async #confirmFull(question) {
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
  // A /command's output is taken back out of the conversation once it's done (nothing of a command
  // stays): one line shown as a notice for a moment, more in a box (Esc closes). Not when the command
  // put another conversation on the screen (/resume, /clear_chat…): that's what it's for.
  mark() {
    return { log: this.log, at: this.log.length - 1, base: this.log.at(-1), tail: this.tail, sgr: this.sgr }
  }
  unmark(m, title) {
    if (this.log !== m.log || this.log.length <= m.at || !this.log[m.at].startsWith(m.base)) return this.render()
    const text = [this.log[m.at].slice(m.base.length), ...this.log.slice(m.at + 1)].join('\n').replace(/^(\s*\n)+|\s+$/g, '')
    this.log.length = m.at + 1
    this.log[m.at] = m.base
    Object.assign(this, { tail: m.tail, sgr: m.sgr })
    const lines = text ? text.split('\n') : []
    if (lines.length === 1 || (lines.length && this.dialog)) this.notice(lines[0], 4000, '›')
    else if (lines.length) this.showText(title, text)
    else this.render()
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
    const left = () => Math.max(0, Math.ceil((until - Date.now()) / 1000)) * 1000
    if (next) return this.spinner(() => `${c.yellow('⚠')} ${why} · trying ${next.provider} · ${next.model}${left() ? ` in ${duration(left())} (all failed once)` : ''} (attempt ${attempt})`)
    this.spinner(() => `${c.yellow('⚠')} retrying in ${duration(left())} (attempt ${attempt}) · ${why}`)
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
    this.waited = 0
    this.spinner('working')
  }
  // time spent on the work so far, without the time it waited for your answers
  worked() {
    return Date.now() - this.busySince - this.waited - (this.asking ? Date.now() - this.askedAt : 0)
  }
  idle() {
    this.busySince = null
    this.stopSpin()
  }

  close() {
    this.busySince = null // closing ends any work in progress: the spinner stops too
    clearInterval(this.dialogTimer)
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
