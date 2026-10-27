// Hooks: your own commands, run at points in HeartCode's work, in Claude Code's format (so hooks
// from it work here too). From ~/.heart/hooks.json and .heartcode/hooks.json (both, global first):
//   { "hooks": { "PreToolUse": [ { "matcher": "edit_file|write_file", "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 60 } ] } ] } }
// Events:
//   UserPromptSubmit  before a message goes to the model; exit 2 blocks it, stdout is added to it
//   PreToolUse        before a tool runs (matcher: the tool's name); exit 2 blocks it, stderr is the reason
//   PostToolUse       after a tool ran; exit 2 tells the model stderr (e.g. lint errors)
//   Stop              when the model is done; exit 2 makes it carry on, with stderr as the reason
// The command gets the event as JSON on stdin (session_id, cwd, hook_event_name, tool_name,
// tool_input, tool_response, prompt, stop_hook_active), runs in the project folder, and can also
// answer with JSON on stdout: {"decision": "block", "reason": "…"} (or "continue": false).
// Matchers are regexes, tested against HeartCode's tool names and Claude Code's (Edit, Bash, …).
import fs from 'node:fs'
import path from 'node:path'
import { HOME, readConfig } from './config.js'
import { runCommand, clip } from './tools.js'
import { log } from './log.js'

export const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']

// HeartCode's tool names → Claude Code's, for matchers and tool_input written for Claude Code.
export const CLAUDE_NAMES = { read_file: 'Read', edit_file: 'Edit', write_file: 'Write', run_command: 'Bash', search: 'Grep', list_files: 'Glob', web_fetch: 'WebFetch', web_search: 'WebSearch', todo: 'TodoWrite', agent: 'Task' }

export const hookFiles = (root) => [path.join(HOME, 'hooks.json'), path.join(root, '.heartcode', 'hooks.json')]

// { event: [{ matcher, command, timeout, file }] }
export function loadHooks(root) {
  const out = {}
  const sources = hookFiles(root).filter((f) => fs.existsSync(f)).map((file) => ({ hooks: readConfig(file, {}), file }))
  for (const { hooks: cfg, file } of sources) {
    for (const [event, groups] of Object.entries(cfg.hooks ?? cfg)) {
      if (!EVENTS.includes(event)) {
        log('hooks', `${file}: unknown event ${event} (known: ${EVENTS.join(', ')})`)
        continue
      }
      for (const g of [groups].flat()) {
        for (const h of g?.hooks ?? []) if (h?.command) (out[event] ??= []).push({ matcher: g.matcher ?? '', command: h.command, timeout: Number(h.timeout) || 60, file })
      }
    }
  }
  return out
}

const matches = (matcher, tool) => {
  if (!matcher || matcher === '*' || !tool) return true
  try {
    const re = new RegExp(`^(?:${matcher})$`)
    return re.test(tool) || re.test(CLAUDE_NAMES[tool] ?? '') || (tool === 'mcp' && /^mcp__/.test(matcher))
  } catch {
    return matcher === tool
  }
}

// Runs the event's hooks (those matching `tool`). Returns { block: reason | null, context: stdout of
// hooks that passed }. A hook that fails to run is logged and ignored: it never stops the work.
export async function runHooks(s, event, data = {}, signal) {
  const hooks = (s.hooks?.[event] ?? []).filter((h) => matches(h.matcher, data.tool_name))
  if (!hooks.length) return { block: null, context: '' }
  const input = { session_id: s.chat?.id, cwd: s.root, hook_event_name: event, ...data }
  if (input.tool_input?.path && !input.tool_input.file_path) input.tool_input = { ...input.tool_input, file_path: input.tool_input.path } // as Claude Code names it
  const context = []
  for (const h of hooks) {
    const t0 = Date.now()
    const { code, output, stderr } = await runCommand(s.root, h.command, { signal, timeout: h.timeout * 1000, stdin: JSON.stringify(input), env: { HEARTCODE_PROJECT_DIR: s.root, CLAUDE_PROJECT_DIR: s.root }, split: true })
    log('hook', `${event} ${h.command} → exit ${code} in ${Date.now() - t0}ms`, clip(output + stderr, 2000))
    let json = null
    try {
      json = /^\s*\{/.test(output) ? JSON.parse(output) : null
    } catch {}
    const reason = (json?.reason ?? json?.stopReason ?? stderr.trim()) || output.trim() || `blocked by the hook ${h.command}`
    if (code === 2 || json?.decision === 'block' || json?.continue === false) {
      s.ui.step('hook', `${event}: ${clip(h.command, 50)}`)
      s.ui.result(`blocked: ${clip(reason.split('\n')[0], 100)}`)
      return { block: clip(reason, 4000), context: context.join('\n') }
    }
    if (code !== 0) s.ui.warn(`hook ${h.command} (${event}) failed: exit ${code}${stderr.trim() ? `: ${clip(stderr.trim().split('\n')[0], 120)}` : ''}`)
    else if (output.trim() && !json && event === 'UserPromptSubmit') context.push(output.trim())
  }
  return { block: null, context: context.join('\n') }
}
