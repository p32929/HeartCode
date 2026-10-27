// Permission rules: what runs without asking, what always asks, what never runs, per tool and
// argument, whatever the permission mode. In ~/.heart/permissions.json and
// .heartcode/permissions.json (both; Claude Code's format and tool names work too):
//   { "allow": ["run_command(npm test*)", "Bash(git status:*)", "web_fetch(domain:nodejs.org)"],
//     "ask":   ["run_command(git push*)"],
//     "deny":  ["run_command(rm -rf*)", "edit_file(.env)", "read_file(secrets/**)", "mcp__github"] }
// A rule is a tool name, alone (every use) or with a pattern in brackets: for commands, the
// command (`*` is anything; "npm test:*" as in Claude Code); for files, the path in the project
// (`*` within a folder, `**` across folders); for web_fetch, the URL or domain:host; for
// web_search, the query; for MCP, mcp__server or mcp__server__tool. Deny beats ask beats allow.
// A command with several parts (&&, ||, ;, |) is allowed only when every part is; denied when any is.
import path from 'node:path'
import { HOME, readJson } from './config.js'
import { CLAUDE_NAMES } from './hooks.js'

const FROM_CLAUDE = { ...Object.fromEntries(Object.entries(CLAUDE_NAMES).map(([h, cl]) => [cl, h])), MultiEdit: 'edit_file', LS: 'list_files' }
const FILE_TOOLS = new Set(['read_file', 'edit_file', 'write_file', 'append_file'])
export const KINDS = ['deny', 'ask', 'allow']

export const ruleFiles = (root) => [path.join(HOME, 'permissions.json'), path.join(root, '.heartcode', 'permissions.json')]

const glob = (pattern, files) =>
  new RegExp(
    '^' +
      pattern
        .replace(/:\*$/, '*')
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?|\*/g, (m) => (!files ? '.*' : m === '*' ? '[^/]*' : '(?:.*/)?'))
        .replace(/\(\?:\.\*\/\)\?$/, '.*') +
      '$',
  )

// "Bash(npm test:*)" → { tool: 'run_command', pattern: 'npm test:*' }
export function parseRule(text) {
  const m = /^\s*([\w-]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(String(text))
  if (!m) return null
  let [, tool, pattern] = m
  if (tool.startsWith('mcp__')) {
    const [server, t] = tool.slice(5).split('__')
    return { tool: 'mcp', pattern: `${server}__${t ?? '*'}`, text }
  }
  return { tool: FROM_CLAUDE[tool] ?? tool, pattern: pattern?.trim() || null, text }
}

export function loadRules(root, extra = {}) {
  const out = { deny: [], ask: [], allow: [] }
  for (const data of [...ruleFiles(root).map((f) => readJson(f, {})), extra]) {
    const p = data.permissions ?? data // Claude Code's settings.json nests them
    for (const kind of KINDS) out[kind].push(...[p[kind] ?? []].flat().map(parseRule).filter(Boolean))
  }
  return out
}

const parts = (cmd) => String(cmd).split(/\s*(?:&&|\|\||;|\||\n)\s*/).map((x) => x.trim()).filter(Boolean)

function matches(rule, name, args, root) {
  if (rule.tool !== name && !(rule.tool === 'write_file' && name === 'append_file')) return false
  if (!rule.pattern) return true
  const p = rule.pattern
  if (name === 'run_command') return (cmd) => glob(p, false).test(cmd) // per part, below
  if (FILE_TOOLS.has(name)) {
    const rel = path.relative(root, path.resolve(root, String(args.path ?? ''))).split(path.sep).join('/')
    return glob(p.replace(/^\.\//, ''), true).test(rel)
  }
  if (name === 'web_fetch') {
    const url = String(args.url ?? '')
    if (p.startsWith('domain:')) {
      const host = (() => {
        try {
          return new URL(/^\w+:\/\//.test(url) ? url : `https://${url}`).hostname
        } catch {
          return ''
        }
      })()
      const d = p.slice(7).toLowerCase()
      return host === d || host.endsWith(`.${d}`)
    }
    return glob(p, false).test(url)
  }
  if (name === 'mcp') return glob(p, false).test(`${args.server}__${args.tool}`)
  return glob(p, false).test(String(args.query ?? args.name ?? args.url ?? ''))
}

// 'deny' | 'ask' | 'allow' | null (no rule: the permission mode decides), and the rule.
export function check(rules, name, args, root) {
  if (!rules) return { kind: null }
  const hit = (kind) => rules[kind].map((r) => [r, matches(r, name, args, root)]).filter(([, m]) => m)
  if (name === 'run_command') {
    const cmd = parts(args.command ?? '')
    for (const kind of ['deny', 'ask']) {
      const r = hit(kind).find(([, m]) => m === true || cmd.some((part) => m(part)))
      if (r) return { kind, rule: r[0].text }
    }
    const allow = hit('allow')
    const ok = cmd.length && cmd.every((part) => allow.some(([, m]) => m === true || m(part)))
    return ok ? { kind: 'allow', rule: allow[0][0].text } : { kind: null }
  }
  for (const kind of KINDS) {
    const r = hit(kind)[0]
    if (r) return { kind, rule: r[0].text }
  }
  return { kind: null }
}
