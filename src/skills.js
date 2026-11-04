// Skills: reusable prompts that you can type as /name and/or the model can load when a task
// matches. One file (<name>.md) or a folder (<name>/SKILL.md, for extra files), in (HeartCode comes
// with none: you add or install them)
//   ~/.heart/skills/          for every project
//   .heartcode/skills/        for one project (wins on the same name)
//   ---
//   description: Review my changes before committing   (what the model sees; also in the / menu)
//   use: both          me (only typed: costs nothing until used) · model (only the model) · both
//                      · always (in every system prompt: how to work, not a task)
//   load: a.md, b.html  (a folder skill) its files that come with it when the model loads it, so a
//                      model that doesn't go on to read them still has them
//   A skill shared with other CLIs (the Agent Skills spec allows only name, description, license,
//   compatibility, metadata, allowed-tools) puts these under metadata: heartcode-use, heartcode-load.
//   ---
//   Review the uncommitted changes, focusing on {{args}}.
//   !`git diff HEAD`
// In the text: {{args}} (all arguments), {{1}} {{2}}… (one each; $ARGUMENTS and $1 work too, as in
// other CLIs), @path/to/file (its contents), !`command` (its output).
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './config.js'

export const USES = ['me', 'model', 'both', 'always']

export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const lines = (m?.[1] ?? '').replace(/\r/g, '').split('\n')
  const meta = {}
  const indent = (l) => l.length - l.trimStart().length
  for (let i = 0; i < lines.length; i++) {
    const key = /^([\w-]+):\s*(.*)$/.exec(lines[i])
    if (!key) continue
    const [, k, raw] = key
    const base = indent(lines[i])
    const block = /^([|>])([+-]?)\s*$/.exec(raw) // a YAML block scalar: | literal, > folded (Claude Code, others use "description: >-")
    if (block) {
      const kept = []
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indent(lines[i + 1]) > base)) kept.push(lines[++i])
      const minIndent = Math.min(...kept.filter((l) => l.trim()).map(indent), Infinity)
      let v = kept.map((l) => l.slice(Number.isFinite(minIndent) ? minIndent : 0)).join(block[1] === '>' ? ' ' : '\n')
      if (block[2] !== '+') v = v.replace(/\n+$/, '') // "-" strips trailing newlines; default keeps one at most
      meta[k] = v.trim()
    } else if (!raw.trim() && /^\s+[\w-]+:/.test(lines[i + 1] ?? '')) {
      // a map (the Agent Skills spec's "metadata:"): its indented "key: value" lines
      meta[k] = {}
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indent(lines[i + 1]) > base)) {
        const kv = /^\s+([\w-]+):\s*(.*)$/.exec(lines[++i])
        if (kv) meta[k][kv[1]] = kv[2].replace(/^["']|["']$/g, '')
      }
    } else {
      meta[k] = raw.replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body: (m ? m[2] : text).trim() }
}

// Who can use a skill. Other CLIs' fields are understood too (disable-model-invocation, user-invocable).
function useOf(meta, fallback = 'both') {
  if (USES.includes(meta.use)) return meta.use
  if (USES.includes(meta.metadata?.['heartcode-use'])) return meta.metadata['heartcode-use'] // a skill shared with other CLIs keeps HeartCode's fields in metadata
  if (meta['disable-model-invocation'] === 'true') return 'me'
  if (meta['user-invocable'] === 'false') return 'model'
  return fallback
}

// More folders of skills from the caller (--skills-dir), after these two.
export const extraSkillDirs = []

export function skillDirs(root) {
  return [path.join(HOME, 'skills'), root && path.join(root, '.heartcode', 'skills'), ...extraSkillDirs].filter(Boolean)
}

export function loadSkills(root) {
  const skills = new Map()
  for (const dir of skillDirs(root)) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {}
    for (const e of entries) {
      const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.name.endsWith('.md') ? path.join(dir, e.name) : null
      if (!file) continue
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const { meta, body } = frontMatter(text)
      const name = (meta.name || e.name.replace(/\.md$/, '')).toLowerCase().replace(/[^a-z0-9_:-]+/g, '-')
      skills.set(name, { name, description: meta.description || body.split('\n')[0].slice(0, 100) || '(no description)', use: useOf(meta), hint: meta['argument-hint'] ?? '', body, file, load: String(meta.load ?? meta.metadata?.['heartcode-load'] ?? '').split(',').map((f) => f.trim()).filter(Boolean) })
    }
  }
  return skills
}

// A folder skill's other files (its guides, a stylesheet…), as paths in it: they're read with the
// skill tool's "file", since they sit outside the project. A one-file skill has none.
export function skillFiles(k) {
  if (path.basename(k.file) !== 'SKILL.md') return []
  const dir = path.dirname(k.file)
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(dir, path.join(d, e.name))]))
  try {
    return walk(dir).filter((f) => f !== 'SKILL.md').sort()
  } catch {
    return []
  }
}

// One of them, or an error (only inside the skill's folder).
export function readSkillFile(k, file) {
  const dir = path.dirname(k.file)
  const abs = path.resolve(dir, file)
  if (path.basename(k.file) !== 'SKILL.md' || !abs.startsWith(dir + path.sep)) return `error: the ${k.name} skill has no file "${file}"`
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return `error: the ${k.name} skill has no file "${file}". Its files: ${skillFiles(k).join(', ') || 'none'}`
  }
}

// The skill's text with the arguments filled in ({{args}}, {{1}}…, or $ARGUMENTS, $1…).
export function fillArgs(body, args) {
  const words = String(args ?? '').trim().split(/\s+/).filter(Boolean)
  const all = String(args ?? '').trim()
  return body
    .replace(/\{\{\s*args\s*\}\}|\$ARGUMENTS\b/g, all)
    .replace(/\{\{\s*(\d)\s*\}\}|\$(\d)\b/g, (m, a, b) => words[Number(a ?? b) - 1] ?? '')
}
