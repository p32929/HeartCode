// Checks HeartCode runs itself, so "done" is something proven rather than claimed: a handoff's check
// (a shell command that must exit 0, or "page <file|url>": a web page opened in a real browser) and
// the browser the skill tests use. The browser: Chrome, Chromium or Edge, headless, driven over the
// DevTools protocol (Node's own WebSocket), with nothing installed (none on the computer: a headless
// one is fetched once, ensureChrome). No browser at all: a page gets a static check instead (the
// files it uses are there, its scripts parse), and says so.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { HOME } from './config.js'
import { log } from './log.js'
import { fetch } from './http.js' // not the built-in one: see http.js

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tail = (t, n = 2500) => ((t = String(t).trim()), t.length > n ? `…${t.slice(-n)}` : t)

// --- a browser ---
let chrome // its path, once found ('' when there's none)
export function findChrome() {
  if (chrome !== undefined) return chrome
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  const win = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((v) => (process.env[v] ? [path.join(process.env[v], 'Google/Chrome/Application/chrome.exe'), path.join(process.env[v], 'Microsoft/Edge/Application/msedge.exe')] : []))
  const named = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  const which = (n) => {
    try {
      return execFileSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim()
    } catch {
      return ''
    }
  }
  chrome = [process.env.CHROME_PATH, ...mac, ...win].find((p) => p && fs.existsSync(p)) ?? named.map(which).find(Boolean) ?? fetched() ?? ''
  return chrome
}

// No browser on the computer: Google's headless one for testing (Chrome for Testing's
// chrome-headless-shell, about 100 MB), fetched once into ~/.heart/browser. note(text): what's happening.
const SHELL = { 'linux-x64': 'linux64', 'linux-arm64': 'linux-arm64', 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'win32-x64': 'win64', 'win32-ia32': 'win32' }[`${process.platform}-${process.arch}`]
const BROWSERS = path.join(HOME, 'browser')
const shellPath = (dir) => path.join(dir, `chrome-headless-shell-${SHELL}`, `chrome-headless-shell${process.platform === 'win32' ? '.exe' : ''}`)
function fetched() {
  if (!SHELL || !fs.existsSync(BROWSERS)) return undefined
  const got = fs.readdirSync(BROWSERS).sort().reverse().map((v) => shellPath(path.join(BROWSERS, v))).find((f) => fs.existsSync(f))
  return got
}
let fetching = null
export async function ensureChrome(note = () => {}) {
  if (findChrome()) return chrome
  if (!SHELL) return ''
  return (fetching ??= (async () => {
    try {
      note('no browser here: fetching a headless one for page checks (once, about 100 MB)')
      const list = await (await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json', { signal: AbortSignal.timeout(30_000) })).json()
      const stable = list.channels.Stable
      const url = stable.downloads['chrome-headless-shell'].find((d) => d.platform === SHELL)?.url
      if (!url) return ''
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok) throw new Error(`${res.status} from ${url}`)
      const dir = path.join(BROWSERS, stable.version)
      unzip(Buffer.from(await res.arrayBuffer()), dir)
      chrome = fs.existsSync(shellPath(dir)) ? shellPath(dir) : ''
      note(chrome ? `browser ready: ${chrome}` : "couldn't unpack the browser")
      return chrome
    } catch (e) {
      note(`couldn't fetch a browser: ${e.message}`)
      return ''
    } finally {
      fetching = null
    }
  })())
}

// A zip archive into dest (stored or deflated entries, with their file modes): Node has no unzip,
// and not every system has one either (GNU tar can't read zips).
export function unzip(buf, dest) {
  let end = buf.length - 22
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error('not a zip file')
  let at = buf.readUInt32LE(end + 16)
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('a broken zip file')
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32)
    const mode = buf.readUInt32LE(at + 38) >>> 16, local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen + extraLen + commentLen
    const file = path.resolve(dest, name)
    if (!file.startsWith(path.resolve(dest) + path.sep)) continue // no writing outside it
    if (name.endsWith('/')) {
      fs.mkdirSync(file, { recursive: true })
      continue
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if ((mode & 0o170000) === 0o120000) {
      fs.symlinkSync((method === 8 ? zlib.inflateRawSync(data) : data).toString(), file)
      continue
    }
    fs.writeFileSync(file, method === 8 ? zlib.inflateRawSync(data) : data)
    if (mode & 0o111 && process.platform !== 'win32') fs.chmodSync(file, mode & 0o777)
  }
}

// A file server for a folder, on a free port: { url, close() } (pages loaded as files can't use
// modules or fetch, so they'd fail in a way they don't for the user)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }
function serve(dir) {
  const server = http.createServer((req, res) => {
    let file
    try {
      file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    } catch {
      return res.writeHead(400).end('bad path') // "50%off.png": what the page asked for isn't a path
    }
    if (file !== dir && !file.startsWith(dir + path.sep)) return res.writeHead(403).end()
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
      if (!fs.statSync(file).isFile()) throw new Error()
    } catch {
      return res.writeHead(404).end('not found')
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

// Opens url in a headless browser and calls fn(page) with it; returns what fn returns. page:
// { send(method, params), run(js) (its value), errors (the page's errors so far), size(w, h), key(name) }.
// Every step has a time limit (a page stuck in a loop answers nothing), and signal (Esc) ends it at once.
const STEP_WAIT = 20_000
export async function browse(url, fn, { width = 1280, height = 800, signal } = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('page checks need Node 22 or newer (this is ' + process.version + ')')
  const exe = await ensureChrome()
  if (!exe) throw new Error('no Chrome, Chromium or Edge found, and none could be fetched (set CHROME_PATH)')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-chrome-'))
  // its own sandbox off only where the system won't let it make one (root; Ubuntu's AppArmor refusing
  // a browser it doesn't know): it's then tried again without
  const launch = (bare) => spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(bare || process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let proc
  let said = ''
  let exited
  const start = (bare) => {
    proc = launch(bare)
    said = ''
    proc.stderr.on('data', (d) => (said = (said + d).slice(-2000)))
    exited = new Promise((r) => proc.once('exit', r))
  }
  start(false)
  let ws
  const pending = new Map()
  const fail = (e) => {
    for (const reject of pending.values()) reject(e)
    pending.clear()
  }
  const stop = () => (fail(signal.reason ?? Object.assign(new Error('stopped'), { name: 'AbortError' })), ws?.close())
  signal?.addEventListener('abort', stop, { once: true })
  try {
    let port
    for (let round = 0; round < 2 && !port; round++) {
      for (let i = 0; i < 100 && !port; i++) {
        if (signal?.aborted) throw signal.reason
        if (proc.exitCode !== null) break
        port = fs.existsSync(path.join(dir, 'DevToolsActivePort')) && fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]
        if (!port) await wait(100)
      }
      if (port || round || !/sandbox/i.test(said)) break
      proc.kill('SIGKILL')
      await Promise.race([exited, wait(3000)])
      start(true)
    }
    if (!port) throw new Error(`the browser didn't start${said.trim() ? `: ${tail(said.split('\n').filter((l) => /error|cannot|failed/i.test(l)).join(' ') || said, 300)}` : ''}`)
    const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((ok, bad) => ((ws.onopen = ok), (ws.onerror = () => bad(new Error("couldn't reach the browser")))))
    ws.onclose = () => fail(new Error('the browser went away'))
    let id = 0
    const errors = []
    let loaded = null
    const onLoad = new Promise((r) => (loaded = r))
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id) return pending.get(d.id)?.(null, d), pending.delete(d.id)
      const p = d.params
      if (d.method === 'Page.loadEventFired') loaded()
      else if (d.method === 'Runtime.exceptionThrown') errors.push(tail(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text, 300))
      else if (d.method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push(tail(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`, 300))
      else if (d.method === 'Network.responseReceived' && p.response.status >= 400 && !/favicon\.ico$/.test(p.response.url)) errors.push(`${p.response.status} for ${p.response.url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '')}`)
      else if (d.method === 'Network.loadingFailed' && !p.canceled && p.type !== 'Other') errors.push(`couldn't load a ${String(p.type).toLowerCase()}: ${p.errorText}`)
    }
    // one DevTools call: its result, or an error when it isn't answered in time. Then the page is asked
    // the smallest thing: no answer, its script is stuck (a loop: stuck, the page's fault); an answer,
    // the computer is just slow at it (a 3D page drawn without a graphics card: slow, not the page's)
    const call = (method, params, ms) =>
      new Promise((ok, bad) => {
        if (signal?.aborted) return bad(signal.reason)
        const n = ++id
        const timer = setTimeout(() => (pending.delete(n), bad(Object.assign(new Error('no answer'), { late: true }))), ms)
        pending.set(n, (e, d) => (clearTimeout(timer), e ? bad(e) : d.error ? bad(new Error(d.error.message)) : ok(d.result)))
        ws.send(JSON.stringify({ id: n, method, params }))
      })
    const send = async (method, params = {}) => {
      try {
        return await call(method, params, STEP_WAIT)
      } catch (e) {
        if (!e.late) throw e
        const alive = await call('Runtime.evaluate', { expression: '1', returnByValue: true }, STEP_WAIT).then(() => true, () => false)
        throw alive
          ? Object.assign(new Error(`this computer was too slow to finish ${method.replace(/^\w+\./, '')} in ${STEP_WAIT / 1000} s (the page itself still responds)`), { slow: true })
          : Object.assign(new Error(`the page stopped responding (${method} got no answer in ${STEP_WAIT / 1000} s, nor did a check after): its script may be stuck in a loop`), { stuck: true })
      }
    }
    const run = async (js) => {
      const r = await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    }
    const key = async (name, hold = 60) => {
      const code = { Enter: 13, ' ': 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[name] ?? name.toUpperCase().charCodeAt(0)
      const k = { key: name, code: name === ' ' ? 'Space' : name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: code }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, ...(name === 'Enter' && { text: '\r' }) })
      await wait(hold)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
    }
    const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')])
    await send('Page.navigate', { url })
    await Promise.race([onLoad, wait(20_000)])
    await wait(1500) // what starts after the load (a game's first frames)
    return await fn({ send, run, errors, size, key })
  } finally {
    signal?.removeEventListener('abort', stop)
    try {
      ws?.close()
    } catch {}
    proc.kill('SIGKILL')
    await Promise.race([exited, wait(3000)]) // gone before its folder is: it writes there until then
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {} // (Windows can hold a file a moment longer: the system's temp folder is cleaned anyway)
  }
}

// Serves root and browses the file in it (or a URL as it is)
export async function browseFile(root, target, fn, opts) {
  if (/^https?:\/\//.test(target)) return browse(target, fn, opts)
  const srv = await serve(path.resolve(root))
  try {
    return await browse(`${srv.url}/${target.replace(/^\.?\//, '').split(path.sep).join('/')}`, fn, opts)
  } finally {
    srv.close()
  }
}

// --- a page's check ---
// "heartcode page <file|url>": a page checked from a shell (a model checks its own page), with
// screenshots at desktop and phone size in .heartcode/page-shots/ to look at. Exit 0 when it passes.
export async function pageCommand(target) {
  if (!target) return console.error('usage: heartcode page <file or URL>'), 2
  const shots = path.join(process.cwd(), '.heartcode', 'page-shots')
  const r = await pageCheck(process.cwd(), target, null, shots, (t) => console.error(t))
  console.log(`${r.ok ? 'PASSED' : 'FAILED'}: ${r.report}`)
  return r.ok ? 0 : 1
}

// A web page: it loads without errors, shows something, and pressing its first button and a few keys
// breaks nothing
async function pageCheck(root, target, signal, shots, note) {
  const isUrl = /^https?:\/\//.test(target)
  if (!isUrl) {
    const file = path.resolve(root, target)
    if (!fs.existsSync(file)) return { ok: false, report: `page ${target}: there's no such file` }
    if (fs.statSync(file).isDirectory()) { // a folder: its index.html
      if (!fs.existsSync(path.join(file, 'index.html'))) return { ok: false, report: `page ${target}: a folder with no index.html` }
      target = path.join(target, 'index.html')
    }
  }
  const unchecked = (why) => (isUrl ? { ok: true, report: `page ${target}: not checked (${why})` } : staticPage(root, target, why))
  if (!(await ensureChrome(note))) return unchecked('no browser here')
  try {
    return await browseFile(root, target, async (page) => {
      const seen = await page.run(`(() => {
        const shown = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(), st = getComputedStyle(e); return r.width * r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0 })
        return { shown: shown.length, text: (document.body?.innerText ?? '').trim().length, canvas: shown.filter((e) => e.tagName === 'CANVAS').length, pictures: shown.filter((e) => /^(IMG|SVG|VIDEO)$/.test(e.tagName)).length, wide: document.documentElement.scrollWidth > innerWidth + 1 }
      })()`)
      const looks = await page.run(LOOKS).catch((e) => (log('check', `looks: ${e.message}`), null))
      const atLoad = page.errors.length
      const saved = []
      let tooSlow = '' // a screenshot this computer couldn't take in time: left out, the rest still checked
      const shot = async (name) => {
        if (tooSlow) return
        fs.mkdirSync(shots, { recursive: true })
        fs.writeFileSync(path.join(shots, '.gitignore'), '*\n') // HeartCode's, not the project's: git leaves them out
        const file = path.join(shots, `${name}.png`)
        try {
          fs.writeFileSync(file, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
          saved.push(path.relative(root, file))
        } catch (e) {
          if (!e.slow) throw e
          tooSlow = e.message
        }
      }
      if (shots) {
        await shot('desktop')
        await page.size(390, 844)
        await wait(800)
        seen.phoneWide = await page.run('document.documentElement.scrollWidth > innerWidth + 1')
        await shot('phone')
        await page.send('Emulation.clearDeviceMetricsOverride')
        await wait(500)
      }
      const button = await page.run(`(() => { const b = [...document.querySelectorAll('button, [role=button], input[type=button], input[type=submit]')].find((e) => !e.disabled && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden'); if (!b) return ''; b.click(); return (b.innerText || b.value || b.getAttribute('aria-label') || 'a button').trim().slice(0, 40) })()`).catch(() => '')
      await wait(500)
      for (const k of ['Enter', ' ', 'ArrowUp', 'ArrowLeft']) await page.key(k, 150)
      await wait(1500)
      const problems = []
      if (!seen.shown || (!seen.text && !seen.canvas && !seen.pictures)) problems.push('the page shows nothing')
      if (looks?.lowContrast.length) problems.push(`text too faint to read (WCAG 1.4.3: 4.5:1, large text 3:1): ${looks.lowContrast.map((x) => `"${x.text}" ${x.ratio}:1 (${x.fg} on ${x.bg})`).join('; ')}`)
      if (looks?.hidden) problems.push(`${looks.hidden}% of the page's text is invisible (opacity 0 or hidden) when it's loaded: content shown only after scrolling or an animation is blank in screenshots, print and with reduced motion; show it by default`)
      if (looks?.icons.length) problems.push(`icons that didn't draw (no such name): ${looks.icons.join(', ')}`)
      if (seen.phoneWide) problems.push('on a phone (390 px) it scrolls sideways: something is wider than the screen')
      if (page.errors.length) problems.push(`${page.errors.length} error${page.errors.length === 1 ? '' : 's'}${page.errors.length > atLoad ? (atLoad ? ` (${page.errors.length - atLoad} after pressing ${button ? `"${button}" and ` : ''}keys)` : ` after pressing ${button ? `"${button}" and ` : ''}keys`) : ''}:\n${[...new Set(page.errors)].slice(0, 8).join('\n')}`)
      const what = `${seen.shown} things shown${seen.canvas ? `, ${seen.canvas} canvas` : ''}${button ? `; pressed "${button}"` : ''} and keys (Enter, Space, arrows)${seen.wide ? '; wider than the window (scrolls sideways)' : ''}${seen.phoneWide ? '; on a phone it scrolls sideways' : ''}${saved.length ? `\nscreenshots (look at them): ${saved.join(', ')}` : ''}${tooSlow ? `\nno screenshots: ${tooSlow}` : ''}`
      return { ok: !problems.length, report: `page ${target} in a browser: ${problems.length ? problems.join('; ') : 'loaded without errors'}; ${what}` }
    }, { signal })
  } catch (e) {
    if (signal?.aborted) throw e
    if (e.stuck) return { ok: false, report: `page ${target} in a browser: ${e.message}` } // the page's fault, not the browser's
    return unchecked(e.message)
  }
}

// What a page looks like, measured in the browser, for what can be told for sure: text whose contrast
// with what's behind it is under WCAG's minimum (colors through a canvas, so any CSS color works;
// text on an image or gradient is skipped), how much of the text is invisible at load (opacity 0,
// visibility hidden: revealed later by scrolling or a timer), and Lucide icons left undrawn.
const LOOKS = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const lum = ([r, g, b]) => { const f = (v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]))
  const behind = (el) => { // the solid color behind el, or null over an image or gradient
    const layers = []
    for (let e = el; e; e = e.parentElement) {
      const st = getComputedStyle(e)
      if (st.backgroundImage !== 'none') return null
      const c = rgba(st.backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    return layers.reduceRight((acc, c) => over(c, acc), [255, 255, 255])
  }
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const low = []
  let all = 0, unseen = 0
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
    if (!/[\\p{L}\\p{N}]/u.test(own) || el.closest('[aria-hidden=true],[inert],script,style,noscript,template,option') || el.matches(':disabled')) continue
    const st = getComputedStyle(el), r = el.getBoundingClientRect()
    if (st.display === 'none' || !r.width || !r.height) continue
    all += own.length
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) { unseen += own.length; continue }
    const bg = behind(el)
    if (!bg) continue
    const fg = rgba(st.color)
    const text = over(fg, bg)
    const [a, b] = [lum(text), lum(bg)].sort((x, y) => y - x)
    const ratio = (a + 0.05) / (b + 0.05)
    const size = parseFloat(st.fontSize), bold = Number(st.fontWeight) >= 700
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
    if (ratio < need) low.push({ text: own.slice(0, 40), ratio: Math.round(ratio * 10) / 10, fg: hex(text), bg: hex(bg) })
  }
  return { lowContrast: low.slice(0, 6), hidden: all && unseen / all > 0.25 ? Math.round((100 * unseen) / all) : 0, icons: [...new Set([...document.querySelectorAll('i[data-lucide]')].map((e) => e.dataset.lucide))].slice(0, 10) }
})()`

// No browser: the files a page uses are there and its scripts parse
function staticPage(root, target, why = 'no browser here') {
  const file = path.resolve(root, target)
  let html
  try {
    html = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { ok: false, report: `page ${target}: couldn't read it (${e.code ?? e.message})` }
  }
  const dir = path.dirname(file)
  const problems = []
  const refs = [...html.matchAll(/<(?:script|img|link|source|audio|video)\b[^>]*?\b(?:src|href)=["']([^"'#?]+)/gi)].map((m) => m[1]).filter((u) => !/^(https?:|data:|\/\/|mailto:)/.test(u))
  for (const u of refs) if (!fs.existsSync(path.resolve(dir, u.replace(/^\//, '')))) problems.push(`it uses ${u}, which isn't there`)
  const parse = (code, name, module) => {
    const tmp = path.join(os.tmpdir(), `heart-check-${process.pid}-${Math.random().toString(36).slice(2)}${module ? '.mjs' : '.js'}`)
    fs.writeFileSync(tmp, code)
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      problems.push(`${name} doesn't parse: ${tail(String(e.stderr).split(/\n\s+at /)[0].replaceAll(tmp, name), 300)}`)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  for (const [i, m] of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
    if (/\bsrc=/.test(m[1]) || /type=["'](?!module|text\/javascript)/i.test(m[1]) || !m[2].trim()) continue
    parse(m[2], `the page's script #${i + 1}`, /module/.test(m[1]))
  }
  for (const u of refs.filter((u) => /\.m?js$/.test(u))) {
    const f = path.resolve(dir, u.replace(/^\//, ''))
    if (fs.existsSync(f)) parse(fs.readFileSync(f, 'utf8'), u, /import|export/.test(fs.readFileSync(f, 'utf8')))
  }
  return { ok: !problems.length, report: `page ${target}, checked without a browser (${why}): ${problems.length ? problems.join('; ') : 'the files it uses are there and its scripts parse'}` }
}
