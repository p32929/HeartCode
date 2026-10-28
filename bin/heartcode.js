#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Client } from '../src/client.js'
import { loadConfig, saveConfig, readJson, writeJson, providerName, CONFIG_FILE, HOME, DEFAULT_MODEL, VERSION } from '../src/config.js'
import { probe, loadProfile, strategy, describe, profilePath, profileFrom } from '../src/probe.js'
import { learnFromUsage, RATE_CAP_MS } from '../src/context.js'
import { Session, transcript } from '../src/agent.js'
import { treeItems, codePlan, move, leaving, leftText, leftFiles } from '../src/tree.js'
import { UI, c, PERMISSIONS, rank, setTheme, themeCodes, renderDiff, diffLines, DEFAULT_KEYS, loadKeys } from '../src/ui.js'
import { listFiles, runCommand, clip } from '../src/tools.js'
import { log, LOG_FILE, LOG_DIR, requestLog, useRequestLog, useLogs, pruneLogs, logDays } from '../src/log.js'
import { prompt, usePromptsFrom, reloadPrompts } from '../src/prompts.js'
import { newChat, saveChat, listChats, loadChat, restoreFiles, ago, forkChat, exportChat } from '../src/sessions.js'
import { loadPrices, priceOf, addUsage, money, limitsOf } from '../src/usage.js'
import { Mcp } from '../src/mcp.js'
import { forget } from '../src/oauth.js'
import { loadSkills, fillArgs, extraSkillDirs } from '../src/skills.js'
import { HeadlessUI, runHeadless, toolNames, PERMISSION_MODES } from '../src/headless.js'
import { findImports } from '../src/importer.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { Memory } from '../src/memory.js'
import { Director } from '../src/director.js'
import { createWorktree, worktreeState, removeWorktree } from '../src/worktree.js'
import { runAcp } from '../src/acp.js'
import { Tabs } from '../src/tabs.js'
import { startSettings } from '../src/settings.js'
import { RESETS, reset, resetPaths, resetCode } from '../src/reset.js'

const LOCAL_SERVERS = ['http://localhost:11434/v1', 'http://localhost:1234/v1', 'http://localhost:8080/v1']

const HELP = `${c.magenta('♥')} ${c.bold('HeartCode')} — a coding CLI for any local or OpenAI-compatible model

${c.bold('usage')}
  heart                              interactive session in this folder (or: heart .)
  heart ~/code/my-app                in that folder (a folder, not a file)
  heart "fix the failing test"       run one task and exit
  heart providers                    list added providers
  heart models [filter]              "default" (your list), then your models: #1 (in use), then its fallbacks
  heart models --all [filter]        every provider's models, yours marked
  heart models --json                as JSON (with --all too), for other programs
  heart probe                        test the current model for real (otherwise its abilities come from models.dev)
  heart config                       show the config file
  heart settings                     change providers, models and settings in your browser

${c.bold('options')}
  -u, --base-url <url>   use this server for this run (add --save to keep it)
  -m, --model <name>     use this model alone for this run (no fallbacks); "default": your list, with its fallbacks
      --api-key <key>    API key for --base-url
  -y, --yes              do everything without asking (the default)
      --ask              ask before every edit and command, this run
      --hide-thinking    collapse the model's thinking to one line
  -C, --cwd <dir>        project folder (default: current folder)
      --temp             a throwaway settings folder for this run (your providers, model tests
                         and prices copied in; deleted after); ~/.heart isn't touched
      --context <n>      context window size in tokens
      --force            re-run the probe
      --save             keep the given -u/-m/--api-key/... in ${CONFIG_FILE}
  -w, --worktree         work in a new git worktree and branch (--worktree=name to name it,
                         or to continue in it); removed on exit if nothing changed
  -c, --continue         continue the last session in this folder
  -r, --resume [id]      pick an earlier session to continue (or the one with this id)
      --provider <name>  use this provider for this run (or -m "provider model")

${c.bold('headless')} (for other programs; flags and output as in Claude Code's -p)
  -p, --print                        run without the screen, print the answer, exit
      --output-format <f>            text (default), json, or stream-json (one JSON event per line)
      --input-format <f>             text (default; the prompt, or stdin) or stream-json (messages on stdin)
      --append-system-prompt <text>  added to HeartCode's system prompt
      --mcp-config <file|json>       more MCP servers (repeatable); --strict-mcp-config: only those
      --skills-dir <dir>             more skills (repeatable)
      --allowedTools <list>          only these tools (HeartCode's or Claude Code's names: Read, Edit, Bash…)
      --disallowedTools <list>       never these tools
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
     HEART_LOG=<file>  where heart logs everything it does (default: ~/.heart/logs/, one per run; off: none)

${c.bold('in a session')}  attach an image with @path/to/shot.png · /help for commands`

// [name, description, takes an argument], by section. /help and the "/" menu are built from it.
const SECTIONS = [
  ['providers and models', [
    ['/select_model', 'switch to another of your models (the list, and every provider\'s models: /settings)', true],
  ]],
  ['settings', [
    ['/toggle_thinking', "show or collapse the model's thinking"],
    ['/voice', 'say your message (or press Ctrl+R in the input): it goes in the input box'],
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
    ['/model_info', 'what the model can do and how HeartCode uses it'],
    ['/test_model', 'test the model for real (otherwise what it can do comes from models.dev, or your settings)'],
    ['/tidy_memory', 'merge, update and link the memory notes now'],
    ['/import', 'bring commands, skills, MCP servers and memory from other CLIs'],
    ['/login_mcp', 'sign in (again) to a remote MCP server', true],
    ['/compact', 'summarize the conversation to free up context (add what to keep)', true],
    ['/clear_chat', 'forget the conversation'],
    ['/reset', "HeartCode's settings (or also providers, or everything) back to the start; asks for a code first"],
    ['/settings', 'change providers, models, settings, MCP servers, hooks, keys and skills in your browser'],
    ['/help', 'this list'],
    ['/tab', 'a new tab (Ctrl+T): another conversation beside this one · /tab worktree [name]: in its own git worktree · /tab 2: go to tab 2 (Ctrl+N/P) · Ctrl+Q closes one', true],
    ['/exit', 'quit HeartCode (Ctrl+Q closes just this tab)'],
  ]],
]
const COMMANDS = SECTIONS.flatMap(([, list]) => list)
const helpText = (sections) => sections.map(([title, list]) => `  ${c.bold(title)}\n` + list.map(([n, d]) => `  ${c.cyan(n.padEnd(18))} ${d}`).join('\n')).join('\n\n')
const SLASH = helpText(SECTIONS)

const HOWTO = `${c.yellow('No model set up yet.')} Add a provider and choose its models in your browser:

  ${c.cyan('/settings')}          (or ${c.cyan('heart settings')} in another terminal)

${c.dim('Ollama, LM Studio or llama.cpp running on this machine is found on its own.')}`
const NO_MODELS = `${c.yellow('No model chosen yet.')} Choose one on ${c.cyan('/settings')}: a provider's models, click one.`

// Choices for commands that take one (also offered in the "/" menu).
const ARGS = {
  export: [['md', 'Markdown'], ['html', 'a web page'], ['json', 'the whole session file']],
  set_effort: [['default', "the model's own setting"], ['low', 'quick, less thinking'], ['medium', 'balanced'], ['high', 'thinks the longest']],
}


// Terminal.app can't report Shift+Enter; Option+Enter works there ("Use Option as Meta key").
const NEWLINE_KEY = process.env.TERM_PROGRAM === 'Apple_Terminal' ? 'Option+Enter' : 'Shift+Enter'

const kTokens = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

const mask = (k) => (k ? (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '…') : c.dim('no key'))

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
  }

  newMcp() {
    const mcp = new Mcp(this.root, this.cfg.mcp)
    // a remote server asks to sign in: its page opens in the browser (and the link is shown)
    if (!this.ui.noUser)
      mcp.onSignIn = (name, url) => {
        this.ui.print(`${c.info('↗')} ${c.bold(name)} ${c.muted('needs you to sign in; opening your browser…')}\n  ${c.faint(url)}`)
        const [cmd, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
        spawnSync(cmd, args, { stdio: 'ignore' })
        this.ui.spinner(`waiting for you to sign in to ${name} in the browser · Esc to stop`)
      }
    return mcp
  }

  // After a skill or MCP server was saved or deleted (by the director or /import).
  reload(kind) {
    if (kind === 'skill') this.skills = loadSkills(this.root)
    if (kind === 'mcp') {
      this.mcp.dispose()
      this.mcp = this.newMcp()
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
      `model: ${cfg.provider ?? '(none)'} ${cfg.model ?? ''}`,
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
      case 'permissions':
        if (!PERMISSIONS.some(([p]) => p === v)) return bad('all, commands, ask or plan')
        ui.setPermission(v)
        return `permissions: ${v}`
      case 'effort':
        if (!ARGS.set_effort.some(([o]) => o === v)) return bad('default, low, medium or high')
        cfg.effort = v === 'default' ? undefined : v
        if (this.s?.strat.thinking) this.s.client.effort = cfg.effort
        return save(`effort: ${v}`)
      case 'auto_compact':
      case 'director':
        if (bool === null) return bad('on or off')
        cfg[name === 'director' ? 'director' : 'autoCompact'] = bool
        if (name === 'auto_compact' && this.s) this.s.autoCompact = bool
        return save(`${name}: ${bool ? 'on' : 'off'}${name === 'director' ? ' (from the next message)' : ''}`)
      case 'model': {
        let [p, ...m] = v.split(/\s+/)
        if (!cfg.providers[p]) [p, m] = [cfg.provider, [v]]
        if (!cfg.providers[p] || !m.join(' ')) return `error: give "provider model" or a model of the current provider; providers: ${Object.keys(cfg.providers).join(', ')}`
        this.later.push(() => this.use(p, m.join(' ')).catch((e) => ui.warn(e.message)))
        return `switching to ${p} · ${m.join(' ')} after this reply`
      }
      default:
        return `error: no setting "${name}"; manage list kind setting shows them`
    }
  }

  // The model, its probe and strategy for a provider and model (probed once, then cached).
  async engine(provider, model, ui, signal) {
    const { cfg } = this
    const client = this.client(provider, model)
    // tokens and cost, into the chat (also a helper's, the probe's, compaction's)
    let price = priceOf(provider, client.baseUrl, model)
    loadPrices().then(() => ((price = priceOf(provider, client.baseUrl, model)), ui.render?.()))
    client.price = () => price
    client.onSpend = (u) => addUsage((this.chat.usage ??= {}), u, price)
    client.onRetry = (err, ms, attempt, next) => ui.retrying(err, ms, attempt, next) // keep trying until Esc (also while probing)
    // the model list (settings page): another model answered; its price from now on
    client.onSwitch = (t) => {
      price = priceOf(t.provider, t.baseUrl, t.model)
      const i = client.rotation.list.indexOf(t)
      ui.print(c.dim(`↻ ${t.provider} · ${t.model} answered${i ? ` (#${i + 1} in your model list)` : ' (#1 again)'}`))
    }
    if (cfg.maxRetries !== undefined) client.retryIf = (e, attempt) => attempt < cfg.maxRetries // headless: then give up
    let profile = await getProfile(client, ui, cfg.force, signal)
    cfg.force = false
    if (strategy(profile, cfg).thinking) client.effort = cfg.effort
    const strat = strategy(profile, cfg)
    // Another model in the list is asked from now on: its own abilities (sees images? its window…)
    // and profile, not the first one's (whose profile was once saved under the next one's name).
    client.onUse = (t) => {
      profile = loadProfile(client) || profileFrom(client, limitsOf(t.provider, client.baseUrl, t.model))
      Object.assign(strat, strategy(profile, cfg))
      Object.assign(client, { tokenRatio: profile.tokenRatio ?? 1, knownGood: profile.largestAccepted ?? 0 })
      log('rotate', `${t.provider} · ${t.model}: ${strat.actions}${strat.vision ? ', images' : ''}, ~${strat.context} tokens`)
    }
    // What the window is, learned while working (context.js); kept in the profile for next time.
    const learned = () => {
      Object.assign(strat, (({ context, contextSure, ratio, reply }) => ({ context, contextSure, ratio, reply }))(strategy(profile, cfg)))
      Object.assign(client, { tokenRatio: profile.tokenRatio ?? 1, knownGood: profile.largestAccepted ?? 0 })
      writeJson(profilePath(client), profile)
    }
    Object.assign(client, { tokenRatio: profile.tokenRatio ?? 1, knownGood: profile.largestAccepted ?? 0 })
    client.onUsage = (used, estimate) => {
      const was = profile.largestAccepted
      const change = learnFromUsage(profile, used, estimate)
      if (change === 'cut') ui.warn(`${client.model} silently cut a request to ~${profile.inputLimit} tokens: that's its window here; keeping the conversation within it`)
      if (change) log('context', `${change}: ${used} tokens counted, ~${estimate} estimated; window now ${strategy(profile, cfg).context}`, { was, largestAccepted: profile.largestAccepted, inputLimit: profile.inputLimit, tokenRatio: profile.tokenRatio })
      if (change) learned()
    }
    // The server said "too large" with its limit: remembered for this model (also next time). A
    // per-minute cap is your account's at this provider: kept apart, for a day.
    client.onInputLimit = (n, { rate = false } = {}) => {
      if (rate) profile.rateCap = { tokens: n, until: Date.now() + RATE_CAP_MS }
      else Object.assign(profile, { inputLimit: Math.min(profile.inputLimit ?? Infinity, n), inputLimitAt: Date.now() })
      learned()
      ui.warn(rate ? `${provider} takes at most ~${n} tokens a minute on your account; shortening the conversation to fit (for today)` : `${client.model} takes at most ~${n} tokens per request here; shortening the conversation to fit`)
    }
    // models.dev's published size for the model (a day old at most): used when the server doesn't say
    loadPrices().then(() => {
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
        return { label: t.task.split('\n')[0].slice(0, 70), desc: `${ago(t.at)}${n ? ` · ${n} file${n > 1 ? 's' : ''} changed since` : ''}`, i }
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

  // Built-in commands, then the skills you can type (a built-in wins on the same name).
  commands() {
    const builtIn = new Set(COMMANDS.map(([n]) => n))
    const mine = [...this.skills.values()].filter((k) => k.use !== 'model' && !builtIn.has(`/${k.name}`)).map((k) => [`/${k.name}`, k.description, true])
    return [...COMMANDS, ...mine]
  }

  // A command: "/name …" with the name of a built-in command or a skill you can type. Anything else
  // starting with "/" (a path like /Users/me/shot.png) is a message for the model.
  isCommand(line) {
    const name = /^\/([\w-]+)(?=\s|$)/.exec(line)?.[1]
    return Boolean(name) && (name === 'quit' || this.commands().some(([n]) => n === `/${name}`))
  }

  help() {
    const mine = this.commands().slice(COMMANDS.length)
    return helpText(mine.length ? [...SECTIONS, ['your skills', mine]] : SECTIONS)
  }

  // "/review focus on tests": the skill's text, arguments filled in, `!command` output added.
  async expandSkill(k, args) {
    let text = fillArgs(k.body, args).replace(/(^|\s)@([\w./-]+)/g, '$1$2') // @file: HeartCode attaches files a message names
    for (const m of [...text.matchAll(/!`([^`]+)`|```!\n([\s\S]*?)```/g)]) {
      const cmd = (m[1] ?? m[2]).trim()
      const ok = await this.ui.confirm(`Run ${c.bold(cmd)} (from /${k.name})?`, 'command')
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

  // The status bar: what's in use, its abilities, and how full the context is.
  status() {
    const { cfg, ui } = this
    const sep = c.ghost(' │ ')
    if (!cfg.providers[cfg.provider] || !cfg.model) return c.dim('no model · /settings to choose one')
    const rot = this.s?.client.rotation
    const now = rot?.list[rot.at] ?? { provider: cfg.provider, model: cfg.model } // the model list: the one in use
    const parts = [`${c.brand('●')} ${c.muted(now.provider)} ${c.ghost('·')} ${c.info(now.model)}${rot ? c.faint(` ↻ ${rot.at + 1}/${rot.list.length}`) : ''}`]
    const key = `${cfg.provider}/${cfg.model}`
    if (this.profileKey !== key) [this.profileKey, this.profile] = [key, this.s?.profile ?? loadProfile(this.client(cfg.provider, cfg.model))]
    const profile = this.s?.profile ?? this.profile
    if (profile) {
      const strat = this.s?.strat ?? strategy(profile, cfg)
      parts.push(c.muted(strat.actions === 'tools' ? 'tools' : 'guided'))
      if (strat.thinking) parts.push(c.think(`thinking${cfg.effort ? ` · ${cfg.effort}` : ''}`) + (ui.showThinking ? '' : c.faint(' (collapsed)')))
      if (strat.vision) parts.push(c.muted('images'))
      const used = this.s?.client.lastTokens ?? 0
      const pct = Math.round((used / strat.context) * 100)
      const paint = pct >= 80 ? c.red : pct >= 50 ? c.yellow : c.green
      const guess = strat.contextSure ? '' : '~' // not said by the server: assumed, and growing as bigger requests work
      parts.push(`${c.faint('ctx')} ${paint(`${kTokens(used)}/${guess}${kTokens(strat.context)}`)} ${c.faint(`${pct}%`)}`)
      const tps = this.s?.client.tps
      if (tps) parts.push(`${c.muted(String(tps))} ${c.faint('tok/s')}`)
      if (this.chat.usage?.priced) parts.push(c.muted(money(this.chat.usage.cost)))
    } else {
      parts.push(c.dim('not probed yet'))
    }
    if (cfg.autoCompact === false) parts.push(c.faint('auto-compact off'))
    if (this.worktree) parts.push(c.info(`⎇ ${this.worktree.branch}`))

    const perm = { all: c.green('⏵⏵ all allowed'), commands: c.yellow('ask before commands'), ask: c.yellow('ask before changes'), plan: c.info('⏸ plan mode') }[ui.permission]
    parts.push(perm) // Shift+Tab changes it (see the header)
    return parts.join(sep)
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
    const { client, profile, strat } = await this.engine(cfg.provider, cfg.model, ui, this.signal)
    this.s = new Session({ client, profile, strat, root: this.root, ui, chat: this.chat }) // details: the status bar
    this.s.autoCompact = cfg.autoCompact !== false
    this.s.onTurn = () => this.save()
    this.useRotation()
    Object.assign(this.s, { noFormat: cfg.format === false, noLsp: cfg.lsp === false })
    Object.assign(this.s, { mcp: this.mcp, memory: this.memory, skills: this.skills, director: this.director })
    this.s.team = () => this.team() // your other models: a job this one can't do goes to one of them
    this.s.engineFor = (t) => this.engine(t.provider, t.model, ui)
    if (this.allowTools?.length) this.s.allowTools = toolNames(this.allowTools) // headless --allowedTools
    if (this.denyTools?.length) this.s.denyTools = toolNames(this.denyTools)
    if (this.cfg.maxTurns) this.s.maxTurns = this.cfg.maxTurns
    log('session', `${cfg.provider} · ${cfg.model} at ${client.baseUrl}`, { strategy: this.s.strat, effort: client.effort })
    return this.s
  }

  // The model list (settings page): this model first, then the others in order; set on the session.
  // A model given for this run (-m, not "default") is used alone: no fallbacks (cfg.fixed).
  useRotation() {
    const { cfg } = this
    const seen = new Set()
    const list = [{ provider: cfg.provider, model: cfg.model }, ...(cfg.fixed ? [] : (cfg.rotation?.then ?? []))]
      .filter((t) => cfg.providers[t.provider] && t.model && !seen.has(`${t.provider}/${t.model}`) && seen.add(`${t.provider}/${t.model}`))
      .map((t) => ({ ...t, baseUrl: cfg.providers[t.provider].baseUrl, apiKey: cfg.providers[t.provider].apiKey }))
    this.s?.client.setRotation(list, cfg.rotation ?? {})
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
    const now = this.s?.client.rotation?.list[this.s.client.rotation.at] ?? this.myModels()[0]
    return this.myModels()
      .filter((t) => !(t.provider === now?.provider && t.model === now?.model))
      .map((t) => ({ ...t, ...this.abilities(t) }))
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
  myModels() {
    const { cfg } = this
    const seen = new Set()
    return [{ provider: cfg.provider, model: cfg.model }, ...(cfg.rotation?.then ?? [])].filter((t) => cfg.providers[t.provider] && t.model && !seen.has(`${t.provider}/${t.model}`) && seen.add(`${t.provider}/${t.model}`))
  }

  // Makes one of your models #1 (the rest keep their order); saved for next time.
  async useMine(t) {
    const { cfg } = this
    delete cfg.fixed // one of your models: your list again, with its fallbacks
    const rest = this.myModels().filter((x) => x.provider !== t.provider || x.model !== t.model)
    cfg.rotation = { ...cfg.rotation, then: rest }
    await this.use(t.provider, t.model)
  }

  // The picker: your models only, #1 first; Enter makes it #1.
  async chooseModel(filter = '') {
    const { ui, cfg } = this
    const mine = this.myModels()
    if (!mine.length) {
      if (!Object.keys(cfg.providers).length && (await this.detectLocal())) return this.session()
      return ui.print(NO_MODELS)
    }
    const items = mine.map((t, i) => ({ label: t.model, t, current: i === 0, desc: this.modelDesc(t, i) }))
    const it = await ui.pick('Choose a model (more on /settings)', items, { filter })
    if (it && !it.current) await this.useMine(it.t)
  }

  // "/select_model gpt-oss-120b" or "/select_model groq openai/gpt-oss-120b": one of your models;
  // no argument, or one that's not in your list: the picker.
  async pickModel(args) {
    if (!args.length) return this.chooseModel()
    const [name, model] = args.length > 1 ? [args[0], args.slice(1).join(' ')] : [null, args[0]]
    const found = this.myModels().filter((t) => t.model === model && (!name || t.provider === name))
    if (found.length === 1) return found[0].provider === this.cfg.provider && found[0].model === this.cfg.model ? this.ui.print(c.dim(`${model} is in use already`)) : this.useMine(found[0])
    if (!found.length) this.ui.print(c.dim(`${model} isn't one of your models: add it on /settings`))
    return this.chooseModel(found.length ? model : '')
  }

  listProviders() {
    const { ui, cfg } = this
    const names = Object.keys(cfg.providers)
    if (!names.length) return ui.print(`No providers yet: add one with ${c.cyan('heart settings')}.`)
    for (const n of names) {
      const p = cfg.providers[n]
      const notes = [n === cfg.provider && c.magenta('● current'), n === cfg.adhoc && c.dim('this run only')].filter(Boolean).join(' ')
      ui.print(`${c.bold(n.padEnd(14))} ${p.baseUrl}  ${c.dim(mask(p.apiKey))}  ${notes}`)
    }
  }

  // `heart models`: your models, in order (every provider's whole list is on the settings page).
  // all: every provider's models too (fetched from each; a provider whose list is switched off: the
  // ones added by name), yours marked. json: one JSON object on stdout, for other programs:
  //   { "models": [{ "place": null, "provider": null, "model": "default", "role": "default", "rotates": true, "about": "…" },
  //                { "place": 1, "provider", "model", "role": "in use" | "fallback", "rotates": false }, …],
  //     "providers": [{ "name", "baseUrl", "list": true, "models": ["…"], "error"? }] }   (--all)
  // "default" is the name for your list: -m default (or no -m) uses #1 and moves on to the next when
  // one fails; -m with one of the models is that model alone.
  async listModels(filter = '', { all = false, json = false } = {}) {
    const { ui, cfg } = this
    const match = (id) => id.toLowerCase().includes(filter.toLowerCase())
    const mine = this.myModels().map((t, i) => ({ place: i + 1, provider: t.provider, model: t.model, role: i === 0 ? 'in use' : 'fallback', rotates: false }))
    const placeOf = (provider, model) => mine.find((t) => t.provider === provider && t.model === model)?.place
    const providers = !all ? [] : await Promise.all(Object.entries(cfg.providers).map(async ([name, p]) => {
      const out = { name, baseUrl: p.baseUrl, list: p.list !== false, models: [] }
      if (out.list) {
        try {
          out.models = await new Client({ baseUrl: p.baseUrl, apiKey: p.apiKey }).listModels()
        } catch (e) {
          out.error = e.message
        }
      }
      // and the ones added by name, and any of yours it doesn't list (as on the settings page)
      out.models = [...new Set([...out.models, ...(p.models ?? []), ...mine.filter((t) => t.provider === name).map((t) => t.model)])].sort((a, b) => a.localeCompare(b)).filter(match)
      return out
    }))
    // "default" first, in the same list: your models, rotating (when there's any)
    const about = mine.length > 1 ? `your models in order: #1, then the next when one fails (-m ${DEFAULT_MODEL}, or no -m)` : `your one model, #1 (-m ${DEFAULT_MODEL}, or no -m)`
    const first = mine.length ? [{ place: null, provider: null, model: DEFAULT_MODEL, role: 'default', rotates: mine.length > 1, about }] : []
    const shown = [...first, ...mine].filter((t) => match(t.model))
    if (json) {
      process.stdout.write(JSON.stringify({ models: shown, ...(all && { providers }) }, null, 2) + '\n')
      return
    }
    if (!all) {
      if (!shown.length) return ui.print(filter ? `None of your models matches "${filter}".` : NO_MODELS)
      for (const t of shown) ui.print(t.place === null ? `${c.magenta('●')} ${c.bold(t.model)} ${c.dim(t.about)}` : `  ${c.bold(`#${t.place}`)} ${t.model} ${c.dim(`${t.provider} · ${t.role}; alone with -m "${t.provider} ${t.model}"`)}`)
      return
    }
    if (!providers.length) return ui.print(NO_MODELS)
    for (const p of providers) {
      ui.print(`${c.bold(p.name)}  ${c.dim(p.baseUrl)}${p.list ? '' : c.dim('  (its list is off: the models added by name)')}`)
      if (p.error) ui.print(`  ${c.red("can't list its models:")} ${c.dim(p.error)}`)
      if (!p.models.length && !p.error) ui.print(c.dim(filter ? `  none matches "${filter}"` : '  no models'))
      for (const id of p.models) {
        const at = placeOf(p.name, id)
        ui.print(`  ${at === 1 ? c.magenta('●') : ' '} ${id}${at ? `  ${c.bold(`#${at}`)} ${c.dim(at === 1 ? 'in use' : 'fallback')}` : ''}`)
      }
    }
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
  let open = (saved?.tabs ?? []).map((t, i) => ({ ...t, i, chat: loadChat(t.chat) })).filter((t) => t.chat?.turns?.length && (!t.worktree || fs.existsSync(t.chat.root)))
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
  if (!app.cfg.providers[provider]) return app.ui.warn(`this tab used ${provider} · ${model}, but there's no provider "${provider}" now: using ${app.cfg.provider} · ${app.cfg.model}`)
  Object.assign(app.cfg, { provider, model })
  app.s = null
}

// The settings page (/settings): on while its dialog is (one at a time).
let settingsPage = null

function openBrowser(url) {
  if (process.env.HEART_NO_BROWSER) return
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  spawnSync(cmd, args, { stdio: 'ignore' })
}

// A change on the settings page (in cfg, saved), brought into every open tab: right away, or the
// model and MCP servers after the reply in progress.
function applySettings(apps, cfg, what) {
  const before = themeCodes()
  if (what === 'theme' || what === 'setting:theme') setTheme(cfg.theme)
  if (what === 'prompts') reloadPrompts() // from each tab's next message
  if (['setting:log', 'setting:logRequests', 'setting:logDetail'].includes(what)) useRequestLog(cfg) // the run's log and the requests', on or off now
  if (what === 'setting:logDays') pruneLogs(logDays(cfg))
  settingsSeen(what) // the watcher (watchSettings) mustn't take it in a second time
  for (const app of apps) {
    const { ui } = app
    const busy = Boolean(ui.busySince)
    const now = (fn) => (busy ? app.later.push(fn) : fn())
    if (app.cfg !== cfg) for (const k of ['providers', 'provider', 'model', 'effort', 'theme', 'context', 'autoCompact', 'director', 'format', 'lsp', 'voice', 'rotation']) app.cfg[k] = cfg[k]
    if (what === 'model') {
      app.lists = {}
      delete app.cfg.fixed // a model chosen on the page: your list again
      const want = cfg.providers[cfg.provider] && app.client(cfg.provider, cfg.model)
      if (app.s && !(want && ['model', 'baseUrl', 'apiKey'].every((k) => want[k] === app.s.client[k])))
        now(() => {
          app.s = null
          ui.print(c.dim(cfg.model ? `settings: ${cfg.provider} · ${cfg.model} from the next message` : 'settings: no model chosen'))
        })
    }
    if (what === 'provider') app.lists = {} // its list switched on or off, a model added by name
    if (what === 'setting:permissions') ui.setPermission(cfg.permissions)
    if (what === 'setting:effort' && app.s?.strat.thinking) app.s.client.effort = cfg.effort
    if (what === 'setting:autoCompact' && app.s) app.s.autoCompact = cfg.autoCompact !== false
    if (what === 'setting:format' && app.s) app.s.noFormat = cfg.format === false
    if (what === 'setting:lsp' && app.s) app.s.noLsp = cfg.lsp === false
    if (what === 'setting:context') now(() => (app.s = null))
    if (what === 'model' || what === 'setting:rotation') now(() => app.useRotation())
    if (what === 'mcp' || what === 'skill') now(() => app.reload(what))
    if (what === 'keys') ui.keys = { ...DEFAULT_KEYS, ...loadKeys() }
    // a model set up or measured on the page: into the session's profile now (it saves its profile
    // as it learns, so it mustn't keep the old one); its mode from the next message
    if (what === 'profile' && app.s?.profile) {
      const disk = loadProfile({ baseUrl: app.s.profile.baseUrl, model: app.s.profile.model })
      if (disk) {
        for (const k of ['source', 'set', 'known', 'measured', 'measuredAt']) disk[k] === undefined ? delete app.s.profile[k] : (app.s.profile[k] = disk[k])
        const st = strategy(app.s.profile, app.cfg)
        Object.assign(app.s.strat, (({ context, contextSure, reply }) => ({ context, contextSure, reply }))(st))
        if (st.actions !== app.s.strat.actions || st.thinking !== app.s.strat.thinking || st.vision !== app.s.strat.vision || st.stream !== app.s.strat.stream) now(() => (app.s = null))
      }
    }
    if (what === 'theme' || what === 'setting:theme') ui.recolor(before, themeCodes())
    else ui.render()
  }
  apps[0]?.tabs?.onChange?.() // each tab's model, for next time
}

// Changes saved by another HeartCode, or \`heart settings\` in another terminal, while this one runs:
// taken in as the page's own are (applySettings). config.json is compared key by key with what it
// was (so a model given for this run with -m stays unless the list's #1 changes); the other files
// by their size and time, and only when this run didn't just apply them itself.
const WATCHED = { 'mcp.json': 'mcp', 'keybindings.json': 'keys', 'theme.json': 'theme', models: 'profile', prompts: 'prompts', skills: 'skill' }
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
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  let last = readJson(CONFIG_FILE, {})
  for (const name of Object.keys(WATCHED)) seenStamp[name] = stampOf(path.join(HOME, name))
  const configChanged = () => {
    const now = readJson(CONFIG_FILE, null)
    if (!now) return
    const keys = [...new Set([...Object.keys(now), ...Object.keys(last)])].filter((k) => !same(now[k], last[k]))
    last = now
    const whats = new Set()
    for (const k of keys) {
      const value = k === 'providers' ? { ...now.providers, ...(cfg.adhoc && { [cfg.adhoc]: cfg.providers[cfg.adhoc] }) } : now[k]
      if (same(value, cfg[k])) continue
      value === undefined ? delete cfg[k] : (cfg[k] = value)
      whats.add(['provider', 'model', 'providers'].includes(k) ? 'model' : k === 'rotation' ? 'setting:rotation' : `setting:${k}`)
    }
    for (const what of whats) applySettings(apps(), cfg, what)
    if (whats.size) log('settings', `taken in from config.json: ${[...whats].join(', ')}`)
  }
  let timer = null
  const check = () => {
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
    for (const k of Object.keys(app.cfg)) if (!['force', 'maxRetries', 'maxTurns', 'mcp', 'adhoc', 'fixed'].includes(k)) delete app.cfg[k]
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

// The system clipboard (pbcopy, clip, wl-copy, xclip, xsel); else the terminal's (OSC 52, works over SSH too).
function copyText(text) {
  const tools = process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '-b', '-i']]
  for (const [cmd, ...args] of tools) if (spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0) return 'system'
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  return 'osc'
}

// A model's profile: the saved one; else what models.dev says (nothing is sent to the model to
// find out); a model it doesn't know: plain assumptions, until you set it up on the settings page.
// force (/test_model, heart probe): test it now instead, with real requests.
async function getProfile(client, ui, force, signal) {
  let p = !force && loadProfile(client)
  if (!p && !force) {
    await loadPrices()
    p = profileFrom(client, limitsOf(client.provider, client.baseUrl, client.model))
    writeJson(profilePath(client), p)
  }
  // one models.dev didn't know when it was saved: looked up again (it may have been added, or the list
  // couldn't be had then)
  if (p?.source === 'assumed') {
    await loadPrices()
    const known = limitsOf(client.provider, client.baseUrl, client.model)
    if (known) writeJson(profilePath(client), (p = { ...p, known, source: 'models.dev' }))
  }
  if (p) {
    if (p.source === 'assumed') ui.warn(`${client.model} isn't in models.dev: assuming it calls tools and streams, with a ~128k window. Set what it can do on /settings`)
    return p
  }
  ui.print(c.dim(`Testing ${client.model}…`))
  const t0 = Date.now()
  const tested = await probe(client, (label) => ui.spinner(`testing: ${label}`), signal)
  ui.stopSpin()
  ui.print(c.dim(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s · saved to ${profilePath(client)}`))
  return tested
}

// A setting from its choices: the argument if valid, else a picker. Returns the choice or null.
async function choose(ui, cmd, arg, title, current) {
  if (ARGS[cmd].some(([o]) => o === arg)) return arg
  return (await ui.pick(title, ARGS[cmd].map(([label, desc]) => ({ label, desc, current: label === current }))))?.label ?? null
}

async function slash(app, line) {
  const [cmd, ...args] = line.slice(1).trim().split(/\s+/)
  const { ui, cfg } = app
  switch (cmd) {
    case 'exit':
    case 'quit': {
      const n = app.tabs?.list.length ?? 1
      if (n > 1) {
        const go = await ui.pick(`Quit HeartCode? ${n} tabs are open`, [
          { label: 'Yes, quit', desc: 'they come back next time you start HeartCode here', yes: true },
          { label: 'No', desc: 'Ctrl+Q closes just this tab' },
        ])
        if (!go?.yes) return
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
      settingsPage ??= startSettings({ cfg, apply: (what) => applySettings(app.tabs ? app.tabs.list.map((t) => t.app) : [app], cfg, what) })
      const { url, close } = await settingsPage
      openBrowser(url)
      ui.print(`${c.info('↗')} ${c.bold('settings')} ${c.muted('opened in your browser:')}\n  ${c.faint(url)}`)
      // a dialog until it's turned off: nothing else meanwhile, in any tab (Esc turns it off too).
      // Not busy meanwhile: what's changed on the page applies at once, here too.
      ui.idle()
      if (app.tabs) app.tabs.locked = true
      try {
        await ui.pick(`${c.info('↗')} ${c.bold('The settings page is on')}`, [{ label: 'Turn off', desc: 'stops the page and gives HeartCode back' }], { fixed: true })
      } finally {
        if (app.tabs) app.tabs.locked = false
        close()
        settingsPage = null
      }
      return ui.print(c.dim('settings page turned off'))
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
      return ui.print(app.help())
    case 'select_model':
      return app.pickModel(args)
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
      fs.writeFileSync(abs, exportChat(app.chat, format, cfg.model ? `${cfg.provider} · ${cfg.model}` : ''))
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
      for (const rel of files) {
        const abs = path.join(app.root, rel)
        const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
        const was = first.get(rel)
        if (was === now) continue
        shown++
        if (was === null || now === null) ui.print(`${c.bold(rel)} ${was === null ? c.green('(new)') : c.red('(deleted)')}`)
        if (now !== null) ui.print(renderDiff(diffLines(was ?? '', now), rel, undefined, 3, 400))
      }
      return ui.print(c.dim(shown ? `${shown} file${shown > 1 ? 's' : ''} changed in this session${files.length > shown ? ` (${files.length - shown} back as they were)` : ''}` : 'every file HeartCode changed is back as it was'))
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
    case 'cost': {
      const u = app.chat.usage
      if (!u?.requests) return ui.print('Nothing used yet in this session.')
      const price = app.s?.client.price?.()
      ui.print(`${c.bold('tokens')}  ${kTokens(u.input)} in${u.cached ? ` (${kTokens(u.cached)} from the cache)` : ''} · ${kTokens(u.output)} out · ${u.requests} request${u.requests > 1 ? 's' : ''}`)
      return ui.print(
        u.priced
          ? `${c.bold('cost')}    ${money(u.cost)}${price ? c.faint(`  (${cfg.model}: $${price.input ?? 0} in / $${price.output ?? 0} out per million tokens, from models.dev)`) : ''}`
          : c.faint(`cost: not known for ${cfg.model ?? 'this model'} (models.dev doesn't list it; local and subscription models have none)`),
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
    case 'login_mcp': {
      const remote = app.mcp.names.filter((n) => app.mcp.get(n).url)
      const name = args[0] ?? (await ui.pick('Sign in to which server?', remote.map((n) => ({ label: n, desc: app.mcp.get(n).url }))))?.label
      if (!name) return remote.length ? undefined : ui.print('No remote MCP servers (ones with a "url") to sign in to.')
      const sv = app.mcp.get(name)
      if (!sv?.url) return ui.print(`No remote MCP server "${name}".`)
      forget(sv.url) // a fresh sign-in
      sv.stop()
      Object.assign(sv, { token: null, tools: null })
      ui.spinner(`connecting to ${name}`)
      const tools = await sv.listTools(app.signal)
      ui.stopSpin()
      return ui.print(`${c.green('connected')} ${c.bold(name)} · ${tools.length} tools`)
    }
    case 'import': {
      const items = findImports(app.root)
      if (!items.length) return ui.print('Nothing to import: no commands, skills, MCP servers, instructions or memory from Claude Code, Codex, Gemini CLI, OpenCode or Cursor found.')
      const chosen = await ui.pick(`Import from other CLIs (${items.length} found)`, items, { multi: true })
      if (!chosen) return
      for (const it of chosen) {
        try {
          ui.print(`${c.green('✓')} ${it.run()}`)
        } catch (e) {
          ui.print(`${c.red('✗')} ${it.label}: ${e.message}`)
        }
      }
      app.reload('skill')
      app.reload('mcp')
      log('import', chosen.map((it) => `${it.group}: ${it.label}`))
      return
    }
    case 'btw':
      return app.btw(line.trim().replace(/^\/btw\b/, '').trim())
    case 'voice': {
      const text = await ui.dictate()
      if (text) app.nextInput = text // in the box, to read over and send
      return
    }
    case 'toggle_thinking':
      ui.showThinking = !ui.showThinking
      return ui.print(c.dim(`thinking ${ui.showThinking ? 'shown' : 'collapsed'}`))
  }
  if (!['model_info', 'test_model', 'compact'].includes(cmd)) {
    app.skills = loadSkills(app.root) // edits to skill files apply right away
    if (app.s) app.s.skills = app.skills
    const k = app.skills.get(cmd)
    if (k && k.use !== 'model') return runTask(app, await app.expandSkill(k, args.join(' ')), { signal: app.signal })
    return ui.print(`unknown command /${cmd} ${c.dim('· /help lists them')}`)
  }
  const s = await app.session()
  if (!s) return
  const restrat = () => (s.strat = strategy(s.profile, cfg))
  switch (cmd) {
    case 'compact': {
      const done = await s.compact({ signal: app.signal, focus: args.join(' ') })
      if (!done) return ui.print('Nothing to compact yet.')
      s.client.lastTokens = 0
      return app.save()
    }
    case 'model_info':
      return ui.print(`${c.cyan(s.client.model)}\n${describe(s.profile, s.strat)}`)
    case 'test_model':
      s.profile = await getProfile(s.client, ui, true, app.signal)
      restrat()
      s.reset()
      return ui.print(describe(s.profile, s.strat))
  }
}

async function runTask(app, task, ctl) {
  const { ui } = app
  try {
    const s = await app.session()
    if (!s) return false
    try {
      await s.run(task, ctl?.signal)
    } finally {
      app.save()
    }
  } catch (e) {
    ui.stopSpin()
    log('error', e.name === 'AbortError' || ctl?.signal.aborted ? 'task interrupted by the user' : e.stack)
    if (e.name === 'AbortError' || ctl?.signal.aborted) ui.print(c.yellow('\ninterrupted'))
    else ui.print(c.red(`\nerror: ${e.message}`))
    return false
  }
  return true
}

async function repl(app, f = {}) {
  const { ui, cfg } = app
  ui.fullscreen()
  ui.onDoubleEscape = () => '/rewind'
  let ctl = null
  ui.onEscape = () => ctl?.abort()
  ui.onBtw = (q) => app.btw(q, true) // /btw typed while it works
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
  // Ctrl+Q: this tab (working: press it again to stop the work too); the last one quits
  let lastClose = 0
  ui.onCloseTab = () => {
    if (ctl && Date.now() - lastClose > 2000) {
      lastClose = Date.now()
      return ui.notice('Still working: Ctrl+Q again stops it and closes this tab', 2000)
    }
    if (app.tabs.list.length < 2) app.tabs.quitting = true
    ctl?.abort()
    ui.cancelAsk()
    ui.close()
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
  ui.header = (cols = 100) => [
    `${c.brand('♥')} ${c.bright(c.bold('HeartCode'))} ${c.faint(VERSION)}  ${c.muted(where.length > cols - 16 ? '…' + where.slice(-(cols - 17)) : where)}`,
    [['/', 'commands'], ['@', 'files'], [NEWLINE_KEY, 'new line'], ['Esc', 'stop'], ['Shift+Tab', 'permissions'], ['Ctrl+R', 'voice']].map(([k, d]) => `${c.muted(k)} ${c.faint(d)}`).join(c.ghost(' · ')),
    '',
  ]
  if (!ui.full) ui.print(ui.header().join('\n'))
  if (f.onStart) await f.onStart(app)
  if (f.continue) {
    const last = listChats(app.root)[0]
    if (last) await app.resume(last)
    else ui.print(c.dim('No earlier session in this folder to continue.'))
  }
  if (f['resume-id']) await app.resume(loadChat(f['resume-id']))
  else if (f.resume) await app.resume()
  if (f.model) useModel(app, f.model) // a continued tab's own model
  app.tabs?.onChange?.() // the conversation it opened with
  for (;;) {
    const line = await ui.ask(` ${c.magenta('♥')} `, { suggest: true, initial: app.nextInput, history: true })
    app.nextInput = undefined
    if (line === null) break
    const t = line.trim()
    if (!t) continue
    ctl = new AbortController()
    app.signal = ctl.signal // Esc stops whatever this line started (a task, a probe, …)
    ui.busy() // the spinner stays until this line's work is done
    if (app.isCommand(t)) {
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
    }
    ui.idle()
    ctl = null
    app.afterLine()
    app.tabs?.onChange?.() // the conversation may be another now (/resume, /fork, /clear_chat)
    if (ui.tail) ui.print() // nothing after /clear_chat
  }
  ui.close()
}

async function main() {
  // "--resume <id>" (as in Claude Code) vs a bare "--resume" (pick one): an id follows it
  const argv = process.argv.slice(2)
  const print = argv.includes('-p') || argv.includes('--print') // headless: an id after --resume is always an id
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-w' || argv[i] === '--worktree') argv[i] = '--worktree=' // a name only as --worktree=name
  for (let i = 0; i < argv.length; i++) if ((argv[i] === '--resume' || argv[i] === '-r') && /^[\w.-]{6,}$/.test(argv[i + 1] ?? '') && (print || loadChat(argv[i + 1]))) argv[i] = '--resume-id'
  const { values: f, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string', short: 'u' },
      model: { type: 'string', short: 'm' },
      'api-key': { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      ask: { type: 'boolean' },
      'hide-thinking': { type: 'boolean' },
      cwd: { type: 'string', short: 'C' },
      context: { type: 'string' },
      force: { type: 'boolean' },
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
      'dangerously-skip-permissions': { type: 'boolean' },
      'session-id': { type: 'string' },
      effort: { type: 'string' },
      'no-memory': { type: 'boolean' },
      verbose: { type: 'boolean' },
      'max-retries': { type: 'string' },
      'max-turns': { type: 'string' },
      all: { type: 'boolean' }, // heart models --all
      json: { type: 'boolean' }, // heart models --json
      // accepted for drop-in use where Claude Code is expected; nothing to do in HeartCode
      autocompact: { type: 'string' },
      'exclude-dynamic-system-prompt-sections': { type: 'boolean' },
      'include-partial-messages': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  if (f.help) return console.log(HELP)
  if (f.version) return console.log(VERSION)
  if (f.context && !(Number(f.context) > 0)) throw new Error('--context must be a number of tokens')
  for (const k of ['output-format', 'input-format']) if (f[k] && !['text', 'json', 'stream-json'].includes(f[k])) throw new Error(`--${k} must be text, json or stream-json`)
  if (f['permission-mode'] && !PERMISSION_MODES[f['permission-mode']]) throw new Error(`--permission-mode must be one of ${Object.keys(PERMISSION_MODES).join(', ')}`)

  const cfg = loadConfig({ baseUrl: f['base-url'], model: f.model, apiKey: f['api-key'], context: f.context })
  setTheme(cfg.theme)
  useLogs(cfg)
  const safe = { ...cfg, providers: Object.fromEntries(Object.entries(cfg.providers).map(([n, p]) => [n, { ...p, apiKey: p.apiKey && mask(p.apiKey) }])) }
  log('start', `heartcode ${VERSION} · node ${process.version} · ${process.platform} · cwd ${process.cwd()}`, { args: process.argv.slice(2).map((a) => (a === f['api-key'] ? mask(a) : a)), config: safe })
  cfg.force = f.force
  if (f.provider) {
    if (!cfg.providers[f.provider]) throw new Error(`no provider "${f.provider}" (heartcode providers lists them)`)
    Object.assign(cfg, { provider: f.provider, fixed: true })
  }
  const [p0, ...rest] = String(f.model ?? '').split(/\s+/) // -m "groq openai/gpt-oss-120b"
  if (rest.length && cfg.providers[p0]) Object.assign(cfg, { provider: p0, model: rest.join(' ') })
  if (f.effort) cfg.effort = f.effort === 'default' ? undefined : f.effort
  if (f['mcp-config'] || f['strict-mcp-config']) cfg.mcp = { extra: f['mcp-config'] ?? [], strict: Boolean(f['strict-mcp-config']) }
  extraSkillDirs.push(...(f['skills-dir'] ?? []).map((d) => path.resolve(d)))
  if (f.save) {
    cfg.adhoc = null
    saveConfig(cfg)
    console.log(c.dim(`saved to ${CONFIG_FILE}`))
  }
  const sub = ['probe', 'models', 'providers', 'config', 'settings'].includes(positionals[0]) && positionals.length <= 2 ? positionals[0] : null

  if (sub === 'settings') {
    const { url } = await startSettings({ cfg })
    console.log(`${c.brand('♥')} HeartCode settings: ${url}\n${c.dim('opened in your browser · Ctrl+C to stop')}`)
    openBrowser(url)
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
    const makeApp = (root, ui, mcp) => new App(mcp ? { ...cfg, mcp: { extra: [mcp] } } : cfg, ui, root)
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
      ui.onPermission = (mode) => {
        if (mode === 'plan') return // for this session only: HeartCode doesn't start in plan mode
        cfg.permissions = mode
        saveConfig(cfg)
      }
    }
    ui.showThinking = !f['hide-thinking']
    const app = new App(cfg, ui, root)
    usePromptsFrom(app.root) // its .heartcode/prompts override the built-in sections
    ui.suggest = (line, cursor) => app.suggest(line, cursor)
    ui.status = () => app.status()
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
  // The full screen: in tabs (the first one is this folder; /tab and Ctrl+T open more).
  if (!headless && !sub && !positionals.length && process.stdin.isTTY && process.stdout.isTTY) {
    if (f['resume-id'] && !loadChat(f['resume-id'])) throw new Error(`no session ${f['resume-id']}`)
    const saved = readJson(TABS_FILE, {})[root] // before this run's first tab replaces it
    const asked = f.continue || f.resume || f['resume-id'] || f['session-id'] // a session was chosen already
    const tabs = new Tabs((tab, o) => {
      const app = newApp(o.first ? cfg : { ...cfg }, o.root, tab)
      Object.assign(tab, { app, ui: app.ui })
      Object.assign(app.ui, tab.hooks)
      Object.assign(app, { tabs, tab, worktree: o.wt ?? null })
      if (o.first) {
        if (f['no-memory']) app.memory = null
        if (f['session-id']) app.setChat(loadChat(f['session-id']) ?? { ...newChat(app.root), id: f['session-id'] })
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
  if (sub === 'probe') {
    cfg.force = true
    const s = await app.session()
    if (s) ui.print(describe(s.profile, s.strat))
    ui.close()
    process.exitCode = s ? 0 : 1
    return
  }
  if (f['no-memory']) app.memory = null
  const chat = f['resume-id'] ? loadChat(f['resume-id']) : f.continue && headless ? listChats(app.root)[0] : f['session-id'] ? (loadChat(f['session-id']) ?? { ...newChat(app.root), id: f['session-id'] }) : null
  if (f['resume-id'] && !chat) throw new Error(`no session ${f['resume-id']}`)
  if (chat && (headless || !f['resume-id'])) app.setChat(chat) // interactive: resumed below, with its transcript
  if (headless) {
    app.allowTools = [...(f.allowedTools ?? []), ...(f['allowed-tools'] ?? [])]
    app.denyTools = [...(f.disallowedTools ?? []), ...(f['disallowed-tools'] ?? [])]
    const code = await runHeadless(app, { prompt: positionals.join(' '), input: f['input-format'], output: f['output-format'], appendSystem: f['append-system-prompt'] })
    if (wt && worktreeState(wt).empty) removeWorktree(wt) // else kept, for the caller to merge (its path is in the log)
    process.exit(code) // MCP servers are stopped by the exit hooks
  }
  if (positionals.length) {
    const ok = await runTask(app, positionals.join(' '))
    ui.close()
    await leaveWorktree(app)
    process.exit(ok ? 0 : 1) // MCP servers are stopped by the exit hooks
  }
  watchSettings(() => [app], cfg)
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
