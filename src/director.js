// Director mode: the main chat can set HeartCode itself up (skills, MCP servers, settings) when
// asked in plain words, with one tool, manage. The settings page (General → Features) turns it off.
import fs from 'node:fs'
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'
import { log } from './log.js'
import { DEFAULT_SERVERS } from './mcp.js'
import { prompt } from './prompts.js'
import { frontMatter, loadSkills, skillDirs } from './skills.js'
import { c, diffLines, renderDiff } from './ui.js'

const KINDS = ['skill', 'mcp', 'setting']
const safeName = (n) => String(n ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')

export class Director {
  // app: { root, ui, cfg, reload(kind), applySetting(name, value), settings() }
  constructor(app) {
    this.app = app
  }

  toolDefs(s) {
    if (this.app.cfg.director === false) return []
    const str = { type: 'string' }
    const obj = (properties, required = []) => ({ type: 'object', properties, required })
    return [
      {
        name: 'manage',
        description: prompt('agent/tool-manage'),
        parameters: obj({ action: { type: 'string', enum: ['help', 'list', 'show', 'save', 'delete'] }, kind: { type: 'string', enum: KINDS }, name: str, scope: { type: 'string', enum: ['project', 'global'] }, content: str, config: { type: 'object' }, value: str }, ['action']),
      },
    ]
  }

  // A tool call for manage: its result, or undefined when the tool isn't manage.
  async tool(name, args, s) {
    return name === 'manage' ? this.manage(args, s) : undefined
  }

  // --- manage: skills, MCP servers and settings ---

  async manage(args, s) {
    const { app } = this
    const kind = args.kind
    const scope = args.scope === 'global' ? 'global' : 'project'
    const name = safeName(args.name)
    if (args.action === 'help') return prompt('agent/director-help', Object.fromEntries(['args', '1', '2'].map((k) => [k, `{{${k}}}`]))) // the formats show these holes as they are
    if (!KINDS.includes(kind)) return `error: kind must be one of ${KINDS.join(', ')}`
    if (kind === 'setting') {
      if (args.action === 'list' || args.action === 'show') return app.settings()
      if (args.action === 'save') return app.applySetting(String(args.name ?? ''), String(args.value ?? args.content ?? ''))
      return 'error: settings can be listed or saved'
    }
    if (args.action === 'list') return this.#list(kind)
    if (!name) return `error: give the ${kind}'s name`
    if (kind === 'mcp') return this.#mcp(args.action, name, scope, args.config ?? args.content, s)
    const dirs = skillDirs(app.root)
    const existing = loadSkills(app.root).get(name)
    const dir = dirs[scope === 'global' ? 0 : 1]
    // saving changes the existing file, unless a scope is given that it isn't in (then a new one there)
    const file = existing && (!args.scope || existing.file.startsWith(dir + path.sep)) ? existing.file : path.join(dir, `${name}.md`)
    if (args.action === 'show') return existing ? `${existing.file}\n\n${fs.readFileSync(existing.file, 'utf8')}` : `error: no ${kind} "${name}"`
    if (args.action === 'delete') {
      if (!existing) return `error: no ${kind} "${name}"`
      const ok = await s.ui.confirm(`Delete the ${kind} ${name} (${existing.file})?`, 'edit')
      if (ok !== true) return declined(ok)
      // a skill in its own folder (<name>/SKILL.md): that folder; never a skills folder itself
      const folder = path.dirname(existing.file)
      const isFolder = path.basename(existing.file) === 'SKILL.md' && !skillDirs(app.root).some((d) => path.resolve(d) === path.resolve(folder))
      fs.rmSync(isFolder ? folder : existing.file, { recursive: true, force: true })
      app.reload(kind)
      return `Deleted the ${kind} ${name}.`
    }
    if (args.action !== 'save') return 'error: action must be help, list, show, save or delete'
    const content = String(args.content ?? '').trim()
    if (!content) return `error: save needs content: the whole ${kind} file (front matter and text); manage help shows the format`
    if (!frontMatter(content).meta.description) return `error: the ${kind} needs "description:" in its front matter (between --- lines at the top); manage help shows the format`
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    s.ui.print(renderDiff(diffLines(old, content + '\n'), tilde(file)))
    const ok = await s.ui.confirm(`${old ? 'Update' : 'Save'} the ${kind} ${name}?`, 'edit')
    if (ok !== true) return declined(ok)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content + '\n')
    app.reload(kind)
    log('director', `saved ${kind} ${name}: ${file}`)
    const how = frontMatter(content).meta.use === 'model' ? '' : `The user can type it as /${name}.`
    return `Saved the ${kind} ${name} (${tilde(file)}). ${how}`.trim()
  }

  #list(kind) {
    const { app } = this
    if (kind === 'skill') {
      const all = [...loadSkills(app.root).values()]
      return all.length ? all.map((k) => `${k.name} (use: ${k.use}; ${k.file.startsWith(HOME) ? 'global' : 'project'}): ${k.description}`).join('\n') : 'no skills yet'
    }
    const servers = { ...DEFAULT_SERVERS }
    for (const f of mcpFiles(app.root)) Object.assign(servers, ...Object.entries(readJson(f.file, {}).mcpServers ?? {}).map(([n, cfg]) => ({ [n]: { ...servers[n], ...cfg, scope: f.scope } })))
    return Object.entries(servers).map(([n, cfg]) => `${n}${cfg.disabled ? ' (disabled)' : ''}${DEFAULT_SERVERS[n] ? ' (built in)' : ` (${cfg.scope})`}: ${cfg.description ?? ''} [${cfg.command} ${(cfg.args ?? []).join(' ')}]`).join('\n')
  }

  async #mcp(action, name, scope, config, s) {
    const files = mcpFiles(this.app.root)
    const where = files.find((f) => readJson(f.file, {}).mcpServers?.[name])
    if (action === 'show') {
      const cfg = where ? readJson(where.file, {}).mcpServers[name] : DEFAULT_SERVERS[name]
      return cfg ? JSON.stringify({ [name]: cfg }, null, 2) : `error: no MCP server "${name}"`
    }
    const file = (action === 'delete' && where ? where : files.find((f) => f.scope === scope)).file
    const data = readJson(file, {})
    data.mcpServers ??= {}
    if (action === 'delete') {
      if (!where && !DEFAULT_SERVERS[name]) return `error: no MCP server "${name}"`
      const ok = await s.ui.confirm(`${DEFAULT_SERVERS[name] ? 'Turn off' : 'Delete'} the MCP server ${name}?`, 'edit')
      if (ok !== true) return declined(ok)
      if (DEFAULT_SERVERS[name]) data.mcpServers[name] = { disabled: true } // built in: turned off, not gone
      else delete data.mcpServers[name]
      writeJson(file, data)
      this.app.reload('mcp')
      return `${DEFAULT_SERVERS[name] ? 'Turned off' : 'Deleted'} the MCP server ${name}.`
    }
    if (action !== 'save') return 'error: action must be help, list, show, save or delete'
    let cfg = config
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg)
      } catch {
        return 'error: config must be a JSON object like {"command": "npx", "args": ["-y", "some-mcp"]}'
      }
    }
    if (cfg?.mcpServers) cfg = cfg.mcpServers[name] ?? Object.values(cfg.mcpServers)[0] // pasted a whole mcp.json
    else if (cfg && !cfg.command && Object.keys(cfg).length === 1 && typeof Object.values(cfg)[0] === 'object') cfg = Object.values(cfg)[0] // { "name": { … } }
    // a program to run (command), or a server on the web (url)
    if (!cfg?.command && !cfg?.url && !(DEFAULT_SERVERS[name] && cfg)) return 'error: config needs "command" (and usually "args"), like {"command": "npx", "args": ["-y", "some-mcp"]}, or "url" for a remote server, like {"url": "https://example.com/mcp"}'
    const clean = Object.fromEntries(['command', 'args', 'env', 'url', 'headers', 'description', 'disabled'].filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]]))
    s.ui.print(`${c.bold(name)} ${c.faint(`→ ${tilde(file)}`)}\n  ${c.muted(JSON.stringify(clean))}`)
    const ok = await s.ui.confirm(clean.url && !clean.command ? `Save the MCP server ${name}? HeartCode will connect to ${clean.url}` : `Save the MCP server ${name}? HeartCode will run: ${clean.command ?? ''} ${(clean.args ?? []).join(' ')}`, 'command')
    if (ok !== true) return declined(ok)
    data.mcpServers[name] = { ...data.mcpServers[name], ...clean }
    writeJson(file, data)
    this.app.reload('mcp')
    return `Saved the MCP server ${name} (${tilde(file)}). Its tools are available through the mcp tool now.`
  }
}

const declined = (ok) => `The user declined.${typeof ok === 'string' ? ` User feedback: ${ok}` : ''}`
const tilde = (f) => (process.env.HOME && f.startsWith(process.env.HOME) ? '~' + f.slice(process.env.HOME.length) : f)
const mcpFiles = (root) => [{ scope: 'global', file: path.join(HOME, 'mcp.json') }, { scope: 'project', file: path.join(root, '.heartcode', 'mcp.json') }]
