// Runs the benchmark tasks with a real model through HeartCode's Session; prints pass/fail and tokens.
// usage: node bench/run.mjs [label]   (the current provider and model from ~/.heart; real requests)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execSync } from 'node:child_process'; import { Writable } from 'node:stream'
const H = new URL('../src/', import.meta.url).href
const { loadConfig } = await import(H + 'config.js')
const { Client } = await import(H + 'client.js')
const { Session } = await import(H + 'agent.js')
const { UI } = await import(H + 'ui.js')
const { strategy, loadProfile } = await import(H + 'probe.js')
const E = path.dirname(new URL(import.meta.url).pathname), label = process.argv[2] ?? 'run'
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'heartcode-bench-'))
const cfg = loadConfig()
const p = cfg.providers[cfg.provider]
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
const scriptOk = (h) => { const m = /<script>([\s\S]*?)<\/script>/.exec(h); if (!m) return false; fs.writeFileSync('/tmp/claude-bench.js', m[1]); try { execSync('node --check /tmp/claude-bench.js', { stdio: 'ignore' }); return true } catch { return false } }
const sh = (cmd, cwd) => { try { return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString() } catch { return '' } }
async function run(name, files, messages, check) {
  const root = path.join(OUT, name)
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true })
  for (const f of files) fs.copyFileSync(path.join(E, 'fixtures', f), path.join(root, f))
  const client = new Client({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: cfg.model })
  client.onRetry = () => {}
  const profile = loadProfile(client)
  let input = 0, output = 0, requests = 0
  const chat = client.chat.bind(client)
  client.chat = async (b, o) => { const r = await chat(b, o); requests++; input += r.usage?.prompt_tokens ?? 0; output += r.usage?.completion_tokens ?? 0; return r }
  const s = new Session({ client, profile, strat: strategy(profile, cfg), root, ui: new UI({ yes: true, output: new Writable({ write: (c, e, cb) => cb() }) }) })
  s.autoCompact = true
  const t0 = Date.now()
  let err = ''
  for (const m of messages) { try { await s.run(m) } catch (e) { err = e.message } }
  const checks = check(root)
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  console.log(`${name.padEnd(9)} ${(bad.length ? '✗ ' + bad.join(', ') : '✓').padEnd(38)} ${String(requests).padStart(3)} req  ${String(input).padStart(7)} in  ${String(output).padStart(6)} out  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${err && 'ERR ' + err.slice(0, 60)}`)
  return { input, output, ok: !bad.length }
}
console.log(`${label}: ${cfg.provider} · ${cfg.model}`)
const r = []
r.push(await run('create', [], ['create index.html: a complete, nicely designed tic tac toe game (HTML, CSS and JavaScript in one file) with win and draw detection and a restart button'], (d) => { const h = read(d + '/index.html'); return { complete: /<\/html>\s*$/.test(h), 'js parses': scriptOk(h), restart: /restart/i.test(h), draw: /draw|tie/i.test(h) } }))
r.push(await run('palette', ['ttt.html'], ['rename the name of the game to FayTikTakToe then change the color palette to this: ["#cdb4db","#ffc8dd","#ffafcc","#bde0fe","#a2d2ff"]'], (d) => { const h = read(d + '/ttt.html').toLowerCase(); const o = read(path.join(E, 'fixtures/ttt.html')); return { renamed: /<title>[^<]*faytiktaktoe/.test(h) && /<h1>[^<]*faytiktaktoe/.test(h), 'new colors': ['#cdb4db', '#ffc8dd', '#ffafcc', '#bde0fe', '#a2d2ff'].filter((c) => h.includes(c)).length >= 4, 'accents gone': ['#6c5ce7', '#00cec9', '#fd79a8'].every((c) => !h.includes(c)), 'script intact': /<script>([\s\S]*?)<\/script>/.exec(read(d + '/ttt.html'))?.[1] === /<script>([\s\S]*?)<\/script>/.exec(o)[1] } }))
r.push(await run('python', ['rect.py', 'test_rect.py'], ['perimeter() in rect.py is wrong and Rect has no area() method. fix it and add area(), then run python3 test_rect.py'], (d) => ({ 'tests pass': sh('python3 test_rect.py', d).includes('ok') })))
r.push(await run('rename', ['utils.js', 'app.js', 'package.json'], ['rename fmtDate to formatDate everywhere'], (d) => { const all = read(d + '/utils.js') + read(d + '/app.js'); return { 'no fmtDate': !/fmtDate/.test(all), 'app runs': sh('node app.js', d).includes('DATE 2026-01-02!') } }))
r.push(await run('session', ['utils.js', 'app.js', 'package.json'], ['what does utils.js do?', "add a function slugify(s) to utils.js that lowercases s and replaces spaces with -", "in app.js, also print slugify('Hello World')"], (d) => { const out = sh('node app.js', d); return { 'slugify works': out.includes('hello-world'), 'old output kept': out.includes('DATE 2026-01-02!') } }))
const sum = (k) => r.reduce((n, x) => n + x[k], 0)
console.log(`TOTAL     ${r.filter((x) => x.ok).length}/${r.length} passed${' '.repeat(26)}${String(sum('input')).padStart(12)} in  ${String(sum('output')).padStart(6)} out`)
