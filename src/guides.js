// Guides for kinds of work (prompts/guides.md): web, api, mobile, desktop, cli, automation, long-task,
// game, data, library, extension, devops, database, upgrade. Easy to find two ways:
//   - the guide tool, always there: its description lists each guide and when it's for;
//   - HeartCode adds the right one itself, once per conversation, with the first tool result of a
//     message whose words or project files show the kind of work (detect), so a model that doesn't
//     think of the tool still gets it. At most two at a time: the message's kind first, then the project's.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prompt } from './prompts.js'

// name → when it's for (the tool's list) and the words in a message that mean it
export const GUIDES = {
  web: ['web sites and web apps, front ends, pages', /\b(web ?site|web ?app|web ?page|landing page|front-?end|react|vue|svelte|next\.?js|angular|tailwind)\b/i],
  api: ['back ends, HTTP APIs, servers, webhooks', /\b(api|apis|endpoints?|back-?end|rest api|graphql|webhooks?|express|fastapi|flask|django)\b/i],
  mobile: ['mobile apps: Flutter, React Native, Android, iOS', /\b(mobile|android|ios|iphone|flutter|react native|expo|swiftui|kotlin)\b/i],
  desktop: ['desktop apps: Electron, Tauri, native GUIs', /\b(desktop|electron|tauri|gui|window app|menu ?bar app|tray app)\b/i],
  cli: ['command-line tools and terminal programs', /\b(cli|command[- ]line|terminal (tool|app)|shell script)\b/i],
  automation: ['scripts, bots, scraping, scheduled and unattended jobs', /\b(automat\w*|scrap(e|er|ing)|crawl\w*|bots?|cron|scheduled?|every (day|hour|morning|week|night))\b/i],
  'long-task': ['big or long work: many parts or files, rewrites, migrations, hours of work', /\b(whole (project|app|codebase)|entire (project|app|codebase)|from scratch|rewrite|overnight|all (the )?(files|pages|modules))\b/i],
  game: ['games: browser (canvas) and engines', /\b(game|games|phaser|canvas|unity|godot|pygame|platformer|arcade)\b/i],
  data: ['data: CSV/JSON/Excel, analysis, charts, notebooks, machine learning', /\b(csv|excel|xlsx|dataset|data ?frame|pandas|charts?|notebook|jupyter|data analysis|machine learning|train(ing)? a model)\b/i],
  library: ['libraries and packages for others: npm, PyPI, crates, SDKs', /\b((write|make|build|create|publish) (a|an|my|the) (library|package|sdk)|npm publish|pypi|crates\.io)\b/i],
  extension: ['browser and editor extensions (Chrome, Firefox, VS Code)', /\b((browser|chrome|firefox|edge|vs ?code|editor) (extension|add-?on|plugin))\b/i],
  devops: ['Docker, CI, deploying, servers config', /\b(docker\w*|deploy\w*|ci\/cd|github actions|kubernetes|k8s|nginx|vps)\b/i],
  database: ['databases: schemas, migrations, queries, ORMs', /\b(database|sql|sqlite|postgres\w*|mysql|mongo\w*|migrations?|prisma|orm)\b/i],
  upgrade: ['upgrades and refactors: new versions, moving to another library, restructuring', /\b(upgrade|migrate to|refactor\w*|update (to|the) (version|latest)|port (it )?to)\b/i],
}
export const GUIDE_NAMES = Object.keys(GUIDES)

// The tool's list: "web: web sites and web apps…", one a line
export const guideList = () => GUIDE_NAMES.map((n) => `${n}: ${GUIDES[n][0]}`).join('\n')

// What a guide (or one of agent.md's guide-*) may use: the browser check's command, a memory tool, nobody to ask
const BIN = fileURLToPath(new URL('../bin/heartcode.js', import.meta.url))
export const guideVars = (s) => ({ memory: Boolean(s.memory) && !s.isSub, noUser: Boolean(s.ui?.noUser || s.isSub), page: `"${process.execPath}" "${BIN}" page` })
export const guideText = (s, name) => prompt(`guides/${name}`, guideVars(s))

// What kind of project the folder is, from its files: a guide name or null
function projectKind(root) {
  const has = (f) => fs.existsSync(path.join(root, f))
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const dep = (...names) => names.some((n) => n in deps)
  let py = ''
  for (const f of ['requirements.txt', 'pyproject.toml']) {
    try {
      py += fs.readFileSync(path.join(root, f), 'utf8')
    } catch {}
  }
  if (has('pubspec.yaml') || dep('react-native', 'expo') || (has('android') && has('ios'))) return 'mobile'
  if (has('src-tauri') || has('tauri.conf.json') || dep('electron')) return 'desktop'
  if (pkg.engines?.vscode || (has('manifest.json') && /"manifest_version"/.test(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')))) return 'extension'
  if (dep('phaser', 'pixi.js', 'three', 'kaboom') || has('project.godot')) return 'game'
  if (dep('react', 'vue', 'svelte', 'next', 'nuxt', 'vite', 'astro', '@angular/core', 'solid-js') || has('index.html')) return 'web'
  if (dep('express', 'fastify', 'koa', 'hono', '@nestjs/core') || /\b(flask|fastapi|django)\b/i.test(py)) return 'api'
  if (/\b(pandas|numpy|scikit-learn|torch|jupyter)\b/i.test(py) || fs.readdirSync(root).some((f) => f.endsWith('.ipynb'))) return 'data'
  if (pkg.bin) return 'cli'
  return null
}

// The guides for a message in this folder (at most two): the kinds its words name, else the project's
export function detect(root, task) {
  const said = GUIDE_NAMES.filter((n) => GUIDES[n][1].test(String(task ?? '')))
  let kind = null
  try {
    kind = projectKind(root)
  } catch {}
  return [...new Set([...said, ...(kind ? [kind] : [])])].slice(0, 2)
}
