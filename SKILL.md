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
heart models --all       # every provider's models (slower: asks each provider); with --json, beside the list
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
  #1 is used, and the next one in order when it fails. No `-m` means `auto` too, unless the user
  chose a set of models for that folder in HeartCode (`/select_model`): then that set. (`default`
  is its old name and still works.)
- **the user's models** (`place` 1, 2, …), as `provider/model`: #1 is the one `auto` starts with.

No model set up yet: `models` is empty (and `heart -p` fails with "no model set up").
`heart models [--all] <filter>` keeps only the ids that contain `<filter>`.

`providers` (only with `--all`): every provider's models. `list: false`: the user switched that
provider's list off, and `models` are the ones they added by name. `off: true`: the user switched
the provider off; `auto` skips its models (they aren't in `models`), but `-m provider/model` still runs one. A provider that can't be
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
and that is remembered for the model for a day. When a conversation takes 85% of the window of the
model answering (room is kept for the reply), a model of the list with room for all of it takes
over (the first such one in the list's order); only when none has room is it summarized. When the
list moves on to a model with a smaller window, it's summarized for that model before it's sent.
Each request is fitted to the model it goes to: one that can't see gets a note in place of each
image, one that can't call tools gets the tool calls as text.

`--provider <name>` and `-u <url>` (a server for this run) also mean one model, alone.

`heartcode page <file|url>` checks a web page in a headless browser (errors, a blank page, a click
that breaks it, text too faint to read, content hidden at load, icons that don't draw: exit 0 when it
passes) and saves screenshots to `.heartcode/page-shots/`.

A run picks up settings the user changes meanwhile (`heart settings`, another HeartCode, or
`~/.heart` by hand) without being restarted, from its next request: the model order, prompts,
hooks, skills, MCP servers. `--temp` runs share one throwaway folder, so a change in one reaches the
other `--temp` runs going on, never the real ones.

`heart` is installed by `npm start` in the HeartCode folder. `heartcode` is the same command.
Needs Node.js 22 or newer. No providers? See "Setting up a model" below.

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
  "stop_reason": "end_turn", "num_turns": 6, "duration_ms": 41200, "total_cost_usd": 0.0031,
  "usage": { "input_tokens": 18000, "output_tokens": 900 }, "session_id": "20261027-…" }
```

Read `is_error` and `result`. `subtype` is `success`, `error_during_execution` or
`error_max_turns`. `stop_reason` is why the answer ended, in Claude's words: `end_turn`, or
`max_tokens` when it was still cut off (see "Cut-off replies" below), `refusal` when the
provider's filter stopped it. Without `--output-format`, stdout is just the answer text, and an error
goes to stderr. Logs never go to stdout.

## Continue the same conversation

Every run is saved as a session in the project's `.heartcode/sessions/` (and logged, for the kinds of logs the user
switched on), as when the user works in HeartCode; `--temp` keeps nothing. Pass the `session_id`
from the last result:

```sh
heart -p --output-format json --resume 20261027-… "now add a test for the empty case"
heart -p --continue "…"          # or: the last session in this folder
```

## Keep it safe

Headless never asks anyone. What the permission mode would ask about is declined, and the
model is told why. A question the model would ask the user (what to build, how it should look,
what testing) it decides itself, and says in its reply what it assumed: put the choices that
matter in the prompt. An MCP tool its server marks read-only is never asked about. The model can't
give itself a freer permission mode (its `manage` tool asks the user, so headless refuses it), and
can't switch the model you chose.

| You want | Flags |
|---|---|
| Answers only, no changes (review, explain, find) | `--allowedTools Read,Grep,Glob` |
| Edits, but no shell commands | `--permission-mode commands` |
| Everything (edits and commands) | `--permission-mode all` (the default unless the user set another) |
| Changes kept apart from the user's files | `--worktree=<name>` (in a git repo): it works in `.heartcode/worktrees/<name>` on the branch `heartcode/<name>`; kept if anything changed (merge it from there), removed if nothing did |
| A cap on how long it works | `--max-turns 30` (model steps), `--max-retries 3` (a failing provider) |
| Nothing kept: no session, logs, settings or notes in `~/.heart`, nothing in the project's `.heartcode/` | `--temp` (a throwaway copy, shared by the `--temp` runs going on at once, deleted after the last; the project's notes and research are read, and what the run adds goes with the copy)  With `--worktree` too, the worktree itself is made in the project's `.heartcode/worktrees/` (git needs it in the repository) |

Tool names: HeartCode's own (`read_file`, `edit_file`, `write_file`, `run_command`, `search`,
`list_files`, `changes`, `web_fetch`, `web_search`…) or Claude Code's (`Read`, `Edit`, `Write`, `Bash`,
`Grep`, `Glob`, `WebFetch`, `WebSearch`). `--disallowedTools Bash` takes one away. MCP servers'
tools are named as in Claude Code: `mcp__<server>__<tool>`; `mcp__<server>` means all of one
server's tools, `mcp` all of them. (The model itself reaches them through one `mcp` tool that lists
each by name; in the output they keep their own names, below.)

## Choose the model

```sh
heart -p -m auto "…"                            # the user's list, with its fallbacks (the same as no -m)
heart -p -m groq/openai/gpt-oss-120b "…"       # that provider and model alone, for this run
heart -p -m groq/openai/gpt-oss-120b --fallback-model openrouter/qwen/qwen3-coder "…"   # and that one when it fails
heart -p --provider ollama -m qwen3-coder "…"   # the same, written apart
heart -p --effort high "…"                      # how hard a thinking model thinks (low unless set)
```

What a model can do (tool calls, context size, thinking, images) comes from models.dev, at once;
nothing is sent to the model to find out. A model models.dev doesn't know works with plain
assumptions, and the user can set it up on the settings page. Models that can't call tools still
work, in a slower guided mode.

The model in use knows the user's other models and works with them through its `agent` tool.
When the user picked helpers (on *Your models*: a switch per model and what it's good at: UI &
visuals, Code & logic, Big & hard, Quick & cheap), it knows only those, and a job goes to the
helper good at it (no model named: the first helper, in the user's order or by their provider
ranking, as they chose); else it knows all of them, in the user's order, with what each can do. It
asks a model that can for what it
can't do itself (a model that can't see asks one that can about a screenshot: "which tiles show a
chair?"), several at once when there are many images or parts, and a helper that fails is handed to
the next capable model in the user's order (with helpers picked: the next helper, then the model in
use) until one does the job. A helper works until its job is done (no step
limit; `--max-turns` applies to it too). Their tokens are in `usage`, and each model's in
`modelUsage`.

A long run that fills the model's context window is compacted: the model first writes down what it
has found, then the conversation so far is replaced by a summary that starts with those notes. That
is two extra requests, counted in `usage`, and not in the stream.

## Setting up a model

Ask the user which provider and model to use, and for the key. Never invent one. Then:

```sh
# for one run only (nothing saved); the key from the environment, not the command line
HEART_BASE_URL=https://api.groq.com/openai/v1 HEART_API_KEY=… HEART_MODEL=openai/gpt-oss-120b heart -p "…"

# saved for every run (writes ~/.heart/config.json)
HEART_API_KEY=… heart -u https://api.groq.com/openai/v1 -m openai/gpt-oss-120b --save -p "hello"
```

A model server on this machine (Ollama on :11434, LM Studio on :1234, llama.cpp on :8080) is
found on its own while no provider is set up yet. The user can also set everything up in a browser: `heart settings` (its link has
the machine's network address, so it opens from another device too, for HeartCode on a server), where
**Test all** under *Your models* sends each model a short message to show it really answers, and how fast. A run that fails with a wrong key or an unknown model: ask the user to test it there.

## More context for the task

| Flag | |
|---|---|
| `--append-system-prompt "<text>"` | your instructions for this run, at the end of the system prompt. HeartCode's own part then says less (no role of its own, no "stay in the project folder", no way of finishing of its own) and tells the model to follow yours where they differ; its `manage` tool is left out (its memory still works: `--no-memory` turns that off) |
| `--mcp-config <file or JSON>` | more MCP servers (repeatable); `--strict-mcp-config`: only those. The model sees every server's tools by name, one line each, and gets a tool's arguments when it uses it (a call that doesn't fit them comes back with what's wrong, not run). What a server says about using its tools comes once, with the first result of one of them |
| `--skills-dir <folder>` | more skills (repeatable) |
| `--no-memory` | nothing read or kept: no memory notes, no web pages saved in the project, no wrap-up at the end (see "What a run leaves") |

A project's own `HEARTCODE.md` (or `AGENTS.md`, `CLAUDE.md`) is read like instructions.

## What a run leaves, and the extra requests

Unless you pass `--no-memory`, a run keeps what it learns in the project it works in:
`.heartcode/research/` (every web page it read, whole, as Markdown; that folder ignores itself in
git) and `.heartcode/memory/` (notes). Notes and pages that match a task come with it next time,
so later runs research less. After a task that read the web, ran commands or made files, a
wrap-up request saves notes, keeps or deletes the pages it read, and removes throwaway files and
empty folders the task made (a test script, a debug log). It runs after the answer: the
`result` (or the printed answer) comes first, and `heart -p` exits once the wrap-up is done (a few
seconds more).

No command blocks: `run_command` waits up to `wait` seconds (the model's choice, 30 if left out)
and a command still running then carries on in the background; one meant to keep running (a dev
server, a watcher) takes `background: true`. The `background` tool reads a command's new output
(after waiting up to `wait` seconds for it), lists them and stops one. Whatever is still running is
stopped when HeartCode exits.

Before a task that changed files ends, another of the user's models (the same one when only one is
used) reviews the work against the request in a request of its own; a NO sends it back to fix.
The first file change of each message waits for the model's plan (its todo list): without one it
isn't made, once (the model is told to write the plan first). Changing files and
then saying it's done without running anything since sends it back to check. Nothing stops a
task but `--max-turns`, `--max-retries` or an interrupt: a model going round in circles hands the
work to the next model in the list. These requests are in `usage` and `modelUsage` too.

## Long tasks: a stream of events

```sh
heart -p --input-format stream-json --output-format stream-json
```

Stdin: one message per line, `{"type":"user","message":{"role":"user","content":"…"}}`.
Stop the running one with `{"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}`;
`initialize` and `set_permission_mode` (`"mode"`: as `--permission-mode` takes it) are answered with
`subtype: "success"`; any other control request gets a `control_response` with `subtype: "error"` (not supported).
Stdout: one JSON event per line, `system`/`init` (its `tools` include the MCP servers' tools, each
`mcp__<server>__<tool>`, and `mcp_servers` says which are `connected`), then `assistant` (text, thinking, `tool_use`),
`user` (`tool_result`), and a `result` after each message. It runs until stdin closes. An MCP
call's `tool_use` is named as in Claude Code, `mcp__<server>__<tool>`, with the tool's own
arguments as `input`.

With `--include-partial-messages`, each reply also comes as it's written, as Claude Code sends it:
`stream_event` lines (`message_start`, `content_block_start`, `content_block_delta` with a
`thinking_delta` or `text_delta`, `content_block_stop`, `message_stop`), before its whole
`assistant` line. Helpers' replies come whole only (their `assistant` lines, with their parent).

A helper's steps (the `agent` tool: another of the user's models, or the same one, doing a job;
several can run at once) come as `assistant` and `user` lines too, as Claude Code sends a
subagent's: `parent_tool_use_id` is the id of the `agent` call they belong to (`null` for the main
conversation's). The helper's last reply is that `agent` call's `tool_result`.

**Which model does what.** Every line says which model it's from, as `provider/model`:

- `assistant`: `message.model` is the model that wrote it (after a fallback, the one that took
  over, not the `init` line's `model`; a helper's lines: the helper's model).
- `user` (a `tool_result`): a top-level `model`, the model that made the call.
- `system` lines (below): `model` on `status`, `helper` and `review`; `by` on each plan step a
  helper took; `from` and `to` on `model_switch`.

`modelUsage` in the `result` has each model that answered.

**Why a reply ended.** Each `assistant` line's `message.stop_reason` is `end_turn`, `tool_use`,
`max_tokens` (cut off: its provider's output limit, or a connection that ended early) or `refusal`
(the provider's filter); the `result` has the final answer's.

**Cut-off replies.** HeartCode sends no `max_tokens`, so each provider's own output limit applies.
An answer cut off by it (or by a stream that ended without `[DONE]`) isn't taken as finished: the
model is asked to go on where it stopped (up to 3 times in a row), and the answer is the pieces
together. Each piece comes as its own `assistant` line (`stop_reason: max_tokens`), then the whole
answer as one more `assistant` line, so the last `assistant` line before the `result` is always
the answer as a whole (and so is `result`).

**What the full screen shows, as `system` lines** (`{"type":"system","subtype":…,"session_id":…}`;
a program that doesn't know a subtype can skip it, as for Claude Code):

| `subtype` | Fields | When |
|---|---|---|
| `status` | `status`, `model` | what it's doing now, as the screen's spinner says it ("thinking", "waiting for …", "preparing read_file README.md", a running command's latest output line, read once a second); sent when it changes. A helper's: its model |
| `todos` | `todos`: `[{ content, status, why?, by? }]` | the whole plan, each time it changes; `status` is `pending`, `in_progress`, `completed` or `stuck` (`why`: the model's reason); `by`: the model a step was handed to |
| `stuck` | `step`, `why`, `count`, `model` | the model says it's stuck on a step (`count` this message): the 1st time it's told to change approach, the 2nd another model gives a second opinion, the 3rd the next model takes over (a `warning` says so) |
| `helper` | `tool_use_id`, `label`, `model`, `status` | a helper at work: `starting`, then what it's doing, then `done`. `tool_use_id` is its `agent` call (several parts of a plan run at once can share one); `label` its job |
| `review` | `model`, `verdict` (`yes`/`no`), `issues` | another model's look at the changes before the answer; a `no` sends the work back to be fixed |
| `model_switch` | `from`, `to`, `reason`, `place` | the user's list moved on: `from` failed (`reason`, e.g. `rate-limited (429)`), `to` answers now (`place`: its place in the list) |
| `retry` | `attempt`, `delay_ms`, `error` | a request failed and is tried again after `delay_ms` |
| `warning` | `message` | what the screen shows as a warning (e.g. a model models.dev doesn't know) |

Not in the stream: HeartCode's own prompts (the system prompt, its nudges) and the wrap-up's
requests (their `retry` lines can come after the `result`). Their tokens are in `usage` and
`modelUsage`.

## Don't

- Don't run `heart` without `-p` from an agent: it's a full-screen app and waits for a person.
- Don't put API keys on the command line where other processes can see them; use `HEART_API_KEY`.
- Don't run `heart settings` unless the user asked: it starts a web page and runs until stopped.
