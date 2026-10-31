# Changelog

What changed in each version of HeartCode, newest first.

## 0.1.25 (2026-10-31)

- The model(s) you choose for a folder with /select_model are remembered per folder, in
  .heartcode/models.json, and restored when you open that folder again; auto stays auto (the file
  is removed). A -m model on the command line still wins for that run.
- The status bar and the working spinner use two lines instead of cramming everything onto one: the
  status shows the model and what it can do on one line, the run's stats and controls on the next;
  the spinner shows what it's doing, with the elapsed time and Esc on the line below.
- When a chosen set or auto rotates to a fallback (the model answering now isn't your first/preferred
  one, because it failed), the status bar marks that model with a yellow "↻" so you can see at a
  glance it came after rotating. No rotation, or back on the first model: no marker.

## 0.1.24 (2026-10-31)

- A pinned model (one picked with /select_model, or -m) is now used by the helpers it spawns too:
  with a model pinned, HeartCode won't hand a helper's job to another of your models, and a
  helper uses the pinned model even if a different one is named. Auto mode still spreads work
  across your models as before.
- A built page is now actually driven like a user before it's called done, not just loaded: HeartCode
  fills the inputs, clicks every button, and toggles every checkbox in the headless browser, and
  any error a control throws (a dead button, a popup that fails) is a must-fix, fed back to the
  model to fix and re-test — like Replit's test-and-fix loop. (Navigation is blocked so one click
  can't end the test.) These failures also become lessons.
- HeartCode now learns from its mistakes in any language, not just web: when something it ran
  failed and then passed after a fix (a Python traceback, a failing test, a build error, a
  broken button in the browser…), it saves the fix as a one-line rule in memory, tagged by
  technology, and recalls it on later tasks of the same kind so the mistake isn't repeated.
  Near-duplicate lessons are skipped. A rerun only counts as a fix if a file was edited between.

- When the model uses any external tool, library, API or framework, it now goes to the official
  source first — always, even when it's sure it knows — assumes its memory is stale, relearns the
  current way from that official page, then acts on it. Official docs/sites/repos come first;
  blogs, listicles and memory are a last resort. (A change to the project's own code, or a question
  the code answers, still needs no lookup.)
  This reminder is repeated across the prompt (research, how it works, on a failure, using a tool,
  every message, and for small models) so a model is far more likely to actually do it.

## 0.1.23 (2026-10-31)

- The "retrying in 0 seconds" message no longer lingers on the spinner while the retried request is
  in flight: the countdown is cleared the moment the wait ends and the new request starts.
- "Make sure it works" now applies to everything the model builds, not just web pages: before it
  finishes it must run what it made and see it work — a CLI with real input, a server by calling
  its endpoints, a library by a small usage snippet, tests if there are any — not just "no error".
- A page the model builds is now checked that it actually works, not just how it looks: HeartCode
  reads the browser console when it opens the page, and any JavaScript error (an unclosed brace, a
  wrong name, a blocked resource) is a must-fix blocker fed back to the model before it can finish.
- While retrying, the retry message and the "responding / waiting for model" timer are on separate
  lines instead of one long line that got cut off.
- A page the model builds is now checked that it actually works even when no browser is available,
  and verification never passes silently: HeartCode statically catches JavaScript that doesn't
  parse and the Tailwind-CDN @apply trap (applying a class you defined yourself, which throws
  "Cannot apply unknown utility class"); and if it couldn't open the page in a browser at all,
  the model is told so and must verify it itself before finishing, instead of assuming it's fine.
- A model pinned in one CLI (/select_model) is now truly session-local: changing the model order
  on the settings page (or in another instance) no longer unpins it or switches its model — that
  only affects instances on auto. The pin isn't written to disk either, so it can't become
  another instance's #1. (Before, a model-order change silently switched every running instance.)
- /select_model now picks the model(s) for this session: tick one to pin it (no rotation), several
  to rotate among just those, or all/none for auto (your whole list). /select_model <model> pins,
  /select_model a, b, c chooses a set, /select_model auto goes back to the list. It's session-local
  — your saved ranking (settings page) is untouched and stays the default for new sessions. The
  status bar shows it: "auto (model) (N)", a pinned model's name alone, or "model (K chosen)".
  A single pinned/chosen set is also what spawned helpers use (no handing off outside the set).
  In the picker, Ctrl+A ticks all and Ctrl+N unticks all, so you can clear then tick what you want.
- Command and @file suggestions now show while the model is working, not only at an empty prompt:
  type `/` or `@`, use ↑/↓ and Tab to complete; Enter queues the command to run when the task is done.
- The browser (chrome-devtools) no longer litters the project: it runs in its own scratch directory,
  so a screenshot or snapshot the model saves by a bare name (screenshot.png, snapshot.txt) lands
  there instead of the project folder. Pages are still opened by absolute path, so nothing breaks.
- The built-in Chrome (chrome-devtools) runs headless (no window) with its own throwaway profile, so
  it doesn't pop up a window, works over SSH, and runs don't fight over one profile. Override `args`
  in ~/.heart/mcp.json for a visible browser.

## 0.1.22 (2026-10-31)

- Times are written out: "responding 5 hours 33 minutes", "took 1 minute 25 seconds", "retrying in
  10 seconds", "thought for 12 seconds", "resumed … 3 hours ago" (the two biggest units).
- Ctrl+R no longer starts voice: /voice does (keybindings.json can still give it a key).
- Click a tab to go to it.
- /rewind puts a message of several lines back in the input box whole (only its last line came back).
- The key hints say what a key does: "Shift+Tab change permissions", "Ctrl+T open a new tab".
- Finding its way in a project, in this order: the model sees every entry of the project root
  (names only; what .gitignore leaves out is marked), then goes folder by folder (list_files with
  a path) and searches; a language server only when the task needs code followed across files.
- Language servers are the model's choice, for any language: it finds out which one fits, checks
  it's installed, and uses it with the new lsp tool (definition, references, hover, errors).
  HeartCode remembers it for the project, and checks each edit of such files with it. No built-in
  list any more.
- find_command: the model checks whether a command is installed before it relies on it (instant,
  runs nothing).
- Building a UI: the model researches the best real examples of that exact kind of screen and
  the current UI library for the stack, writes a design brief and its own checklist from them,
  builds with the library, then looks at screenshots (desktop and phone) and fixes what's off. A
  model that can't see has one of your models that can check them.
- The status bar says how many providers are on and how many models are in your list:
  "local (2) · qwen3 (3)".
- A queue for messages typed while it works: Enter adds one (shown above the input, numbered).
  When the answer is done they go all together, as one message, or one by one: Ctrl+_ switches
  (saved). Ctrl+] stops the answer and sends the first one now, Ctrl+\ sends them all now, as one
  message (one request). The model no longer gets them in the middle of an answer.
- Web search asks several engines at once and puts their results together: public SearXNG
  instances (from searx.space; five at a time, the next five when none answers well, pages 2–3
  when the first has few good results), Mwmbl, DuckDuckGo, and for coding questions Stack Overflow,
  npm and GitHub. Each result is ranked by the query's words in it (rare words count more) and by
  how many engines found it, and says where it came from. Searching fails only when every engine
  does; then the model is told search can't be reached, instead of "try other words" again and again.
- What the model makes: stability and UI/UX come first.
- A page it builds or restyles is opened in the built-in browser when it says it's done: a model
  that can see reviews the screenshots (desktop and phone width) in a request of its own and lists
  what's wrong, and the model fixes it (twice per message at most).
- A reply that goes into a loop (the same text over and over) is cut, and the model asked again.
- A path the model copied wrong (the project's long path without its first "/", or with folder
  names run together) is read as the project path it meant; a command that went outside the
  project says where the project is.
- Searches, page reads and file reads asked for in one reply run at the same time, and servers are
  asked for several calls per reply (parallel_tool_calls). The model is told to look things up
  together, and to get everything a task needs before doing it, as much as it takes.
- A search, page, read or command made again in the same message, with nothing changed since,
  isn't run again: the model gets the earlier result. Ten such repeats stop the message; four
  failing commands in a row get a "rethink this" note.
- The model researches the kind of thing it's asked to make, not the names in the request, and
  installs only what its plan needs, after making sure it's the real one.

## 0.1.21 (2026-10-31)

- How long HeartCode took to answer: the spinner counts "responding 45s" while it works, and when
  it's done a line stays under the answer ("✻ took 1m 12s"). Time spent waiting for your answer
  to its questions isn't counted, and the line doesn't keep counting after it's done.
- The mouse wheel scrolls just the conversation: the tabs, the input and the status bar stay where
  they are.
- Select text in the conversation by dragging with the mouse: it's highlighted and copied when you
  let go ("copied 42 characters"). A click or a key clears it.
- Keys to scroll the conversation: Shift+↑/↓ (3 lines), Alt+↑/↓ or PgUp/PgDn (a page).
- Closing a tab (Ctrl+Q, or the new /close_tab) asks first.
- The model's answers are drawn as Markdown as they stream in: headings, **bold**, *italic*,
  `code`, lists, quotes, code blocks and rules (/copy and /export keep the Markdown as written).
  The thinking too, and answers in sessions and tabs from before, when they're shown again.
- The model is told to give choices as a numbered list, and to keep to simple Markdown (no tables).

## 0.1.20 (2026-10-31)

- The settings page's accent is green.
- A System / Light / Dark switch at the bottom of the settings page's sidebar (System follows your
  computer's setting).
- Voice works like Claude Code's: /voice (or Ctrl+R), Space to talk (again to pause, again to go
  on), Enter to finish, Esc to cancel; what you say shows in the input box as you say it.

## 0.1.19 (2026-10-30)

- The settings page, redone: one accent color, calmer lists (a row's buttons
  show when you point at it), clearer type, hover, press and focus states, dialogs that animate in,
  and a layout that works on a phone too.
- A provider switched off is gone from everywhere it was still showing: the status bar (it showed
  the off provider's model when only one other model was on), `heart providers`, /select_model,
  and on the settings page Your models, its count, Test all and the provider ranking. Its models
  keep their places in your list for when it's on again.
- /rewind numbers your messages, newest first.
- The settings page says "Disconnected" and can't be used once it's turned off (in HeartCode or
  with Ctrl+C), instead of failing quietly.
- The compaction switch on the settings page says 85%, as it is now.

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
