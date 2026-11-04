// Test skills (the settings page): a few small jobs per model, each scored by HeartCode itself (never
// by another model), 0 to 1, with the time it took. The orchestrator sees the scores next to each
// model, so it hands work by what models have shown.
//   code    a function, run against hidden tests: the share that pass
//   page    a small web app, opened in a real browser and used: the share of checks that pass
//   vision  a picture drawn here (so the answer is known): where a shape is, how many of two kinds
//   tools   a bug to fix with HeartCode's tools in a folder of its own: fixed or not, less for bad calls
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { TOOL_DEFS } from './tools.js'
import { browse, findChrome } from './check.js'
import { prompt } from './prompts.js' // what each job asks: prompts/tests.md

export const SKILLS = ['code', 'page', 'vision', 'tools']

// the reply's code block (the first of that language, else the first, else all of it)
const codeOf = (text, lang) => {
  const blocks = [...String(text ?? '').matchAll(/```([\w-]*)\n([\s\S]*?)```/g)]
  return (blocks.find((b) => b[1].toLowerCase() === lang) ?? blocks[0])?.[2] ?? String(text ?? '')
}
// A model's code, run by Node in its permission model: it may read its own folder and nothing else
// (no writing, no other programs, no workers), for 10 s at most; not waited on with the rest stopped.
// Resolves with what it printed; rejects with { stdout, stderr, status } like a failed command.
const [major, minor] = process.versions.node.split('.').map(Number)
const LOCKED = major > 23 || (major === 23 && minor >= 5) ? '--permission' : '--experimental-permission'
const node = (file, real = fs.realpathSync(file)) => // (the permission model goes by real paths: macOS's temp folder is a link)
  new Promise((ok, bad) =>
    execFile(process.execPath, [LOCKED, `--allow-fs-read=${path.dirname(real)}`, real], { encoding: 'utf8', timeout: 10_000 }, (e, stdout, stderr) =>
      e ? bad(Object.assign(e, { stdout, stderr, status: e.code ?? 1 })) : ok(stdout),
    ),
  )

// --- code ---
const CODE_TESTS = [['1h30m', 5_400_000], ['45s', 45_000], ['2d 4h', 187_200_000], ['1.5h', 5_400_000], ['90m', 5_400_000], ['1H', 3_600_000], ['0s', 0], ['3d', 259_200_000], ['', null], ['10', null], ['5x', null], ['h', null], ['1h-2m', null], [null, null], [42, null]]
async function scoreCode(reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-skill-'))
  try {
    const file = path.join(dir, 'test.mjs')
    fs.writeFileSync(file, `${codeOf(reply, 'js').replace(/^\s*export\s+(default\s+)?/gm, '')}\n;const cases = ${JSON.stringify(CODE_TESTS)};\nlet n = 0; for (const [i, want] of cases) { try { if (Object.is(parseDuration(i), want) || parseDuration(i) === want) n++ } catch {} }\nconsole.log(n)`)
    const passed = Number((await node(file)).trim().split('\n').at(-1))
    return { score: passed / CODE_TESTS.length, why: `${passed} of ${CODE_TESTS.length} hidden tests pass` }
  } catch (e) {
    return { score: 0, why: `its code doesn't run: ${String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) ?? 'error'}`.slice(0, 160) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// --- page ---
// in the page, before and after Enter is pressed for real (a form's submit, a key handler: either works)
const PAGE_BEFORE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const $ = (id) => document.getElementById(id)
  window.__items = () => [...($('list')?.querySelectorAll('li') ?? [])]
  const r = { parts: Boolean($('item') && $('add') && $('list') && $('count')) }
  if (!r.parts) return r
  $('item').value = '  milk  '; $('item').dispatchEvent(new Event('input', { bubbles: true })); $('add').click(); await wait(200)
  r.added = __items().length === 1 && /milk/.test(__items()[0].textContent) && !/  milk/.test(__items()[0].textContent)
  r.cleared = $('item').value === ''
  $('item').value = ''; $('item').focus()
  return r
})()`
const PAGE_AFTER = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const $ = (id) => document.getElementById(id)
  const r = { enter: __items().length === 2, count: /\\b2\\b/.test($('count').textContent) }
  $('item').value = '   '; $('add').click(); await wait(200)
  r.empty = __items().length === 2
  const x = __items()[0]?.querySelector('button, [role=button], .remove, [aria-label*=emove]'); x?.click(); await wait(200)
  r.removed = __items().length === 1 && /\\b1\\b/.test($('count').textContent)
  return r
})()`
const PAGE_WORDS = { parts: 'the asked-for parts', added: 'Add adds (trimmed)', cleared: 'the input clears', enter: 'Enter adds', count: 'the count', empty: 'empty text adds nothing', removed: 'remove works', errors: 'no errors', phone: 'fits a phone' }
async function scorePage(reply, signal) {
  if (!findChrome()) return { skipped: true, why: 'needs Chrome, Chromium or Edge on this computer' }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-skill-'))
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), codeOf(reply, 'html'))
    const r = await browse(`file://${path.join(dir, 'index.html')}`, async (page) => {
      const got = await page.run(PAGE_BEFORE).catch(() => ({}))
      if (got.parts) {
        await page.send('Input.insertText', { text: 'eggs' })
        await page.key('Enter')
        await new Promise((ok) => setTimeout(ok, 300))
        Object.assign(got, await page.run(PAGE_AFTER).catch(() => ({})))
      }
      await page.size(390, 844)
      await new Promise((ok) => setTimeout(ok, 300))
      got.phone = await page.run('document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll("#item, #add, #list")].every((e) => e.getBoundingClientRect().right <= innerWidth + 1)').catch(() => false)
      got.errors = !page.errors.length
      return got
    }, { signal })
    const keys = Object.keys(PAGE_WORDS)
    const missed = keys.filter((k) => !r[k])
    return { score: (keys.length - missed.length) / keys.length, why: missed.length ? `failed: ${missed.map((k) => PAGE_WORDS[k]).join(', ')}` : 'every check passed' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// --- vision: a PNG drawn here ---
const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0 })
const crc32 = zlib.crc32 ?? ((b) => { let c = ~0; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0 }) // (zlib's from Node 20.15)
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
export function scene(rand = Math.random) {
  const W = 640, H = 400
  const px = Buffer.alloc(W * H * 3, 255)
  const put = (x, y, c) => x >= 0 && y >= 0 && x < W && y < H && px.set(c, (y * W + x) * 3)
  const placed = []
  const spot = (r) => {
    for (;;) {
      const x = Math.round(r + 10 + rand() * (W - 2 * r - 20)), y = Math.round(r + 10 + rand() * (H - 2 * r - 20))
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + r + 14)) return placed.push({ x, y, r }), { x, y }
    }
  }
  const circle = (c, r = 22) => { const { x, y } = spot(r); for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) put(x + dx, y + dy, c) }
  const square = (c, r = 20) => { const { x, y } = spot(r * 1.42); for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(x + dx, y + dy, c) }
  const RED = [220, 40, 40], BLUE = [40, 90, 220], GREEN = [30, 160, 70], YELLOW = [235, 190, 30]
  // the triangle: its centre is where it's asked for (the centroid)
  const r = 30
  const t = spot(r)
  const a = [t.x, t.y - r], b = [t.x - r * 0.87, t.y + r / 2], c = [t.x + r * 0.87, t.y + r / 2]
  const side = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
  for (let y = t.y - r; y <= t.y + r; y++) for (let x = t.x - r; x <= t.x + r; x++) if (side(a, b, x, y) <= 0 && side(b, c, x, y) <= 0 && side(c, a, x, y) <= 0) put(x, y, RED)
  const blue = 3 + Math.floor(rand() * 4), green = 1 + Math.floor(rand() * 3)
  for (let i = 0; i < blue; i++) circle(BLUE)
  for (let i = 0; i < green; i++) square(GREEN)
  for (let i = 0; i < 2; i++) circle(YELLOW) // to tell apart from the blue ones
  return { url: `data:image/png;base64,${png(W, H, px).toString('base64')}`, x: t.x, y: t.y, blue, green }
}
function scoreVision(reply, s) {
  let a
  try {
    a = JSON.parse(/\{[\s\S]*\}/.exec(String(reply))?.[0] ?? '')
  } catch {
    return { score: 0, why: `not JSON: "${String(reply).trim().slice(0, 60)}"` }
  }
  const off = Math.hypot(Number(a.x) - s.x, Number(a.y) - s.y)
  const where = Number.isFinite(off) ? (off <= 15 ? 1 : Math.max(0, 1 - (off - 15) / 85)) : 0
  const blue = Number(a.blue_circles) === s.blue, green = Number(a.green_squares) === s.green
  return { score: (where + blue + green) / 3, why: `the triangle ${Number.isFinite(off) ? `${Math.round(off)} px off` : 'not found'}; blue circles ${blue ? 'right' : `${a.blue_circles} (${s.blue})`}; green squares ${green ? 'right' : `${a.green_squares} (${s.green})`}` }
}

// --- tools: a bug to fix in a folder of its own, with HeartCode's own tool definitions ---
const BUGGY = `// adds up the numbers in a comma-separated string: total('1, 2,3') is 6
function total(text) {
  return text.split(',').reduce((sum, part) => sum + part, 0)
}
module.exports = { total }
`
const TEST = `const { total } = require('./sum.js')
const ok = total('1, 2,3') === 6 && total('10') === 10 && total('') === 0
console.log(ok ? 'ok' : 'FAIL: got ' + JSON.stringify([total('1, 2,3'), total('10'), total('')]))
process.exit(ok ? 0 : 1)
`
const ROUNDS = 12 // a test's end: a model still going after this many steps is going round in circles
async function scoreTools(client, ms, signal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-skill-'))
  fs.writeFileSync(path.join(dir, 'sum.js'), BUGGY)
  fs.writeFileSync(path.join(dir, 'test.js'), TEST)
  const inside = (p) => ((f) => (f === dir || f.startsWith(dir + path.sep) ? f : null))(path.resolve(dir, String(p ?? '.')))
  const run = async (name, a) => {
    if (name === 'list_files') return fs.readdirSync(dir).join('\n')
    const file = inside(a.path)
    if (name === 'read_file') return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'error: no such file'
    if (name === 'write_file') return file ? (fs.writeFileSync(file, String(a.content ?? '')), 'written') : 'error: outside the folder'
    if (name === 'edit_file') {
      if (!file || !fs.existsSync(file)) return 'error: no such file'
      const text = fs.readFileSync(file, 'utf8')
      if (a.search != null) return text.includes(a.search) ? (fs.writeFileSync(file, text.replace(a.search, String(a.replace ?? ''))), 'edited') : 'error: search text not found'
      const lines = text.split('\n')
      lines.splice(Number(a.start_line) - 1, Number(a.end_line ?? a.start_line) - Number(a.start_line) + 1, String(a.replace ?? ''))
      return fs.writeFileSync(file, lines.join('\n')), 'edited'
    }
    if (name === 'run_command') {
      const m = /^\s*(node|cat|ls)(?:\s+([\w./-]+))?\s*$/.exec(String(a.command ?? ''))
      if (!m) return 'error: only "node <file>", "cat <file>" and "ls" work here'
      try {
        if (m[1] !== 'ls' && !inside(m[2])) return 'error: outside the folder'
        return m[1] === 'ls' ? fs.readdirSync(dir).join('\n') : m[1] === 'cat' ? fs.readFileSync(inside(m[2]), 'utf8') : `${await node(inside(m[2]))}\n(exit 0)`
      } catch (e) {
        return `${e.stdout ?? ''}${e.stderr ?? e.message}\n(exit ${e.status ?? 1})`
      }
    }
    return `error: no tool ${name}`
  }
  try {
    const tools = TOOL_DEFS.filter((f) => ['read_file', 'list_files', 'edit_file', 'write_file', 'run_command'].includes(f.name)).map((f) => ({ type: 'function', function: f }))
    const messages = [{ role: 'user', content: prompt('tests/skill-tools') }]
    let bad = 0, steps = 0
    for (; steps < ROUNDS; steps++) {
      const res = await client.chat({ messages, tools, stream: true }, { signal: AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]) })
      if (!res.toolCalls?.length) break
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls })
      for (const c of res.toolCalls) {
        let out
        try {
          out = await run(c.function.name, JSON.parse(c.function.arguments || '{}'))
        } catch {
          out = 'error: the arguments aren\'t valid JSON'
        }
        if (/^error:/.test(out)) bad++
        messages.push({ role: 'tool', tool_call_id: c.id, content: out })
      }
    }
    let fixed = false
    try {
      fixed = /^ok/.test(await node(path.join(dir, 'test.js')))
    } catch {}
    return { score: fixed ? Math.max(0.5, 1 - 0.1 * bad) : 0, why: `${fixed ? 'fixed it' : steps >= ROUNDS ? `not fixed after ${ROUNDS} steps` : 'not fixed'} in ${steps} step${steps === 1 ? '' : 's'}${bad ? `, ${bad} failed tool call${bad === 1 ? '' : 's'}` : ''}` }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// One model's tests, all at once: { code, page, vision, tools } each { score, ms, why } | { slow } |
// { error } | { skipped }. can: { tools, images }. ms: how long each answer may take. onStep({ skill,
// now }) as one starts, onStep({ skill, ...result }) as it ends. gate(fn): runs fn when its provider
// has room (the Test's limit of requests at once per provider); none: at once.
export async function testSkills(client, can, ms, signal, onStep = () => {}, gate = (fn) => fn()) {
  const out = {}
  const ask = (content) => client.chat({ messages: [{ role: 'user', content }], stream: true }, { signal: AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]) }).then((r) => r.content ?? '')
  const one = async (skill) => {
    if (skill === 'tools' && !can.tools) return (out[skill] = { skipped: true, why: "it doesn't call tools" }), onStep({ skill, ...out[skill] })
    if (skill === 'vision' && !can.images) return (out[skill] = { skipped: true, why: "it can't see images" }), onStep({ skill, ...out[skill] })
    await gate(async () => {
      if (signal?.aborted) return
      onStep({ skill, now: true })
      const t0 = Date.now() // from when it's sent: waiting for room isn't the model's time
      try {
        let r
        if (skill === 'code') r = await scoreCode(await ask(prompt('tests/skill-code')))
        else if (skill === 'page') r = await scorePage(await ask(prompt('tests/skill-page')), signal)
        else if (skill === 'vision') {
          const s = scene()
          r = scoreVision(await ask([{ type: 'text', text: prompt('tests/skill-vision') }, { type: 'image_url', image_url: { url: s.url } }]), s)
        } else r = await scoreTools(client, ms, signal)
        out[skill] = r.skipped ? r : { ...r, ms: Date.now() - t0 }
      } catch (e) {
        if (signal?.aborted) return
        out[skill] = e.name === 'TimeoutError' ? { slow: true, why: /aborted due to timeout/i.test(e.message) ? `no answer within ${Math.round(ms / 1000)} s` : String(e.message).slice(0, 160) } : { error: true, why: String(e.message).slice(0, 160) } // (the client's own: it didn't start, or went quiet)
      }
      onStep({ skill, ...out[skill] })
    })
  }
  await Promise.all(SKILLS.map(one))
  return out
}
