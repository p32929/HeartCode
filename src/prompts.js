// Every text HeartCode sends to a model is a section of a markdown file in prompts/ (agent.md,
// guided.md, compact.md, probe.md). prompt('guided/next-action') is the "## next-action" section of
// guided.md. The user's own sections override the built-in ones, by name:
//   ~/.heart/prompts/<file>.md          for every project
//   <project>/.heartcode/prompts/<file>.md   for one project
// In a section:
//   {{name}}                              filled in from `vars`; a missing one is an error
//   {{#if name}} … {{else}} … {{/if}}     optional parts (else is optional)
//   <!-- … -->                             a note right under the heading; never sent
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME } from './config.js'

const BUILTIN = fileURLToPath(new URL('../prompts/', import.meta.url))
let project = null
const cache = new Map()

// The project whose .heartcode/prompts and HEARTCODE.md apply.
export function usePromptsFrom(root) {
  project = root
  cache.clear()
}

// After the user's sections changed (the settings page): read again, from the next message.
export const reloadPrompts = () => cache.clear()
export const BUILTIN_PROMPTS = BUILTIN

// "## name" sections of a markdown file (text before the first heading is the file's own notes).
export function sections(text) {
  const out = new Map()
  let name = null
  let lines = []
  const flush = () => name && out.set(name, lines.join('\n').replace(/^\s*<!--[\s\S]*?-->\s*/, '').replace(/^\s+|\s+$/g, ''))
  for (const line of text.split('\n')) {
    const h = /^## (\S+)\s*$/.exec(line)
    if (h) {
      flush()
      ;[name, lines] = [h[1], []]
    } else if (name) lines.push(line)
  }
  flush()
  return out
}

function load(file) {
  if (!cache.has(file)) {
    const merged = new Map()
    for (const dir of [BUILTIN, path.join(HOME, 'prompts'), project && path.join(project, '.heartcode', 'prompts')]) {
      if (!dir) continue
      try {
        for (const [k, v] of sections(fs.readFileSync(path.join(dir, `${file}.md`), 'utf8'))) merged.set(k, v)
      } catch {}
    }
    cache.set(file, merged)
  }
  return cache.get(file)
}

export function prompt(id, vars = {}) {
  const i = id.indexOf('/')
  const text = load(id.slice(0, i)).get(id.slice(i + 1))
  if (text === undefined) throw new Error(`no prompt "${id}" (a "## ${id.slice(i + 1)}" section in prompts/${id.slice(0, i)}.md)`)
  return text
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (m, k, yes, no = '') => (vars[k] ? yes : no))
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
      if (!(k in vars)) throw new Error(`prompt "${id}" needs {{${k}}}`)
      return String(vars[k])
    })
}

// The user's standing instructions: ~/.heart/HEARTCODE.md, then the project's own file. The project's
// is HEARTCODE.md, or else the first other tool's file found (so a project set up for another CLI
// works as is). Only one, so the same rules never cost twice. '' when there are none.
export const INSTRUCTION_FILES = ['HEARTCODE.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursorrules']

export function userInstructions(root = project) {
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8').trim()
    } catch {
      return ''
    }
  }
  let local = ''
  for (const f of root ? INSTRUCTION_FILES : []) if ((local = read(path.join(root, f)))) break
  if (!local && root) local = cursorRules(root)
  return [read(path.join(HOME, 'HEARTCODE.md')), local].filter(Boolean).join('\n\n')
}

// Cursor's .cursor/rules/*.mdc: the ones marked "alwaysApply: true", without their front matter.
function cursorRules(root) {
  const dir = path.join(root, '.cursor', 'rules')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => /\.mdc?$/.test(f)).sort()
  } catch {}
  return files
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .map((t) => /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(t))
    .filter((m) => m && /^alwaysApply:\s*true/m.test(m[1]))
    .map((m) => m[2].trim())
    .join('\n\n')
}
