# Changelog

What changed in each version of HeartCode, newest first.

## 0.1.13 (2026-10-30)

- Settings no longer go back by themselves: a save writes only what changed, so another HeartCode
  or settings page with an older copy doesn't undo your change (and keys HeartCode doesn't know stay).
- A settings change reaches every HeartCode running on the same settings at once, mid-task too: the
  model order, prompts and HEARTCODE.md, hooks, skills, MCP servers. Open settings pages update by themselves.
- `--temp` runs going on at once share one throwaway folder: a change in one reaches the others,
  never your real settings. Ctrl+C now cleans it up too.
- Settings page: nothing is kept in the browser (the provider ranking, sorts and folds are in
  ~/.heart); Save order is always there; Invert selection on Your models.

## 0.1.12 (2026-10-30)

- `auto` is the name for your model list (#1, then the next when one fails); `default` still works.
- Models are written `provider/model` (`-m groq/openai/gpt-oss-120b`); the old `"provider model"` still works.
- `heart models` prints what `-m` takes, one per line (`auto` first); `--json` gives an `id` for each.
- `--fallback-model <provider/model>`, as in `claude -p`: tried after the `-m` model when it fails.
- Settings changed while HeartCode runs (also `-p`, stream-json and editors over ACP) are taken in
  without a restart: a new model order from the running task's next request.
- Settings page: adding a provider, an MCP server or a skill opens a dialog; every dialog is 70% of
  the screen wide. Your models can be sorted by a provider ranking you drag into order.

## 0.1.11 (2026-10-30)

- A changelog (this file) in place of the old TODO list.

## 0.1.10 (2026-10-30)

- Any model error (a rate limit, an outage, "request too large", a bad model name, a wrong key…)
  moves on to the next model in your list, another provider's first, without the app using
  HeartCode seeing it. A run stops with an error only when every model has failed.
- No more token estimates deciding when to shrink a request or switch models. A long
  conversation is summarized every 100 messages instead.
- Settings: the rotation choice "at any error" is gone; it now works the same as "at its first
  failure".

## 0.1.9 (2026-10-29)

- After an error, the next model tried is from another provider; the failing provider's other
  models come only after every provider has had a go.
- Model lists in Cloudflare's format (`{ "result": [...] }`) are read.
- Settings: model lists no longer stay stuck on "loading…", and an empty saved list is fetched again.
- A shorter system prompt, with the duplicates taken out.

## 0.1.8 (2026-10-29)

- Settings page: model tests run on the server, long model lists scroll smoothly, prices are
  shown, and "Test all" shows its progress.

## 0.1.7 (2026-10-29)

- Each request is fitted to the model it goes to (images, tool calls, thinking).
- Safer file changes.
- Better handing of work to the other models.

## 0.1.6 (2026-10-29)

- Better handing of work to the other models.
- A helper's steps are sent to apps using HeartCode, like Claude Code's subagents.
- Fixed switching models.
- npm page: GitHub links and keywords.

## 0.1.5 (2026-10-28)

- Several helpers can run at once; thinking is shown with its name; the model lists show what
  each model can do.
- Tab only completes, it doesn't send.

## 0.1.3 (2026-10-28)

- Another of your models does what the one in use can't (for example, looking at an image).
- A path typed at the prompt is no longer taken for a command.

## 0.1.2 (2026-10-28)

- Logging: the size on disk, and a Delete all button.
- Refresh model data from models.dev.
- A Test button on the Your models page, a simpler list, and `-latest` model names matched in models.dev.
- Screenshots in the README.

## 0.1.1 (2026-10-28)

- First release: MCP tools as real tools, fallback models that keep going, a model Test button.
- The npm package holds only what HeartCode needs to run.
- README, MIT license, and failures described in SKILL.md.
