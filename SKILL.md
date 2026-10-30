---
name: heartcode
description: Run a coding task with HeartCode, a coding agent for any OpenAI-compatible model (OpenRouter, Groq, Ollama, LM Studio, your own server…), from a script or another AI agent. Use it to hand a task to a different or cheaper model, get a second opinion on code, or run work in an isolated git worktree. Headless: `heart -p`, JSON out, exit code 0 or 1.
---

# HeartCode, for AI agents

HeartCode is a coding agent in the terminal. Interactively it takes the whole screen, which an
agent can't drive. Use it **headless**: `heart -p` runs one task without the screen, prints the
answer (or JSON) and exits. Its flags and output match Claude Code's `claude -p`.

## Check it's there

```sh
heart --version          # installed? (else: node /path/to/heart_cli/bin/heart.js --version)
heart providers          # the providers set up, and their URLs (keys are masked)
heart models             # what -m takes, one per line: "auto" first, then the user's models (provider/model), #1 first
heart models --json      # the same, as JSON
heart models --all       # every provider's models too (slower: asks each provider)
```

`heart models` prints one id per line, nothing else (like `opencode models`):

```
auto
groq/openai/gpt-oss-120b
openrouter/qwen/qwen3-coder
```

With `--json`:

```json
{ "models": [
    { "id": "auto", "fallbacks": true },
    { "id": "groq/openai/gpt-oss-120b", "provider": "groq", "model": "openai/gpt-oss-120b", "place": 1 },
    { "id": "openrouter/qwen/qwen3-coder", "provider": "openrouter", "model": "qwen/qwen3-coder", "place": 2 } ],
  "providers": [
    { "name": "groq", "baseUrl": "https://api.groq.com/openai/v1", "list": true, "models": ["groq/…"] },
    { "name": "local", "baseUrl": "http://127.0.0.1:9/v1", "list": true, "models": [], "error": "cannot reach …" } ] }
```

`id` is exactly what to pass to `-m`:

- **`auto`** (always first): the user's list. `fallbacks: true` when it has more than one model:
  #1 is used, and the next one in order when it fails. No `-m` means `auto` too. (`default` is
  its old name and still works.)
- **the user's models** (`place` 1, 2, …), as `provider/model`: #1 is the one `auto` starts with.

No model set up yet: `models` is empty (and `heart -p` fails with "no model set up").
`heart models [--all] <filter>` keeps only the ids that contain `<filter>`.

`providers` (only with `--all`): every provider's models. `list: false`: the user switched that
provider's list off, and `models` are the ones they added by name. A provider that can't be
reached has an `error` (in text: a line on stderr) and is skipped; the command still exits `0`.

**Which model to pass:**

| `-m` | What runs |
|---|---|
| `auto`, or no `-m` | the user's list: #1, and the next one in order when it fails. Use this unless you need one particular model. |
| `provider/model` (`-m groq/openai/gpt-oss-120b`), or a model of #1's provider alone | that model alone: never another one, also when it fails (a rate limit or an outage is tried again, up to `--max-retries`) |
| that, plus `--fallback-model provider/model` (repeatable) | that model, then the fallbacks in order when it fails (as `claude -p --fallback-model`) |

**Failures:** with `auto` (the list), any failure (an error status of any kind, a timeout, a reply
that stops coming, a lost connection, an error page from a proxy, a model that keeps replying with
nothing) makes way for the next model, from another provider first; that provider's other models
are tried only after every provider has had a go. None of it shows: the run goes on with the model
that answers. It stops with exit code `1` only when every model in the list fails: at once if they
all refused the request outright, else after `--max-retries` (10) whole rounds of them. A single
model (`-m <model>`) waits out rate limits and outages, up to `--max-retries` tries, and stops at
any other error. A provider that refuses a part of the request HeartCode can do without (the
model's thinking sent back, keys in the tools' schemas, images) gets it again without that part,
and that is remembered for the model for a day. A long conversation is summarized every 100
messages.
Each request is fitted to the model it goes to: one that can't see gets a note in place of each
image, one that can't call tools gets the tool calls as text.

`--provider <name>` and `-u <url>` (a server for this run) also mean one model, alone.

A run picks up settings the user changes meanwhile (`heart settings`, another HeartCode, or
`~/.heart` by hand) without being restarted, from its next request: the model order, prompts,
hooks, skills, MCP servers. `--temp` runs share one throwaway folder, so a change in one reaches the
other `--temp` runs going on, never the real ones.

`heart` is installed by `npm start` in the HeartCode folder. `heartcode` is the same command.
Needs Node.js 20 or newer. No providers? See "Setting up a model" below.

## Run a task

```sh
heart -p --output-format json -C /path/to/project "fix the failing test in math.test.js"
```

- `-C <folder>`: the project to work in (default: the current folder). A folder, not a file.
- The prompt is the last argument, or stdin: `echo "explain src/agent.js" | heart -p`.
- An image goes with the task as `@path/to/shot.png` or a full path (`/Users/me/shot.png`) in the
  prompt, or as an image block in stream-json. A file name only mentioned ("rename logo.png") isn't
  attached. A model that can't see gets it looked at by one of the user's models that can.
- Exit code: `0` it finished, `1` it failed (no model, the model kept failing, the server refused
  the request (wrong model name, bad key), `--max-turns` hit). The error is in `result` (JSON) or on stderr.

`--output-format json` prints one object on stdout:

```json
{ "type": "result", "subtype": "success", "is_error": false, "result": "Fixed it: …",
  "num_turns": 6, "duration_ms": 41200, "total_cost_usd": 0.0031,
  "usage": { "input_tokens": 18000, "output_tokens": 900 }, "session_id": "20261027-…" }
```

Read `is_error` and `result`. `subtype` is `success`, `error_during_execution` or
`error_max_turns`. Without `--output-format`, stdout is just the answer text, and an error
goes to stderr. Logs never go to stdout.

## Continue the same conversation

Pass the `session_id` from the last result:

```sh
heart -p --output-format json --resume 20261027-… "now add a test for the empty case"
heart -p --continue "…"          # or: the last session in this folder
```

## Keep it safe

Headless never asks anyone. What the permission mode would ask about is declined, and the
model is told why. An MCP tool its server marks read-only is never asked about. The model can't
give itself a freer permission mode (its `manage` tool asks the user, so headless refuses it), and
can't switch the model you chose.

| You want | Flags |
|---|---|
| Answers only, no changes (review, explain, find) | `--allowedTools Read,Grep,Glob` |
| Edits, but no shell commands | `--permission-mode commands` |
| Everything (edits and commands) | `--permission-mode all` (the default unless the user set another) |
| Changes kept apart from the user's files | `--worktree=<name>` (in a git repo): it works in `.heartcode/worktrees/<name>` on the branch `heartcode/<name>`; kept if anything changed (merge it from there), removed if nothing did |
| A cap on how long it works | `--max-turns 30` (model steps), `--max-retries 3` (a failing provider) |
| Nothing written to the user's `~/.heart` (sessions, logs, settings) | `--temp` (a throwaway copy, shared by the `--temp` runs going on at once) |

Tool names: HeartCode's own (`read_file`, `edit_file`, `write_file`, `run_command`, `search`,
`list_files`, `web_fetch`, `web_search`…) or Claude Code's (`Read`, `Edit`, `Write`, `Bash`,
`Grep`, `Glob`, `WebFetch`, `WebSearch`). `--disallowedTools Bash` takes one away. MCP servers'
tools are named as in Claude Code: `mcp__<server>__<tool>`; `mcp__<server>` means all of one
server's tools, `mcp` all of them.

## Choose the model

```sh
heart -p -m auto "…"                            # the user's list, with its fallbacks (the same as no -m)
heart -p -m groq/openai/gpt-oss-120b "…"       # that provider and model alone, for this run
heart -p -m groq/openai/gpt-oss-120b --fallback-model openrouter/qwen/qwen3-coder "…"   # and that one when it fails
heart -p --provider ollama -m qwen3-coder "…"   # the same, written apart
heart -p --effort high "…"                      # how hard a thinking model thinks
```

What a model can do (tool calls, context size, thinking, images) comes from models.dev, at once;
nothing is sent to the model to find out. A model models.dev doesn't know works with plain
assumptions, and the user can set it up on the settings page. Models that can't call tools still
work, in a slower guided mode.

The model in use knows the user's other models (what each can do, how often it failed this
session) and works with them through its `agent` tool: it asks a model that can for what it
can't do itself (a model that can't see asks one that can about a screenshot: "which tiles show a
chair?"), several at once when there are many images or parts, and a helper that fails is handed to
the next capable model until one does the job. A helper takes 25 steps at most, then answers with
what it has. Their tokens are in `usage`, and each model's in
`modelUsage`.

## Setting up a model

Ask the user which provider and model to use, and for the key. Never invent one. Then:

```sh
# for one run only (nothing saved); the key from the environment, not the command line
HEART_BASE_URL=https://api.groq.com/openai/v1 HEART_API_KEY=… HEART_MODEL=openai/gpt-oss-120b heart -p "…"

# saved for every run (writes ~/.heart/config.json)
HEART_API_KEY=… heart -u https://api.groq.com/openai/v1 -m openai/gpt-oss-120b --save -p "hello"
```

A model server on this machine (Ollama on :11434, LM Studio on :1234, llama.cpp on :8080) is
found on its own. The user can also set everything up in a browser: `heart settings`, where
**Test** (or **Test all**) under *Your models* sends a model a short message to show it really
answers. A run that fails with a wrong key or an unknown model: ask the user to test it there.

## More context for the task

| Flag | |
|---|---|
| `--append-system-prompt "<text>"` | your instructions for this run, at the end of the system prompt. HeartCode's own part then says less (no role of its own, no "stay in the project folder", no way of finishing of its own) and tells the model to follow yours where they differ; its `manage` tool is left out, and nothing from the run's messages is saved to its memory |
| `--mcp-config <file or JSON>` | more MCP servers (repeatable); `--strict-mcp-config`: only those. Each server's tools are tools of their own for the model, `mcp__<server>__<tool>`, as in Claude Code, and what the server says about using them goes in the system prompt |
| `--skills-dir <folder>` | more skills (repeatable) |
| `--no-memory` | don't read or write HeartCode's memory notes |

A project's own `HEARTCODE.md` (or `AGENTS.md`, `CLAUDE.md`) is read like instructions.

## Long tasks: a stream of events

```sh
heart -p --input-format stream-json --output-format stream-json
```

Stdin: one message per line, `{"type":"user","message":{"role":"user","content":"…"}}`.
Stop the running one with `{"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}`;
any other control request gets a `control_response` with `subtype: "error"` (not supported).
Stdout: one JSON event per line, `system`/`init` (its `tools` include the MCP servers' tools,
`mcp_servers` says which are `connected`), then `assistant` (text, thinking, `tool_use`),
`user` (`tool_result`), and a `result` after each message. It runs until stdin closes.

A helper's steps (the `agent` tool: another of the user's models, or the same one, doing a job;
several can run at once) come as `assistant` and `user` lines too, as Claude Code sends a
subagent's: `parent_tool_use_id` is the id of the `agent` call they belong to (`null` for the main
conversation's). The helper's last reply is that `agent` call's `tool_result`.

Every `assistant` line's `message.model` is the model that wrote it (`provider/model`): after a
fallback, the one that took over, not the one the run started with (the `init` line's `model`).
`modelUsage` in the `result` has each model that answered.

## Don't

- Don't run `heart` without `-p` from an agent: it's a full-screen app and waits for a person.
- Don't put API keys on the command line where other processes can see them; use `HEART_API_KEY`.
- Don't run `heart settings` unless the user asked: it starts a web page and runs until stopped.
