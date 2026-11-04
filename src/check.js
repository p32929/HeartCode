// Checks HeartCode runs itself, so "done" is something proven rather than claimed: a handoff's check
// (a shell command that must exit 0, or "page <file|url>": a web page opened in a real browser) and
// the browser the skill tests use. The browser: Chrome, Chromium or Edge, headless, driven over the
// DevTools protocol (Node's own WebSocket), with nothing installed. No browser: a page gets a static
// check instead (the files it uses are there, its scripts parse), and says so.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  chrome = [process.env.CHROME_PATH, ...mac, ...win].find((p) => p && fs.existsSync(p)) ?? named.map(which).find(Boolean) ?? ''
  return chrome
}

// A file server for a folder, on a free port: { url, close() } (pages loaded as files can't use
// modules or fetch, so they'd fail in a way they don't for the user)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }
function serve(dir) {
  const server = http.createServer((req, res) => {
    let file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!file.startsWith(dir)) return res.writeHead(403).end()
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) return res.writeHead(404).end('not found')
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

// Opens url in a headless browser and calls fn(page) with it; returns what fn returns. page:
// { send(method, params), run(js) (its value), errors (the page's errors so far), size(w, h), key(name) }.
export async function browse(url, fn, { width = 1280, height = 800, signal } = {}) {
  const exe = findChrome()
  if (!exe) throw new Error('no Chrome, Chromium or Edge found (set CHROME_PATH)')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-chrome-'))
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let port
    for (let i = 0; i < 100 && !port; i++) {
      if (signal?.aborted) throw signal.reason
      port = fs.existsSync(path.join(dir, 'DevToolsActivePort')) && fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]
      if (!port) await wait(100)
    }
    if (!port) throw new Error("the browser didn't start")
    const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((ok, bad) => ((ws.onopen = ok), (ws.onerror = () => bad(new Error("couldn't reach the browser")))))
    let id = 0
    const pending = new Map()
    const errors = []
    let loaded = null
    const onLoad = new Promise((r) => (loaded = r))
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id) return pending.get(d.id)?.(d), pending.delete(d.id)
      const p = d.params
      if (d.method === 'Page.loadEventFired') loaded()
      else if (d.method === 'Runtime.exceptionThrown') errors.push(tail(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text, 300))
      else if (d.method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push(tail(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`, 300))
      else if (d.method === 'Network.responseReceived' && p.response.status >= 400 && !/favicon\.ico$/.test(p.response.url)) errors.push(`${p.response.status} for ${p.response.url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '')}`)
      else if (d.method === 'Network.loadingFailed' && !p.canceled && p.type !== 'Other') errors.push(`couldn't load a ${String(p.type).toLowerCase()}: ${p.errorText}`)
    }
    const send = (method, params = {}) =>
      new Promise((ok, bad) => {
        pending.set(++id, (d) => (d.error ? bad(new Error(d.error.message)) : ok(d.result)))
        ws.send(JSON.stringify({ id, method, params }))
      })
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
    try {
      ws?.close()
    } catch {}
    proc.kill()
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1000).unref()
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

// --- a handoff's check ---
// { ok, report }: report says what was checked and how it went (the output of a failed command)
export async function runCheck(root, check, signal) {
  const c = String(check ?? '').trim()
  const page = /^page\s+(.+)$/i.exec(c)
  if (page) return pageCheck(root, page[1].trim().replace(/^["']|["']$/g, ''), signal)
  return commandCheck(root, c, signal)
}

// "heartcode page <file|url>": the same check from a shell (a model checks its own page), with
// screenshots at desktop and phone size in .heartcode/page-shots/ to look at. Exit 0 when it passes.
export const PAGE_COMMAND = `"${process.execPath}" "${fileURLToPath(new URL('../bin/heartcode.js', import.meta.url))}" page`
export async function pageCommand(target) {
  if (!target) return console.error('usage: heartcode page <file or URL>'), 2
  const shots = path.join(process.cwd(), '.heartcode', 'page-shots')
  const r = await pageCheck(process.cwd(), target, null, shots)
  console.log(`${r.ok ? 'PASSED' : 'FAILED'}: ${r.report}`)
  return r.ok ? 0 : 1
}

// a command must end by itself: one that's still going after this is a server or a watcher, not a check
const COMMAND_WAIT = 5 * 60_000
function commandCheck(root, cmd, signal) {
  return new Promise((done) => {
    const t0 = Date.now()
    const p = spawn(cmd, { cwd: root, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out = (out + d).slice(-20_000)))
    p.stderr.on('data', (d) => (out = (out + d).slice(-20_000)))
    const kill = () => {
      try {
        process.platform === 'win32' ? p.kill() : process.kill(-p.pid, 'SIGKILL')
      } catch {}
    }
    const timer = setTimeout(() => ((out += `\n(still running after ${COMMAND_WAIT / 60_000} minutes: stopped. A check must end by itself: no servers or watchers; for a web page use "page <file>")`), kill()), COMMAND_WAIT)
    const onAbort = () => kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    p.on('error', (e) => (out += `\n${e.message}`))
    p.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const ok = code === 0
      done({ ok, report: `\`${cmd}\` ${ok ? 'passed' : `failed (exit ${code ?? 'killed'})`} in ${Math.round((Date.now() - t0) / 1000)} s${out.trim() ? `:\n${tail(out)}` : ''}` })
    })
  })
}

// A web page: it loads without errors, shows something, and pressing its first button and a few keys
// breaks nothing
async function pageCheck(root, target, signal, shots) {
  const isUrl = /^https?:\/\//.test(target)
  if (!isUrl && !fs.existsSync(path.resolve(root, target))) return { ok: false, report: `page ${target}: there's no such file` }
  if (!findChrome()) return isUrl ? { ok: true, report: `page ${target}: not checked (no browser here)` } : staticPage(root, target)
  try {
    return await browseFile(root, target, async (page) => {
      const seen = await page.run(`(() => {
        const shown = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(), st = getComputedStyle(e); return r.width * r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0 })
        return { shown: shown.length, text: (document.body?.innerText ?? '').trim().length, canvas: shown.filter((e) => e.tagName === 'CANVAS').length, pictures: shown.filter((e) => /^(IMG|SVG|VIDEO)$/.test(e.tagName)).length, wide: document.documentElement.scrollWidth > innerWidth + 1 }
      })()`)
      const atLoad = page.errors.length
      const saved = []
      const shot = async (name) => {
        fs.mkdirSync(shots, { recursive: true })
        const file = path.join(shots, `${name}.png`)
        fs.writeFileSync(file, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
        saved.push(path.relative(root, file))
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
      if (page.errors.length) problems.push(`${page.errors.length} error${page.errors.length === 1 ? '' : 's'}${page.errors.length > atLoad ? (atLoad ? ` (${page.errors.length - atLoad} after pressing ${button ? `"${button}" and ` : ''}keys)` : ` after pressing ${button ? `"${button}" and ` : ''}keys`) : ''}:\n${[...new Set(page.errors)].slice(0, 8).join('\n')}`)
      const what = `${seen.shown} things shown${seen.canvas ? `, ${seen.canvas} canvas` : ''}${button ? `; pressed "${button}"` : ''} and keys (Enter, Space, arrows)${seen.wide ? '; wider than the window (scrolls sideways)' : ''}${seen.phoneWide ? '; on a phone it scrolls sideways' : ''}${saved.length ? `\nscreenshots (look at them): ${saved.join(', ')}` : ''}`
      return { ok: !problems.length, report: `page ${target} in a browser: ${problems.length ? problems.join('; ') : 'loaded without errors'}; ${what}` }
    }, { signal })
  } catch (e) {
    if (signal?.aborted) throw e
    return staticPage(root, target, e.message)
  }
}

// No browser: the files a page uses are there and its scripts parse
function staticPage(root, target, why = 'no browser here') {
  const file = path.resolve(root, target)
  const html = fs.readFileSync(file, 'utf8')
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
