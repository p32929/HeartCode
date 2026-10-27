# HeartCode: what the other coding CLIs have and HeartCode doesn't

Compared with cline, openclaude, opencode and pi (in `~/Documents/Fayaz/personal/go/coding_clis`),
grouped by how many of them have it. From their docs and source layout.

## A. Three or four of them have it (the core features)

- [x] 1. **Subagents.** The model hands a side job (search, review, explore) to a helper with its own context, which keeps the main conversation small. All four have this; pi does it with an add-on.
- [x] 2. **Plan mode.** A read-only phase: the model plans, you approve, then it edits. cline, opencode, openclaude, and pi with an add-on.
- [x] 3. **Todo list tool.** The model keeps a checklist on screen and ticks items off, which helps long tasks not stop halfway. opencode, openclaude, pi.
- [x] 4. **Web fetch** (opencode, openclaude, cline) **and web search** (opencode, openclaude): read a URL as text, and search the web.
- [x] 5. **Hooks.** Your own scripts run before or after tool calls, and can block one (e.g. "never touch .env"). All four.
- [x] 6. **Ask the user a question.** The model asks a multiple-choice question mid-task instead of guessing. cline, opencode, openclaude.
- [x] 7. **Remote MCP servers** (HTTP/SSE with OAuth login), not only local ones. All four.
- [x] 8. **Cost and usage tracking**: tokens and cost per session, with prices from a model list. All four.
- [x] 9. **Session commands**: `/fork` (branch from a point), `/rename`, `/export` (HTML/JSON), `/copy`. All four.
- [ ] 10. **Native provider APIs** (Anthropic, Gemini, Bedrock…) and subscription logins (Claude, ChatGPT, Copilot), not only OpenAI-compatible endpoints. All four. *Later: OpenAI-compatible only for now; a first version is parked in `later/native.js`; Anthropic's API needs `max_tokens`, which HeartCode never sends. Subscription logins work by signing in as the vendors' own apps, which is against their terms.*
- [x] 11. **Themes and custom keybindings.** All four.

## B. Two of them have it

- [ ] 12. **Per-tool permission rules**, such as allow `npm test*` and deny `rm -rf*`. opencode, openclaude. *Later: built, then taken out; parked in `later/rules.js`.*
- [x] 13. **Git worktree isolation**: run a task in a separate worktree. cline, opencode, openclaude.
- [x] 14. **ACP mode**, so editors like Zed, JetBrains and Neovim can use it. cline, opencode.
- [x] 15. **apply_patch tool**: multi-file patch edits, which GPT-family models are trained to use. cline, opencode.
- [x] 16. **Tool search / "code mode"**: hide many MCP tools until needed, to save context. opencode, openclaude, pi. *Done as a `search` in the `mcp` tool (MCP tools were already hidden until needed); "code mode" left out.*
- [x] 17. **Plugins/extensions and a package installer.** All but openclaude are full systems. *Built (`/plugin`, Claude Code's plugins and marketplaces), then removed on 2026-10-28: not wanted for now. Skills, MCP servers and hooks cover it. Code extensions (JS adding tools) left out: MCP servers do that.*
- [x] 18. **Messages while the model works**: steer it mid-task, or queue a follow-up. pi; Claude Code does it too.
- [x] 19. **`/btw`**: a side question that doesn't go into the conversation. opencode, openclaude. *Done, also while it works.*
- [x] 20. **LSP diagnostics**: type errors shown to the model after each edit. openclaude has it; opencode's isn't finished in this version. *Done (`/toggle_lsp`).*
- [x] 21. **Auto-format after edits.** opencode. *Done (`/toggle_format`, `format.json`).*
- [ ] 22. **Server/SDK modes**: an HTTP API (opencode), RPC (pi), gRPC (openclaude), a JS SDK (cline, opencode, pi).
- [ ] 23. **Scheduled tasks (cron).** cline, openclaude.
- [ ] 24. **Write the prompt in `$EDITOR`.** opencode, pi.
- [ ] 25. **Repeated tool-call loop detection.** cline (HeartCode only has this in guided mode).

## C. Only one has it (mostly extras)

openclaude:
- [ ] 26. RepoMap: a ranked map of the code
- [ ] 27. Notebook editing
- [ ] 28. Smart routing: a cheap model for easy steps
- [x] 29. `/diff` *Done: every file changed this session, from before to now.*
- [ ] 30. `/doctor`
- [ ] 31. Git/PR commands
- [ ] 32. Vim mode
- [x] 33. Voice input *Done: Ctrl+R or `/voice`; whisper-cli on this machine (no download), or a provider's transcription API.*

pi:
- [x] 34. Session tree with branch summaries *Done: `/tree`; `/rewind` keeps what came after as a branch; files follow; a summary of the branch you leave.*
- [ ] 35. Project trust prompt before loading `.pi/` config
- [ ] 36. Prompt templates with arguments

cline:
- [ ] 37. Conditional rules that apply only to matching files
- [ ] 38. Chat from Telegram, Slack and others
- [ ] 39. Kanban board and dashboard

opencode:
- [ ] 40. Web UI and desktop app
- [x] 41. `/init` writes AGENTS.md *Done.*
- [ ] 42. Finish sounds and notifications
