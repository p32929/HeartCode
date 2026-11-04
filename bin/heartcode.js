#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Client, limitSaid } from '../src/client.js'
import { loadConfig, saveConfig, readJson, writeJson, providerName, CONFIG_FILE, HOME, TEMP, AUTO_MODEL, isAuto, parseModel, takeIn, whatOf, VERSION } from '../src/config.js'
import { loadProfile, strategy, describe, profilePath, profileFrom } from '../src/probe.js'
import { learnFromUsage, LIMIT_MS, RATE_CAP_MS } from '../src/context.js'
import { whyUnusable } from '../src/usable.js'
import { Session, transcript, contextReport, firstRequest } from '../src/agent.js'
import { listJobs, getJob, stopJob, removeJob, runningJobs, tailLines, ago as ranFor } from '../src/background.js'
import { checkUpdate, installKind, UPDATE_COMMANDS, packageDir, whatsNew } from '../src/update.js'
import { treeItems, codePlan, move, leaving, leftText, leftFiles } from '../src/tree.js'
import { UI, c, PERMISSIONS, duration, copyText, rank, setTheme, themeCodes, renderDiff, diffLines, DEFAULT_KEYS, loadKeys, width } from '../src/ui.js'
import { listFiles, runCommand, clip } from '../src/tools.js'
import { notify } from '../src/telegram.js'
import { log, LOG_FILE, LOG_DIR, requestLog, useRequestLog, useLogs, pruneLogs, logDays } from '../src/log.js'
import { prompt, usePromptsFrom, reloadPrompts } from '../src/prompts.js'
import { newChat, saveChat, listChats, loadChat, restoreFiles, ago, forkChat, exportChat } from '../src/sessions.js'
import { loadPrices, priceOf, addUsage, money, limitsOf } from '../src/usage.js'
import { Mcp, mcpAuth, loadServers } from '../src/mcp.js'
import { forget } from '../src/oauth.js'
import { loadSkills, fillArgs, extraSkillDirs } from '../src/skills.js'
import { HeadlessUI, runHeadless, toolNames, PERMISSION_MODES } from '../src/headless.js'
import { findImports, installSkill } from '../src/importer.js'
import { capabilities } from '../src/capabilities.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { Memory } from '../src/memory.js'
import { Director } from '../src/director.js'
import { createWorktree, worktreeState, removeWorktree } from '../src/worktree.js'
import { runAcp } from '../src/acp.js'
import { Tabs } from '../src/tabs.js'
import { startSettings } from '../src/settings.js'
import { loadHooks } from '../src/hooks.js'
import { RESETS, reset, resetPaths, resetCode } from '../src/reset.js'

const LOCAL_SERVERS = ['http://localhost:11434/v1', 'http://localhost:1234/v1', 'http://localhost:8080/v1']

const HELP = `${c.magenta('♥')} ${c.bold('HeartCode')} — a coding CLI for any local or OpenAI-compatible model

${c.bold('usage')}
  heart                              interactive session in this folder (or: heart .)
  heart ~/code/my-app                in that folder (a folder, not a file)
  heart "fix the failing test"       run one task and exit
  heart providers                    list added providers
  heart models [filter]              what -m takes, one per line: "auto" (your list), then your models
                                     as provider/model, #1 first
  heart models --all [filter]        every provider's models (provider/model)
  heart models --json                as JSON (with --all too), for other programs
  heart config                       show the config file
  heart settings                     change providers, models and settings in your browser

${c.bold('options')}
  -u, --base-url <url>   use this server for this run (add --save to keep it)
  -m, --model <name>     this model alone for this run (provider/model, or a model of #1's provider);
                         "auto" (the default): your list, #1 then the next when one fails
      --fallback-model <name>  after -m's model when it fails (repeatable)
      --api-key <key>    API key for --base-url
  -y, --yes              do everything without asking (the default)
      --ask              ask before every edit and command, this run
      --hide-thinking    the model's thinking: only its last two lines while it thinks (the default; Ctrl+O shows all of it)
  -C, --cwd <dir>        project folder (default: current folder)
      --temp             keep nothing: a throwaway settings folder (your providers, model info,
                         prices and notes copied in), shared by the --temp runs going on at once
                         and deleted after the last, with its logs; ~/.heart and the project's
                         .heartcode/ aren't touched (their notes and research are read from a copy)
      --context <n>      context window size in tokens
      --save             keep the given -u/-m/--api-key/... in ${CONFIG_FILE}
  -w, --worktree         work in a new git worktree and branch (--worktree=name to name it,
                         or to continue in it); removed on exit if nothing changed
  -c, --continue         continue the last session in this folder
  -r, --resume [id]      pick an earlier session to continue (or the one with this id)
      --provider <name>  use this provider for this run (or -m provider/model)

${c.bold('headless')} (for other programs; flags and output as in Claude Code's -p)
  -p, --print                        run without the screen, print the answer, exit
      --output-format <f>            text (default), json, or stream-json (one JSON event per line)
      --input-format <f>             text (default; the prompt, or stdin) or stream-json (messages on stdin)
      --append-system-prompt <text>  added to HeartCode's system prompt
      --mcp-config <file|json>       more MCP servers (repeatable); --strict-mcp-config: only those
      --skills-dir <dir>             more skills (repeatable)
      --allowedTools <list>          only these tools (HeartCode's or Claude Code's names: Read, Edit, Bash…)
      --disallowedTools <list>       never these tools
      --model-choice <order|fit>     your models' order (#1, then the next), or fit: an orchestrator hands each task out
      --permission-mode <m>          all, commands, ask, plan (or bypassPermissions, acceptEdits, default);
                                     --dangerously-skip-permissions = all. Nothing is asked: the rest is declined
      --session-id <id>              start (or continue) the session with this id
      --effort <level>               low, medium or high, for thinking models
      --no-memory                    don't read or write memory notes
      --max-retries <n>              give up on a failing request after n retries (headless default 10;
                                     interactive: until Esc)
      --max-turns <n>                stop after n model steps in one message (default: no limit)
      --verbose                      warnings and retries on stderr

${c.bold('editors')}  heartcode --acp   the Agent Client Protocol on stdin/stdout (Zed, JetBrains, Neovim)

${c.bold('env')}  HEART_BASE_URL, HEART_MODEL, HEART_API_KEY (or OPENAI_BASE_URL / OPENAI_API_KEY)
     HEART_LOG=<file>  every kind of log of this run in that one file, whatever is switched on (off: none)

${c.bold('in a session')}  attach an image with @path/to/shot.png · /help for commands`

// [name, description, takes an argument], by section. /help and the "/" menu are built from it.
const SECTIONS = [
  ['providers and models', [
    ['/select_model', 'pick the model(s) for this session: one pins it, several rotate among them, auto = your whole list', true],
  ]],
  ['settings', [
    ['/toggle_thinking', "the model's thinking: its last two lines, or all of it (Ctrl+O)"],
    ['/voice', 'say your message (or Space in an empty box): it shows in the box as you speak, Enter sends it, Esc cancels'],
  ]],
  ['session', [
    ['/resume', 'continue an earlier session in this folder'],
    ['/rewind', 'go back to an earlier message: conversation, code or both (Esc Esc); what came after stays in /tree'],
    ['/tree', "every message on every branch of this session: go to any, the files follow, a summary of what you leave comes along"],
    ['/rename', 'name this session (shown in /resume)', true],
    ['/fork', 'go on in a copy of this session (the original stays in /resume)'],
    ['/export', 'save the conversation as Markdown, HTML or JSON', true],
    ['/copy', "copy the model's last answer to the clipboard"],
    ['/diff', 'every change HeartCode made to files in this session (add a file name to see one)', true],
    ['/init', 'look at the project and write AGENTS.md: its commands, conventions and layout'],
    ['/btw', 'ask something on the side, also while it works; the answer stays out of the conversation', true],
    ['/cost', 'tokens used and what they cost, this session'],
    ['/context', "what's in the context now: system prompt, tools, messages, tool results, and the biggest pieces"],
    ['/background', 'commands running in the background (servers, watchers): their logs live, a tab each (Alt+B) · /background stop [id] · /background files', true],
    ['/model_info', 'what the model can do and how HeartCode uses it'],
    ['/tidy_memory', 'merge, update and link the memory notes now'],
    ['/import', 'bring commands, skills, MCP servers and memory from other CLIs'],
    ['/install_skill', 'install a skill from a GitHub repo or a SKILL.md URL (add --project for this folder only)', true],
    ['/doctor', 'check the outside tools HeartCode features need (voice, browser, git) and what to install'],
    ['/update', 'install the newest HeartCode (shows what changed first)'],
    ['/mcp', 'your MCP servers and whether each needs signing in'],
    ['/login_mcp', 'sign in (again) to a remote MCP server', true],
    ['/compact', 'summarize the conversation to free up context (add what to keep)', true],
    ['/clear_chat', 'forget the conversation'],
    ['/reset', "HeartCode's settings (or also providers, or everything) back to the start; asks for a code first"],
    ['/settings', 'change providers, models, settings, MCP servers, hooks, keys and skills in your browser'],
    ['/help', 'this list'],
    ['/tab', 'a new tab (Alt+T): another conversation beside this one · /tab worktree [name]: in its own git worktree · /tab 2: go to tab 2 (Alt+N/P) · Alt+W closes one', true],
    ['/close_tab', 'close this tab (Alt+W); asks first'],
    ['/exit', 'quit HeartCode (Alt+W closes just this tab)'],
  ]],
]
const byName = (a, b) => a[0].localeCompare(b[0])
for (const [, list] of SECTIONS) list.sort(byName) // alphabetical, in /help and in the "/" menu
const COMMANDS = SECTIONS.flatMap(([, list]) => list).sort(byName)
// Typed while a task works, these run at once, beside it: they leave the conversation alone. The
// others (/compact, /rewind, /resume, /init…) wait in the queue until it's done.
const RIGHT_AWAY = new Set(['help', 'cost', 'context', 'background', 'model_info', 'diff', 'copy', 'mcp', 'doctor', 'toggle_thinking', 'btw', 'rename', 'export', 'tab', 'close_tab', 'exit', 'quit', 'settings', 'login_mcp', 'install_skill', 'import', 'voice', 'select_model'])
const helpText = (sections) => sections.map(([title, list]) => `  ${c.bold(title)}\n` + list.map(([n, d]) => `  ${c.cyan(n.padEnd(18))} ${d}`).join('\n')).join('\n\n')
const SLASH = helpText(SECTIONS)

// The keyboard shortcuts, as [keys, what] rows, read from the effective keybindings (keybindings.json
// can change any of them) plus the fixed ones (Space, Enter, Esc, Shift+Tab, Ctrl+C).
function keysHelp(keys = {}, mouse = false) {
  const NAMES = { pageup: 'PgUp', pagedown: 'PgDn', up: '↑', down: '↓', left: '←', right: '→', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
  const pretty = (k) => k.split('+').map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('+')
  const forAct = (a) => Object.entries(keys).filter(([, v]) => v === a).map(([k]) => pretty(k)).join(' / ')
  const tabs = /(^|,)alt\+[1-9]/.test(Object.keys(keys).join(','))
  const rows = [
    ['Space', 'voice: listens at once, Enter sends what you said (in an empty box)'],
    ['Enter', 'send · while it works, queue the message (commands like /help, /cost, /select_model run at once)'],
    ['Option/Shift/Ctrl+Enter', 'new line in the box'],
    ['Esc', 'stop the task (press twice to confirm)'],
    ['Esc Esc', 'rewind to an earlier message (at the prompt)'],
    ['Shift+Tab', 'change what runs without asking (permissions)'],
    [forAct('background_log'), "the background commands' logs in a dialog, a tab each (←/→ switch, ↑/↓ scroll, K twice stops one, Esc closes)"],
    [forAct('new_tab'), 'new tab'],
    [forAct('close_tab'), 'close this tab'],
    [forAct('next_tab'), 'next tab'],
    [forAct('prev_tab'), 'previous tab'],
    [tabs ? 'Alt+1…9' : '', 'go to tab 1–9'],
    [forAct('send_first'), 'queue: send the first one now'],
    [forAct('send_all'), 'queue: send all now'],
    [forAct('queue_mode'), 'queue: one by one, or all together'],
    [[forAct('scroll_up'), forAct('scroll_down')].filter(Boolean).join(' / '), 'scroll the conversation a page'],
    [[forAct('scroll_top'), forAct('scroll_bottom')].filter(Boolean).join(' / '), 'to the top / bottom of the conversation (scrolled up, it stays put while the answer comes in)'],
    [[forAct('scroll_line_up'), forAct('scroll_line_down')].filter(Boolean).join(' / '), 'scroll a few lines'],
    ['Ctrl+C', 'stop · twice quits HeartCode'],
    [mouse ? 'Drag' : '', 'select and copy: the conversation, a dialog, the folder, the input, the status bar'],
    [mouse ? 'Double-click' : '', 'copy the word under it (an address, a path, a model)'],
    [mouse ? (process.platform === 'darwin' ? 'Option+drag' : 'Shift+drag') : '', "the terminal's own selection, past HeartCode's"],
    [mouse ? '' : 'Mouse', 'the terminal\'s own: select and copy as usual (switch "HeartCode takes the mouse" on in /settings → General for the wheel to scroll only the conversation)'],
  ].filter(([k]) => k)
  return rows
}

const HOWTO = `${c.yellow('No model set up yet.')} Add a provider and choose its models in your browser:

  ${c.cyan('/settings')}          (or ${c.cyan('heart settings')} in another terminal)

${c.dim('Ollama, LM Studio or llama.cpp running on this machine is found on its own.')}`
const NO_MODELS = `${c.yellow('No model chosen yet.')} Choose one on ${c.cyan('/settings')}: a provider's models, click one.`
const ALL_OFF = `${c.yellow('The providers of all your models are switched off.')} Switch one on on ${c.cyan('/settings')}, or add a model of one that's on.`

// Choices for commands that take one (also offered in the "/" menu).
const ARGS = {
  export: [['md', 'Markdown'], ['html', 'a web page'], ['json', 'the whole session file']],
  set_effort: [['default', 'low: a little thinking, shown as it comes'], ['low', 'quick, less thinking'], ['medium', 'balanced'], ['high', 'thinks the longest']],
}


// Terminal.app can't report Shift+Enter; Option+Enter works there ("Use Option as Meta key").
const NEWLINE_KEY = process.env.TERM_PROGRAM === 'Apple_Terminal' ? 'Option+Enter' : 'Shift+Enter'

const kTokens = (n) => (n >= 1e6 ? `${Number((n / 1e6).toFixed(2))}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)) // 1.05M, not rounded up to 1.1M

const mask = (k) => (k ? (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '…') : c.dim('no key'))

// The status bar's default layout (two lines): the model and what it can do, then the run's stats and
// controls — model and context on the left, abilities and controls pushed to the right. cfg.statusBar
// overrides it — see App.status for the item names and format.
const DEFAULT_STATUS = [
  { left: ['provider', 'model'], right: ['mode', 'thinking', 'images'] },
  { left: ['ctx', 'tps', 'autocompact'], right: ['background', 'permissions', 'worktree', 'cost'] },
]

class App {
  constructor(cfg, ui, root) {
    Object.assign(this, { cfg, ui, root })
    this.s = null // the Session, built on first use
    this.lists = {} // provider → model ids, cached for this run
    this.chat = newChat(root) // the conversation, saved after every message (sessions.js)
    this.mcp = this.newMcp() // MCP servers (each starts when first used); cfg.mcp: --mcp-config
    this.skills = loadSkills(root)
    this.memory = new Memory(root) // .heartcode/memory: notes linked with [[name]]
    this.director = new Director(this) // the manage tool: skills, MCP servers and settings by asking
    this.later = [] // setting changes that wait until the current message is done
    this.failures = {} // "provider model" → failed requests this session (engine: onFail)
    this.resting = {} // "provider model" → until when it's out of quota (the server said so: engine: onFail)
    this.loadProjectModels() // the model(s) you last chose for this folder (.heartcode/models.json)
  }

  // Per folder: the model set you picked with /select_model, remembered in .heartcode/models.json and
  // restored when you open this folder again. Absent/empty means auto (your whole list). A -m model
  // from the command line (cfg.session already set) wins and isn't overwritten.
  loadProjectModels() {
    if (this.cfg.session) return
    const saved = readJson(path.join(this.root, '.heartcode', 'models.json'), null)
    const valid = (saved?.session ?? []).filter((t) => t?.provider && t?.model && this.cfg.providers[t.provider])
    if (valid.length) [this.cfg.session, this.folderModels] = [valid, true]
  }

  saveProjectModels() {
    if (TEMP) return // --temp keeps nothing: the choice lasts for this run only
    const file = path.join(this.root, '.heartcode', 'models.json')
    if (this.cfg.session?.length) writeJson(file, { session: this.cfg.session.map((t) => ({ provider: t.provider, model: t.model })) })
    else fs.rmSync(file, { force: true }) // auto: forget the folder's choice
  }

  newMcp() {
    const mcp = new Mcp(this.root, this.cfg.mcp)
    // a remote server asks to sign in: its page opens in the browser (and the link is shown)
    if (!this.ui.noUser)
      mcp.onSignIn = (name, url) => {
        this.ui.print(`${c.info('↗')} ${c.bold(name)} ${c.muted('needs you to sign in; opening your browser…')}\n  ${c.faint(url)}`)
        const [cmd, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url]
        spawnSync(cmd, args, { stdio: 'ignore' })
        this.ui.spinner(`waiting for you to sign in to ${name} in the browser · Esc to stop`)
      }
    return mcp
  }

  // After a skill or MCP server was saved or deleted (the settings page, the director, /import):
  // from the next tool call. The old servers are stopped once the message in progress is done
  // (busy), so a call to one of them finishes.
  reload(kind, busy = false) {
    if (kind === 'skill') this.skills = loadSkills(this.root)
    if (kind === 'mcp') {
      const old = this.mcp
      this.mcp = this.newMcp()
      busy ? this.later.push(() => old.dispose()) : old.dispose()
    }
    if (this.s) Object.assign(this.s, { skills: this.skills, mcp: this.mcp })
  }

  afterLine() {
    for (const fn of this.later.splice(0)) fn()
  }

  // The settings the director can change (manage, kind setting).
  settings() {
    const { cfg, ui } = this
    return [
      `permissions: ${ui.permission}`,
      `effort: ${cfg.effort ?? 'default'}`,
      `auto_compact: ${cfg.autoCompact === false ? 'off' : 'on'}`,
      `director: ${cfg.director === false ? 'off' : 'on'}`,
      `model: ${this.inUse() ? `${this.inUse().provider} ${this.inUse().model}` : '(none)'}`,
      `providers: ${Object.keys(cfg.providers).join(', ') || '(none)'}`,
    ].join('\n')
  }

  applySetting(name, value) {
    const { cfg, ui } = this
    const v = value.trim()
    const bool = /^(on|true|yes)$/i.test(v) ? true : /^(off|false|no)$/i.test(v) ? false : null
    const bad = (choices) => `error: ${name} must be ${choices}`
    const save = (msg) => (saveConfig(cfg), log('director', `setting ${name} = ${v}`), msg)
    switch (name) {
      case 'permissions': {
        if (!PERMISSIONS.some(([p]) => p === v)) return bad('all, commands, ask or plan')
        // allowing more than now: only if you say yes (the model can't give itself more on its own)
        const free = (p) => ['plan', 'ask', 'commands', 'all'].indexOf(p)
        if (free(v) <= free(ui.permission)) return (ui.setPermission(v), `permissions: ${v}`)
        return ui.confirm(`The model wants to change permissions from "${ui.permission}" to "${v}". Allow?`, 'command').then((ok) => (ok === true ? (ui.setPermission(v), `permissions: ${v}`) : `The user didn't allow it; permissions stay "${ui.permission}".`))
      }
      case 'effort':
        if (!ARGS.set_effort.some(([o]) => o === v)) return bad('default, low, medium or high')
        cfg.effort = v === 'default' ? undefined : v
        if (this.s?.strat.thinking) this.s.client.effort = effortOf(cfg)
        return save(`effort: ${v}`)
      case 'auto_compact':
      case 'director':
        if (bool === null) return bad('on or off')
        cfg[name === 'director' ? 'director' : 'autoCompact'] = bool
        if (name === 'auto_compact' && this.s) this.s.autoCompact = bool
        return save(`${name}: ${bool ? 'on' : 'off'}${name === 'director' ? ' (from the next message)' : ''}`)
      case 'model': {
        const { provider: p, model: m } = parseModel(v, cfg.providers, cfg.provider)
        if (!cfg.providers[p] || !m) return `error: give provider/model or a model of the current provider; providers: ${Object.keys(cfg.providers).join(', ')}`
        // headless (-p) and editors (ACP): the program that started HeartCode chooses the model
        if (this.ui instanceof HeadlessUI) return 'error: the model can\'t be switched here: the program that started HeartCode chooses it'
        this.later.push(() => this.use(p, m).catch((e) => ui.warn(e.message)))
        return `switching to ${p} · ${m} after this reply`
      }
      default:
        return `error: no setting "${name}"; manage list kind setting shows them`
    }
  }

  // The model, its probe and strategy for a provider and model (probed once, then cached).
  // quiet: for a helper (orchestration): nothing printed about the model, the settings left alone.
  async engine(provider, model, ui, signal, { quiet = false } = {}) {
    const { cfg } = this
    const client = this.client(provider, model)
    let price = null
    // tokens and cost, into the chat (also a helper's, the probe's, compaction's)
    client.price = () => price
    client.onSpend = (u) => addUsage((this.chat.usage ??= {}), u, price)
    client.onRetry = (err, ms, attempt, next) => ui.retrying(err, ms, attempt, next) // keep trying until Esc (also while probing)
    // failures per model this session: the main model sees them (Your other models) and helpers
    // are tried in that order
    client.onFail = (e, t) => {
      if (e.name === 'AbortError') return
      const k = `${t.provider} ${t.model}`
      this.failures[k] = (this.failures[k] ?? 0) + 1
      if (Number(e.retryAfter) > 60) this.resting[k] = Date.now() + Number(e.retryAfter) * 1000
      // "too large" with the limit stated (Groq: "Limit 2000 … tokens per minute"): kept in its profile,
      // so it isn't sent what it can't take, and is left out where its first request is bigger (usable.js)
      const said = limitSaid(e)
      if (said) {
        const cl = this.client(t.provider, t.model)
        const p = loadProfile(cl) || profileFrom(cl, limitsOf(t.provider, cl.baseUrl, t.model))
        if (said.rate) p.rateCap = { tokens: said.tokens, until: Date.now() + RATE_CAP_MS }
        else Object.assign(p, { inputLimit: said.tokens, inputLimitAt: Date.now() })
        writeJson(profilePath(cl), p)
        log('context', `${k}: ${said.rate ? 'a per-minute cap' : 'a request limit'} of ${said.tokens} tokens, from its provider`)
      }
    }
    // the model list (settings page): another model answered
    // told once the reply that came is closed (it's known before the reply's last line ends: it'd go on
    // that line): the agent says it then (announceSwitch), else right after
    let switched = null
    client.announceSwitch = () => switched && (ui.print(switched), (switched = null))
    client.onSwitch = (t) => {
      const i = client.rotation.list.indexOf(t)
      switched = c.dim(`↻ ${t.provider} · ${t.model} answered${i ? ` (#${i + 1} in your model list)` : ' (#1 again)'}`)
      setImmediate(client.announceSwitch)
    }
    if (cfg.maxRetries !== undefined) client.retryIf = (e, attempt) => attempt < cfg.maxRetries // headless: then give up
    let profile = await getProfile(client, ui, quiet)
    const strat = {}
    // The model asked from now on (at first, and when the model list moves on): its own profile,
    // abilities (sees images? calls tools? its window), thinking effort, price, and what its
    // provider refuses. client.can: what the conversation is fitted to before each request.
    const apply = () => {
      for (const k of Object.keys(strat)) delete strat[k]
      Object.assign(strat, strategy(profile, cfg))
      Object.assign(client, { tokenRatio: profile.tokenRatio ?? 1, knownGood: profile.largestAccepted ?? 0, can: strat, effort: strat.thinking ? effortOf(cfg) : undefined })
      for (const [q, at] of Object.entries(profile.quirks ?? {})) if (Date.now() - at < LIMIT_MS) client.quirks[q] = true
      price = priceOf(client.provider, client.baseUrl, client.model)
      if (this.s?.client === client) this.s.profile = profile // /model_info, the settings page
    }
    apply()
    // the profile file as this run last read or wrote it: changed since (the settings page, another
    // HeartCode, a helper on the same model), it's read again before the next request
    let stamp = stampOf(profilePath(client))
    client.onUse = (t) => {
      profile = loadProfile(client) || profileFrom(client, limitsOf(t.provider, client.baseUrl, t.model))
      stamp = stampOf(profilePath(client))
      apply()
      log('rotate', `${t.provider} · ${t.model}: ${strat.actions}${strat.vision ? ', images' : ''}, ~${strat.context} tokens`)
    }
    // The settings as they are now, whatever did or didn't tell this run they changed: before every
    // request (this model's, a helper's, guided mode's, a summary's) and before a tool's result is cut
    // to the window (a command can run for minutes). Nothing goes on with an old copy.
    client.refresh = () => {
      syncSettings()
      client.startMs = 1000 * (Number(this.cfg.replyStart) > 0 ? Number(this.cfg.replyStart) : 60) // a reply must start within this, else the next model
      if (stampOf(profilePath(client)) !== stamp) client.onUse({ provider: client.provider, model: client.model })
    }
    // What this run learned about the model, onto its file as it is now: the rest (what you set up for
    // it on the settings page, a measured window, models.dev's word) stays the file's. The provider's
    // refusals that another connection to it (a helper) learned meanwhile are kept too.
    const save = () => {
      const file = profilePath(client)
      const disk = readJson(file, null)
      if (disk?.model === profile.model) {
        const out = { ...disk, quirks: { ...disk.quirks, ...profile.quirks } }
        for (const k of LEARNED) k in profile ? (out[k] = profile[k]) : delete out[k]
        if (disk.source === 'assumed' && profile.source !== 'assumed') out.source = profile.source // models.dev knows it now
        profile = out
      }
      writeJson(file, profile)
      stamp = stampOf(file)
      settingsSeen('profile') // its own write: not a change to take in
      apply()
    }
    // What the window is, learned while working (context.js); kept in the profile for next time.
    const learned = () => {
      Object.assign(strat, (({ context, contextSure, ratio, reply }) => ({ context, contextSure, ratio, reply }))(strategy(profile, cfg)))
      Object.assign(client, { tokenRatio: profile.tokenRatio ?? 1, knownGood: profile.largestAccepted ?? 0 })
      save()
    }
    // A part of the request this model's provider refused and the request worked without: kept for
    // a day (images: the model is treated as not seeing them).
    client.onLearn = (quirk) => {
      profile.quirks = { ...profile.quirks, [quirk]: Date.now() }
      if (quirk === 'noImages') strat.vision = false
      save()
      log('quirk', `${client.model}: ${quirk} (kept for a day)`)
    }
    client.onUsage = (used, estimate) => {
      const was = profile.largestAccepted
      const change = learnFromUsage(profile, used, estimate)
      if (change === 'cut') ui.warn(`${client.model} silently cut a request to ~${profile.inputLimit} tokens: that's its window here; keeping the conversation within it`)
      if (change) log('context', `${change}: ${used} tokens counted, ~${estimate} estimated; window now ${strategy(profile, cfg).context}`, { was, largestAccepted: profile.largestAccepted, inputLimit: profile.inputLimit, tokenRatio: profile.tokenRatio })
      if (change) learned()
    }
    // models.dev's published size for the model (a day old at most): used when the server doesn't say
    loadPrices().then(() => {
      price = priceOf(client.provider, client.baseUrl, client.model)
      const known = limitsOf(provider, client.baseUrl, model) ?? undefined
      if (profile.model !== model || JSON.stringify(known) === JSON.stringify(profile.known)) return // (a switched-to model: its own)
      profile.known = known
      if (known && profile.source === 'assumed') profile.source = 'models.dev' // it's listed now
      learned()
      ui.render?.()
    })
    return { client, profile, strat }
  }

  setChat(chat) {
    this.chat = chat
    if (this.s) this.s.chat = chat
  }

  save() {
    this.chat.log = this.ui.log
    saveChat(this.chat)
  }

  // /btw: a side question, answered from the conversation so far and never added to it. While a
  // task works it's typed into the busy input and runs at once (working: true), beside the task.
  async btw(question, working = false) {
    const { ui } = this
    if (!question.trim()) return ui.print(`${c.cyan('/btw')} ${c.muted('<question>')} ${c.faint('asks something on the side, also while HeartCode works; the answer stays out of the conversation')}`)
    const s = await this.session()
    if (!s) return
    if (!working) ui.spinner('answering on the side')
    const bar = c.info('┃')
    try {
      const answer = await s.side(question, working ? undefined : this.signal)
      if (!working) ui.stopSpin()
      ui.print(`${bar} ${c.info(c.bold('btw'))} ${c.muted(clip(question.split('\n')[0], 100))}\n${(answer || c.faint('(no answer)')).split('\n').map((l) => `${bar} ${l}`).join('\n')}`)
    } catch (e) {
      if (!working) ui.stopSpin()
      ui.print(`${bar} ${c.info(c.bold('btw'))} ${c.red(e.name === 'AbortError' ? 'stopped' : `failed: ${e.message}`)}`)
    }
  }

  // /resume: pick one of this folder's saved sessions and continue it.
  async resume(chat) {
    const { ui } = this
    if (!chat) {
      const chats = listChats(this.root).filter((x) => x.id !== this.chat.id)
      if (!chats.length) return ui.print('No earlier sessions in this folder yet.')
      const it = await ui.pick('Resume which session?', chats.map((x) => ({ label: x.title, desc: `${ago(x.updated)} · ${x.turns.length} message${x.turns.length > 1 ? 's' : ''}`, chat: x })))
      if (!it) return
      chat = it.chat
    }
    this.setChat(chat)
    ui.setLog(chat.log)
    ui.print(c.dim(`resumed "${chat.title}" · ${chat.turns.length} message${chat.turns.length > 1 ? 's' : ''} · ${ago(chat.updated)}`))
  }

  // /rewind: back to before one of your messages; the conversation, the files HeartCode changed, or both.
  async rewind() {
    const { ui, chat } = this
    if (!chat.turns.length) return ui.print('Nothing to rewind yet.')
    const turns = chat.turns.map((t, i) => ({ t, i })).reverse()
    const pickTurn = await ui.pick(
      'Go back to before which message?',
      turns.map(({ t, i }) => {
        const n = Object.keys(chat.turns.slice(i).reduce((all, x) => Object.assign(all, x.files), {})).length
        const num = `${i + 1}.`.padStart(String(chat.turns.length).length + 1) // its number in the conversation, newest first
        return { label: `${num} ${t.task.split('\n')[0].slice(0, 70)}`, desc: `${ago(t.at)}${n ? ` · ${n} file${n > 1 ? 's' : ''} changed since` : ''}`, i }
      }),
    )
    if (!pickTurn) return
    const i = pickTurn.i
    const turn = chat.turns[i]
    const changed = Object.keys(chat.turns.slice(i).reduce((all, x) => Object.assign(all, x.files), {}))
    const options = [
      ...(changed.length ? [{ label: 'Restore conversation and code', conversation: true, code: true }] : []),
      { label: 'Restore conversation', desc: changed.length ? 'keep the files as they are now' : '', conversation: true },
      ...(changed.length ? [{ label: 'Restore code', desc: `put back ${changed.join(', ')}; keep the conversation`, code: true }] : []),
      { label: 'Cancel' },
    ]
    const how = await ui.pick('Restore what?', options)
    if (!how || (!how.conversation && !how.code)) return
    if (how.code && !how.conversation) {
      const files = restoreFiles(chat, i)
      log('rewind', `files restored to before "${turn.task}":`, files)
      for (const t of chat.turns.slice(i)) t.files = {}
      chat.messages?.push({ role: 'user', content: prompt('agent/files-restored', { task: turn.task, files: files.join(', ') }) })
      ui.print(c.dim(`restored ${files.join(', ')} to before "${turn.task.split('\n')[0].slice(0, 60)}"`))
    }
    if (how.conversation) {
      // what came after is kept as a branch (/tree), never lost: with its files as they are now,
      // so the move puts the files back (not restoreFiles before it)
      chat.log = ui.log
      const { files } = move(chat, null, i, { code: Boolean(how.code) })
      log('rewind', `files restored to before "${turn.task}":`, files)
      ui.setLog(chat.log)
      if (how.code) ui.print(c.dim(`restored ${files.join(', ') || 'nothing (no file differed)'}`))
      ui.print(c.dim('the messages after it are kept as a branch: /tree goes back to them'))
      this.nextInput = turn.task // back in the input, to edit and send again
    }
    log('rewind', `to before message ${i + 1}`, { conversation: Boolean(how.conversation), code: Boolean(how.code) })
    if (this.s) this.s.client.lastTokens = 0
    this.save()
  }

  // /tree: every message of this session, on every branch; go to any of them. The branch you
  // leave is kept, the files can follow, and a summary of what you leave can come along.
  async tree() {
    const { ui, chat } = this
    if (!chat.turns.length && !chat.branches?.length) return ui.print('Nothing here yet: the tree grows as you send messages and go back (/rewind, /tree).')
    chat.log = ui.log
    const n = (chat.branches?.length ?? 0) + 1
    const it = await ui.pick(`This session${n > 1 ? `, ${n} branches` : ''} · pick a message`, treeItems(chat, ago))
    if (!it) return
    const atEnd = !it.branch && it.keep + 1 === chat.turns.length // the last message where you are
    const go = await ui.pick('Go there how?', [
      ...(atEnd ? [] : [{ label: 'Continue after this message', desc: it.end ? 'where that branch ended' : 'its answer and what came before it', keep: it.keep + 1 }]),
      { label: 'Edit this message and send it again', desc: 'a new branch from just before it', keep: it.keep, edit: true },
      { label: 'Cancel' },
    ])
    if (go?.keep === undefined) return
    const { plan, unknown } = codePlan(chat, it.branch, go.keep)
    let code = true
    if (plan.length) {
      const names = plan.map(([rel]) => rel)
      const how = await ui.pick('And the files?', [
        { label: 'Switch them too', desc: `${names.length} file${names.length > 1 ? 's' : ''} as they were there: ${clip(names.join(', '), 80)}`, code: true },
        { label: 'Keep them as they are now', code: false },
      ])
      if (!how) return
      code = how.code
    }
    let summarize = false
    if (leaving(chat, it.branch, go.keep) && (this.s || this.cfg.providers[this.cfg.provider])) {
      const a = await ui.pick('Bring a summary of the messages you leave?', [
        { label: 'Yes', desc: 'one request to the model, so this branch knows what was tried there', yes: true },
        { label: 'No', desc: 'they stay in the tree, the model just won\'t know about them' },
      ])
      if (!a) return
      summarize = Boolean(a.yes)
    }
    const { left, files } = move(chat, it.branch, go.keep, { code })
    ui.setLog(chat.log)
    if (files.length) ui.print(c.dim(`files now as on this branch: ${files.join(', ')}`))
    if (code && unknown.length) ui.warn(`not known how ${unknown.join(', ')} looked there; left as they are`)
    if (summarize) {
      const s = await this.session()
      if (s) {
        ui.spinner('summarizing the branch you left')
        try {
          const changedThere = leftFiles(left)
          const summary = await s.summarizeBranch(leftText(left, transcript), changedThere, this.signal)
          chat.branchNote = prompt('compact/branch-note', { summary, files: changedThere.join(', '), kept: changedThere.length && !code, restored: changedThere.length && code })
          ui.stopSpin()
          ui.print(`${c.faint('✻')} ${c.muted(`summary of the branch you left (goes with your next message): ${clip(summary.split('\n').find((l) => l.trim()) ?? '', 120)}`)}`)
        } catch (e) {
          ui.stopSpin()
          if (e.name === 'AbortError') throw e
          ui.warn(`no summary: ${e.message}`)
        }
      }
    }
    ui.print(c.dim(`${go.edit ? 'edit the message and send it: a new branch' : 'here now'} · the branch you left stays in /tree`))
    if (go.edit) this.nextInput = it.task
    if (this.s) this.s.client.lastTokens = 0
    this.save()
  }

  // Built-in commands (/name), then the skills you can type, namespaced as /skill:name so they're
  // easy to tell apart from HeartCode's own commands (and can't clash with them).
  commands() {
    const mine = [...this.skills.values()].filter((k) => k.use === 'me' || k.use === 'both').map((k) => [`/skill:${k.name}`, k.description, true]).sort(byName)
    return [...COMMANDS, ...mine]
  }

  // A command: a built-in "/name", or a skill "/skill:name". A bare "/name" that matches a skill is
  // still caught (slash points it to /skill:name). Anything else starting with "/" (a path like
  // /Users/me/shot.png) is a message for the model.
  isCommand(line) {
    if (/^\s*\/skill:\S/.test(line)) return true // any /skill:x is a command attempt; slash() says if the skill is unknown
    const name = /^\/([\w-]+)(?=\s|$)/.exec(line)?.[1]
    if (!name) return false
    return name === 'quit' || COMMANDS.some(([n]) => n === `/${name}`) || this.skills.has(name)
  }

  help() {
    const mine = this.commands().slice(COMMANDS.length)
    const sections = [...SECTIONS]
    if (mine.length) sections.push(['your skills (type /skill:name)', mine])
    sections.push(['keyboard', keysHelp(this.ui.keys, this.cfg?.mouse !== false)])
    return helpText(sections)
  }

  // "/skill:review focus on tests": the skill's text, arguments filled in, `!command` output added.
  async expandSkill(k, args) {
    let text = fillArgs(k.body, args).replace(/(^|\s)@([\w./-]+)/g, '$1$2') // @file: HeartCode attaches files a message names
    for (const m of [...text.matchAll(/!`([^`]+)`|```!\n([\s\S]*?)```/g)]) {
      const cmd = (m[1] ?? m[2]).trim()
      const ok = await this.ui.confirm(`Run ${c.bold(cmd)} (from /skill:${k.name})?`, 'command')
      const out = ok === true ? (await runCommand(this.root, cmd, { signal: this.signal })).output.trim() : '(not run)'
      log('skill', `/${k.name} ran ${cmd}`)
      text = text.replace(m[0], () => `\n\`\`\`\n$ ${cmd}\n${clip(out, 8000)}\n\`\`\`\n`)
    }
    return text
  }

  // What the menu under the prompt offers for the text before the cursor.
  suggest(line, cursor) {
    const before = line.slice(0, cursor)
    const end = cursor + (/^\S*/.exec(line.slice(cursor))?.[0].length ?? 0)
    let m = /^\/(\S*)$/.exec(before)
    if (m) {
      const items = this.commands().map(([value, desc, args]) => ({ value, desc, space: args, start: 0, end }))
      const hits = rank(items, '/' + m[1])
      return hits.length === 1 && hits[0].value === before ? [] : hits
    }
    m = /^\/(\w+)\s+(?:(\S+)\s+)?(\S*)$/.exec(before)
    if (m) {
      const [, cmd, first, typed] = m
      const start = cursor - typed.length
      const opts = (list) => rank(list.map(([value, desc]) => ({ value, desc, start, end })), typed)
      if (ARGS[cmd] && !first) return opts(ARGS[cmd])
      if (cmd === 'select_model' && !first) return this.modelChoices(typed, start, end)
      return []
    }
    m = /(?:^|\s)@(\S*)$/.exec(before)
    if (m) {
      if (!this.files || Date.now() - this.filesAt > 5000) [this.files, this.filesAt] = [listFiles(this.root), Date.now()]
      const start = cursor - m[1].length
      return rank(this.files.map((f) => ({ value: f, start, end, insertOnly: true })), m[1]).slice(0, 50)
    }
    return []
  }

  // Your models (the list on /settings: #1 and the fallbacks), for the "/select_model " menu.
  modelChoices(typed, start, end) {
    const mine = this.myModels()
    const twice = (m) => mine.filter((t) => t.model === m).length > 1
    const items = mine.map((t, i) => ({ value: twice(t.model) ? `${t.provider} ${t.model}` : t.model, desc: this.modelDesc(t, i), start, end }))
    return rank(items, typed).slice(0, 200)
  }

  // The status bar. The layout is config-driven (cfg.statusBar): a list of lines, each either a list
  // of item names (all left-aligned) or { left: [...], right: [...] } to push some to the right edge.
  // Item names: provider, model, mode, thinking, images, ctx, tps, cost, autocompact, worktree,
  // permissions. cfg.statusBar === false hides the whole bar. Unknown names and items that don't
  // apply right now are skipped. `cols` (from the renderer) is used to right-align.
  status(cols = 100) {
    const { cfg, ui } = this
    if (cfg.statusBar === false) return '' // turned off: no status bar at all
    if (!cfg.providers[cfg.provider] || !cfg.model) return c.dim('no model · /settings to choose one')
    const rot = this.s?.client.rotation
    const now = this.inUse() // the model list's one in use; never one of a provider that's off
    if (!now) return c.dim('the providers of all your models are off · /settings to switch one on')
    const on = Object.values(cfg.providers).filter((p) => !p.off).length
    const count = this.sessionModels().length
    // the model answering now; a yellow "↻" before it when it's a fallback (rotated to after one failed)
    const rotated = rot && rot.at > 0
    const name = rotated ? c.yellow('↻ ' + now.model) : c.info(now.model)
    const model =
      count === 1 ? name : cfg.session ? `${name} ${c.faint(`(${count} chosen)`)}` : `${c.muted(fitMode(cfg) ? 'orchestrated' : 'auto')} ${c.faint('(')}${name}${c.faint(')')} ${c.faint(`(${count})`)}`
    const key = `${now.provider}/${now.model}`
    if (this.profileKey !== key) [this.profileKey, this.profile] = [key, this.s?.profile ?? loadProfile(this.client(now.provider, now.model))]
    const profile = this.s?.profile ?? this.profile
    const strat = profile && (this.s?.strat ?? strategy(profile, cfg))
    // each item, rendered (or null when it doesn't apply)
    const parts = {
      provider: `${c.brand('●')} ${c.muted(now.provider)} ${c.faint(`(${on})`)}`,
      model,
      mode: strat ? c.muted(strat.actions === 'tools' ? 'tools' : 'guided') : c.dim('not loaded yet'),
      thinking: strat?.thinking ? c.think(`thinking · ${effortOf(cfg)}`) + (ui.showThinking ? c.faint(' (all)') : '') : null,
      images: strat?.vision ? c.muted('images') : null,
      ctx: null,
      tps: null,
      cost: null,
      autocompact: cfg.autoCompact === false ? c.faint('auto-compact off') : null,
      worktree: this.worktree ? c.info(`⎇ ${this.worktree.branch}`) : null,
      background: runningJobs(this.root).length ? c.info(`⚙ ${runningJobs(this.root).length} running`) + c.faint(' Alt+B') : null,
      update: this.update?.newer ? c.green(`⬆ ${this.update.latest}`) + c.faint(' /update') : null,
      permissions: { all: c.green('⏵⏵ all allowed'), commands: c.yellow('ask before commands'), ask: c.yellow('ask before changes'), plan: c.info('⏸ plan mode') }[ui.permission],
    }
    if (strat) {
      const used = this.s?.client.lastTokens ?? 0
      const pct = Math.round((used / strat.context) * 100)
      const paint = pct >= 80 ? c.red : pct >= 50 ? c.yellow : c.green
      const guess = strat.contextSure ? '' : '~' // not said by the server: assumed, and growing as bigger requests work
      parts.ctx = `${c.faint('ctx')} ${paint(`${kTokens(used)}/${guess}${kTokens(strat.context)}`)} ${c.faint(`${pct}%`)}`
      const tps = this.s?.client.tps
      if (tps) parts.tps = `${c.muted(String(tps))} ${c.faint('tok/s')}`
      if (this.chat.usage?.priced) parts.cost = c.muted(money(this.chat.usage.cost))
    }
    const sep = c.ghost(' │ ')
    const vis = (str) => width(str.replace(/\x1b\[[0-9;]*m/g, ''))
    let layout = Array.isArray(cfg.statusBar) && cfg.statusBar.length ? cfg.statusBar : DEFAULT_STATUS
    // background commands and a newer HeartCode are shown also on a bar laid out before there were these items
    for (const id of ['update', 'background']) if (parts[id] && !JSON.stringify(layout).includes(`"${id}"`)) layout = [...layout.slice(0, -1), ...layout.slice(-1).map((row) => (Array.isArray(row) ? { left: row, right: [id] } : { ...row, right: [id, ...(row.right ?? [])] }))]
    const line = (row) => {
      const names = (g) => (g ?? []).map((t) => parts[t]).filter(Boolean).join(sep)
      const left = names(Array.isArray(row) ? row : row?.left)
      const right = names(Array.isArray(row) ? null : row?.right)
      if (!right) return left
      if (!left) return right
      const pad = cols - 1 - vis(left) - vis(right) - 1 // the renderer adds a leading space; keep 1 to spare on the right
      return pad > 0 ? left + ' '.repeat(pad) + right : `${left}${sep}${right}` // too narrow to split: just join
    }
    return layout.map(line).filter((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).join('\n')
  }

  client(name, model) {
    const p = this.cfg.providers[name]
    return new Client({ baseUrl: p.baseUrl, apiKey: p.apiKey, model, provider: name })
  }


  // With nothing configured, use a local server if one is running.
  async detectLocal() {
    for (const url of LOCAL_SERVERS) {
      try {
        const models = await new Client({ baseUrl: url }).listModels(800)
        const name = providerName(url)
        this.cfg.providers[name] = { baseUrl: url }
        this.cfg.adhoc = name
        this.cfg.provider = name
        this.cfg.model ??= models[0]
        this.lists[name] = models
        return true
      } catch {}
    }
    return false
  }

  // The Session for the current provider and model, or null (after saying how to set one up).
  async session() {
    if (this.s) return this.s
    const { ui, cfg } = this
    if (!Object.keys(cfg.providers).length) await this.detectLocal()
    if (!cfg.providers[cfg.provider]) {
      if (!Object.keys(cfg.providers).length) ui.print(HOWTO)
      else ui.print(NO_MODELS)
      return null
    }
    if (!cfg.model) {
      ui.print(NO_MODELS)
      return null
    }
    // this session's models (a set you chose, else your list), first one whose provider is on
    const start = this.sessionModels()[0]
    if (!start) {
      ui.print(ALL_OFF)
      return null
    }
    const { client, profile, strat } = await this.engine(start.provider, start.model, ui, this.signal)
    this.s = new Session({ client, profile, strat, root: this.root, ui, chat: this.chat }) // details: the status bar
    this.s.autoCompact = cfg.autoCompact !== false
    this.s.onTurn = () => this.save()
    this.useRotation()
    Object.assign(this.s, { noFormat: cfg.format === false, noLsp: cfg.lsp === false })
    Object.assign(this.s, { mcp: this.mcp, memory: this.memory, skills: this.skills, director: this.director })
    this.s.team = () => this.team() // your other models: a job this one can't do goes to one of them
    this.s.fitMode = () => fitMode(this.cfg) // an orchestrator hands each message's work out, not your list's order
    this.s.orchestrators = () => this.orchestrators()
    this.s.engineFor = (t) => this.engine(t.provider, t.model, ui, undefined, { quiet: true })
    // A model's context window, read from its saved profile (no probe, no network): so the agent can
    // see, before compacting, whether another model in the list has room for the whole conversation.
    this.s.windowOf = (t) => {
      try {
        const cl = this.client(t.provider, t.model)
        const profile = loadProfile(cl) || profileFrom(cl, limitsOf(t.provider, cl.baseUrl, t.model))
        return strategy(profile, cfg).context || 0
      } catch {
        return 0
      }
    }
    this.s.failures = this.failures
    this.s.resting = this.resting
    if (this.allowTools?.length) this.s.allowTools = toolNames(this.allowTools) // headless --allowedTools
    if (this.denyTools?.length) this.s.denyTools = toolNames(this.denyTools)
    if (this.cfg.maxTurns) this.s.maxTurns = this.cfg.maxTurns
    log('session', `${cfg.provider} · ${cfg.model} at ${client.baseUrl}`, { strategy: this.s.strat, effort: client.effort })
    return this.s
  }

  // The session's models as a rotation on the client: this session's set (sessionModels), then
  // --fallback-model's. One model: no rotation.
  useRotation() {
    const { cfg } = this
    const seen = new Set()
    const list = [...this.sessionModels(), ...(cfg.fallbacks ?? [])]
      .filter((t) => cfg.providers[t.provider] && t.model && !seen.has(`${t.provider}/${t.model}`) && seen.add(`${t.provider}/${t.model}`))
      .map((t) => ({ ...t, baseUrl: cfg.providers[t.provider].baseUrl, apiKey: cfg.providers[t.provider].apiKey }))
    this.s?.client.setRotation(list, cfg.rotation ?? {})
    if (fitMode(cfg)) this.s?.client.orderBy(this.orchestrators().map((t) => `${t.provider} ${t.model}`)) // the first orchestrator answers first (and the status bar shows it)
  }

  async use(name, model) {
    Object.assign(this.cfg, { provider: name, model })
    this.s = null
    if (name !== this.cfg.adhoc) saveConfig(this.cfg)
    this.ui.print(`${c.green('using')} ${name} · ${c.cyan(model)}`)
    await this.session()
  }

  // Your other models (not the one in use) and what each can do, from its saved profile or
  // models.dev: nothing is sent to them to find out.
  team() {
    // helpers use this session's models (the set you chose, else your list), minus the one in use —
    // so a pinned single model gives no team, and a chosen set keeps helpers within it. While one
    // orchestrates: minus the orchestrators too (they only hand work out)
    const now = this.s?.client.rotation?.list[this.s.client.rotation.at] ?? this.sessionModels()[0]
    const lead = this.s?.orchestrating ? this.orchestrators() : []
    const tested = readJson(path.join(HOME, 'model-tests.json'), {}) // Test all's and Test skills' results: how quick, which did a job with a tool, the skill scores (ponytail: read each time, it's small)
    const need = (this.workerNeed ??= firstRequest(this.root, false))
    return this.sessionModels()
      .filter((t) => ![now, ...lead].some((o) => t.provider === o?.provider && t.model === o?.model))
      .map((t) => ((r) => ({ ...t, ...this.abilities(t), toolsOk: r?.toolsOk, replyMs: r?.ok ? r.ms : undefined, skills: r?.skills, test: r }))(tested[`${t.provider}/${t.model}`]))
      .filter((t) => !this.leftOut(t, whyUnusable({ test: t.test, context: t.context, need }))) // what can't work isn't offered
  }

  // A model HeartCode leaves out (usable.js): said once per session per model, in the log
  leftOut(t, why) {
    if (why && !(this.saidOut ??= new Set()).has(`${t.provider} ${t.model}`)) this.saidOut.add(`${t.provider} ${t.model}`), log('fit', `left out: ${t.provider} ${t.model}: ${why}`)
    return Boolean(why)
  }

  // The models that orchestrate (Pick: "an orchestrator hands it out"): those picked on Your models
  // that are in this session's set and call tools; none picked: your first that calls tools.
  orchestrators() {
    const tested = readJson(path.join(HOME, 'model-tests.json'), {})
    const last = readJson(path.join(HOME, 'full-test.json'), null)?.orchestrators ?? []
    const need = firstRequest(this.root, true, this.sessionModels()) // its list of the others: about the same size
    const able = (t) => !this.leftOut(t, whyUnusable({ test: tested[`${t.provider}/${t.model}`], context: this.abilities(t).context, need, orch: last.find((r) => r.provider === t.provider && r.model === t.model) }))
    const mine = this.sessionModels().filter((t) => this.abilities(t).tools)
    const picked = (this.cfg.orchestrators ?? []).map((o) => mine.find((t) => o.provider === t.provider && o.model === t.model)).filter((t) => t && able(t)) // in their own order (Test sets it)
    return picked.length ? picked : mine.filter(able).slice(0, 1)
  }

  // What a model can do, from its saved profile or models.dev (guessed: neither knows it).
  abilities(t) {
    const cl = this.client(t.provider, t.model)
    const p = loadProfile(cl) || profileFrom(cl, limitsOf(t.provider, cl.baseUrl, t.model))
    const st = strategy(p)
    return { tools: st.actions === 'tools', images: st.vision, thinking: st.thinking, context: st.context, guessed: p.source === 'assumed' && !p.set }
  }

  // A row of the model lists (the picker, the /select_model suggestions): "openrouter · #1 · in use · tools · 1M".
  modelDesc(t, i) {
    return `${t.provider} · #${i + 1}${i === 0 ? ' · in use' : ''} · ${this.canText(t)}`
  }

  // "tools · images · thinking · 1M", for the model lists.
  canText(t) {
    const a = this.abilities(t)
    return [a.tools ? 'tools' : 'no tools', a.images && 'images', a.thinking && 'thinking', kTokens(a.context) + (a.guessed ? '?' : '')].filter(Boolean).join(' · ')
  }

  // Your models, in order: this one (#1), then the fallbacks (chosen on /settings, where every
  // provider's whole list is).
  // The model answering now: the model list's current one, the session's, or (none yet) the one it
  // will start with: the first of yours whose provider is on (a model given for this run: that one).
  // What the screen shows as "the model": never one of a provider that's switched off.
  inUse() {
    const { cfg } = this
    const rot = this.s?.client.rotation
    if (rot) return rot.list[rot.at]
    if (this.s) return { provider: this.s.client.provider, model: this.s.client.model }
    return (fitMode(cfg) ? this.orchestrators()[0] : null) ?? this.sessionModels()[0] ?? null
  }

  // your list has models, but the providers of all of them are switched off
  allOff() {
    return !this.cfg.session && this.myModels(true).length > 0 && !this.myModels().length
  }

  // all: also the ones of a provider switched off (on the settings page), which are skipped otherwise
  myModels(all = false) {
    const { cfg } = this
    const seen = new Set()
    return [{ provider: cfg.provider, model: cfg.model }, ...(cfg.rotation?.then ?? [])].filter((t) => cfg.providers[t.provider] && (all || !cfg.providers[t.provider].off) && t.model && !seen.has(`${t.provider}/${t.model}`) && seen.add(`${t.provider}/${t.model}`))
  }

  // The models THIS session uses: the set you chose with /select_model (cfg.session, session-local),
  // else your whole list. One model: no rotation (pinned). Several: it rotates among just those.
  sessionModels(all = false) {
    const { cfg } = this
    if (!cfg.session) return this.myModels(all)
    const seen = new Set()
    return cfg.session.filter((t) => cfg.providers[t.provider] && (all || !cfg.providers[t.provider].off) && t.model && !seen.has(`${t.provider}/${t.model}`) && seen.add(`${t.provider}/${t.model}`))
  }

  // Alt+B, /background: the background commands' logs in a dialog, one at a time with a tab each.
  // ←/→ (or a click on a tab): another one; ↑/↓, PgUp/PgDn, the wheel: back in its log (End: the
  // newest again); K twice: stop it and close its tab; Esc or Alt+B: closed.
  toggleJobs(on = !this.jobsShown) {
    const { ui } = this
    if (!on) return ui.setDialog(null)
    this.jobsShown = true
    const ERROR = /\b(error|errors|failed|fail|exception|traceback|panic|fatal)\b/i
    const jobs = () => listJobs(this.root)
    const current = () => jobs().find((j) => j.id === this.jobTab) ?? jobs().findLast((j) => !j.exited) ?? jobs().at(-1)
    let spots = [] // where each tab is on its row: { from, to, id }
    let back = 0 // lines scrolled back from the newest (0: following it)
    let page = 10
    let armed = 0 // K pressed once, when
    let said = '' // a line for the footer (K's question)
    const go = (d) => {
      const all = jobs()
      if (!all.length) return
      this.jobTab = all[(all.indexOf(current()) + d + all.length) % all.length].id
      back = 0
    }
    const kill = () => {
      const job = current()
      if (!job) return
      if (Date.now() - armed > 2500) return (armed = Date.now()), (said = `Press K again to ${job.exited ? 'close' : 'stop and close'} #${job.id}`)
      armed = 0
      said = ''
      const all = jobs()
      const next = all[all.indexOf(job) + 1] ?? all[all.indexOf(job) - 1]
      removeJob(job)
      ui.print(c.dim(`${job.exited ? 'closed' : 'stopped'} #${job.id} ${clip(job.command, 80)}`))
      if (!next) return this.toggleJobs(false)
      this.jobTab = next.id
      back = 0
    }
    ui.setDialog({
      title: 'Background commands',
      toggle: 'background_log', // Alt+B closes it too
      close: () => (this.jobsShown = false),
      key: (key) => {
        if (key.name !== 'k') (armed = 0), (said = '')
        if (key.name === 'left' || key.name === 'right') return go(key.name === 'left' ? -1 : 1)
        if (key.name === 'up' || key.name === 'down') return (back = Math.max(0, back + (key.name === 'up' ? (key.wheel ? 3 : 1) : key.wheel ? -3 : -1)))
        if (key.name === 'pageup' || key.name === 'pagedown') return (back = Math.max(0, back + (key.name === 'pageup' ? page : -page)))
        if (key.name === 'end') return (back = 0)
        if (key.name === 'home') return (back = 1e6)
        if (key.name === 'k' && !key.ctrl && !key.meta) return kill()
      },
      click: (col, row) => {
        const hit = row === 0 && spots.find((t) => col >= t.from && col < t.to)
        if (hit) (this.jobTab = hit.id), (back = 0)
      },
      draw: (w, h) => {
        const all = jobs()
        if (!all.length) return ['', `  ${c.faint('Nothing runs in the background. The model starts servers and watchers there.')}`, '', `  ${c.faint('Esc close')}`]
        const job = current()
        this.jobTab = job.id
        // the tabs, scrolled so the one shown is on screen
        const label = (j) => ` ${j.exited ? '○' : '●'} #${j.id} ${clip(j.command.replace(/\s+/g, ' '), 18)} `
        let first = 0
        while (first < all.indexOf(job) && all.slice(first, all.indexOf(job) + 1).reduce((n, j) => n + width(label(j)) + 1, 0) > w - 2) first++
        spots = []
        let x = 1
        let bar = ' '
        for (const j of all.slice(first)) {
          const lw = width(label(j))
          if (x + lw > w - 2) break
          spots.push({ from: x, to: x + lw, id: j.id })
          bar += (j === job ? `\x1b[7m${c.brand(c.bold(label(j)))}\x1b[27m` : j.exited ? c.faint(label(j)) : c.muted(label(j))) + ' '
          x += lw + 1
        }
        const hidden = all.length - spots.length
        page = Math.max(1, h - 6)
        const n = h - 5 // tabs, a rule, the command, (the log), a rule, the keys
        const lines = tailLines(job, n + back + 2000) // enough to scroll back through
        back = Math.min(back, Math.max(0, lines.length - n))
        const shown = lines.slice(Math.max(0, lines.length - n - back), lines.length - back)
        const state = job.exited ? c.yellow(`exited with ${job.code}`) : c.green('running')
        const where = back ? c.yellow(` · ${back} line${back > 1 ? 's' : ''} back (End: the newest)`) : ''
        return [
          bar + (hidden ? c.faint(` +${hidden} more`) : ''),
          c.ghost('─'.repeat(w)),
          ` ${c.bold(clip(job.command, w - 40))} ${c.faint('·')} ${state} ${c.faint(`· ${ranFor(job)}`)}${where}`,
          ...Array.from({ length: n }, (_, i) => (shown.length ? (shown[i] === undefined ? '' : ` ${ERROR.test(shown[i]) ? c.red(shown[i]) : c.muted(shown[i])}`) : i ? '' : ` ${c.faint('(no output yet)')}`)),
          c.ghost('─'.repeat(w)),
          ` ${said ? c.yellow(said) : c.faint(`${all.length > 1 ? '←/→ another one · ' : ''}↑/↓ PgUp/PgDn scroll · K ${job.exited ? 'close' : 'stop'} it · Esc close`)}`,
        ]
      },
    })
  }

  // Use a chosen set of models for this session: one pins it (no rotation), several rotate among
  // just those. Remembered for this folder (.heartcode/models.json); the saved ranking is untouched.
  // later: chosen while a task works; it goes on with its models, yours from the next message.
  async setSession(list, later = false) {
    const { cfg } = this
    const apply = () => {
      cfg.session = list // the global #1 (cfg.provider/model) stays, so your whole list and the picker are unchanged
      this.saveProjectModels()
      this.s = null
    }
    const msg = list.length === 1 ? `${c.green('using')} ${c.cyan(list[0].model)} ${c.dim('· pinned for this folder')}` : `${c.green(`using ${list.length} models for this folder`)}: ${c.cyan(list.map((t) => t.model).join(', '))}`
    if (later) return this.later.push(apply), this.ui.print(`${msg} ${c.dim('· from your next message')}`)
    apply()
    this.ui.print(msg)
    await this.session()
  }

  // Back to auto: your whole list again (#1, then the next when one fails), following the saved
  // ranking. The folder's remembered choice is cleared.
  async auto(later = false) {
    const { cfg } = this
    const apply = () => {
      delete cfg.session
      this.saveProjectModels()
      this.s = null
    }
    const msg = `${c.green('using')} ${c.dim('auto')} ${c.cyan(`(${this.myModels().length} models)`)}`
    if (later) return this.later.push(apply), this.ui.print(`${msg} ${c.dim('· from your next message')}`)
    apply()
    this.ui.print(msg)
    await this.session()
  }

  // The picker: tick the models for this session — one pins it, several rotate among them, all of
  // them (or none) is the same as auto (your whole list). "auto" is the first entry.
  async chooseModel(filter = '', later = false) {
    const { ui, cfg } = this
    const mine = this.myModels()
    if (!mine.length) {
      if (!Object.keys(cfg.providers).length && (await this.detectLocal())) return this.session()
      return ui.print(NO_MODELS)
    }
    const key = (t) => `${t.provider}/${t.model}`
    const chosen = new Set((cfg.session ?? mine).map(key)) // pre-ticked: this session's set, or all (auto)
    const items = mine.map((t) => ({ label: t.model, t, checked: chosen.has(key(t)), desc: this.modelDesc(t, mine.indexOf(t)) }))
    // first, standing alone: back to auto (Enter on it, whatever is ticked)
    const auto = { label: 'auto', only: true, auto: true, desc: `your whole list, in its order (${mine.length} models)${cfg.session ? ' · forgets what this folder picked' : ' · in use'}` }
    const picked = await ui.pick('Models for this session — tick several to rotate, one to pin, or auto', [auto, ...items], { filter, multi: true })
    if (!picked) return
    if (picked.some((it) => it.auto)) return cfg.session ? this.auto(later) : ui.print(c.dim('already on auto'))
    const list = picked.map((it) => it.t)
    return list.length >= mine.length ? this.auto(later) : this.setSession(list, later)
  }

  // "/select_model a, b, c": use those models this session (one pins, several rotate). One model:
  // "model", "provider model" or "provider/model". "/select_model auto": your whole list. No
  // argument: the picker.
  async pickModel(args, later = false) {
    if (!args.length) return this.chooseModel('', later)
    if (args.every((a) => isAuto(a))) return this.cfg.session ? this.auto(later) : this.ui.print(c.dim('already on auto'))
    const raw = args.join(' ')
    const specs = raw.includes(',') ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [raw]
    const resolve = (spec) => {
      const w = spec.trim().split(/\s+/)
      const tries = [[null, spec.trim()], w.length > 1 && [w[0], w.slice(1).join(' ')], spec.includes('/') && [spec.slice(0, spec.indexOf('/')), spec.slice(spec.indexOf('/') + 1)]].filter(Boolean)
      for (const [name, model] of tries) {
        const hit = this.myModels().find((t) => t.model === model && (!name || t.provider === name))
        if (hit) return hit
      }
      return null
    }
    const found = []
    const missing = []
    for (const spec of specs) (resolve(spec) ? found : missing).push(resolve(spec) ?? spec)
    if (missing.length || !found.length) {
      if (missing.length) this.ui.print(c.dim(`not in your models: ${missing.join(', ')} · add on /settings`))
      return this.chooseModel(specs.length === 1 ? specs[0] : '', later)
    }
    return this.setSession(found, later)
  }

  listProviders() {
    const { ui, cfg } = this
    const names = Object.keys(cfg.providers)
    if (!names.length) return ui.print(`No providers yet: add one with ${c.cyan('heart settings')}.`)
    for (const n of names) {
      const p = cfg.providers[n]
      const notes = [n === this.inUse()?.provider && c.magenta('● current'), p.off && c.yellow('off'), n === cfg.adhoc && c.dim('this run only')].filter(Boolean).join(' ')
      ui.print(`${c.bold(n.padEnd(14))} ${p.baseUrl}  ${c.dim(mask(p.apiKey))}  ${notes}`)
    }
  }

  // `heart models`: what -m takes, one per line (as \`opencode models\`): "auto" (your list: #1, then
  // the next when one fails; also no -m), then your models as provider/model, #1 first. all: every
  // provider's models (fetched from each; a provider whose list is off: the ones added by name).
  // json: one JSON object on stdout, for other programs:
  //   { "models": [{ "id": "auto", "fallbacks": true }, { "id": "groq/openai/gpt-oss-120b", "provider", "model", "place": 1 }, …],
  //     "providers": [{ "name", "baseUrl", "list": true, "off"?: true, "models": ["provider/model", …], "error"? }] }   (--all)
  async listModels(filter = '', { all = false, json = false } = {}) {
    const { ui, cfg } = this
    const match = (id) => id.toLowerCase().includes(filter.toLowerCase())
    const mine = this.myModels().map((t, i) => ({ id: `${t.provider}/${t.model}`, provider: t.provider, model: t.model, place: i + 1 }))
    const providers = !all ? [] : await Promise.all(Object.entries(cfg.providers).map(async ([name, p]) => {
      const out = { name, baseUrl: p.baseUrl, list: p.list !== false, ...(p.off && { off: true }), models: [] }
      if (out.list) {
        try {
          out.models = await new Client({ baseUrl: p.baseUrl, apiKey: p.apiKey }).listModels()
        } catch (e) {
          out.error = e.message
        }
      }
      // and the ones added by name, and any of yours it doesn't list (as on the settings page)
      out.models = [...new Set([...out.models, ...(p.models ?? []), ...mine.filter((t) => t.provider === name).map((t) => t.model)])].sort((a, b) => a.localeCompare(b)).map((id) => `${name}/${id}`).filter(match)
      return out
    }))
    const shown = [...(mine.length ? [{ id: AUTO_MODEL, fallbacks: mine.length > 1 }] : []), ...mine].filter((t) => match(t.id))
    if (json) return void process.stdout.write(JSON.stringify({ models: shown, ...(all && { providers }) }, null, 2) + '\n')
    if (!all) {
      if (!mine.length) return ui.print(NO_MODELS)
      return void process.stdout.write(shown.map((t) => t.id + '\n').join(''))
    }
    for (const p of providers) if (p.error) process.stderr.write(`heartcode: can't list ${p.name}'s models: ${p.error}\n`)
    process.stdout.write(providers.flatMap((p) => p.models).map((id) => id + '\n').join(''))
  }
}

// Leaving a --worktree session: nothing changed → it's removed; else you choose (it's kept by default).
async function leaveWorktree(app) {
  const wt = app.worktree
  if (!wt) return
  const st = worktreeState(wt)
  wt.done = true
  if (st.empty) {
    removeWorktree(wt)
    return console.log(c.dim(`worktree ${wt.name}: nothing changed, removed`))
  }
  const what = [st.changes && `${st.changes} uncommitted change${st.changes > 1 ? 's' : ''}`, st.commits && `${st.commits} commit${st.commits > 1 ? 's' : ''}`].filter(Boolean).join(' and ')
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout })
  const a = process.stdin.isTTY ? await rl.question(`worktree ${wt.name} has ${what}. Keep it? [Y/n, or "remove"] `) : ''
  rl.close()
  if (/^(n|no|remove)$/i.test(a.trim())) {
    removeWorktree(wt)
    return console.log(c.dim(`removed ${wt.dir} and the branch ${wt.branch}`))
  }
  console.log(`kept ${c.info(wt.dir)} on ${c.info(wt.branch)}\n${c.dim(`continue: heartcode --worktree=${wt.name} · merge: git merge ${wt.branch} (commit in the worktree first) · remove: git worktree remove ${wt.dir}`)}`)
}

// Which conversations are open in tabs, per folder (~/.heart/tabs.json), to offer them again.
const TABS_FILE = path.join(HOME, 'tabs.json')
function saveTabs(tabs) {
  const all = readJson(TABS_FILE, {})
  all[tabs.root] = { at: tabs.list.indexOf(tabs.at), tabs: tabs.list.map((t) => ({ chat: t.app.chat.id, worktree: t.app.worktree?.name ?? null, provider: t.app.cfg.provider ?? null, model: t.app.cfg.model ?? null })) }
  writeJson(TABS_FILE, all)
}

// Starting in a folder with an earlier session: continue it? With every tab it had open that has a
// message sent (answered or not; a worktree tab if its worktree is still there). A last run with
// nothing sent: nothing to continue. No record of one (sessions from before tabs, or -p): the
// last session here.
async function continueTabs(app, saved) {
  const { ui, tabs } = app
  let open = (saved?.tabs ?? []).map((t, i) => ({ ...t, i, chat: loadChat(t.chat, app.root) })).filter((t) => t.chat?.turns?.length && (!t.worktree || fs.existsSync(t.chat.root)))
  if (!saved) open = listChats(app.root).filter((c) => c.turns?.length).slice(0, 1).map((chat) => ({ chat, worktree: null }))
  if (!open.length) return
  const many = open.length > 1
  const newest = open.map((t) => t.chat.updated).sort().at(-1)
  const go = await ui.pick(many ? `Continue where you left off? ${open.length} tabs` : 'Continue your last session here?', [
    { label: many ? `Yes, with its ${open.length} tabs` : 'Yes', desc: `${open.map((t) => `"${t.chat.title}"`).join(', ')} · ${ago(newest)}`, yes: true },
    { label: 'No, start a new session', desc: '/resume finds it later' },
  ], { quiet: true })
  if (!go?.yes) return
  // this tab takes the first one in this folder; the rest (and worktree ones) open as tabs
  const here = open.find((t) => !t.worktree) ?? null
  if (here) {
    await app.resume(here.chat)
    useModel(app, here) // after: resuming redraws the screen
  }
  const tabOf = new Map(here ? [[here, tabs.at]] : [])
  for (const t of open.filter((x) => x !== here)) {
    try {
      const wt = t.worktree ? createWorktree(app.root, t.worktree) : null
      tabOf.set(t, tabs.add({ root: wt?.cwd ?? app.root, wt, chat: t.chat, model: t }))
    } catch (e) {
      ui.warn(`"${t.chat.title}": ${e.message}`)
    }
  }
  tabs.show(tabOf.get(open.find((t) => t.i === saved?.at)) ?? tabs.list[0])
}

// A continued tab's own model, as it was (unless its provider is gone: then the current one).
function useModel(app, { provider, model }) {
  if (!provider || !model || (provider === app.cfg.provider && model === app.cfg.model)) return
  if (!app.cfg.providers[provider]) return app.ui.warn(`this tab used ${provider} · ${model}, but there's no provider "${provider}" now: using your list`)
  if (app.cfg.providers[provider].off) return app.ui.warn(`this tab used ${provider} · ${model}, but ${provider} is switched off: using your list`)
  Object.assign(app.cfg, { provider, model })
  app.s = null
}

// The settings page (/settings): on while its dialog is (one at a time).
let settingsPage = null

// The browser, with a page. Windows: its URL handler (cmd's start mangles a URL whose arguments
// it reads as its own, and wants a quoted empty title first).
// How HeartCode picks your models: "fit" (an orchestrator hands the work out) or your order; --model-choice for this run wins.
let modelChoiceFlag
// The thinking effort asked of a model that thinks: yours, or low when you haven't chosen (many think
// only when asked: then they think a little, and you see it)
const effortOf = (cfg) => cfg.effort ?? 'low'
const fitMode = (cfg) => (modelChoiceFlag ?? cfg.modelChoice) === 'fit'

function openBrowser(url) {
  if (process.env.HEART_NO_BROWSER) return
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url]
  spawnSync(cmd, args, { stdio: 'ignore' })
}

// A change of the settings (the settings page, another HeartCode on the same folder, a hand), brought
// into every open tab and run (also -p and ACP) right away: the running task's next request has it
// (the model list's #1, the prompts, hooks, skills, MCP servers…).
function applySettings(apps, cfg, what) {
  const before = themeCodes()
  if (what === 'theme' || what === 'setting:theme') setTheme(cfg.theme)
  if (what === 'prompts') reloadPrompts()
  if (['setting:logs', 'setting:log', 'setting:logRequests', 'setting:logDetail'].includes(what)) useRequestLog(cfg) // each kind of log, on or off now
  if (what === 'setting:logDays') pruneLogs(logDays(cfg))
  settingsSeen(what) // the watcher (watchSettings) mustn't take it in a second time
  for (const app of apps) {
    const { ui } = app
    const busy = Boolean(ui.busySince || app.working)
    const now = (fn) => (busy ? app.later.push(fn) : fn())
    if (app.cfg !== cfg) for (const k of ['providers', 'provider', 'model', 'effort', 'theme', 'context', 'autoCompact', 'director', 'format', 'lsp', 'voice', 'rotation', 'statusBar', 'modelChoice', 'orchestrators']) app.cfg[k] = cfg[k]
    // a model pinned in this CLI (/select_model) is a session choice: a model/order change on the
    // settings page leaves it alone (only /select_model auto here returns it to the list)
    if (what === 'model' && !app.cfg.session) {
      app.lists = {}
      if (app.s && !(cfg.providers[cfg.provider] && cfg.model)) now(() => ((app.s = null), ui.print(c.dim('settings: no model chosen'))))
      else if (app.s && !app.myModels().length) now(() => ((app.s = null), ui.print(c.dim('settings: the providers of all your models are switched off'))))
    }
    // your model list: into the running session now, its next request goes to the new #1 (or orchestrator)
    if (['model', 'setting:rotation', 'setting:modelChoice', 'setting:orchestrators'].includes(what) && !app.cfg.session && app.s && cfg.providers[cfg.provider] && cfg.model) {
      const was = `${app.s.client.provider} · ${app.s.client.model}`
      app.useRotation()
      const is = `${app.s.client.provider} · ${app.s.client.model}`
      if (is !== was) ui.print(c.dim(`settings: ${is} now`))
    }
    if (what === 'provider') app.lists = {} // its list switched on or off, a model added by name
    if (what === 'setting:permissions') ui.setPermission(cfg.permissions)
    if (what === 'setting:mouse') ui.setMouse(cfg.mouse !== false)
    if (what === 'setting:statusBar') ui.render?.() // the status bar's layout changed: redraw it now
    if (what === 'setting:effort' && app.s?.strat.thinking) app.s.client.effort = effortOf(cfg)
    if (what === 'setting:autoCompact' && app.s) app.s.autoCompact = cfg.autoCompact !== false
    if (what === 'setting:format' && app.s) app.s.noFormat = cfg.format === false
    if (what === 'setting:lsp' && app.s) app.s.noLsp = cfg.lsp === false
    // the window size, or a model set up or measured on the page: the model in use takes it again
    // from its profile now (it saves its profile as it learns, so it mustn't keep the old one)
    if ((what === 'setting:context' || what === 'profile') && app.s) app.s.client.onUse?.({ provider: app.s.client.provider, model: app.s.client.model })
    if (what === 'mcp' || what === 'skill') app.reload(what, busy)
    if (what === 'prompts' && app.s) app.s.refreshSystem = true // the system prompt, again before the next request
    if (what === 'hooks' && app.s && app.s.hooks !== false) app.s.hooks = loadHooks(app.root)
    if (what === 'keys') ui.keys = { ...DEFAULT_KEYS, ...loadKeys() }
    if (what === 'theme' || what === 'setting:theme') ui.recolor(before, themeCodes())
    else ui.render()
  }
  apps[0]?.tabs?.onChange?.() // each tab's model, for next time
}

// Changes saved by another HeartCode, or \`heart settings\` in another terminal, while this one runs:
// taken in as the page's own are (applySettings). config.json: the keys others changed (takeIn; a
// model given for this run with -m stays unless the list's #1 changes); the other files by their
// size and time, and only when this run didn't just apply them itself.
// A model's profile fields a running HeartCode learns itself (context.js, the models.dev lookup); the
// rest of the file is the settings page's.
const LEARNED = ['inputLimit', 'inputLimitAt', 'cutAt', 'tokenRatio', 'largestAccepted', 'rateCap', 'known']
// The settings as they are now, into every HeartCode in this process (watchSettings): run before each
// request too, so a change the file watcher hasn't passed on yet (or never will) is still taken in.
let syncSettings = () => {}
const WATCHED = { 'mcp.json': 'mcp', 'hooks.json': 'hooks', 'keybindings.json': 'keys', 'theme.json': 'theme', models: 'profile', prompts: 'prompts', 'HEARTCODE.md': 'prompts', skills: 'skill' }
const seenStamp = {}
const stampOf = (p) => {
  try {
    const st = fs.statSync(p)
    if (!st.isDirectory()) return `${st.mtimeMs}:${st.size}`
    return fs.readdirSync(p, { recursive: true }).sort().map((f) => `${f}=${stampOf(path.join(p, f))}`).join('|')
  } catch {
    return ''
  }
}
function settingsSeen(what) {
  for (const [name, w] of Object.entries(WATCHED)) if (w === what || (what === 'setting:theme' && w === 'theme')) seenStamp[name] = stampOf(path.join(HOME, name))
}
function watchSettings(apps, cfg) {
  for (const name of Object.keys(WATCHED)) seenStamp[name] = stampOf(path.join(HOME, name))
  const configChanged = () => {
    const whats = new Set(takeIn(cfg).map(whatOf))
    for (const what of whats) applySettings(apps(), cfg, what)
    if (whats.size) log('settings', `taken in from config.json: ${[...whats].join(', ')}`)
  }
  let timer = null
  const check = () => {
    clearTimeout(timer)
    timer = null
    configChanged()
    for (const [name, what] of Object.entries(WATCHED)) {
      const now = stampOf(path.join(HOME, name))
      if (now === seenStamp[name]) continue
      seenStamp[name] = now
      log('settings', `taken in: ${name} changed`)
      applySettings(apps(), cfg, what)
    }
  }
  syncSettings = check
  try {
    const watcher = fs.watch(HOME, { recursive: true }, (_, file) => {
      const top = String(file ?? '').split(path.sep)[0]
      if (top !== 'config.json' && !WATCHED[top]) return // sessions, logs…: not settings
      clearTimeout(timer)
      timer = setTimeout(check, 150) // a file written in parts, several files at once: one look
    })
    watcher.on('error', () => {})
    watcher.unref()
  } catch (e) {
    log('settings', `can't watch ${HOME}: ${e.message}`)
  }
}

// After /reset: every tab goes on with what's left (the files as they are now), from the next
// message; the screen in the theme there is now.
function afterReset(apps, level) {
  const fresh = loadConfig()
  useRequestLog(fresh)
  const before = themeCodes()
  setTheme(fresh.theme)
  reloadPrompts()
  for (const app of apps) {
    for (const k of Object.keys(app.cfg)) if (!['maxRetries', 'maxTurns', 'mcp', 'adhoc', 'fixed'].includes(k)) delete app.cfg[k]
    Object.assign(app.cfg, fresh)
    const { ui } = app
    ui.permission = fresh.permissions ?? 'all' // not setPermission: that saves it again
    ui.keys = { ...DEFAULT_KEYS, ...loadKeys() }
    app.lists = {}
    const now = (fn) => (ui.busySince ? app.later.push(fn) : fn())
    now(() => {
      app.s = null
      app.reload('mcp')
      app.reload('skill')
      if (level === 'everything') app.memory = new Memory(app.root)
    })
    ui.recolor(before, themeCodes())
  }
  apps[0]?.tabs?.onChange?.()
}

// A tab in a worktree closed while other tabs stay open: removed if nothing changed, else kept.
function leaveTabWorktree(app) {
  const wt = app.worktree
  if (!wt) return
  wt.done = true
  const ui = app.tabs.at.ui
  if (worktreeState(wt).empty) return removeWorktree(wt), ui.print(c.dim(`worktree ${wt.name}: nothing changed, removed`))
  ui.print(`${c.dim('kept worktree')} ${c.info(wt.dir)} ${c.dim('on')} ${c.info(wt.branch)} ${c.faint(`· merge: git merge ${wt.branch} (commit in the worktree first)`)}`)
}

// A model's profile: the saved one; else what models.dev says (nothing is sent to the model to
// find out); a model it doesn't know: plain assumptions, until you set it up on the settings page.
async function getProfile(client, ui, quiet = false) {
  let p = loadProfile(client)
  if (!p) {
    await loadPrices()
    p = profileFrom(client, limitsOf(client.provider, client.baseUrl, client.model))
    writeJson(profilePath(client), p)
  }
  // one models.dev didn't know when it was saved: looked up again (it may have been added, or the list
  // couldn't be had then)
  if (p.source === 'assumed') {
    await loadPrices()
    const known = limitsOf(client.provider, client.baseUrl, client.model)
    if (known) writeJson(profilePath(client), (p = { ...p, known, source: 'models.dev' }))
  }
  if (p.source === 'assumed' && !quiet) ui.warn(`${client.model} isn't in models.dev: assuming it calls tools and streams, with a ~128k window. Set what it can do on /settings`)
  return p
}

// A setting from its choices: the argument if valid, else a picker. Returns the choice or null.
async function choose(ui, cmd, arg, title, current) {
  if (ARGS[cmd].some(([o]) => o === arg)) return arg
  return (await ui.pick(title, ARGS[cmd].map(([label, desc]) => ({ label, desc, current: label === current }))))?.label ?? null
}

// Fresh sign-in to a remote MCP server: forget the old token, reconnect (opens the browser via
// app.mcp.onSignIn), list its tools. Used by /login_mcp and the settings page's Sign in button.
async function signInMcp(app, name, signal) {
  const sv = app.mcp.get(name)
  if (!sv?.url) throw new Error(`no remote MCP server "${name}"`)
  forget(sv.url)
  sv.stop()
  Object.assign(sv, { token: null, tools: null })
  const tools = await sv.listTools(signal)
  return `signed in to ${name} · ${tools.length} tools`
}

// working: typed while a task works and run beside it (RIGHT_AWAY): no spinner of its own, nothing
// that would end the task's.
async function slash(app, line, working = false) {
  const [cmd, ...args] = line.slice(1).trim().split(/\s+/)
  const { ui, cfg } = app
  const spin = (label) => !working && ui.spinner(label)
  const unspin = () => !working && ui.stopSpin()
  switch (cmd) {
    case 'close_tab':
      return void (await app.closeTab(working))
    case 'exit':
    case 'quit': {
      const n = app.tabs?.list.length ?? 1
      if (n > 1 || working) {
        const go = await ui.pick(`Quit HeartCode?${working ? ' It is still working: that stops.' : ''}${n > 1 ? ` ${n} tabs are open` : ''}`, [
          { label: 'Yes, quit', desc: 'they come back next time you start HeartCode here', yes: true },
          { label: 'No', desc: 'Alt+W closes just this tab' },
        ])
        if (!go?.yes) return
      }
      if (!working && app.s?.wrapping) {
        ui.spinner('keeping what the last task learned · Ctrl+C to quit now')
        await app.s.wrapping
      }
      return 'exit'
    }
    case 'reset': {
      const it = await ui.pick('Reset what?', RESETS.map((r) => ({ label: r.label, desc: r.desc, level: r.level })))
      if (!it) return ui.print(c.dim('nothing reset'))
      const home = process.env.HOME
      const tilde = (f) => (home && f.startsWith(home) ? '~' + f.slice(home.length) : f)
      const files = resetPaths(it.level)
      const what = [...(it.level === 'settings' ? [`the settings in ${tilde(CONFIG_FILE)} (not your providers, keys or model)`] : []), ...files.map(tilde)]
      ui.print(`${c.warn('!')} ${c.bold(`Reset: ${it.label.toLowerCase()}.`)} ${c.muted("This can't be undone. It removes:")}\n${what.length ? what.map((f) => `  ${c.faint('·')} ${f}`).join('\n') : c.faint('  (nothing there yet)')}`)
      const code = resetCode()
      const typed = await ui.ask(`  Type ${c.bold(code)} to reset ${c.dim('(anything else: no)')}: `)
      if (typed?.trim().toUpperCase() !== code) return ui.print(c.dim('not reset'))
      reset(it.level)
      log('reset', it.level, what)
      afterReset(app.tabs ? app.tabs.list.map((t) => t.app) : [app], it.level)
      return ui.print(`${c.ok('✓')} ${c.muted(`reset: ${it.label.toLowerCase()}`)}${it.level === 'settings' ? '' : c.dim(' · add a provider on /settings')}`)
    }
    case 'settings': {
      settingsPage ??= startSettings({ cfg, root: app.root, onLoginMcp: (name) => signInMcp(app, name, null), onTested: () => settingsDone?.(), apply: (what) => (applySettings(app.tabs ? app.tabs.list.map((t) => t.app) : [app], cfg, what), what === 'setting:modelChoice' && !fitMode(cfg) && settingsDone?.()) })
      const { url, local, close } = await settingsPage
      const test = settingsDone ? '&test=1#models' : '' // opened to run the Test (testedFirst): the page starts it
      openBrowser(local + test)
      ui.print(`${c.info('↗')} ${c.bold('settings')} ${c.muted(test ? 'opened in your browser, testing:' : 'opened in your browser:')}\n  ${c.faint(url + test)}`)
      // a dialog until it's turned off: nothing else meanwhile, in any tab (Esc turns it off too).
      // Not busy meanwhile: what's changed on the page applies at once, here too (opened while a task
      // works: once it's done).
      if (!working) ui.idle()
      if (app.tabs) app.tabs.locked = true
      let done = false // ended by what it was opened for (testedFirst): the page stays, to read the results
      const was = settingsDone
      if (was) settingsDone = () => ((done = true), was())
      try {
        await ui.pick('The settings page is on', [{ label: 'Turn off', desc: 'stops the page and gives HeartCode back' }], { fixed: true, body: `It's open in your browser:\n${url}\n\nWhat you change there applies right away.` })
      } finally {
        if (app.tabs) app.tabs.locked = false
        if (!done) close(), (settingsPage = null)
      }
      return ui.print(c.dim(done ? 'the settings page stays open in your browser for now (/settings turns it off)' : 'settings page turned off'))
    }
    case 'tab': {
      const { tabs } = app
      if (!tabs) return ui.print(c.dim('tabs need the full screen'))
      if (!args[0] || args[0] === 'new') return void tabs.add({ root: app.root })
      if (args[0] === 'worktree') {
        const wt = createWorktree(app.root, args[1] ?? '')
        return void tabs.add({ root: wt.cwd, wt })
      }
      if (/^\d+$/.test(args[0]) && tabs.list[args[0] - 1]) return tabs.show(tabs.list[args[0] - 1])
      return ui.print(`${c.cyan('/tab')} ${c.faint('a new tab ·')} ${c.cyan('/tab worktree')} ${c.muted('[name]')} ${c.faint('a new tab in its own git worktree ·')} ${c.cyan('/tab')} ${c.muted('<1–' + tabs.list.length + '>')} ${c.faint('go to that tab')}`)
    }
    case 'help':
      return ui.showText('Commands and keys', app.help())
    case 'update': {
      ui.spinner('asking npm for the newest HeartCode')
      const u = await checkUpdate()
      ui.stopSpin()
      if (!u) return ui.warn("couldn't reach npm to check for a newer HeartCode")
      app.update = u
      ui.render?.()
      if (!u.newer) return ui.print(c.dim(`HeartCode ${u.current} is the newest`))
      const kind = installKind()
      const notes = await whatsNew(u.current, u.latest)
      if (kind === 'git') return ui.showText(`HeartCode ${u.latest} is out (you have ${u.current})`, `${notes || '(no changelog found)'}\n\nThis HeartCode runs from a git checkout (${packageDir}): update it there with git pull.`)
      const cmd = UPDATE_COMMANDS[kind]
      ui.showText(`HeartCode ${u.latest} is out (you have ${u.current})`, notes || '(no changelog found)')
      if ((await ui.confirm(`Update now with ${c.bold(cmd)}?`, 'command')) !== true) return ui.print(c.dim('not updated'))
      ui.spinner(`running ${cmd}`)
      const r = await runCommand(process.cwd(), cmd, { timeout: 300_000 })
      ui.stopSpin()
      if (r.code !== 0) return ui.warn(`the update failed (exit ${r.code}): ${r.output.trim().split('\n').slice(-3).join(' · ')}`)
      app.update = { ...u, newer: false }
      ui.render?.()
      return ui.print(`${c.green('✓')} HeartCode ${u.latest} installed ${c.dim('· restart HeartCode to use it (/exit, then heart)')}`)
    }
    case 'select_model':
      return app.pickModel(args, working)
    case 'rename': {
      const name = args.join(' ').trim() || (await ui.ask(`  ${c.bold('Name for this session')}: `, { initial: app.chat.name ?? '' }))?.trim()
      if (!name) return ui.print(c.dim('cancelled'))
      app.chat.name = name
      if (app.chat.turns.length) app.save()
      return ui.print(c.dim(`named "${name}"${app.chat.turns.length ? '' : ' (saved with the first message)'}`))
    }
    case 'fork': {
      if (!app.chat.turns.length) return ui.print('Nothing to fork yet.')
      app.save()
      const was = app.chat.id
      app.setChat(forkChat(app.chat))
      app.save()
      return ui.print(c.dim(`forked: you're in "${app.chat.name}" now; the original (${was}) stays in /resume`))
    }
    case 'export': {
      if (!app.chat.turns.length) return ui.print('Nothing to export yet.')
      let file = args.join(' ').trim()
      if (!file) file = (await choose(ui, cmd, '', 'Export as?')) ?? ''
      if (!file) return
      if (ARGS.export.some(([f]) => f === file)) file = `heartcode-${app.chat.id}.${file}`
      const format = /\.html?$/i.test(file) ? 'html' : /\.json$/i.test(file) ? 'json' : 'md'
      const abs = path.resolve(app.root, file)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, exportChat(app.chat, format, app.inUse() ? `${app.inUse().provider} · ${app.inUse().model}` : ''))
      return ui.print(`${c.green('saved')} ${path.relative(app.root, abs) || abs}`)
    }
    case 'diff': {
      // each file from before HeartCode first changed it in this session, to now
      const first = new Map()
      for (const t of app.chat.turns) for (const [rel, before] of Object.entries(t.files)) if (!first.has(rel)) first.set(rel, before)
      const want = args.join(' ').trim()
      const files = [...first.keys()].filter((f) => !want || f.includes(want)).sort()
      if (!files.length) return ui.print(want ? `No changes to ${want} in this session.` : 'No changes in this session yet.')
      let shown = 0
      const out = []
      for (const rel of files) {
        const abs = path.join(app.root, rel)
        const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
        const was = first.get(rel)
        if (was === now) continue
        shown++
        if (was === null || now === null) out.push(`${c.bold(rel)} ${was === null ? c.green('(new)') : c.red('(deleted)')}`)
        if (now !== null) out.push(renderDiff(diffLines(was ?? '', now), rel, undefined, 3, 400))
      }
      out.push(c.dim(shown ? `${shown} file${shown > 1 ? 's' : ''} changed in this session${files.length > shown ? ` (${files.length - shown} back as they were)` : ''}` : 'every file HeartCode changed is back as it was'))
      return ui.showText(want ? `Changes to ${want}` : 'Changes in this session', out.join('\n'))
    }
    case 'init': {
      const has = (f) => fs.existsSync(path.join(app.root, f))
      const file = has('HEARTCODE.md') ? 'HEARTCODE.md' : 'AGENTS.md'
      const others = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursorrules'].filter((f) => f !== file && has(f))
      return runTask(app, prompt('agent/init', { file, existing: has(file), others: others.join(', ') }), { signal: app.signal })
    }
    case 'copy': {
      const answer = app.chat.history.at(-1)?.answer?.trim()
      if (!answer) return ui.print('No answer to copy yet.')
      const how = copyText(answer)
      return ui.print(c.dim(`copied the last answer (${answer.split('\n').length} lines)${how === 'osc' ? ' through the terminal' : ''}`))
    }
    case 'background': {
      const jobs = listJobs(app.root)
      const label = (j) => `#${j.id} ${clip(j.command, 70)}`
      if (args[0] === 'off' || args[0] === 'hide') return app.toggleJobs(false)
      if (args[0] === 'stop') {
        const j = args[1] ? getJob(args[1]) : null
        const running = jobs.filter((x) => !x.exited)
        if (!j && !running.length) return ui.print(c.dim('Nothing is running in the background.'))
        const pick = j ? { j } : await ui.pick('Stop which one?', running.map((x) => ({ label: label(x), desc: `running · ${ranFor(x)}`, j: x })))
        if (!pick?.j) return
        return ui.print(stopJob(pick.j) ? `${c.ok('✓')} stopped ${label(pick.j)}` : c.dim(`#${pick.j.id} had already exited`))
      }
      if (args[0] === 'files') return jobs.length ? ui.showText('Background logs', jobs.map((j) => `${label(j)}\n  ${c.faint(j.file)}`).join('\n')) : ui.print(c.dim('No background commands yet.'))
      if (getJob(args[0])) app.jobTab = getJob(args[0]).id // /background 2: its tab
      return app.toggleJobs(true) // their logs, live, a tab each
    }
    case 'context': {
      const s = app.s
      if (!s?.messages?.length) return ui.print('Nothing in the context yet: it fills with your first message.')
      const r = contextReport(s)
      const share = (n) => (r.window ? `${Math.round((n / r.window) * 100)}%` : '')
      const bar = (n) => c.brand('█'.repeat(r.window ? Math.round((n / r.window) * 40) : 0) || (n ? '▏' : ''))
      const row = (name, n, note = '') => `  ${name.padEnd(20)} ${kTokens(n).padStart(6)} ${c.faint(share(n).padStart(4))}  ${bar(n)}${note ? ` ${c.faint(note)}` : ''}`
      const free = Math.max(0, r.compactAt - r.total)
      ui.showText(
        'Context',
        [
          `${c.muted(`~${kTokens(r.total)} of ${kTokens(r.window)} (${share(r.total)}) · ${s.client.model}`)}${r.counted ? c.faint(` · the last request, as the server counted it: ${kTokens(r.counted)}`) : ''}`,
          ...r.parts.filter((p) => p.tokens).map((p) => row(p.name, p.tokens, p.note)),
          `  ${'room left'.padEnd(20)} ${kTokens(free).padStart(6)} ${c.faint(share(free).padStart(4))}  ${c.faint(`before it summarizes, at 85% (${kTokens(r.compactAt)}) — or moves to a model with more room`)}`,
          '',
          c.bold('Biggest pieces'),
          ...r.biggest.map((b) => `  ${kTokens(b.tokens).padStart(6)}  ${b.what} ${c.faint(b.ago ? `· ${b.ago} message${b.ago > 1 ? 's' : ''} ago` : '· the newest')}`),
          c.faint('  /compact summarizes it (add what to keep); older tool results become pointers to their files on their own'),
        ].join('\n'),
      )
      return
    }
    case 'cost': {
      const u = app.chat.usage
      if (!u?.requests) return ui.print('Nothing used yet in this session.')
      const price = app.s?.client.price?.()
      return ui.showText(
        'Cost',
        `${c.bold('tokens')}  ${kTokens(u.input)} in${u.cached ? ` (${kTokens(u.cached)} from the cache)` : ''} · ${kTokens(u.output)} out · ${u.requests} request${u.requests > 1 ? 's' : ''}\n` +
          (u.priced
            ? `${c.bold('cost')}    ${money(u.cost)}${price ? c.faint(`  (${app.inUse()?.model}: $${price.input ?? 0} in / $${price.output ?? 0} out per million tokens, from models.dev)`) : ''}`
            : c.faint(`cost: not known for ${app.inUse()?.model ?? 'this model'} (models.dev doesn't list it; local and subscription models have none)`)),
      )
    }
    case 'clear_chat': // a new session; the old one stays in /resume
      ui.clear()
      app.setChat(newChat(app.root))
      if (app.s) app.s.client.lastTokens = 0
      return
    case 'resume':
      return app.resume()
    case 'rewind':
      return app.rewind()
    case 'tree':
      return app.tree()
    case 'tidy_memory': {
      const s = await app.session()
      if (!s) return
      return s.tidyMemory(app.signal)
    }
    case 'doctor': {
      const caps = capabilities(cfg)
      const rows = caps.map((cp) => {
        const head = `  ${cp.ok ? c.green('✓') : c.red('✗')} ${c.bold(cp.name)}${cp.ok ? c.dim(' · ready') : c.yellow(' · needs setup')}`
        return cp.ok ? head : `${head}\n    ${c.faint(`install ${cp.need}`)}`
      })
      return ui.showText('External tools HeartCode features use', rows.join('\n'))
    }
    case 'mcp': {
      const all = loadServers(app.root, { includeDisabled: true }) // enabled and off, so off ones are visible
      const names = Object.keys(all)
      if (!names.length) return ui.print('No MCP servers. Add one in /settings → MCP servers, or /import from another CLI.')
      const running = new Set(app.mcp.names)
      const label = { local: c.dim('local · no sign-in'), in: c.green('signed in'), out: c.yellow('sign-in needed') }
      const rows = names.map((n) => {
        const cfg = all[n]
        const on = running.has(n)
        const where = cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ')
        const head = on ? `${c.brand('●')} ${c.bold(n.padEnd(16))} ${label[mcpAuth(cfg)]}` : `${c.dim('○')} ${c.dim(n.padEnd(16))} ${c.dim('off')}`
        return `  ${head}\n    ${c.faint(clip(where, 90))}`
      })
      const needs = names.some((n) => running.has(n) && mcpAuth(all[n]) === 'out')
      const off = names.some((n) => !running.has(n))
      return ui.showText('MCP servers', `${rows.join('\n')}${needs ? `\n  ${c.dim('sign in to a remote one with /login_mcp <name>')}` : ''}${off ? `\n  ${c.dim('turn one on in /settings → MCP servers')}` : ''}`)
    }
    case 'login_mcp': {
      const remote = app.mcp.names.filter((n) => app.mcp.get(n).url)
      const name = args[0] ?? (await ui.pick('Sign in to which server?', remote.map((n) => ({ label: n, desc: app.mcp.get(n).url, hint: mcpAuth(app.mcp.get(n).cfg) === 'in' ? 'signed in' : 'not signed in' }))))?.label
      if (!name) return remote.length ? undefined : ui.print('No remote MCP servers (ones with a "url") to sign in to.')
      if (!app.mcp.get(name)?.url) return ui.print(`No remote MCP server "${name}".`)
      spin(`connecting to ${name}`)
      try {
        const msg = await signInMcp(app, name, app.signal)
        unspin()
        return ui.print(`${c.green('✓')} ${msg}`)
      } catch (e) {
        unspin()
        return ui.print(`${c.red('✗')} ${e.message}`)
      }
    }
    case 'import': {
      const items = findImports(app.root)
      if (!items.length) return ui.print('Nothing to import: no commands, skills, MCP servers, instructions or memory from Claude Code, Codex, Gemini CLI, OpenCode or Cursor found.')
      for (const it of items) if (it.dup?.()) it.desc = `${c.yellow('already have it')} · ${it.desc}`
      const chosen = await ui.pick(`Import from other CLIs (${items.length} found)`, items, { multi: true })
      if (!chosen) return
      for (const it of chosen) {
        try {
          // a duplicate (also of one just imported): added only if you say so, under a free name
          const dup = it.dup?.()
          if (dup && (await ui.pick(`${it.label}: ${dup}. Add it anyway?`, [{ label: 'No, skip it', value: false }, { label: 'Yes, add it under a new name', value: true }]))?.value !== true) {
            ui.print(`${c.dim('–')} ${it.label} ${c.dim(`skipped: ${dup}`)}`)
            continue
          }
          ui.print(`${c.green('✓')} ${it.run()}`)
        } catch (e) {
          ui.print(`${c.red('✗')} ${it.label}: ${e.message}`)
        }
      }
      app.reload('skill')
      app.reload('mcp', working) // working: the old servers stop once the task is done
      log('import', chosen.map((it) => `${it.group}: ${it.label}`))
      return
    }
    case 'install_skill': {
      const url = args.find((a) => !a.startsWith('--'))
      if (!url) return ui.print('Usage: /install_skill <github repo or a SKILL.md url> [--project]')
      const scope = args.includes('--project') ? 'project' : 'global'
      spin(`installing from ${url}`)
      try {
        const msg = await installSkill(app.root, url, scope, { signal: app.signal })
        unspin()
        app.reload('skill')
        return ui.print(`${c.green('✓')} ${msg}${scope === 'project' ? ' (this folder)' : ''} ${c.dim('· run with /skill:<name>, /help lists them')}`)
      } catch (e) {
        unspin()
        return ui.print(`${c.red('✗')} could not install: ${e.message}`)
      }
    }
    case 'btw':
      return app.btw(line.trim().replace(/^\/btw\b/, '').trim(), working)
    case 'voice': {
      if (working) return ui.dictateIn() // as Space does while it works: sent when you press Enter
      const text = await ui.dictate()
      if (text) ui.ahead.push(text) // sent: the next prompt takes it, as if typed
      return
    }
    case 'toggle_thinking':
      ui.showThinking = !ui.showThinking
      ui.print(c.dim(ui.showThinking ? 'thinking: all of it, as it comes (Ctrl+O: its last two lines)' : 'thinking: its last two lines while it thinks (Ctrl+O: all of it)'))
      if (ui.showThinking && !ui.thinkTail) ui.showLastThought() // the one just over: all of it now
      return
  }
  if (!['model_info', 'compact'].includes(cmd)) {
    app.skills = loadSkills(app.root) // edits to skill files apply right away
    if (app.s) app.s.skills = app.skills
    if (cmd.startsWith('skill:')) {
      const name = cmd.slice(6)
      const k = app.skills.get(name)
      if (k && (k.use === 'me' || k.use === 'both')) return runTask(app, await app.expandSkill(k, args.join(' ')), { signal: app.signal })
      return ui.print(`unknown skill /skill:${name} ${c.dim('· /help lists your skills')}`)
    }
    if (app.skills.has(cmd)) return ui.print(`${c.dim(`/${cmd} is a skill — run it as`)} ${c.cyan(`/skill:${cmd}`)}`) // bare skill name: point to the namespaced form
    return ui.print(`unknown command /${cmd} ${c.dim('· /help lists them')}`)
  }
  const s = await app.session()
  if (!s) return
  switch (cmd) {
    case 'compact': {
      const done = await s.compact({ signal: app.signal, focus: args.join(' ') })
      if (!done) return ui.print('Nothing to compact yet.')
      s.client.lastTokens = 0
      return app.save()
    }
    case 'model_info':
      return ui.showText(s.client.model, describe(s.profile, s.strat))
  }
}

// An orchestrator whose models were never tested together (the settings page's Test) would pick by
// names and public ranks alone: before the message goes, ask what to do. Test (the message waits for
// the settings page), your order instead, or send it anyway (not asked again this session).
async function testedFirst(app) {
  const { ui, cfg } = app
  const untested = () => ui.full && fitMode(cfg) && !app.untestedOk && app.sessionModels().length > 1 && !fs.existsSync(path.join(HOME, 'full-test.json'))
  if (!untested()) return true
  const it = await ui.pick('Test your models first?', [
    { label: 'Open settings and run Test', desc: 'checks your orchestrators and models work together; your message waits', act: 'test' },
    { label: 'Use my order instead', desc: '#1 answers, the next one when it fails (switch back in /settings)', act: 'order' },
    { label: 'Send it anyway', desc: 'the orchestrator guesses from names and ranks (not asked again this session)', act: 'send' },
  ], { fixed: true, body: "An orchestrator picks which of your models does each job, by how they did in a test. Yours haven't been tested yet." })
  if (!it) return ui.print(c.dim('not sent')), false
  if (it.act === 'send') app.untestedOk = true
  if (it.act === 'order') {
    cfg.modelChoice = 'order'
    modelChoiceFlag = undefined
    saveConfig(cfg)
    applySettings(app.tabs ? app.tabs.list.map((t) => t.app) : [app], cfg, 'setting:modelChoice')
    ui.print(`${c.ok('✓')} ${c.muted('your models in your order now (/settings to change it)')}`)
  }
  if (it.act === 'test') {
    // the page's done when the Test is (or you switch to your order there): it turns off, and the message goes
    ui.print(c.dim('The Test starts on the settings page. When it\'s done, your message goes.'))
    settingsDone = () => ui.cancelAsk('done')
    try {
      await slash(app, '/settings')
    } finally {
      settingsDone = null
    }
    if (untested()) (app.untestedOk = true), ui.print(c.dim('not tested yet: this time the orchestrator picks by names and ranks'))
  }
  return true
}
let settingsDone = null // what the settings page ends when it's done (testedFirst)

async function runTask(app, task, ctl) {
  const { ui } = app
  try {
    if (!(await testedFirst(app))) return false
    const s = await app.session()
    if (!s) return false
    let answer
    try {
      answer = await s.run(task, ctl?.signal)
    } finally {
      app.save()
    }
    notify(app.cfg, 'done', `✅ Done · ${path.basename(app.root)} · ${duration(ui.worked())}\n${clip(task.split('\n')[0], 200)}\n\n${clip(String(answer ?? '').trim(), 3500)}`)
  } catch (e) {
    ui.stopSpin()
    log('error', e.name === 'AbortError' || ctl?.signal.aborted ? 'task interrupted by the user' : e.stack)
    if (e.name === 'AbortError' || ctl?.signal.aborted) ui.print(c.yellow('\ninterrupted'))
    else {
      ui.print(c.red(`\nerror: ${e.message}`))
      notify(app.cfg, 'failed', `❌ Failed · ${path.basename(app.root)}\n${clip(task.split('\n')[0], 200)}\n\n${clip(e.message, 1500)}`)
    }
    return false
  }
  return true
}

async function repl(app, f = {}) {
  const { ui, cfg } = app
  ui.fullscreen({ mouse: cfg.mouse !== false }) // HeartCode's wheel and selection ("mouse": false: the terminal's own: then its wheel scrolls the whole screen)
  ui.onDoubleEscape = () => '/rewind'
  let ctl = null
  ui.onEscape = () => ctl?.abort()
  // a command typed while it works: run now, beside the task, if it leaves the conversation alone
  ui.onPanel = () => app.toggleJobs() // Alt+B: the background commands' logs, side by side, live
  ui.onNow = (line) => {
    if (!RIGHT_AWAY.has(/^\/([\w-]+)/.exec(line)?.[1]) || !app.isCommand(line)) return false
    slash(app, line, true)
      .then((r) => r === 'exit' && (ctl?.abort(), app.save(), quit()))
      .catch((e) => (log('error', e.stack), ui.print(c.red(`error: ${e.message}`))))
    return true
  }
  ui.onWaiting = (question) => notify(cfg, 'waiting', `⏳ Waiting for you · ${path.basename(app.root)}\n${clip(question.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s*›\s*$/, '').replace(/^\?\s*/, '').trim(), 1000)}`) // a question or a permission while it works (Telegram)
  ui.isCommand = (l) => app.isCommand(l)
  loadPrices().then(() => ui.render?.()) // models.dev: what each model can do, for the model lists
  ui.voiceConfig = () => ({ voice: cfg.voice, providers: cfg.providers })
  // Ctrl+C: stops what's running; clears the input if there's text; otherwise asks before quitting
  // (a second Ctrl+C within 2s quits, also when something is stuck).
  let lastInterrupt = 0
  // Ctrl+C twice: all of HeartCode (its tabs come back next time, in continueTabs)
  const quit = () => {
    if (app.tabs) app.tabs.quitting = true
    ui.print()
    ui.close()
    process.exit(0)
  }
  // Alt+W, /close_tab: this tab, after asking (working: that stops too); the last one quits
  let closing = false
  app.closeTab = async (working = false) => {
    if (closing) return
    closing = true
    try {
      const last = (app.tabs?.list.length ?? 1) < 2
      const go = await ui.pick(`Close this tab?${working ? ' It is still working: that stops too.' : ''}`, [
        { label: 'Yes, close it', desc: last ? 'the last tab: HeartCode quits (it comes back next time)' : undefined, yes: true },
        { label: 'No' },
      ])
      if (!go?.yes) return
      if (last && app.tabs) app.tabs.quitting = true
      ctl?.abort()
      ui.cancelAsk()
      ui.close()
    } finally {
      closing = false
    }
  }
  ui.onCloseTab = () => {
    if (closing) return
    if (!ui.asking) return app.closeTab(true) // working: asked over the work
    if (!ui.histOn || ui.menu.pick) return ui.notice('Answer this first, then Alt+W', 2000)
    ui.submit('/close_tab') // at the prompt: asked in its turn, like a typed /close_tab
  }
  const others = () => (app.tabs?.list.length ?? 1) - 1
  ui.onInterrupt = () => {
    const again = Date.now() - lastInterrupt < 2000
    lastInterrupt = Date.now()
    if (ctl) {
      if (again) return quit()
      ctl.abort()
      ui.cancelAsk()
      return ui.warn(`stopping… (Ctrl+C again to quit${others() ? ` HeartCode, all ${others() + 1} tabs` : ''})`)
    }
    if (ui.rl?.line) {
      lastInterrupt = 0 // clearing isn't the first half of quitting
      return ui.clearInput()
    }
    if (again) return quit() // the second within 2s (also when the first stopped the work)
    ui.notice(others() ? `Press Ctrl+C again to quit HeartCode (all ${others() + 1} tabs; Ctrl+Q closes just this one)` : 'Press Ctrl+C again to quit', 2000)
  }
  // Pinned to the top of the screen; /clear_chat and scrolling leave it alone.
  const home = process.env.HOME
  const where = home && app.root.startsWith(home) ? '~' + app.root.slice(home.length) : app.root
  ui.folder = app.root // what a double click on the header's folder copies
  ui.header = (cols = 100) => [
    `${c.brand('♥')} ${c.bright(c.bold('HeartCode'))} ${c.faint(VERSION)}  ${c.muted(where.length > cols - 16 ? '…' + where.slice(-(cols - 17)) : where)}`,
    [['/', 'run a command'], ['@', 'attach a file'], ...(ui.voiceReady?.() ? [['Space', 'talk (voice)']] : []), [NEWLINE_KEY, 'add a new line'], ['Esc', 'stop'], ['Shift+Tab', 'change permissions']].map(([k, d]) => `${c.muted(k)} ${c.faint(d)}`).join(c.ghost(' · ')),
    '',
  ]
  if (!ui.full) ui.print(ui.header().join('\n'))
  if (f.onStart) await f.onStart(app)
  if (f.continue) {
    const last = listChats(app.root)[0]
    if (last) await app.resume(last)
    else ui.print(c.dim('No earlier session in this folder to continue.'))
  }
  if (f['resume-id']) await app.resume(loadChat(f['resume-id'], app.root))
  else if (f.resume) await app.resume()
  if (f.model) useModel(app, f.model) // a continued tab's own model
  // models this folder picked earlier (/select_model): said, with the way back to your whole list
  if (app.folderModels && cfg.session?.length) ui.print(`${c.muted('this folder uses')} ${c.cyan(cfg.session.map((t) => t.model).join(', '))} ${c.faint(`(picked earlier) · ${c.cyan('/select_model auto')} for your whole list again`)}`)
  app.tabs?.onChange?.() // the conversation it opened with
  // a newer HeartCode: asked of npm in the background at every start, said once and kept in the status bar
  if (cfg.updateCheck !== false)
    checkUpdate()
      .then((u) => {
        if (!u?.newer) return
        app.update = u
        ui.print(`${c.green('⬆')} ${c.muted('HeartCode')} ${c.green(u.latest)} ${c.muted(`is out (you have ${u.current})`)} ${c.faint('·')} ${c.cyan('/update')}`)
        ui.render?.()
      })
      .catch(() => {})
  for (;;) {
    const line = await ui.ask(` ${c.magenta('♥')} `, { suggest: true, initial: app.nextInput, history: true })
    app.nextInput = undefined
    if (line === null) break
    const t = line.trim()
    if (!t) continue
    ctl = new AbortController()
    app.signal = ctl.signal // Esc stops whatever this line started (a task, a probe, …)
    ui.escArm = 0 // a fresh task: a first Esc from before doesn't count toward stopping this one
    ui.busy() // the spinner stays until this line's work is done
    const command = app.isCommand(t)
    if (command) {
      const mark = ui.mark?.() // what it prints goes back out of the conversation when it's done
      try {
        if ((await slash(app, t)) === 'exit') {
          if (app.tabs) app.tabs.quitting = true
          break
        }
      } catch (e) {
        ui.stopSpin()
        log('error', e.stack)
        ui.print(c.red(`error: ${e.message}`))
      }
      if (mark) ui.unmark(mark, /^\S+/.exec(t)[0])
    } else {
      let ok = await runTask(app, t, ctl)
      // plan mode: the plan is done; go ahead with it?
      while (ok && ui.permission === 'plan' && !ctl.signal.aborted) {
        const back = ui.beforePlan && ui.beforePlan !== 'plan' ? ui.beforePlan : 'all'
        const go = await ui.pick('Go ahead with this plan?', [
          { label: 'Yes', desc: Object.fromEntries(PERMISSIONS)[back], mode: back },
          ...(back !== 'ask' ? [{ label: 'Yes, and ask before every change', mode: 'ask' }] : []),
          { label: 'No, keep planning', desc: 'then type what to change in the plan' },
        ])
        if (!go?.mode) break
        ui.setPermission(go.mode)
        ok = await runTask(app, prompt('agent/plan-approved'), ctl)
      }
      if (ui.busySince) ui.print(c.faint(c.italic(`✻ took ${duration(ui.worked())}`))) // fixed once the reply is in
    }
    ui.idle()
    ctl = null
    app.afterLine()
    app.tabs?.onChange?.() // the conversation may be another now (/resume, /fork, /clear_chat)
    if (ui.tail && !command) ui.print() // nothing after /clear_chat, nor after a command (it left nothing)
  }
  ui.close()
}

async function main() {
  // "heartcode page <file|url>": a web page checked in a browser (src/check.js). Only that: a prompt
  // that starts with "page" ("page fix the footer") is a prompt
  const target = process.argv[3]
  if (process.argv[2] === 'page' && process.argv.length === 4 && (/^https?:\/\//.test(target) || fs.existsSync(target))) return (process.exitCode = await (await import('../src/check.js')).pageCommand(target))
  // "--resume <id>" (as in Claude Code) vs a bare "--resume" (pick one): an id follows it
  const argv = process.argv.slice(2)
  const print = argv.includes('-p') || argv.includes('--print') // headless: an id after --resume is always an id
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-w' || argv[i] === '--worktree') argv[i] = '--worktree=' // a name only as --worktree=name
  // an id: a saved session's, or (headless) shaped like one: HeartCode's (20261028091723-f44o) or a UUID
  const idShaped = (x) => /^\d{14}-[a-z0-9]+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
  for (let i = 0; i < argv.length; i++) if ((argv[i] === '--resume' || argv[i] === '-r') && /^[\w.-]{6,}$/.test(argv[i + 1] ?? '') && (loadChat(argv[i + 1]) || (print && idShaped(argv[i + 1])))) argv[i] = '--resume-id'
  const { values: f, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string', short: 'u' },
      model: { type: 'string', short: 'm' },
      'fallback-model': { type: 'string', multiple: true },
      'api-key': { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      ask: { type: 'boolean' },
      'hide-thinking': { type: 'boolean' },
      cwd: { type: 'string', short: 'C' },
      context: { type: 'string' },
      save: { type: 'boolean' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'boolean', short: 'r' },
      'resume-id': { type: 'string' },
      worktree: { type: 'string' },
      acp: { type: 'boolean' },
      provider: { type: 'string' },
      print: { type: 'boolean', short: 'p' },
      'output-format': { type: 'string' },
      'input-format': { type: 'string' },
      'append-system-prompt': { type: 'string' },
      'mcp-config': { type: 'string', multiple: true },
      'strict-mcp-config': { type: 'boolean' },
      'skills-dir': { type: 'string', multiple: true },
      allowedTools: { type: 'string', multiple: true },
      'allowed-tools': { type: 'string', multiple: true },
      disallowedTools: { type: 'string', multiple: true },
      'disallowed-tools': { type: 'string', multiple: true },
      'permission-mode': { type: 'string' },
      'model-choice': { type: 'string' },
      'dangerously-skip-permissions': { type: 'boolean' },
      'session-id': { type: 'string' },
      effort: { type: 'string' },
      'no-memory': { type: 'boolean' },
      verbose: { type: 'boolean' },
      'max-retries': { type: 'string' },
      'max-turns': { type: 'string' },
      all: { type: 'boolean' }, // heart models --all
      json: { type: 'boolean' }, // heart models --json
      'include-partial-messages': { type: 'boolean' }, // stream-json: the replies as they come (thinking too)
      // accepted for drop-in use where Claude Code is expected; nothing to do in HeartCode
      autocompact: { type: 'string' },
      'exclude-dynamic-system-prompt-sections': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  if (f.help) return console.log(HELP)
  if (f.version) return console.log(VERSION)
  if (f.context && !(Number(f.context) > 0)) throw new Error('--context must be a number of tokens')
  for (const k of ['output-format', 'input-format']) if (f[k] && !['text', 'json', 'stream-json'].includes(f[k])) throw new Error(`--${k} must be text, json or stream-json`)
  if (f['permission-mode'] && !PERMISSION_MODES[f['permission-mode']]) throw new Error(`--permission-mode must be one of ${Object.keys(PERMISSION_MODES).join(', ')}`)
  if (f['model-choice'] && !['order', 'fit'].includes(f['model-choice'])) throw new Error('--model-choice must be order or fit')
  modelChoiceFlag = f['model-choice']

  const cfg = loadConfig({ baseUrl: f['base-url'], model: f.model, apiKey: f['api-key'], context: f.context })
  setTheme(cfg.theme)
  useLogs(cfg)
  const safe = { ...cfg, providers: Object.fromEntries(Object.entries(cfg.providers).map(([n, p]) => [n, { ...p, apiKey: p.apiKey && mask(p.apiKey) }])) }
  log('start', `heartcode ${VERSION} · node ${process.version} · ${process.platform} · cwd ${process.cwd()}`, { args: process.argv.slice(2).map((a) => (a === f['api-key'] ? mask(a) : a)), config: safe })
  if (f.provider) {
    if (!cfg.providers[f.provider]) throw new Error(`no provider "${f.provider}" (heartcode providers lists them)`)
    Object.assign(cfg, { provider: f.provider, fixed: true })
  }
  // --fallback-model: after the model given (as in Claude Code's -p), when it fails
  cfg.fallbacks = (f['fallback-model'] ?? []).map((v) => {
    const t = parseModel(v, cfg.providers, cfg.provider)
    if (isAuto(v) || !cfg.providers[t.provider]) throw new Error(`--fallback-model ${v}: give provider/model, or a model of ${cfg.provider} (heart models lists yours)`)
    return t
  })
  if (f.effort) cfg.effort = f.effort === 'default' ? undefined : f.effort
  if (f['mcp-config'] || f['strict-mcp-config']) cfg.mcp = { extra: f['mcp-config'] ?? [], strict: Boolean(f['strict-mcp-config']) }
  extraSkillDirs.push(...(f['skills-dir'] ?? []).map((d) => path.resolve(d)))
  if (f.save) {
    cfg.adhoc = null
    saveConfig(cfg)
    console.log(c.dim(`saved to ${CONFIG_FILE}`))
  }
  const sub = ['models', 'providers', 'config', 'settings'].includes(positionals[0]) && positionals.length <= 2 ? positionals[0] : null

  if (sub === 'settings') {
    const { url, local } = await startSettings({ cfg })
    console.log(`${c.brand('♥')} HeartCode settings: ${url}\n${c.dim('opened in your browser · from another device on this network, open the link above · Ctrl+C to stop')}`)
    openBrowser(local)
    return new Promise(() => {}) // until Ctrl+C
  }

  if (sub === 'config') {
    const file = readJson(CONFIG_FILE, {})
    for (const p of Object.values(file.providers ?? {})) if (p.apiKey) p.apiKey = mask(p.apiKey)
    return console.log(`${CONFIG_FILE}\n${JSON.stringify(file, null, 2)}`)
  }

  if (f.acp) {
    // each editor session gets its own App, for its folder and its MCP servers
    cfg.maxRetries ??= 10
    // each editor session its own settings (one choosing a model doesn't change the others')
    const apps = []
    const makeApp = (root, ui, mcp) => apps[apps.push(new App({ ...structuredClone(cfg), ...(mcp && { mcp: { extra: [mcp] } }) }, ui, root)) - 1]
    watchSettings(() => apps, cfg) // the settings page's changes, into every editor session
    process.exit(await runAcp({ makeApp, version: VERSION, permission: f['permission-mode'] ? PERMISSION_MODES[f['permission-mode']] : (cfg.permissions ?? 'ask') }))
  }
  const headless = f.print || f['output-format'] || f['input-format'] === 'stream-json'
  if (f['max-retries'] !== undefined || headless) cfg.maxRetries = Number(f['max-retries'] ?? 10) // nobody is there to press Esc
  if (f['max-turns']) cfg.maxTurns = Number(f['max-turns'])
  // A UI and an App on it (one per tab; io: the tab's input and output).
  const newApp = (cfg, root, io) => {
    const ui = headless ? new HeadlessUI({ verbose: f.verbose }) : new UI(io)
    // Everything is allowed unless the user chose otherwise (saved), or --ask for this run.
    ui.permission = f['dangerously-skip-permissions'] ? 'all' : f['permission-mode'] ? PERMISSION_MODES[f['permission-mode']] : f.ask ? 'ask' : f.yes ? 'all' : (cfg.permissions ?? 'all')
    if (!headless) {
      ui.queueMode = cfg.queue ?? 'all'
      ui.onQueueMode = (mode) => {
        cfg.queue = mode
        saveConfig(cfg)
      }
      ui.onPermission = (mode) => {
        if (mode === 'plan') return // for this session only: HeartCode doesn't start in plan mode
        cfg.permissions = mode
        saveConfig(cfg)
      }
    }
    ui.showThinking = false // the thinking's last two lines while it thinks; Ctrl+O shows all of it (--hide-thinking: the same)
    const app = new App(cfg, ui, root)
    usePromptsFrom(app.root) // its .heartcode/prompts override the built-in sections
    ui.suggest = (line, cursor) => app.suggest(line, cursor)
    ui.status = (cols) => app.status(cols)
    ui.requestSince = () => app.s?.client.inFlight // the spinner shows how long the model has been answering
    return app
  }
  let root = path.resolve(f.cwd ?? process.cwd())
  const wt = f.worktree !== undefined ? createWorktree(root, f.worktree) : null
  if (wt) {
    root = wt.cwd
    log('worktree', `working in ${wt.dir} on ${wt.branch}`)
    process.on('exit', () => wt.done || activeUI?.noUser || console.error(c.dim(`worktree kept: ${wt.dir} (branch ${wt.branch})`)))
  }
  // The full screen: in tabs (the first one is this folder; /tab and Alt+T open more).
  if (!headless && !sub && !positionals.length && process.stdin.isTTY && process.stdout.isTTY) {
    if (f['resume-id'] && !loadChat(f['resume-id'], root)) throw new Error(`no session ${f['resume-id']}`)
    const saved = readJson(TABS_FILE, {})[root] // before this run's first tab replaces it
    const asked = f.continue || f.resume || f['resume-id'] || f['session-id'] // a session was chosen already
    const tabs = new Tabs((tab, o) => {
      const app = newApp(o.first ? cfg : { ...cfg }, o.root, tab)
      Object.assign(tab, { app, ui: app.ui })
      Object.assign(app.ui, tab.hooks)
      Object.assign(app, { tabs, tab, worktree: o.wt ?? null })
      if (o.first) {
        if (f['no-memory']) app.memory = null
        if (f['session-id']) app.setChat(loadChat(f['session-id'], app.root) ?? { ...newChat(app.root), id: f['session-id'] })
      }
      return (async () => {
        await repl(app, o.first ? { ...f, onStart: !asked && ((a) => continueTabs(a, saved)) } : o.chat ? { 'resume-id': o.chat.id, model: o.model } : {})
        if (tabs.quitting) {
          // quitting: every tab's worktree is kept or removed, then out (other tabs' work stops)
          for (const t of tabs.list) await leaveWorktree(t.app)
          process.exit(process.exitCode ?? 0)
        }
        if (tabs.list.includes(tab)) await leaveWorktree(app) // the last tab: the full screen is gone
        else leaveTabWorktree(app)
      })()
    })
    tabs.root = root
    tabs.onChange = () => saveTabs(tabs)
    watchSettings(() => tabs.list.map((t) => t.app), cfg)
    tabs.onShow = (t) => (activeUI = t.ui)
    tabs.add({ root, wt, first: true })
    await tabs.done
    process.exit(process.exitCode ?? 0) // the last tab closed: quit, even if a timer or an MCP server is still around
  }
  const app = newApp(cfg, root)
  const { ui } = app
  activeUI = ui
  app.worktree = wt
  if (sub === 'providers') return app.listProviders(), ui.close()
  if (sub === 'models') return await app.listModels(positionals[1] ?? '', { all: f.all, json: f.json }), ui.close()
  if (f['no-memory']) app.memory = null
  const chat = f['resume-id'] ? loadChat(f['resume-id'], app.root) : f.continue && headless ? listChats(app.root)[0] : f['session-id'] ? (loadChat(f['session-id'], app.root) ?? { ...newChat(app.root), id: f['session-id'] }) : null
  if (f['resume-id'] && !chat) throw new Error(`no session ${f['resume-id']}`)
  if (chat && (headless || !f['resume-id'])) app.setChat(chat) // interactive: resumed below, with its transcript
  if (headless || positionals.length) watchSettings(() => [app], cfg) // an app's run takes the settings page's changes too
  if (headless) {
    app.allowTools = [...(f.allowedTools ?? []), ...(f['allowed-tools'] ?? [])]
    app.denyTools = [...(f.disallowedTools ?? []), ...(f['disallowed-tools'] ?? [])]
    const code = await runHeadless(app, { prompt: positionals.join(' '), input: f['input-format'], output: f['output-format'], appendSystem: f['append-system-prompt'], partial: f['include-partial-messages'] })
    if (wt && worktreeState(wt).empty) removeWorktree(wt) // else kept, for the caller to merge (its path is in the log)
    process.exit(code) // MCP servers are stopped by the exit hooks
  }
  if (positionals.length) {
    const ok = await runTask(app, positionals.join(' '))
    ui.close()
    await leaveWorktree(app)
    process.exit(ok ? 0 : 1) // MCP servers are stopped by the exit hooks
  }
  if (!positionals.length) watchSettings(() => [app], cfg)
  await repl(app, f)
  await leaveWorktree(app)
  process.exit(process.exitCode ?? 0) // /exit or Ctrl+D: quit, even if a timer or an MCP server is still around
}

let activeUI = null
process.on('uncaughtException', (e) => {
  log('crash', e.stack)
  activeUI?.close()
  console.error(`${c.red('crash:')} ${e.stack}`)
  process.exit(1)
})
// Killed from outside (kill, closing the tab): give the terminal back as it was first.
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    log('exit', `got ${sig}`)
    activeUI?.close()
    process.exit(128 + (sig === 'SIGTERM' ? 15 : 1))
  })
}
process.on('unhandledRejection', (e) => log('crash', 'unhandled rejection:', e?.stack ?? e))
// After the full screen is gone (the UI registers its exit hook later, so leave it here first).
process.on('exit', (code) => {
  log('exit', `code ${code}`)
  const logs = [LOG_FILE ?? (LOG_DIR && fs.existsSync(LOG_DIR) ? LOG_DIR : null), requestLog.dir].filter(Boolean)
  if (!logs.length) return
  activeUI?.leaveFullscreen()
  process.stderr.write(c.dim(`${logs.map((l) => `${l === requestLog.dir ? 'requests' : 'log'}: ${l}`).join('\n')}\n`))
})
main().catch((e) => {
  log('error', e.stack)
  activeUI?.close() // leave full screen first, so the error stays visible
  console.error(`${c.red('error:')} ${e.message}`)
  process.exit(1)
})
