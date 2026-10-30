# Changelog

What changed in each version of HeartCode, newest first.

## 0.1.18 (2026-10-30)

- Before building anything, the model researches it first (the current, most recommended way and
  the latest stable versions, from the web and the official docs), plans the whole job, and asks
  what it still isn't sure of: free models' training data is old.
- Tab names are at most 20 characters, "..." included.
- Settings changed while HeartCode works now reach it at once, every time: before every request and
  before each tool's result is cut to the context window, HeartCode takes in what changed (it no longer
  depends on the file watcher being quick enough). A model's context window, set up on the settings
  page mid-task, is used from the next step, also by helpers (the agent tool) already at work, which
  used to keep the old one until they finished.
- Auto-compact when the conversation takes 85% of the window of the model answering (room is kept
  for the reply), no longer every 100 messages: a long session is no longer summarized at a few
  percent of a big window. When the model list moves on to a model with a smaller window, the
  conversation is compacted for that model before it's sent, instead of being refused as too big.
  The spinner says how full it is ("context 86% full (~660k of 768k)").
- A running HeartCode no longer overwrites what you set up for a model: saving what it learned
  about the model (token counts, limits) used to write its old copy of your settings back over them.

## 0.1.17 (2026-10-30)

- Stronger system prompts (tool mode and guided mode for small models): act instead of describing,
  don't guess paths or APIs, search the web when unsure or knowledge is dated, never stop until the
  request is done, verify by output, and answer short and to the point. Small local models follow
  these far better.
- The system prompt now tells the model the OS and shell it's running on (e.g. "macOS (darwin, arm64),
  shell zsh"), and how to find and install a tool it needs: use what's already there, else install it
  the right way for this OS (asking first unless commands are already allowed).

## 0.1.16 (2026-10-30)

- Switch a provider off (and on again) on the settings page, without deleting it: its key and its
  models in your list stay, but `auto` skips them, also in a HeartCode running already. `-m
  provider/model` still runs one of its models. `heart providers` says which are off; `heart models
  --all --json` gives them `off: true`.

## 0.1.15 (2026-10-30)

- Settings page, Providers & models: Test on each model sends it "Hello" and shows what was sent
  and what came back. Tick several and Test them all at once (a provider's one after another, for
  its rate limit); then keep ticked only the ones that answered.
- Free only: just the models a provider's list prices at $0, marked free; sort by price puts them first.
- Prices read right: Airforce's were 100 times too high (its list is in cents), Cloudflare's are read
  now. Model lists saved before are read again.
- Each provider has a box to add a model by its name; one it has already, or one in your list, is
  said and shown instead.

## 0.1.14 (2026-10-30)

- Settings page, Providers & models: one full-width list. Tick models (or a whole provider, or
  everything shown) and add them to your list or take them off it at once; a click on one still
  adds or removes it. Each provider is one line; its model list switch, the models added by name
  and Delete are in its Edit dialog. Your list is a button to the Your models page, which now has
  what to do when a model fails.

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
