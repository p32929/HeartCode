// /import: finds what other coding CLIs have set up (commands, skills, MCP servers, instructions,
// memory) and copies what the user picks into HeartCode's places, converted. Nothing is used from
// the other tools until it's imported, so their setups never cost tokens by surprise; nothing that
// already exists in HeartCode is overwritten. A duplicate (the same name, the same text, the same
// server) is told in the picker (dup) and added only when the user says so, under a free name.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { HOME, TEMP, readJson, writeJson } from './config.js'
import { frontMatter } from './skills.js'
import { Memory } from './memory.js'
import { fetch } from './http.js' // not the built-in one: see http.js

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
// --temp: the throwaway folder, never the project (nothing is kept from a --temp run)
const skillsDir = (root, scope) => (scope === 'global' || TEMP ? path.join(HOME, 'skills') : path.join(root, '.heartcode', 'skills'))
const taken = (root, scope, name) => exists(path.join(skillsDir(root, scope), `${name}.md`)) || exists(path.join(skillsDir(root, scope), name))
// name, else name-2, name-3…: the first not taken
const freeName = (isTaken, name) => {
  let n = name
  for (let i = 2; isTaken(n); i++) n = `${name}-${i}`
  return n
}
const same = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
// The skills there are (one file, or a folder with SKILL.md): [name, body]
function skillBodies(root, scope) {
  const dir = skillsDir(root, scope)
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {}
  return entries.flatMap((e) => {
    const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.name.endsWith('.md') ? path.join(dir, e.name) : null
    if (!file || !exists(file)) return []
    return [[e.name.replace(/\.md$/, ''), frontMatter(fs.readFileSync(file, 'utf8')).body]]
  })
}
// Why a skill or command would be a duplicate there, or ''
function skillDup(root, scope, name, body) {
  if (taken(root, scope, name)) return `a skill named ${name} is already there`
  const twin = skillBodies(root, scope).find(([, b]) => same(b, body))
  return twin ? `the same as the skill ${twin[0]}` : ''
}

// A markdown command (Claude Code, Codex, OpenCode) → a HeartCode skill you type ("use: me").
function importCommand(root, scope, name, file) {
  name = freeName((n) => taken(root, scope, n), name)
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
  name = freeName((n) => taken(root, scope, n), name)
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
  name = freeName((n) => taken(root, scope, n), name)
  fs.cpSync(dir, path.join(skillsDir(root, scope), name), { recursive: true })
  return name
}

const mcpFile = (root, scope) => (scope === 'global' || TEMP ? path.join(HOME, 'mcp.json') : path.join(root, '.heartcode', 'mcp.json'))
const serverKey = (cfg) => (cfg.command ? [cfg.command, ...(cfg.args ?? [])].join(' ') : (cfg.url ?? cfg.httpUrl ?? ''))
// Why an MCP server would be a duplicate there, or ''
function mcpDup(root, scope, name, cfg) {
  const have = readJson(mcpFile(root, scope), {}).mcpServers ?? {}
  if (have[name]) return `an MCP server named ${name} is already there`
  const twin = Object.entries(have).find(([, c]) => serverKey(c) === serverKey(cfg))
  return twin ? `the same server as ${twin[0]}` : ''
}

function importMcp(root, scope, name, cfg) {
  const file = mcpFile(root, scope)
  const data = readJson(file, {})
  data.mcpServers ??= {}
  name = freeName((n) => data.mcpServers[n], name)
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
  // dup(): why it would be a duplicate (asked when it runs: an earlier pick may have just added it)
  const add = (group, label, desc, run, dup) => items.push({ group, label, desc, run, dup })
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
      add(`${tool} · ${scope === 'global' ? 'global' : 'this project'} · commands`, `/${name}`, (meta.description || body.split('\n')[0]).slice(0, 90), () => importCommand(root, scope, name, file), () => skillDup(root, scope, name, body))
    }
  }
  for (const [scope, dir] of [['project', path.join(root, '.gemini', 'commands')], ['global', path.join(home, '.gemini', 'commands')]]) {
    for (const [rel, file] of filesIn(dir, ['.toml'])) {
      const name = safe(rel)
      add(`Gemini CLI · ${scope === 'global' ? 'global' : 'this project'} · commands`, `/${name}`, /^description\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '', () => importToml(root, scope, name, file), () => (taken(root, scope, name) ? `a skill named ${name} is already there` : ''))
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
      const { meta, body } = frontMatter(fs.readFileSync(file, 'utf8'))
      add(`${tool} · ${scope === 'global' ? 'global' : 'this project'} · skills`, safe(e.name), (meta.description ?? '').slice(0, 90), () => importSkillFolder(root, scope, safe(e.name), path.join(dir, e.name)), () => skillDup(root, scope, safe(e.name), body))
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
      add(`${tool} · ${scope === 'global' ? 'global' : 'this project'} · MCP servers`, name, (cfg.command ? `${cfg.command} ${(cfg.args ?? []).join(' ')}` : (cfg.url ?? cfg.httpUrl)).slice(0, 90), () => importMcp(root, scope, name, cfg), () => mcpDup(root, scope, name, cfg))
    }
  }
  for (const [tool, file] of [['Claude Code', path.join(home, '.claude', 'CLAUDE.md')], ['Codex', path.join(home, '.codex', 'AGENTS.md')], ['Gemini CLI', path.join(home, '.gemini', 'GEMINI.md')]]) {
    if (exists(file)) add(`${tool} · global · instructions`, path.basename(file), `${tool} instructions → ~/.heart/HEARTCODE.md`, () => importInstructions(file, tool))
  }
  const claudeMemory = path.join(home, '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
  const notes = filesIn(claudeMemory, ['.md']).filter(([n]) => n !== 'MEMORY')
  if (notes.length) add('Claude Code · this project · memory', `${notes.length} memory notes`, 'become HeartCode memory notes for this project', () => importClaudeMemory(root, claudeMemory))
  return items
}

// Install a skill straight from a GitHub repo or a URL — not another CLI's config. Accepts
// "user/repo", a github repo URL, a .git URL, or a direct link to a SKILL.md / <name>.md (a
// one-file skill). Clones (git) or downloads a tarball, finds every SKILL.md, and copies each skill
// folder into the skills dir (global by default). Returns a short summary; nothing existing is
// overwritten. scope: "global" (~/.heart/skills) or "project" (.heartcode/skills).
export async function installSkill(root, source, scope = 'global', { signal } = {}) {
  source = String(source ?? '').trim()
  if (!source) throw new Error('give a GitHub repo (user/repo or its URL) or a link to a SKILL.md')
  const dest = skillsDir(root, scope)
  fs.mkdirSync(dest, { recursive: true })

  // a single .md file → a one-file skill
  if (/^https?:\/\/\S+\.md(\?\S*)?$/i.test(source)) {
    const res = await fetch(source, { signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`could not download: HTTP ${res.status}`)
    const text = await res.text()
    const { meta } = frontMatter(text)
    if (!meta.description) throw new Error('that .md is not a skill (it needs YAML frontmatter with a description)')
    const name = safe(meta.name || source.split('/').pop().replace(/\.md.*$/i, '')) || 'skill'
    if (taken(root, scope, name)) return `${name} is already installed`
    fs.writeFileSync(path.join(dest, `${name}.md`), text)
    return `installed skill ${name}`
  }

  // otherwise a repo
  const { gitUrl, tarUrl } = repoUrls(source)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-skill-'))
  try {
    await fetchRepo(gitUrl, tarUrl, tmp, signal)
    const found = findSkillFolders(tmp)
    if (!found.length) throw new Error('no SKILL.md found in that repo')
    const done = []
    for (const { name, dir } of found) {
      if (taken(root, scope, name)) {
        done.push(`${name} (already installed)`)
        continue
      }
      fs.cpSync(dir, path.join(dest, name), { recursive: true, filter: (s) => !/[/\\]\.git([/\\]|$)/.test(s) })
      done.push(name)
    }
    return `installed ${done.filter((d) => !d.includes('already')).length} of ${found.length} skill${found.length === 1 ? '' : 's'}: ${done.join(', ')}`
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// "user/repo" or a github link → a clone URL and a codeload tarball URL (for when git isn't around).
function repoUrls(source) {
  let m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(source)
  if (!m && /^[\w.-]+\/[\w.-]+$/.test(source)) m = [, ...source.split('/')]
  if (m) return { gitUrl: `https://github.com/${m[1]}/${m[2]}.git`, tarUrl: `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/HEAD` }
  if (/^https?:\/\/\S+/.test(source) || /\.git$/.test(source)) return { gitUrl: source.replace(/\/$/, ''), tarUrl: null }
  throw new Error(`can't tell what "${source}" is — give a GitHub repo (user/repo or its URL) or a link to a SKILL.md`)
}

// Shallow git clone, or download and extract the tarball if git isn't installed.
async function fetchRepo(gitUrl, tarUrl, into, signal) {
  const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  if (hasGit) {
    const r = spawnSync('git', ['clone', '--depth', '1', gitUrl, into], { encoding: 'utf8', timeout: 120_000 })
    if (r.status === 0) return
    if (!tarUrl) throw new Error(`git clone failed: ${(r.stderr || '').trim().slice(0, 200)}`)
  } else if (!tarUrl) {
    throw new Error('git is not installed; install git, or give a GitHub repo so the tarball can be downloaded')
  }
  const res = await fetch(tarUrl, { signal, redirect: 'follow' })
  if (!res.ok) throw new Error(`could not download the repo: HTTP ${res.status}`)
  fs.writeFileSync(path.join(into, '_repo.tgz'), Buffer.from(await res.arrayBuffer()))
  const r = spawnSync('tar', ['-xzf', '_repo.tgz', '--strip-components=1'], { cwd: into, encoding: 'utf8' })
  fs.rmSync(path.join(into, '_repo.tgz'), { force: true })
  if (r.status !== 0) throw new Error(`could not extract the repo: ${(r.stderr || '').trim().slice(0, 200)}`)
}

// Every SKILL.md in the tree (depth-limited) as { name, dir }; doesn't descend into a skill folder.
// A skill at the repo root is named from its frontmatter; a nested one from its folder.
function findSkillFolders(base, depth = 4) {
  const out = []
  const walk = (d, left) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const { meta } = frontMatter(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'))
      const name = safe((d === base ? meta.name : path.basename(d)) || meta.name || path.basename(d)) || 'skill'
      out.push({ name, dir: d })
      if (left > 0 && entries.some((e) => e.isDirectory() && e.name === 'skills')) walk(path.join(d, 'skills'), left - 1) // a repo that's one skill plus a skills/ collection
      return
    }
    if (left <= 0) return
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(d, e.name), left - 1)
  }
  walk(base, depth)
  return out
}
