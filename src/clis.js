// Coding CLIs on this machine as providers: Claude Code, Codex, opencode, Junie and the ones that speak
// the Agent Client Protocol (Kilo, Cline, Copilot, Cursor, Qwen…). One is added on /settings like any
// provider, with the address cli://<its name> and no key: its models are the CLI's own, tested and put
// in your list the same way. A CLI is an agent itself, so a message answered by one is worked on by it,
// in this folder, with its own tools, signed in its own way; HeartCode shows its thinking, its steps
// and its answer, and keeps its session for the next message (one it didn't see, from another of your
// models, is passed on to it first). Anything else asked of it (a summary, a test) is one plain
// question, in a scratch folder, with nothing it may change.
// Install routes, logins and invocations: from Nibedita (its internal/clis and internal/cli), checked
// against each CLI's --help and real runs.
// ponytail: no images and no effort levels passed to a CLI; Windows' argv limit (~32k) can cut a long
// first message to opencode, Junie and Kiro (the others read it on stdin or over ACP).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { spawnCmd, onPath, killTree } from './spawn.js'
import { guarded } from './guard.js'
import { log } from './log.js'

const WIN = process.platform === 'win32'
const ACP_MODE = 'https://agentclientprotocol.com/protocol/session-modes#' // Copilot names its modes so
const npm = (pkg) => ({ cmd: ['npm', 'install', '-g', pkg] })
const script = (unix, win) => [unix && { os: 'unix', cmd: ['bash', '-c', `curl -fsSL '${unix}' | bash`], also: ['curl'] }, win && { os: 'win32', cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm '${win}' | iex`] }].filter(Boolean)

// id → { title, bin, kind, login (signs in, run in a terminal), page, install routes, … }. ACP ones:
// args (run it as an ACP server), modes (HeartCode's permission mode → the session settings that make
// it ask where HeartCode would: [option or 'mode', value]; what it asks, you answer, plan mode only
// reads), modeEnv (the same in its environment), bypassArgs (no asking, on its command line), modelArgs (a model on the command line, for one whose
// sessions offer none to pick), models (lists them, for one whose sessions don't).
export const CLIS = {
  claude: { title: 'Claude Code', bin: 'claude', kind: 'claude', login: 'claude', page: 'https://docs.anthropic.com/en/docs/claude-code/setup', install: [...script('https://claude.ai/install.sh', 'https://claude.ai/install.ps1'), npm('@anthropic-ai/claude-code')] },
  codex: { title: 'Codex', bin: 'codex', kind: 'codex', login: 'codex login', page: 'https://developers.openai.com/codex/cli', install: [npm('@openai/codex')] },
  opencode: { title: 'opencode', bin: 'opencode', kind: 'opencode', login: 'opencode auth login', page: 'https://opencode.ai/docs', install: script('https://opencode.ai/install') },
  junie: { title: 'Junie', bin: 'junie', kind: 'junie', login: 'junie', page: 'https://junie.jetbrains.com/docs/junie-cli.html', install: [...script('https://junie.jetbrains.com/install.sh', 'https://junie.jetbrains.com/install.ps1'), npm('@jetbrains/junie')] },
  kilo: { title: 'Kilo Code', bin: 'kilo', kind: 'acp', args: ['acp'], login: 'kilo auth login', page: 'https://kilo.ai/docs/cli', install: [npm('@kilocode/cli')], modes: { all: [['mode', 'code']], commands: [['mode', 'code']], ask: [['mode', 'code']], plan: [['mode', 'plan']] }, modeEnv: { commands: { KILO_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'ask' } }) }, ask: { KILO_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } }) } } },
  cline: { title: 'Cline', bin: 'cline', kind: 'acp', args: ['--acp'], login: 'cline auth', page: 'https://docs.cline.bot/cline-cli/overview', install: [npm('cline')], modes: { all: [['auto_approve', 'true'], ['mode', 'act']], commands: [['auto_approve', 'false'], ['mode', 'act']], ask: [['auto_approve', 'false'], ['mode', 'act']], plan: [['mode', 'plan']] } },
  agy: { title: 'Antigravity', bin: 'agy', kind: 'acp', args: ['acp'], login: 'agy acp --login', page: 'https://antigravity.google/docs/cli/install', install: script('https://antigravity.google/cli/install.sh', 'https://antigravity.google/cli/install.ps1'), bypassArgs: ['--dangerously-skip-permissions'], modes: { all: [['mode', 'auto']], commands: [['mode', 'accept-edits']], ask: [['mode', 'default']], plan: [['mode', 'plan']] } },
  'kiro-cli': { title: 'Kiro', bin: 'kiro-cli', kind: 'acp', args: ['acp'], login: 'kiro-cli login', page: 'https://kiro.dev/docs/cli/installation/', install: script('https://cli.kiro.dev/install', 'https://cli.kiro.dev/install.ps1'), modes: { all: [['autopilot', 'on'], ['mode', 'vibe']], commands: [['autopilot', 'off'], ['mode', 'vibe']], ask: [['autopilot', 'off'], ['mode', 'vibe']], plan: [['autopilot', 'off'], ['mode', 'plan']] }, modelArgs: (m) => (m && m !== 'auto' ? ['--model', m] : []), models: kiroModels },
  copilot: { title: 'GitHub Copilot', bin: 'copilot', kind: 'acp', args: ['--acp', '--no-auto-update'], login: 'copilot login', page: 'https://docs.github.com/copilot/how-tos/copilot-cli', install: [npm('@github/copilot')], bypassArgs: ['--allow-all'], modes: { all: [['allow_all', 'on'], ['mode', `${ACP_MODE}autopilot`]], commands: [['mode', `${ACP_MODE}agent`]], ask: [['mode', `${ACP_MODE}agent`]], plan: [['mode', `${ACP_MODE}plan`]] }, modelArgs: (m) => (m ? ['--model', m] : []), models: copilotModels },
  'cursor-agent': { title: 'Cursor', bin: 'cursor-agent', kind: 'acp', args: ['acp'], login: 'cursor-agent login', page: 'https://cursor.com/docs/cli/installation', install: script('https://cursor.com/install', 'https://cursor.com/install?win32=true'), modes: { all: [['mode', 'agent']], commands: [['mode', 'agent']], ask: [['mode', 'agent']], plan: [['mode', 'plan']] } },
  codebuddy: { title: 'CodeBuddy', bin: 'codebuddy', kind: 'acp', args: ['--acp'], login: 'codebuddy', page: 'https://www.codebuddy.ai/cli', install: [npm('@tencent-ai/codebuddy-code')], modes: { all: [['mode', 'bypassPermissions']], commands: [['mode', 'acceptEdits']], ask: [['mode', 'default']], plan: [['mode', 'plan']] } },
  qwen: { title: 'Qwen Code', bin: 'qwen', kind: 'acp', args: ['--acp'], login: 'qwen', page: 'https://github.com/QwenLM/qwen-code', install: [npm('@qwen-code/qwen-code')], modes: { all: [['mode', 'yolo']], commands: [['mode', 'auto-edit']], ask: [['mode', 'default']], plan: [['mode', 'plan']] } },
  qodercli: { title: 'Qoder', bin: 'qodercli', kind: 'acp', args: ['--acp'], login: 'qodercli login', page: 'https://www.npmjs.com/package/@qoder-ai/qodercli', install: [npm('@qoder-ai/qodercli')], modes: { all: [['mode', 'yolo']], commands: [['mode', 'acceptEdits']], ask: [['mode', 'default']], plan: [['mode', 'default']] } },
  vibe: { title: 'Mistral Vibe', bin: 'vibe-acp', kind: 'acp', args: [], login: 'vibe-acp --setup', page: 'https://github.com/mistralai/mistral-vibe', install: [{ cmd: ['uv', 'tool', 'install', 'mistral-vibe'] }, { cmd: ['pipx', 'install', 'mistral-vibe'] }], modes: { all: [['mode', 'auto-approve']], commands: [['mode', 'accept-edits']], ask: [['mode', 'ask']], plan: [['mode', 'ask']] } },
  alphacode: { title: 'AlphaCode', bin: 'alphacode', kind: 'acp', args: ['acp', '--quiet', '--no-update'], login: 'alphacode', page: 'https://github.com/dragonked2/alphacode#install-in-30-seconds', install: script('https://raw.githubusercontent.com/dragonked2/alphacode/main/scripts/install.sh', 'https://raw.githubusercontent.com/dragonked2/alphacode/main/scripts/install.ps1'), modelArgs: (m) => (m ? ['--model', m] : []), models: alphacodeModels },
}

// The CLI a provider's address names (cli://claude), or null
export const cliOf = (baseUrl) => {
  const m = /^cli:\/\/([^/]+)/i.exec(String(baseUrl ?? ''))
  return m && CLIS[m[1]] ? m[1] : null
}
export const cliUrl = (id) => `cli://${id}`

// --- installed? installing ---
const fits = (r) => !r.os || (r.os === 'unix' ? !WIN : r.os === process.platform)
const ready = (r) => [r.cmd[0], ...(r.also ?? [])].every((p) => onPath(p))
const shown = (r) => (r.cmd[0] === 'bash' || r.cmd[0] === 'powershell' ? r.cmd.at(-1) : r.cmd.join(' '))
const versions = new Map() // id → its --version, once asked
const installs = new Map() // id → { running, log, error }

const run = (bin, args, { cwd = os.tmpdir(), timeout = 60_000, input } = {}) =>
  new Promise((resolve) => {
    let out = ''
    let err = ''
    const p = spawnCmd(bin, args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: !WIN, env: { ...process.env, NO_COLOR: '1' } })
    const t = setTimeout(() => killTree(p.pid, 'SIGKILL'), timeout)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    if (input !== undefined) p.stdin.end(input)
    p.on('error', (e) => (clearTimeout(t), resolve({ code: -1, out, err: err || e.message })))
    p.on('close', (code) => (clearTimeout(t), resolve({ code, out, err })))
  })

// its --version, asked once in the background: { v } once it answered (a slow one doesn't hold the list up)
function versionOf(id) {
  if (!versions.has(id)) {
    const got = {}
    versions.set(id, got)
    run(CLIS[id].bin, ['--version'], { timeout: 15_000 }).then(({ out, err }) => (got.v = (/\d+\.\d+[\w.+-]*/.exec(out || err)?.[0] ?? '').replace(/\.$/, '')))
  }
  return versions.get(id).v
}

// Every CLI, for the settings page: installed (its version, pending: not known yet), or how to install it
export function clisInfo() {
  return Object.entries(CLIS).map(([id, k]) => {
    const where = onPath(k.bin)
    const routes = k.install.filter(fits)
    const pick = routes.find(ready)
    const inst = installs.get(id)
    return {
      id, title: k.title, login: k.login, page: k.page, installed: Boolean(where), version: where ? (versionOf(id) ?? '') : '', ...(where && versionOf(id) === undefined && { pending: true }),
      ...(!where && { install: pick ? shown(pick) : '', commands: routes.map(shown), needs: pick ? '' : [...new Set(routes.map((r) => ({ npm: 'Node.js (npm)', bash: 'curl', uv: 'uv or pipx', pipx: 'uv or pipx' })[r.cmd[0]] ?? r.cmd[0]))].join(' or ') }),
      ...(inst && { installing: inst.running, log: inst.log.slice(-3000), error: inst.error }),
    }
  })
}

// Installs one in the background, by the first way that fits this machine; one at a time (npm's global
// folder doesn't take two at once). done(): finished, either way.
let queue = Promise.resolve()
export function installCli(id, done = () => {}) {
  const k = CLIS[id]
  if (!k) throw new Error(`no CLI "${id}"`)
  const r = k.install.filter(fits).find(ready)
  if (!r) throw new Error(`nothing here can install ${k.title}: see ${k.page}`)
  if (installs.get(id)?.running) return
  const st = { running: true, log: '', error: '' }
  installs.set(id, st)
  queue = queue.then(() => new Promise((resolve) => {
    const args = [...r.cmd.slice(1), ...(r.cmd[0] === 'npm' ? ['--loglevel=http'] : [])] // npm says nothing until it's done otherwise: looked stuck
    const p = spawnCmd(r.cmd[0], args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN, env: { ...process.env, CI: '1', NONINTERACTIVE: '1' } })
    const t = setTimeout(() => killTree(p.pid, 'SIGKILL'), 15 * 60_000) // an installer waiting for something that never comes
    const add = (d) => (st.log = (st.log + d).slice(-256_000))
    p.stdout.on('data', add)
    p.stderr.on('data', add)
    const end = (code, e) => {
      clearTimeout(t)
      widenPath()
      versions.delete(id)
      st.running = false
      if (code !== 0) st.error = `${shown(r)} failed (${e ?? `exit ${code}`}): ${st.log.trim().slice(-600)}`
      else if (!onPath(k.bin)) st.error = `installed, but "${k.bin}" isn't on HeartCode's PATH yet: restart HeartCode`
      log('cli', `install ${id}: ${st.error || 'done'}`)
      resolve()
      done()
    }
    p.on('error', (e) => end(-1, e.message))
    p.on('close', (code) => end(code))
  }))
}

// Where installers leave programs, on PATH for this run: npm's global bin, ~/.local/bin, ~/.opencode/bin…
function widenPath() {
  const add = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.opencode', 'bin'), path.join(os.homedir(), '.claude', 'local')]
  const npmBin = onPath('npm')
  if (npmBin) add.push(path.dirname(npmBin))
  if (process.env.npm_config_prefix) add.push(WIN ? process.env.npm_config_prefix : path.join(process.env.npm_config_prefix, 'bin'))
  const have = new Set((process.env.PATH ?? '').split(path.delimiter))
  for (const d of add) if (!have.has(d) && fs.existsSync(d)) process.env.PATH += path.delimiter + d
}

// --- models ---
const json = (text) => JSON.parse(text.slice(text.indexOf('{'))) // some print a log line first (Junie)
// [{ id, name, description }], asked of the CLI (a process start, no message sent)
export async function cliModels(id) {
  const k = CLIS[id]
  if (!onPath(k.bin)) throw new Error(`${k.title} isn't installed ("${k.bin}" isn't on PATH)`)
  if (k.models) return k.models()
  if (k.kind === 'claude') return claudeModels(k)
  if (k.kind === 'acp') return acpModels(id)
  const { code, out, err } = await run(k.bin, { codex: ['debug', 'models'], opencode: ['models'], junie: ['list-models'] }[k.kind])
  if (code !== 0) throw new Error(signedIn(id, err || out || `${k.bin} exited ${code}`))
  if (k.kind === 'opencode') return out.split('\n').map((l) => l.trim()).filter((l) => /^\S+\/\S+$/.test(l)).map((m) => ({ id: m, description: m.split('/')[0] }))
  if (k.kind === 'codex') return json(out).models.filter((m) => m.visibility !== 'hide').map((m) => ({ id: m.slug, name: m.display_name, description: m.description }))
  return json(out).models.map((m) => ({ id: m.id, name: m.displayName }))
}

// Claude Code's own model menu: the initialize control request, answered before anything is sent
async function claudeModels(k) {
  const p = spawnCmd(k.bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN })
  try {
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'heart-models', request: { subtype: 'initialize' } }) + '\n')
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${k.title} didn't list its models in 45s`)), 45_000)
      lines(p.stdout, (l) => {
        const r = l.type === 'control_response' && l.response?.request_id === 'heart-models' && l.response
        if (!r) return
        clearTimeout(t)
        if (r.subtype === 'error') return reject(new Error(r.error))
        resolve((r.response?.models ?? []).filter((m) => m.value).map((m) => ({ id: m.value, name: m.displayName, description: m.description })))
      })
      p.on('close', () => reject(new Error(`${k.title} ended without listing its models`)))
      p.on('error', reject)
    })
  } finally {
    killTree(p.pid, 'SIGKILL')
  }
}

async function kiroModels() {
  const { out } = await run('kiro-cli', ['chat', '--list-models', '--format', 'json'])
  return json(out).models.map((m) => ({ id: m.model_id, name: m.model_name, description: `${m.description ?? ''}${m.rate_multiplier ? ` (${m.rate_multiplier}x credits)` : ''}`.trim() }))
}
// the choices for "model" in `copilot help config`, and auto
async function copilotModels() {
  const { out } = await run('copilot', ['help', 'config'])
  const ms = [{ id: 'auto', name: 'Auto', description: 'Copilot picks the model' }]
  let inside = false
  for (const l of out.split('\n').map((x) => x.trim())) {
    if (l.startsWith('`model`:')) inside = true
    else if (inside && l.startsWith('- "')) ms.push({ id: l.slice(3, -1) })
    else if (inside && l) break
  }
  return ms
}
async function alphacodeModels() {
  const { out } = await run('alphacode', ['model', 'list', '--no-update'])
  return out.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(' ')).map((id) => ({ id }))
}

// One JSON object per line from a stream: each(obj)
function lines(stream, each) {
  let buf = ''
  stream.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!l.startsWith('{')) continue
      try {
        each(JSON.parse(l))
      } catch {}
    }
  })
}

// "not signed in" said as how to sign in
function signedIn(id, said) {
  const k = CLIS[id]
  said = String(said).trim().slice(-500)
  return /auth|log ?in|sign ?in|credential|api key|unauthori[sz]ed|not logged/i.test(said) ? `${k.title} isn't signed in: run \`${k.login}\` in a terminal (${said})` : said
}

// --- a message ---
// HeartCode's step names for what the CLIs call their tools (and ACP's kinds), so their steps read like
// HeartCode's own
const STEP_OF = { bash: 'run_command', shell: 'run_command', execute: 'run_command', commandexecution: 'run_command', runshellcommand: 'run_command', read: 'read_file', readfile: 'read_file', view: 'read_file', write: 'write_file', writefile: 'write_file', create: 'write_file', edit: 'edit_file', multiedit: 'edit_file', strreplace: 'edit_file', applypatch: 'edit_file', patch: 'edit_file', delete: 'edit_file', move: 'edit_file', grep: 'search', glob: 'search', search: 'search', find: 'search', ls: 'list_files', list: 'list_files', webfetch: 'web_fetch', fetch: 'web_fetch', websearch: 'web_search', todowrite: 'todo', task: 'agent', agent: 'agent', subagent: 'agent' }
const KEYS = ['command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'prompt', 'description']
function stepOf(name, input, cwd) {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '')
  let detail = ''
  for (const k of KEYS) if (typeof input?.[k] === 'string' && input[k]) (detail ||= input[k])
  if (detail && path.isAbsolute(detail) && detail.startsWith(cwd + path.sep)) detail = path.relative(cwd, detail)
  return [STEP_OF[n] ?? (String(name ?? 'tool').replace(/^mcp__/, '') || 'tool'), detail.replace(/\s+/g, ' ').slice(0, 200)]
}

// The words of a message (images left out: see the top)
const words = (c) => (Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('') : String(c ?? ''))
// Messages as one text, for a CLI that didn't see them
function transcript(msgs) {
  return msgs.map((m) => {
    if (m.role === 'tool') return `[a tool's result]: ${words(m.content).slice(0, 2000)}`
    const calls = (m.tool_calls ?? []).map((t) => `[called ${t.function?.name}(${String(t.function?.arguments ?? '').slice(0, 300)})]`).join('\n')
    return `[${m.role}]: ${[words(m.content), calls].filter(Boolean).join('\n')}`
  }).join('\n\n')
}

// A request to a CLI provider (client.js sends it here): { content, reasoning, toolCalls: [], cli: true }.
// opts.agent: a message of the conversation (worked on by the CLI, in opts.cwd: steps through
// opts.onStep(name, detail) / opts.onStepFailed(), asked through opts.confirm(question, kind), allowed
// what opts.permission says); else one plain question.
export async function cliChat(client, body, opts = {}) {
  const id = cliOf(client.baseUrl)
  const k = CLIS[id]
  if (!onPath(k.bin)) throw Object.assign(new Error(`${k.title} isn't installed ("${k.bin}" isn't on PATH): install it on /settings → Providers`), { status: 404 })
  const msgs = body.messages.filter((m) => m.role !== 'system')
  const agent = Boolean(opts.agent)
  const runs = (client.cliRuns ??= new Map()) // provider → { session, last: the last message it saw }
  const key = `${client.provider}/${client.model}`
  const was = agent ? runs.get(key) : null
  const at = was ? msgs.indexOf(was.last) : -1
  let session = at >= 0 ? was.session : null // a rewind (Esc Esc) or another conversation: a new session, told all of it
  let delta = session ? msgs.slice(at + 1) : msgs
  if (session && delta[0]?.role === 'assistant') delta = delta.slice(1) // its own answer
  // the message: the latest of yours; what came before it that it didn't see, as background
  const at2 = delta.findLastIndex((m) => m.role === 'user')
  const latest = delta[at2] ?? delta.at(-1)
  const earlier = delta.slice(0, Math.max(0, at2))
  const text = !agent
    ? (body.messages[0]?.role === 'system' ? `${words(body.messages[0].content)}\n\n---\n\n` : '') + (msgs.length === 1 ? words(msgs[0].content) : transcript(msgs))
    : earlier.length ? `Background: ${session ? 'what was said in this conversation since your last answer, while another assistant answered' : 'this conversation so far, from before you joined it'} (HeartCode, the app you run in, kept it):\n\n${transcript(earlier)}\n\n---\n\nMy message now:\n\n${words(latest?.content)}` : words(latest?.content)
  const said = { text: '', last: '', think: '' }
  const on = {
    text: (t) => t && ((said.text += t), (said.last += t), opts.onToken?.(t)),
    think: (t) => t && ((said.think += t), opts.onReasoning?.(t)),
    step: (name, input, detail) => {
      said.last = '' // the answer is what it says after its last step
      if (!agent) return
      const [n, d] = stepOf(name, input, opts.cwd ?? process.cwd())
      opts.onStep?.(n, detail ?? d)
    },
    fail: () => agent && opts.onStepFailed?.(),
  }
  const mode = agent ? (opts.permission ?? 'all') : 'plan'
  const cwd = agent ? (opts.cwd ?? process.cwd()) : os.tmpdir()
  const t0 = Date.now()
  const r = await DRIVERS[k.kind]({ id, k, model: client.model, text, session, mode, cwd, signal: opts.signal, on, confirm: opts.confirm, fresh: !agent })
  log('cli', `${id} · ${client.model}: ${agent ? 'a message' : 'a question'} in ${Date.now() - t0}ms${r.session ? ` (session ${r.session})` : ''}`)
  if (agent && r.session) runs.set(key, { session: r.session, last: latest })
  const content = (said.last.trim() ? said.last : r.answer || said.last || said.text).trim()
  return { content, reasoning: said.think.trim(), toolCalls: [], usage: null, finishReason: 'stop', cli: true }
}

// Stops a CLI and everything under it: some start their commands in groups of their own (opencode),
// which stopping its group leaves running (Windows: taskkill /T takes the tree)
function stopAll(pid) {
  if (!pid) return
  if (!WIN) {
    try {
      const kids = new Map()
      for (const l of execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
        const [c, p] = l.trim().split(/\s+/).map(Number)
        if (c) kids.set(p, [...(kids.get(p) ?? []), c])
      }
      const all = []
      for (let q = [pid]; q.length; ) for (const c of kids.get(q.shift()) ?? []) all.push(c), q.push(c)
      for (const c of all) killTree(c, 'SIGTERM', false)
    } catch {}
  }
  killTree(pid, 'SIGTERM')
}

// A CLI run for one message: started in its own process group (Esc stops all of it), its output read
// line by line (each(obj)), its environment guarded (guard.js: its commands can't stop HeartCode).
// { code, err } at the end.
function start(k, args, { cwd, signal, input, env = {} }, each) {
  return new Promise((resolve, reject) => {
    const p = spawnCmd(k.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN, env: { ...guarded('', process.env).env, ...env } })
    let err = ''
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)))
    lines(p.stdout, each)
    if (input !== undefined) p.stdin.end(input)
    else p.stdin.end()
    const stop = () => stopAll(p.pid)
    signal?.addEventListener('abort', stop, { once: true })
    p.on('error', (e) => reject(Object.assign(new Error(`couldn't start ${k.bin}: ${e.message}`), { status: 404 })))
    p.on('close', (code) => {
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) return reject(Object.assign(new Error('stopped'), { name: 'AbortError' }))
      resolve({ code, err: err.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim() })
    })
  })
}

// A failed run as an error: a sign-in its words name (401), a limit (429), anything else (400: not
// waited out; your list moves on, if you have one)
const failure = (id, said) => {
  const why = signedIn(id, said || 'it ended with an error')
  return Object.assign(new Error(`${CLIS[id].title}: ${why}`), { status: /isn't signed in/.test(why) ? 401 : /rate.?limit|429|quota|usage limit|too many requests/i.test(why) ? 429 : 400 })
}

const DRIVERS = {
  // claude -p, its stream-json; the message on stdin
  async claude({ id, k, model, text, session, mode, cwd, signal, on, fresh }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (model && model !== 'default') args.push('--model', model)
    if (fresh) args.push('--no-session-persistence', '--tools', '')
    else args.push(...({ all: ['--dangerously-skip-permissions'], commands: ['--permission-mode', 'acceptEdits'], plan: ['--permission-mode', 'plan'] }[mode] ?? []))
    if (session) args.push('--resume', session)
    let sid = null
    let result = null
    let streamed = false
    const { code, err } = await start(k, args, { cwd, signal, input: text, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }, (l) => {
      if (l.session_id) sid = l.session_id
      if (l.parent_tool_use_id) return // a subagent's: its work is its parent's step
      if (l.type === 'stream_event') {
        const d = l.event?.delta
        if (d?.type === 'text_delta') (streamed = true), on.text(d.text)
        if (d?.type === 'thinking_delta') on.think(d.thinking)
      } else if (l.type === 'assistant') {
        for (const c of l.message?.content ?? []) {
          if (c.type === 'tool_use') on.step(c.name, c.input)
          if (c.type === 'text' && !streamed) on.text(c.text)
        }
        streamed = false
      } else if (l.type === 'user') {
        for (const c of l.message?.content ?? []) if (c.type === 'tool_result' && c.is_error) on.fail()
      } else if (l.type === 'result') result = l
    })
    if (result?.is_error || (!result && code !== 0)) throw failure(id, result?.result || result?.error || err)
    return { session: sid, answer: result?.result }
  },
  // codex exec --json (exec resume <id> after the first); the message on stdin
  async codex({ id, k, model, text, session, mode, cwd, signal, on, fresh }) {
    const args = ['exec', ...(session ? ['resume'] : []), '--json', '--skip-git-repo-check']
    if (mode === 'all') args.push('--dangerously-bypass-approvals-and-sandbox')
    else args.push('-c', `sandbox_mode="${mode === 'commands' ? 'workspace-write' : 'read-only'}"`)
    if (fresh) args.push('--ephemeral')
    if (model) args.push('-m', model)
    if (session) args.push(session)
    args.push('-')
    let sid = null
    let error = ''
    const { code, err } = await start(k, args, { cwd, signal, input: text }, (l) => {
      const it = l.item ?? {}
      if (l.type === 'thread.started') sid = l.thread_id
      else if (l.type === 'item.started') {
        if (it.type === 'command_execution') on.step('bash', { command: it.command })
        else if (it.type === 'mcp_tool_call') on.step(`${it.server}.${it.tool}`, {})
        else if (it.type === 'web_search') on.step('websearch', { query: it.query })
      } else if (l.type === 'item.completed') {
        if (it.type === 'agent_message') on.text(it.text)
        else if (it.type === 'reasoning') on.think(it.text)
        else if (it.type === 'file_change') for (const c of it.changes ?? []) on.step('edit', { path: c.path })
        else if ((it.type === 'command_execution' && it.exit_code) || (it.type === 'mcp_tool_call' && it.status === 'failed')) on.fail()
      } else if (l.type === 'turn.failed') error = l.error?.message ?? 'the turn failed'
      else if (l.type === 'error') error = l.message
    })
    if (error || code !== 0) throw failure(id, error || err)
    return { session: sid }
  },
  // opencode run --format json; the message as its argument (a leading dash would read as a flag).
  // --standalone: its own server, under this run (the background service would go on with the work
  // after Esc, and its commands wouldn't be guarded)
  async opencode({ id, k, model, text, session, mode, cwd, signal, on }) {
    const args = ['run', '--standalone', '--format', 'json', '--thinking']
    if (model) args.push('-m', model)
    if (session) args.push('-s', session)
    if (mode === 'all') args.push('--auto')
    else args.push('--agent', 'plan') // its read-only agent: it can't ask here
    args.push(text.startsWith('-') ? ` ${text}` : text)
    let sid = null
    let error = ''
    const { code, err } = await start(k, args, { cwd, signal, env: { OPENCODE_DISABLE_AUTOUPDATE: '1', PWD: cwd } }, (l) => {
      sid ??= l.sessionID
      const p = l.part ?? {}
      if (l.type === 'text') on.text(p.text)
      else if (l.type === 'reasoning') on.think(p.text)
      else if (l.type === 'tool_use') {
        on.step(p.tool, p.state?.input)
        if (p.state?.status === 'error') on.fail()
      } else if (l.type === 'error') error = l.error?.data?.message ?? l.error?.message ?? 'opencode reported an error'
    })
    if (error || (code !== 0 && !sid)) throw failure(id, error || err)
    return { session: sid }
  },
  // junie --output-format=json-stream; it can't be held back, so only with "do everything"
  async junie({ id, k, model, text, session, mode, cwd, signal, on, fresh }) {
    if (mode !== 'all' && !fresh) throw Object.assign(new Error(`Junie can't be limited to asking first or reading: it works only with "do everything without asking" (Shift+Tab)`), { status: 400 })
    const args = ['--output-format=json-stream', ...(session ? [`--session-id=${session}`] : []), ...(model ? [`--model=${model}`] : []), text]
    let sid = null
    let error = ''
    let answer = ''
    const { code, err } = await start(k, args, { cwd, signal }, (l) => {
      if (l.type === 'session') sid = l.sessionId
      else if (l.type === 'step' && l.name !== 'TASK RESULT') on.step(l.name, null, String(l.details ?? '').split('\n')[0])
      else if (l.type === 'result' && l.status === 'failed') error ||= [l.errors].flat().filter(Boolean).join('; ')
      else if (l.type === 'result') (answer = l.result), on.text(l.result)
      else if (l.type === 'error') error = l.error || l.message || l.details || 'Junie reported an error'
    })
    if (error || (code !== 0 && !answer)) throw failure(id, error || err)
    return { session: sid, answer }
  },
  acp: acpRun,
}

// --- ACP: JSON-RPC over the CLI's stdin and stdout ---
function acpConnect(id, { cwd, args = [], env = {}, onNote = () => {}, onAsk = async () => null }) {
  const k = CLIS[id]
  const p = spawnCmd(k.bin, [...k.args, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN, env: { ...guarded('', process.env).env, ...env } })
  let next = 0
  const waiting = new Map()
  let err = ''
  let dead = null
  p.stderr.on('data', (d) => (err = (err + d).slice(-4000)))
  const send = (m) => !dead && p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  lines(p.stdout, async (m) => {
    if (m.method && m.id !== undefined) {
      try {
        send({ id: m.id, result: await onAsk(m.method, m.params ?? {}) })
      } catch (e) {
        send({ id: m.id, error: { code: -32601, message: e.message } })
      }
    } else if (m.method) onNote(m.method, m.params ?? {})
    else if (waiting.has(m.id)) {
      const w = waiting.get(m.id)
      waiting.delete(m.id)
      m.error ? w.reject(Object.assign(new Error(m.error.message + (m.error.data ? ` (${JSON.stringify(m.error.data).slice(0, 300)})` : '')), { rpc: true })) : w.resolve(m.result ?? {})
    }
  })
  const gone = new Promise((resolve) => p.on('close', resolve))
  p.on('error', (e) => (err ||= e.message))
  gone.then(() => {
    dead = new Error(`${k.title} stopped${err ? `: ${err.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().slice(-500)}` : ''}`)
    for (const w of waiting.values()) w.reject(dead)
    waiting.clear()
  })
  const call = (method, params) => (dead ? Promise.reject(dead) : new Promise((resolve, reject) => {
    const id = ++next
    waiting.set(id, { resolve, reject })
    send({ id, method, params })
  }))
  const hello = () => call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'heartcode', title: 'HeartCode', version: '1' } })
  return { call, notify: (method, params) => send({ method, params }), hello, close: () => (p.stdin.end(), stopAll(p.pid)), pid: p.pid }
}
// a session's choices for one kind of setting ("model", "mode"), from its configOptions
const optionOf = (s, category) => s.configOptions?.find((o) => o.category === category || o.id === category)
const valuesOf = (o) => (o?.options ?? []).flatMap((c) => c.options ?? [c])

async function acpModels(id) {
  const dir = path.join(os.tmpdir(), 'heartcode-models')
  fs.mkdirSync(dir, { recursive: true })
  const c = acpConnect(id, { cwd: dir })
  try {
    const caps = (await c.hello()).agentCapabilities ?? {}
    const s = await c.call('session/new', { cwd: dir, mcpServers: [] }).catch((e) => Promise.reject(new Error(signedIn(id, e.message))))
    if (caps.sessionCapabilities?.delete) await c.call('session/delete', { sessionId: s.sessionId }).catch(() => {})
    else if (caps.sessionCapabilities?.close) await c.call('session/close', { sessionId: s.sessionId }).catch(() => {})
    const o = optionOf(s, 'model')
    if (o) return valuesOf(o).map((v) => ({ id: v.value, name: v.name, description: v.description }))
    return (s.models?.availableModels ?? []).map((m) => ({ id: m.modelId, name: m.name, description: m.description }))
  } finally {
    c.close()
  }
}

async function acpRun({ id, k, model, text, session, mode, cwd, signal, on, confirm, fresh }) {
  const all = mode === 'all'
  const calls = new Map() // its tool calls, shown once they say what they do
  const show = (u, c) => {
    if (c.shown || !(c.input || u.status === 'completed' || u.status === 'failed')) return
    c.shown = true
    on.step(c.tool || (c.title && !c.title.includes(' ') ? c.title : c.kind) || c.title, c.input ?? {}, c.input ? undefined : (c.path ?? (c.title?.includes(' ') ? c.title : '')))
  }
  let loading = false // a session reopened replays itself: not news
  const conn = acpConnect(id, {
    cwd,
    args: [...(all ? (k.bypassArgs ?? []) : []), ...(k.modelArgs?.(model) ?? [])],
    env: k.modeEnv?.[mode],
    onNote: (method, { update: u }) => {
      if (method !== 'session/update' || !u || loading) return
      if (u.sessionUpdate === 'agent_message_chunk') on.text(u.content?.text)
      else if (u.sessionUpdate === 'agent_thought_chunk') on.think(u.content?.text)
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const c = calls.get(u.toolCallId) ?? {}
        calls.set(u.toolCallId, c)
        c.title = u.title || c.title
        c.kind = u.kind || c.kind
        c.tool = u._meta?.toolName || u._meta?.claudeCode?.toolName || c.tool
        if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) c.input = u.rawInput
        c.path = u.locations?.[0]?.path || c.path
        show(u, c)
        if (u.status === 'failed') on.fail()
      }
    },
    // its permission questions: yours to answer, as HeartCode's own (the mode you're in decides)
    onAsk: async (method, r) => {
      if (method !== 'session/request_permission') throw new Error(`${method} isn't something HeartCode does`)
      const kind = r.toolCall?.kind
      const reading = ['read', 'search', 'fetch', 'think'].includes(kind)
      const title = String(r.toolCall?.title ?? kind ?? 'a step').split(cwd + path.sep).join('')
      const verb = { edit: 'change', delete: 'delete', move: 'move', execute: 'run', fetch: 'fetch', read: 'read', search: 'search' }[kind]
      const question = !title.includes(' ') && verb ? `${k.title} wants to ${verb} ${title}` : `${k.title}: ${title}?`
      const yes = fresh ? reading : all || (mode === 'plan' && reading) || (mode !== 'plan' && (await confirm?.(question, kind === 'execute' ? 'command' : reading ? 'read' : 'edit')) === true)
      const want = yes ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
      const pick = want.map((w) => r.options?.find((o) => o.kind === w)).find(Boolean)
      return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } }
    },
  })
  const stop = () => sid && conn.notify('session/cancel', { sessionId: sid })
  let sid = null
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const caps = (await conn.hello()).agentCapabilities ?? {}
    let s = null
    if (session && (caps.sessionCapabilities?.resume || caps.loadSession)) {
      loading = true
      s = await conn.call(caps.sessionCapabilities?.resume ? 'session/resume' : 'session/load', { sessionId: session, cwd, mcpServers: [] }).catch(() => null)
      loading = false
      if (s) s.sessionId ??= session
    }
    if (!s && session) text = `(You don't remember this conversation's start: ${k.title} couldn't reopen its session.)\n\n${text}`
    s ??= await conn.call('session/new', { cwd, mcpServers: [] })
    sid = s.sessionId
    for (const [opt, value] of k.modes?.[mode] ?? []) await acpSet(conn, s, opt, value)
    if (model && !k.modelArgs) {
      const o = optionOf(s, 'model')
      await (o ? conn.call('session/set_config_option', { sessionId: sid, configId: o.id, value: model }) : conn.call('session/set_model', { sessionId: sid, modelId: model })).catch((e) => log('cli', `${id}: model ${model}: ${e.message}`))
    }
    const res = await conn.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] })
    if (res.stopReason === 'cancelled' || signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
    for (const [, c] of calls) show({ status: 'completed' }, c)
    if (fresh && (caps.sessionCapabilities?.delete || caps.sessionCapabilities?.close)) await conn.call(caps.sessionCapabilities.delete ? 'session/delete' : 'session/close', { sessionId: sid }).catch(() => {})
    return { session: caps.loadSession || caps.sessionCapabilities?.resume ? sid : null }
  } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
    throw failure(id, e.message)
  } finally {
    signal?.removeEventListener('abort', stop)
    conn.close()
  }
}
// one of a session's settings, or its mode; only what it offers
async function acpSet(conn, s, opt, value) {
  try {
    if (opt === 'mode') {
      const o = optionOf(s, 'mode')
      if (o) await conn.call('session/set_config_option', { sessionId: s.sessionId, configId: o.id, value })
      else if (s.modes) await conn.call('session/set_mode', { sessionId: s.sessionId, modeId: value })
    } else {
      const o = s.configOptions?.find((x) => x.id === opt)
      if (o) await conn.call('session/set_config_option', { sessionId: s.sessionId, configId: opt, value: o.type === 'boolean' ? value === 'true' : value })
    }
  } catch (e) {
    log('cli', `set ${opt}=${value}: ${e.message}`)
  }
}
