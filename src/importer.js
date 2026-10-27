// /import: finds what other coding CLIs have set up (commands, skills, MCP servers, instructions,
// memory) and copies what the user picks into HeartCode's places, converted. Nothing is used from
// the other tools until it's imported, so their setups never cost tokens by surprise; nothing that
// already exists in HeartCode is overwritten.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'
import { frontMatter } from './skills.js'
import { Memory } from './memory.js'

const exists = (p) => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

// Every file under dir with one of the extensions: [relative name without extension, full path]
function filesIn(dir, exts) {
  const out = []
  const walk = (d, prefix) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {}
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}-`)
      else if (exts.some((x) => e.name.endsWith(x))) out.push([`${prefix}${e.name.replace(/\.[^.]+$/, '')}`, path.join(d, e.name)])
    }
  }
  walk(dir, '')
  return out
}

const safe = (n) => String(n).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
const skillsDir = (root, scope) => (scope === 'global' ? path.join(HOME, 'skills') : path.join(root, '.heartcode', 'skills'))
const taken = (root, scope, name) => exists(path.join(skillsDir(root, scope), `${name}.md`)) || exists(path.join(skillsDir(root, scope), name))

// A markdown command (Claude Code, Codex, OpenCode) → a HeartCode skill you type ("use: me").
function importCommand(root, scope, name, file) {
  if (taken(root, scope, name)) return `/${name} already exists, kept it`
  const { meta, body } = frontMatter(fs.readFileSync(file, 'utf8'))
  const head = [`description: ${(meta.description || body.split('\n')[0]).replace(/\n/g, ' ').slice(0, 200)}`, `use: ${meta['user-invocable'] === 'false' ? 'model' : 'me'}`]
  if (meta['argument-hint']) head.push(`argument-hint: ${meta['argument-hint']}`)
  fs.mkdirSync(skillsDir(root, scope), { recursive: true })
  fs.writeFileSync(path.join(skillsDir(root, scope), `${name}.md`), `---\n${head.join('\n')}\n---\n\n${body}\n`)
  return `/${name}`
}

// A Gemini CLI command (.toml with prompt and description) → a HeartCode skill. {{args}} stays as
// is (it's HeartCode's too); !{cmd} becomes !`cmd`.
function importToml(root, scope, name, file) {
  if (taken(root, scope, name)) return `/${name} already exists, kept it`
  const text = fs.readFileSync(file, 'utf8')
  const str = (key) => {
    const m = new RegExp(`^${key}\\s*=\\s*(?:"""([\\s\\S]*?)"""|'''([\\s\\S]*?)'''|"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, 'm').exec(text)
    return m ? (m[1] ?? m[2] ?? m[3]?.replace(/\\n/g, '\n').replace(/\\"/g, '"') ?? m[4]) : ''
  }
  const prompt = str('prompt').trim().replace(/!\{([^}]*)\}/g, '!`$1`')
  if (!prompt) return `${name}: no prompt in it, skipped`
  fs.mkdirSync(skillsDir(root, scope), { recursive: true })
  fs.writeFileSync(path.join(skillsDir(root, scope), `${name}.md`), `---\ndescription: ${(str('description') || prompt.split('\n')[0]).slice(0, 200)}\nuse: me\n---\n\n${prompt}\n`)
  return `/${name}`
}

// A skill folder (Claude Code, Codex): copied as is, supporting files included.
function importSkillFolder(root, scope, name, dir) {
  if (taken(root, scope, name)) return `${name} already exists, kept it`
  fs.cpSync(dir, path.join(skillsDir(root, scope), name), { recursive: true })
  return name
}

function importMcp(root, scope, name, cfg) {
  const file = scope === 'global' ? path.join(HOME, 'mcp.json') : path.join(root, '.heartcode', 'mcp.json')
  const data = readJson(file, {})
  data.mcpServers ??= {}
  if (data.mcpServers[name]) return `MCP server ${name} already exists, kept it`
  const { command, args, env, url, httpUrl, headers, type } = cfg
  data.mcpServers[name] = command
    ? { command, ...(args?.length && { args }), ...(env && Object.keys(env).length && { env }) }
    : { url: url ?? httpUrl, ...(headers && Object.keys(headers).length && { headers }), ...(type === 'sse' && { type }) } // Gemini CLI names it httpUrl
  writeJson(file, data)
  return `MCP server ${name}`
}

function importInstructions(file, from) {
  const target = path.join(HOME, 'HEARTCODE.md')
  const text = fs.readFileSync(file, 'utf8').trim()
  const now = exists(target) ? fs.readFileSync(target, 'utf8') : ''
  if (now.includes(text)) return `${from} instructions were already there`
  fs.mkdirSync(HOME, { recursive: true })
  fs.writeFileSync(target, `${now.trim() ? `${now.trim()}\n\n` : ''}<!-- from ${from}: ${file} -->\n${text}\n`)
  return `${from} instructions → ~/.heart/HEARTCODE.md`
}

// Claude Code's memory for this project: its notes become HeartCode notes (tags from the name;
// /tidy_memory can refine them and move general ones to the global memory).
function importClaudeMemory(root, dir) {
  const memory = new Memory(root)
  let n = 0
  for (const [name, file] of filesIn(dir, ['.md'])) {
    if (name === 'MEMORY') continue
    const { meta, body } = frontMatter(fs.readFileSync(file, 'utf8'))
    if (memory.read(meta.name || name)) continue
    const type = /^\s*type:\s*(\w+)/m.exec(fs.readFileSync(file, 'utf8'))?.[1]
    const tags = String(meta.name || name).split(/[-_\s]+/).filter((w) => w.length > 2).slice(0, 2)
    memory.write({ name: meta.name || name, description: meta.description, type: type === 'user' || type === 'feedback' || type === 'reference' ? type : 'project', tags, content: body })
    n++
  }
  return `${n} memory note${n === 1 ? '' : 's'} from Claude Code`
}

// Codex keeps MCP servers in TOML: [mcp_servers.name] with command, args and env.
function codexServers(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  for (const m of text.matchAll(/^\[mcp_servers\.("?)([^\]"]+)\1\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) {
    const block = m[3]
    const command = /^command\s*=\s*"([^"]*)"/m.exec(block)?.[1]
    const args = [...(/^args\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((a) => a[1])
    const env = Object.fromEntries([...(/^env\s*=\s*\{([^}]*)\}/m.exec(block)?.[1] ?? '').matchAll(/"?([\w.-]+)"?\s*=\s*"([^"]*)"/g)].map((e) => [e[1], e[2]]))
    if (command) out[m[2]] = { command, args, env }
  }
  return out
}

// Everything importable, as picker items: { label, desc, group, run() → what was done }.
export function findImports(root, home = os.homedir()) {
  const items = []
  const add = (group, label, desc, run) => items.push({ group, label, desc, run })
  const commandSources = [
    ['Claude Code', 'project', path.join(root, '.claude', 'commands')],
    ['Claude Code', 'global', path.join(home, '.claude', 'commands')],
    ['Codex', 'global', path.join(home, '.codex', 'prompts')],
    ['OpenCode', 'project', path.join(root, '.opencode', 'commands')],
    ['OpenCode', 'project', path.join(root, '.opencode', 'command')],
    ['OpenCode', 'global', path.join(home, '.config', 'opencode', 'commands')],
    ['OpenCode', 'global', path.join(home, '.config', 'opencode', 'command')],
  ]
  for (const [tool, scope, dir] of commandSources) {
    for (const [rel, file] of filesIn(dir, ['.md'])) {
      const name = safe(rel)
      const { meta, body } = frontMatter(fs.readFileSync(file, 'utf8'))
      add(`${tool} · ${scope === 'global' ? 'yours' : 'this project'} · commands`, `/${name}`, (meta.description || body.split('\n')[0]).slice(0, 90), () => importCommand(root, scope, name, file))
    }
  }
  for (const [scope, dir] of [['project', path.join(root, '.gemini', 'commands')], ['global', path.join(home, '.gemini', 'commands')]]) {
    for (const [rel, file] of filesIn(dir, ['.toml'])) {
      const name = safe(rel)
      add(`Gemini CLI · ${scope === 'global' ? 'yours' : 'this project'} · commands`, `/${name}`, /^description\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '', () => importToml(root, scope, name, file))
    }
  }
  const skillSources = [
    ['Claude Code', 'project', path.join(root, '.claude', 'skills')],
    ['Claude Code', 'global', path.join(home, '.claude', 'skills')],
    ['Codex', 'global', path.join(home, '.codex', 'skills')],
  ]
  for (const [tool, scope, dir] of skillSources) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {}
    for (const e of entries) {
      const file = path.join(dir, e.name, 'SKILL.md')
      if (!e.isDirectory() || !exists(file)) continue
      const { meta } = frontMatter(fs.readFileSync(file, 'utf8'))
      add(`${tool} · ${scope === 'global' ? 'yours' : 'this project'} · skills`, safe(e.name), (meta.description ?? '').slice(0, 90), () => importSkillFolder(root, scope, safe(e.name), path.join(dir, e.name)))
    }
  }
  const claudeJson = readJson(path.join(home, '.claude.json'), {})
  const mcpSources = [
    ['Claude Code', 'project', readJson(path.join(root, '.mcp.json'), {}).mcpServers],
    ['Claude Code', 'project', claudeJson.projects?.[root]?.mcpServers],
    ['Claude Code', 'global', claudeJson.mcpServers],
    ['Cursor', 'project', readJson(path.join(root, '.cursor', 'mcp.json'), {}).mcpServers],
    ['Cursor', 'global', readJson(path.join(home, '.cursor', 'mcp.json'), {}).mcpServers],
    ['Gemini CLI', 'project', readJson(path.join(root, '.gemini', 'settings.json'), {}).mcpServers],
    ['Gemini CLI', 'global', readJson(path.join(home, '.gemini', 'settings.json'), {}).mcpServers],
    ['Codex', 'global', codexServers(path.join(home, '.codex', 'config.toml'))],
  ]
  for (const [tool, scope, servers] of mcpSources) {
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      if (!cfg?.command && !cfg?.url && !cfg?.httpUrl) continue
      add(`${tool} · ${scope === 'global' ? 'yours' : 'this project'} · MCP servers`, name, (cfg.command ? `${cfg.command} ${(cfg.args ?? []).join(' ')}` : (cfg.url ?? cfg.httpUrl)).slice(0, 90), () => importMcp(root, scope, name, cfg))
    }
  }
  for (const [tool, file] of [['Claude Code', path.join(home, '.claude', 'CLAUDE.md')], ['Codex', path.join(home, '.codex', 'AGENTS.md')], ['Gemini CLI', path.join(home, '.gemini', 'GEMINI.md')]]) {
    if (exists(file)) add(`${tool} · yours · instructions`, path.basename(file), `your ${tool} instructions → ~/.heart/HEARTCODE.md`, () => importInstructions(file, tool))
  }
  const claudeMemory = path.join(home, '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
  const notes = filesIn(claudeMemory, ['.md']).filter(([n]) => n !== 'MEMORY')
  if (notes.length) add('Claude Code · this project · memory', `${notes.length} memory notes`, 'become HeartCode memory notes for this project', () => importClaudeMemory(root, claudeMemory))
  return items
}
