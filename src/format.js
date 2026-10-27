// After HeartCode writes a file, the project's formatter runs on it, so its edits look like the rest
// of the code (and the user's own format-on-save doesn't turn every edit into a second diff).
// Only formatters the project already uses: prettier or biome from its node_modules, ruff or black
// when its pyproject/ruff.toml sets them up, clang-format with a .clang-format; and the languages'
// own (gofmt, rustfmt, dart format, zig fmt) when they're installed.
// ~/.heart/format.json or .heartcode/format.json (wins) change it, by file pattern:
//   { "*.py": "black -q $FILE", "*.md": false }   (false: never for those files)
// The settings page (General → Features) turns it all off.
import fs from 'node:fs'
import path from 'node:path'
import { HOME, readJson } from './config.js'
import { runCommand } from './tools.js'
import { log } from './log.js'

const has = (root, f) => fs.existsSync(path.join(root, f))
const read = (root, f) => {
  try {
    return fs.readFileSync(path.join(root, f), 'utf8')
  } catch {
    return ''
  }
}
const onPath = (cmd) => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, cmd)))
const local = (root, cmd) => (has(root, `node_modules/.bin/${cmd}`) ? path.join(root, 'node_modules/.bin', cmd) : null)
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// [file pattern, (root) → the command (the file's path is added at the end), or null]
const BUILTIN = [
  [/\.(m?[jt]sx?|cjs|cts|json|jsonc|css|scss|less|html|vue|svelte|astro|graphql|md|mdx|ya?ml)$/, (root) => {
    const biome = local(root, 'biome')
    if (biome && (has(root, 'biome.json') || has(root, 'biome.jsonc'))) return `${q(biome)} format --write`
    const prettier = local(root, 'prettier')
    return prettier && `${q(prettier)} --write --log-level=warn`
  }],
  [/\.pyi?$/, (root) => {
    const py = read(root, 'pyproject.toml')
    if (onPath('ruff') && (has(root, 'ruff.toml') || has(root, '.ruff.toml') || /^\[tool\.ruff/m.test(py))) return 'ruff format -q'
    return onPath('black') && /^\[tool\.black\]/m.test(py) ? 'black -q' : null
  }],
  [/\.go$/, () => onPath('gofmt') && 'gofmt -w'],
  [/\.rs$/, () => onPath('rustfmt') && 'rustfmt --edition 2021'], // rustfmt.toml in the project still applies
  [/\.dart$/, () => onPath('dart') && 'dart format -o write'],
  [/\.zig$/, () => onPath('zig') && 'zig fmt'],
  [/\.(c|cc|cpp|cxx|h|hh|hpp|m|mm)$/, (root) => onPath('clang-format') && has(root, '.clang-format') && 'clang-format -i'],
]

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)

// The command for a file ("…$FILE…" or one the path goes after), or null.
export function formatterFor(root, rel) {
  const own = { ...readJson(path.join(HOME, 'format.json'), {}), ...readJson(path.join(root, '.heartcode', 'format.json'), {}) }
  const base = path.basename(rel)
  for (const [pattern, cmd] of Object.entries(own)) {
    if (glob(pattern).test(base) || glob(pattern).test(rel)) return cmd || null
  }
  for (const [re, pick] of BUILTIN) if (re.test(rel)) return pick(root) || null
  return null
}

// Formats the file HeartCode just wrote. Returns its new text when the formatter changed it, else
// null. A formatter that fails (a syntax error it can't parse) is left at that: the file stays as
// written, and the language server or the model's next run says what's wrong.
export async function formatFile(root, rel) {
  const cmd = formatterFor(root, rel)
  if (!cmd) return null
  const abs = path.join(root, rel)
  const before = fs.readFileSync(abs, 'utf8')
  const line = cmd.includes('$FILE') ? cmd.replaceAll('$FILE', q(rel)) : `${cmd} ${q(rel)}`
  const { code, output } = await runCommand(root, line, { timeout: 20_000 })
  log('format', `${line} → exit ${code}`, code ? output.slice(0, 1000) : '')
  if (code !== 0) return null
  const after = fs.readFileSync(abs, 'utf8')
  return after === before ? null : { text: after, by: cmd.split(/\s+/)[0].split('/').pop().replace(/'$/, '') }
}
