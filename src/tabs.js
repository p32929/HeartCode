import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { c, width } from './ui.js'
import { logContext } from './log.js'

// Several HeartCodes on one screen. Each tab has its own UI (on its own input and output) and its
// own conversation; the terminal's keys go to the tab on screen, and only that tab draws. Tabs in
// the background keep working; the bar on top says which work (●), wait for you (?) or are done (✓).
export class Tabs {
  // open(tab, opts): makes tab.ui (on tab.input/tab.output, with tab.hooks: the bar, the tab keys)
  // and tab.app right away, then runs the tab until it's closed (a promise).
  constructor(open, { input = process.stdin, output = process.stdout } = {}) {
    Object.assign(this, { open, input, output })
    this.list = []
    this.at = null // the tab on screen
    this.onShow = null // (tab) → after a tab comes on screen
    this.onChange = null // () → after a tab is opened, closed or shown
    this.quitting = false // all of HeartCode is quitting: closing a tab doesn't take it off the list
    this.done = new Promise((resolve) => (this.empty = resolve)) // the last tab closed
    input.on('data', (d) => this.at?.input.write(d))
    output.on('resize', () => this.at?.output.emit('resize'))
    // the bar shows what tabs in the background do: redrawn when that changes
    this.timer = setInterval(() => {
      if (this.list.length < 2) return // no bar
      const now = this.list.map((t) => this.state(t)).join()
      if (now === this.seen) return
      this.seen = now
      this.at?.ui.render()
    }, 300)
    this.timer.unref()
  }

  add(opts = {}) {
    const real = { input: this.input, output: this.output }
    const tab = { name: opts.name ?? '' }
    const on = () => this.at === tab
    tab.input = new PassThrough()
    tab.input.isTTY = true
    tab.input.setRawMode = (raw) => on() && real.input.setRawMode?.(raw)
    tab.input.on('pause', () => on() && real.input.pause())
    tab.input.on('resume', () => on() && real.input.resume())
    tab.output = Object.assign(new EventEmitter(), { isTTY: true, write: (s) => (on() ? real.output.write(s) : true) })
    for (const k of ['columns', 'rows']) Object.defineProperty(tab.output, k, { get: () => real.output[k] })
    Object.defineProperty(tab.output, 'hidden', { get: () => !on() })
    tab.hooks = { tabBar: (cols) => this.bar(cols), onTab: (what) => this.key(what) }
    this.list.push(tab)
    this.at = tab
    tab.id = this.made = (this.made ?? 0) + 1 // for its log file: tab-1.log… (its place in the bar can change)
    const run = logContext.run({ tab: tab.id }, () => this.open(tab, opts))
    // Closing a tab while others are open: off the screen first, so it doesn't take the terminal
    // (raw mode, the full screen) with it.
    const close = tab.ui.close.bind(tab.ui)
    tab.ui.close = () => {
      if (this.list.length > 1 && this.list.includes(tab) && !this.quitting) this.remove(tab)
      close()
    }
    this.onShow?.(tab) // on screen already: it drew its first prompt, with the bar
    this.onChange?.()
    Promise.resolve(run).finally(() => {
      if (this.list.includes(tab)) tab.ui.close()
      if (!this.list.includes(tab)) return
      this.list.splice(this.list.indexOf(tab), 1)
      this.empty()
    })
    return tab
  }

  show(tab) {
    if (!tab) return
    this.at = tab
    tab.unseen = false
    this.input.setRawMode?.(true)
    this.input.resume()
    this.onShow?.(tab)
    this.onChange?.()
    tab.ui.wrapped = []
    tab.ui.render()
  }

  remove(tab) {
    const i = this.list.indexOf(tab)
    this.list.splice(i, 1)
    if (this.at === tab) this.show(this.list[Math.min(i, this.list.length - 1)])
    else this.onChange?.()
  }

  // new_tab, close_tab, next_tab, prev_tab, tab_1…tab_9 (keys, from the UI); none while locked
  // (the settings page is on: its dialog holds the screen)
  key(what) {
    if (this.locked) return
    const i = this.list.indexOf(this.at)
    if (what === 'close_tab') return this.at.ui.onCloseTab?.()
    if (what === 'new_tab') return this.add({ root: this.at.app.root })
    if (what === 'next_tab' || what === 'prev_tab') return this.show(this.list[(i + (what === 'next_tab' ? 1 : this.list.length - 1)) % this.list.length])
    const n = /^tab_(\d)$/.exec(what)?.[1]
    if (n) this.show(this.list[Number(n) - 1])
  }

  // working, waiting for an answer, or done since you last looked at it
  state(t) {
    const ui = t.ui
    const working = Boolean(ui.busySince || ui.timer) && !ui.asking
    if (t.working && !working && t !== this.at) t.unseen = true
    t.working = working
    return ui.asking && !ui.histOn ? '?' : working ? '●' : t.unseen ? '✓' : ''
  }

  // The tab bar, three rows: tabs drawn as tabs, the one on screen open onto it (its bottom
  // edge missing), the others closed off. Number, name, and what it's doing.
  //  ╭─────────────╮ ╭──────────────╮
  //  │ 1 heart_cli │ │ 2 fix tests ●│  + Ctrl+T new tab
  // ─╯             ╰─┴──────────────┴──────────────────
  bar(cols = 100) {
    const mark = { '?': c.warn('?'), '●': c.brand('●'), '✓': c.ok('✓') }
    const room = Math.max(6, Math.floor((cols - 24) / this.list.length) - 7) // a name's cells, so they all fit
    let [top, mid, bottom] = [' ', ' ', c.ghost('─')]
    this.list.forEach((t, i) => {
      const on = t === this.at
      const s = this.state(t)
      const name = cut(t.name || t.app?.chat?.title || pathTail(t.app?.root), room)
      const text = ` ${i + 1} ${name}${s ? ' ' + s : ''} `
      const w = width(text)
      const line = on ? c.brand : c.ghost
      const label = ` ${on ? c.bright(c.bold(`${i + 1} ${name}`)) : c.muted(`${i + 1} ${name}`)}${s ? ' ' + mark[s] : ''} `
      top += line(`╭${'─'.repeat(w)}╮`) + ' '
      mid += line('│') + label + line('│') + ' '
      bottom += (on ? c.brand(`╯${' '.repeat(w)}╰`) : c.ghost(`┴${'─'.repeat(w)}┴`)) + c.ghost('─')
    })
    const hint = this.list.length > 1 ? 'Ctrl+T new · Ctrl+Q close · Ctrl+N/P switch' : 'Ctrl+T new tab'
    mid += ` ${c.faint(hint)}`
    bottom += c.ghost('─'.repeat(Math.max(0, cols - width(bottom.replace(/\x1b\[[0-9;]*m/g, '')))))
    return [top, mid, bottom]
  }
}

// At most n cells, with … when cut.
function cut(s, n) {
  if (width(s) <= n) return s
  let out = ''
  for (const ch of s) {
    if (width(out + ch) > n - 1) break
    out += ch
  }
  return out + '…'
}

const pathTail = (p = '') => p.split(/[\\/]/).filter(Boolean).pop() ?? p
