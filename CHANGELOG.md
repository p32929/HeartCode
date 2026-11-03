# Changelog

What changed in each version of HeartCode, newest first.

## 0.1.41 (2026-11-03)

- **Model scores on Your models**: Coding, Web apps and Vision show each model's LMArena score with
  its place (`1478 #60`; hover for the votes); green is the top tenth. The page opens fast again
  with thousands of models (each name matched once, not once per ranking entry).
- **Your models in three rows**: the title with Order providers and Update model info (models.dev
  and the scores in one click); the settings on one line with short names (Pick, If one fails, Give
  up after, New message to, Tests wait); search, filters, the count, Clear, Test all and Save order
  on one line. The sort shows in the column heads.
- **Best fit said plainly**: with Pick on "the best for each task", the page and the sidebar say
  each message goes to the models that score best for it (not "HeartCode uses #1"), and Order
  providers is off, with why on hover.
- **The list holds still while models are tested** (or Update model info runs): filters, sorting,
  the settings, dragging and each row's changes wait; Stop and Request still work.
- **Settings from another device**: the link shows your machine's network address
  (`http://192.168.1.108:43135/?t=…`) and the page answers there; only with its key, and only to
  this machine's addresses.
- **Slash commands leave nothing behind**: a command shows a toast for a few seconds; what it shows
  opens in a dialog, and nothing stays in the conversation.
- **/import asks before a duplicate**: one you already have (same name, same text, or the same MCP
  server under another name) is marked, and added only if you say so, under a new name.
- **Removed**: /test_model and `heart probe` (models.dev says what a model can do), and the
  settings only those tests could switch on.

## 0.1.40 (2026-11-03)

- **A smaller, general system prompt** (about 6,700 tokens to start a task, from 13,000+): its rules
  in working order (ask what they want → research and plan → find your way → write code → install
  tools → prove it works, then stop → keep going → how to answer), the discipline skill merged into
  them (no separate copy), nothing about one kind of project: a check is "the way the person will use
  it", for a page, a script or a server alike. Gone: the web UI guide, the reminder on every
  message, the automatic page review with screenshots, and asking models what they're good at
  (best fit's rankings do that). Your other models in a short list; an MCP server's own
  instructions sent once, the first time its tool is used.
- **Your terminal's mouse**: HeartCode no longer takes the mouse, so text is selected and copied the
  terminal's own way, over SSH too (to the computer you connect from). `"mouse": true` in config.json
  brings back the wheel scrolling the conversation and drag to copy.
- **A model that doesn't start answering** within the time allowed: a helper, the image describer or
  the reviewer goes to your next model at once, not after three more waits.
- **Gemini, then another model**: Gemini's tool-call signature goes back to Gemini only; Mistral and
  others refused the request with it (422).
- **/update's changelog** wrapped at words, not mid-word, and a list item's lines joined.
- Lessons learned from a fixed mistake are tagged by the tool that failed (npm, python3, cargo…).

## 0.1.39 (2026-11-03)

- **Best fit picks by public rankings**, not by a model's opinion of models: for each new message,
  one short request names the skills the task needs (web pages, code, images, long inputs…), and
  your models are ranked by their places in LMArena's rankings of those skills (people comparing
  two models' answers, per skill). The best becomes the lead, the next take over when it fails; the
  code review and the page review go to the best-ranked others (not the lead). Models the rankings
  don't know come after, in your order. The rankings are fetched once a week into
  ~/.heart/rankings.json, and only in best fit: with "your order", your list is followed as it is.
- **Your models shows each model's ranks**: Coding, Web apps and Vision columns (its place in
  LMArena's ranking; the top tenth in green), sortable like the others, with Get rankings /
  Refresh rankings above the list.
- **Gemini 3.x works with tools**: the thought signature Gemini sends with each tool call is kept
  and sent back, so its second step is no longer refused (400 "missing a thought_signature").

## 0.1.38 (2026-11-02)

- **Asks what you want before building**: the questions whose answers change the result (what it's
  for, looks, testing, robustness, scope), in rounds, each with a recommended answer; again for a
  new message that leaves things open. The answers are kept with the conversation and steer the
  checks and reviews: a demo isn't sent back for polish or tests nobody asked for. The UI guide and
  the page review only go for looks when looks were asked for. When it made something that runs, it
  ends with how to run it.
- **The discipline skill**, built in and always on (from Karpathy's guidelines, Grill Me,
  Superpowers, Ponytail and Caveman): think first, ask in rounds, root cause first, done-when and
  non-goals, the least code that works, surgical changes, test first when tests are wanted, evidence
  before claims, stop when proven, answers kept short. Skills with `use: always` go in every message;
  Make my own copy on the settings page to change it or turn it off.
- **Your models, by strength**: what each model is good and weak at is learned once (a web search,
  kept in model-strengths.json for every project) and shown to the model with your test results.
  The plan's parts can go to other models at the same time (parallel, model, files), each helper
  changing only its own files. **Best fit** (Your models → HeartCode picks the model by): for each
  new message the models that suit it best do the work, review it and check pages; your order breaks
  ties. `--model-choice order|fit` for one run.
- **Nothing hangs**: every command can carry on in the background, the model choosing how long to
  wait and checking back; processes a command leaves running (`server &`) are kept as background
  commands instead of killed. A reply must start within 60 seconds (Your models: A reply must start
  within), then the next model answers; reviews, picks and summaries are streamed too, so a silent
  model is given up on.
- **Nothing lost**: the conversation is saved after every step, so a crash or kill mid-task loses
  nothing and "continue" picks it up; the answers to its questions and folders named earlier come
  back too.
- **Logs, kind by kind**: requests, tools & commands, model choices, the agent's decisions, errors,
  the conversation, debug, each switched on by itself (all off by default), a file per kind per run;
  read on the settings page by run, searched and live.
- **Updates**: a newer HeartCode is shown at start and in the status bar (asked of npm once a day);
  `/update` shows what changed and installs it the way you installed HeartCode (a git checkout:
  git pull). Check for updates on General.
- Reads folders your message names (read only, outside the project); MCP arguments mended from the
  tool's schema (a missing page id, msgId for msgid, a value for a list…); page syntax errors with
  their line; "enough checks" after five with nothing changed; a nudge at the third change to the
  same spot; plan-first holds back the whole reply.
- Scrolled up, the conversation stays where you're reading while the answer comes in;
  Alt+Shift+↑/↓ (or Ctrl+Home/End) to its top and bottom.

## 0.1.37 (2026-11-02)

- Settings page, Your models: filters (search, provider, test result with counts, context, tools,
  thinking, images, free) that combine and are kept. Filtered, **Use these N** makes the models shown
  the only ones HeartCode uses, in the order shown (asked first; the others stay under Providers);
  Test N shown tests just them; dragging works while filtered. The page laid out in full-width rows:
  the list's settings in three cells, filters on one line, what's shown and the list's actions on
  one line, the column names (or the selection's actions) sticky above aligned rows.
- The whole settings page with icons and colors: each part's icon on its own color in the sidebar
  and on its title, buttons with icons colored by what they do, card titles with icons, less room
  around pages and cards, General's cards packed in two columns, rows' actions as icon buttons,
  Providers one line a model.
- Saving the list builds the page's state once, not three times (the server skips its own writes);
  a sort or filter changed on the page isn't undone by an older state.
- Contexts with two decimals (1.05M, not rounded up to 1.1M), on the page and in the status bar;
  the exact count on hover. Checked against models.dev for every model: the data is right.
- Logs are kept 3 days by default instead of 30 (Advanced → Logs changes it).

## 0.1.36 (2026-11-02)

- Voice: Space in an empty box (or /voice) starts listening at once, no second key; what you say
  shows in the box as you speak, and Enter sends it, all of it as one message. Keys wait while the
  last part is transcribed (an Enter then sent only the part heard so far, and the rest stayed in
  the box). Esc cancels; Space pauses and goes on. While a task works, it's sent as typed then.

## 0.1.35 (2026-11-02)

- Settings page, Your list: every column sorts by the value it shows, ↑ smallest first and ↓
  largest first, the first click the useful way (Model A→Z, Provider your ranking, Context and
  Abilities most first, Tools/Thinking/Images with first, prices cheapest first, Works? fastest
  first). Works? sorts by the test's time; failed and untested models (no time), unknown prices and
  contexts are last either way (untested before failed). Clicks still stack sorts (each breaks the
  ties of the ones before). A sort kept from before is converted.
- A sort redraws the table once (it was redrawn again half a second later, when the page's own
  saved sort came back from the server as a change); the header spins until the new order is drawn,
  and while tests run the sort line says the order moves as results come in.
- Stop (and every button in the table) works at the first click while tests run: the table was
  redrawn at every result, replacing buttons between a click's press and release. Now it's redrawn
  at most every 400 ms, never while the mouse button is down, Stop keeps its place and acts on press.

## 0.1.34 (2026-11-02)

- Model tests on the settings page (Test all, Test selected, a row's Test and Hello) wait 10
  seconds for an answer by default, not 90; the Timeout box next to Test all changes it (1 to 600
  seconds, kept in the config as testTimeout).
- Sorting by Works? puts the fastest working model first (by its test's time), then the untested,
  then the ones that don't work.

## 0.1.33 (2026-11-01)

- Text you may need can be selected and copied, not only the conversation: drag to select (copied
  when you let go), double-click to copy a word (an address, a path, a model's name). Inside a
  dialog (the settings page's address, /help, /context, /diff, the background logs, a permission's
  command, the choices), the header's folder (a double click copies the whole path, also when it's
  shown cut), the input box and the status bar. Not the tab bar, the borders or the key hints. A
  plain click in a dialog still does its job (a tab in the background logs). /help lists it, and
  Shift+drag (Option+drag on macOS) for the terminal's own selection.
- Windows: the browser opens through Windows' URL handler (rundll32 url.dll,FileProtocolHandler)
  instead of `cmd /c start`, for /settings and an MCP server's sign-in page.

## 0.1.32 (2026-11-01)

- Dialogs: pickers (`/select_model`, `/resume`, `/rewind`, `/export`…), permission questions, typed
  questions (`/rename`, "what should it do instead?") and what commands show (`/help`, `/context`,
  `/cost`, `/diff`, `/mcp`, `/doctor`, `/model_info`) open in a box over the conversation: 70% of
  the width, as tall as what's in it (70% at most), everything behind dimmed. A short list is
  cards (name, description under it); a permission shows what it's about (this task's last lines)
  above the choices; long text scrolls. Esc closes any of them; a question the model asks closes
  an open dialog so it can be answered.
- Commands that run in the background: `run_command` with `background: true` (a dev server, a
  watcher) answers after a few seconds and keeps it running; the `background` tool reads its new
  output, lists them, stops one; the model hears when one exits. `⚙ 1 running` in the status bar;
  `Alt+B` (or `/background`) shows their logs live in a dialog, a tab each (←/→, a click), ↑/↓ and
  PgUp/PgDn scroll, K twice stops one and closes its tab. Everything still running is stopped when
  HeartCode exits. Alt+B only acts in an empty box (Option+← sends the same keys: the word jump).
- `/context`: what fills the context window, part by part (system prompt, tools, your messages,
  notes, replies, tool results whole and as pointers), the room left, and the biggest pieces.
- The wrap-up after a task (notes, research pages kept or dropped, throwaway files removed) runs
  after the answer is back, beside what you do next, on a connection of its own; it keeps a file a
  new message may use. `heart -p` prints the result first and exits once it's done; `/exit` waits
  for it.
- Web search: your own SearXNG (settings page → General → Web search: its address in its own row,
  with Test), and the engines in the order you set (↑/↓, each switchable). They're asked in that
  order: the next only when one hasn't found enough, failed or took over 3 s; the rest aren't asked
  once there's enough. A SearXNG's JSON API is used when it's on there.
- `/select_model` has an "auto" row (back to your whole list, forgetting this folder's choice), and
  a folder that picked its own models says so at start.
- `/` commands in alphabetical order (the `/` menu and `/help`).
- Settings page: one light/dark button at the top right instead of the switch in the sidebar; on a
  phone, the top bar no longer grows taller than its tabs. Typing and pasting in the SearXNG and
  skill-URL boxes work (an Enter handler cancelled every other key).

## 0.1.31 (2026-11-01)

- Commands typed while HeartCode works run at once instead of waiting in the queue, when they leave
  the conversation alone: `/help`, `/cost`, `/model_info`, `/diff`, `/copy`, `/mcp`, `/doctor`,
  `/toggle_thinking`, `/btw`, `/rename`, `/export`, `/tab`, `/close_tab`, `/exit`, `/settings`,
  `/login_mcp`, `/install_skill`, `/import`, `/voice`, `/select_model`. The ones that change it
  (`/compact`, `/clear_chat`, `/resume`, `/rewind`, `/tree`, `/fork`, `/init`, skills, `/tidy_memory`,
  `/test_model`, `/reset`) still wait until it's done.
- `/select_model` while it works: the task goes on with its models, yours from the next message.
  `/exit` while it works asks first (that stops the task).
- One question on screen at a time: a command's picker and the task's question (a permission)
  take turns instead of drawing over each other.

## 0.1.30 (2026-11-01)

- Settings page: the sidebar is 7 items in 4 groups split by lines (Models · General, Notifications ·
  Skills, MCP servers, System prompt · Advanced); merged pages have tabs (Your list / Providers,
  Settings / Status bar, Logs / Files) and every old address still opens its tab. General is one
  calm column of cards (permissions three across, colors four across, rows with the control on the
  right), and voice input is a form (this machine or a provider, model, language) instead of JSON.
  "Testing…" and warnings are amber, not the green that means "works".
- Headless (`heart -p`) output keeps Claude Code's shape for MCP tools: the `init` event lists each
  as `mcp__<server>__<tool>`, and an MCP call's `tool_use` is named so, with the tool's own
  arguments (it went out as HeartCode's one `mcp` tool since 0.1.28, which programs reading the
  stream, like Nibedita, don't know).
- `--no-memory` now also keeps web pages out of the project (no `.heartcode/research/`), and helpers
  follow it.
- SKILL.md brought up to date: no helper step limit, how the model reaches MCP tools, a model with
  room before summarizing, and what a run leaves (research, notes, the wrap-up) and the extra
  requests it makes (the review).

## 0.1.29 (2026-11-01)

- Telegram notifications: a message on your phone when a task finishes (the task, how long it took,
  the answer), fails (the error), or HeartCode waits for you (a question or a permission). Set up on
  the settings page's new Notifications page: make a bot with @BotFather, paste its token, press
  Start in the bot, and HeartCode finds your chat and says hello. Each kind can be switched off; a
  test button; Disconnect forgets the token. The token is never shown whole or logged; a message
  that can't be sent never holds up the work.
  A token saved before Start was pressed in the bot no longer leaves notifications silently off:
  the chat is found (and saved) the first time one is sent.

## 0.1.28 (2026-11-01)

- When a conversation outgrows the current model's context window and you have other models selected,
  HeartCode now moves to a model with room instead of compacting — nothing is summarized away when a
  roomier model is available. It scans your model list in order, so it picks your highest-priority
  model that can hold the whole conversation; if none of your models has more room, it compacts as
  before (uses what's available). With a single pinned model, nothing changes.
- Learning that actually keeps what it learns, per project:
  - Every web page HeartCode reads is saved whole as Markdown in `.heartcode/research/` (one file
    per page, its address as the name, a header with the URL, title, date and what it was looking
    for; real Markdown tables; the folder ignores itself in git). Helpers' pages are saved too.
  - `web_fetch` takes `look_for`: a long page comes as its outline plus the parts that match, with
    line numbers into the saved file — not just the first 10,000 characters.
  - `web_search` offers matching pages this project already has first (with the date each was read);
    `fresh: true` searches the web anyway. Matching notes and saved pages come with each message.
  - When a task that read the web, ran commands or made files ends, a wrap-up step saves what's
    worth knowing as notes (project or global), keeps each page it read (with what it was used for)
    or deletes it as junk, and removes throwaway files and empty folders the task made.
  - Lessons learned from fixes now go to the project when they only hold there (they all went
    global before); note names are cut at a word's end; saving a note that repeats one says so.
- Less in every request:
  - MCP tools are listed by name with one line each (one `mcp` tool), not each tool's whole schema:
    ~13,400 → ~1,800 tokens for two browser servers. A call whose arguments don't fit gets the
    tool's arguments back with what's wrong (and "did you mean"), and isn't run. The 100-tool cap is gone.
  - Every sizable tool result is saved to a file when it comes (`~/.heart/outputs/`, kept with the
    chat, deleted with it); past 8 long results, all but the newest 4 become a pointer to their file.
  - The UI guide left the system prompt: it comes with a message about a UI, or with the first UI
    file written.
  - Older conversations' MCP calls (made by their own `mcp__server__tool` names) are rewritten as
    `mcp` calls when resumed.
- Done means done:
  - The first file change of a message waits for a plan (the todo list, each step with how it'll be checked).
  - Saying it's done after changing files without running anything since: sent back to check it.
    Naming files as made that don't exist: sent back.
  - Before a task with changes ends, another of your models (or the same one, fresh) reviews it
    against your request, plan, changes and what was run: YES, or NO with what's wrong, which goes
    back to be fixed.
  - Nothing stops a task but Esc: going round in circles (the same call five times, ten repeated
    calls, eight failing commands, replies that loop) hands over to the next model in your list, or
    warns and goes on; a server that keeps failing is waited out, not given up on. Reminders about
    unfinished work repeat as long as the model makes progress (no count). The page check clicks
    every control and looks again whenever pages changed (no 30-button, 2-page or 3-look caps).
- Fixed: tool outputs saved in the same millisecond overwrote each other; HeartCode's own research
  files showed up as a command's file changes (and in /rewind).
- Helpers' replies are shown in full under their name (only the title showed before), printed whole
  when each finishes so helpers working side by side don't interleave.
- Helpers (the agent tool) no longer stop at 25 steps — like the main session, they run until the job
  is done (Esc stops them; --max-turns still applies if you set it).

## 0.1.27 (2026-10-31)

- A built-in computer-use MCP server (@zavora-ai/computer-use-mcp), off by default: switch it on in
  /settings → MCP servers (or see it with /mcp) to let a capable vision model control your desktop —
  screenshots, mouse, keyboard, clipboard. It's off by default because it controls your whole machine
  and needs the OS's screen/accessibility permission and a model that's good at computer use.
- /mcp now lists installed-but-off servers too (marked "off"), not only the running ones.

- Features that need an outside tool now say so. The settings page's General tab has an "External
  tools" card that lists each such feature (voice input, browser preview/UI review, installing skills
  from GitHub), ticks the ready ones, and grays out the rest with what to install — just the name of
  what's needed, since how to install it differs by OS. /doctor shows the same in the CLI.

- MCP servers now show whether they need signing in. In the CLI, /mcp lists every server with its
  status: "local · no sign-in", "signed in", or "sign-in needed". In the settings page, each remote
  server on the MCP page shows a "signed in" / "sign-in needed" badge and a Sign in button (it opens
  your browser; available when the page was opened from HeartCode with /settings). Local servers show
  no sign-in, since they don't need it.

- The settings page's Skills page can install a skill from a GitHub repo or URL (owner/repo, a repo
  link, or a link to a SKILL.md) — the /install_skill command, now a button and input. Skills show
  with the /skill: prefix throughout the page.
- The settings page can import from other coding CLIs (the /import command): "Import from other tools"
  on the Skills page lists the skills, commands, MCP servers, instructions and memory found in Claude
  Code, Cursor, Gemini CLI and Codex, grouped with checkboxes, and brings in what you tick.

- /install_skill <github repo or SKILL.md url> installs a skill straight from GitHub (or any URL) —
  "user/repo", a repo link, a .git URL, or a link to a SKILL.md. It clones (or downloads a tarball)
  and installs every skill it finds; add --project to keep it to this folder. Run it as /skill:<name>.
- /help now lists the keyboard shortcuts (voice, tabs, the message queue, scrolling, permissions,
  stop), read from your effective keybindings.

- Skills are now typed as /skill:name, so they're easy to tell apart from HeartCode's own commands
  (and can't clash with them). The command menu and /help show the /skill: form; typing a bare
  /name of a skill points you to /skill:name. Built-in commands (/help, /settings, …) are unchanged.
- The settings page (/settings) has a visual Status bar editor: drag items into each line, drop some
  on the right to push them to the edge, add or remove lines, turn the whole bar off, and see a live
  preview — no editing config.json by hand. Saved changes apply to a running HeartCode right away.
- Before building, HeartCode now checks what the project already has and reuses it (DRY), keeps code
  clean with self-explaining names, and adds comments only where something is genuinely non-obvious.
- Research is remembered per project: HeartCode checks the project's memory before searching, and
  saves what it learns (a library's API, setup, a design direction, with the source) as a project
  note, so later sessions reuse it instead of searching again.
- Esc no longer stops a running task on a single stray tap: it asks for a second Esc within 2.5s
  first. Flushing the queue (Alt+S / Alt+A) still stops at once.
- When the model describes a next step but stops without doing it, HeartCode nudges it once to finish
  the work (alongside the existing nudge for unfinished todo items).
- The status bar is configurable. "statusBar" in config.json is a list of lines; each line is a list
  of item names (all left-aligned) or { "left": [...], "right": [...] } to push some to the right
  edge. Item names: provider, model, mode, thinking, images, ctx, tps, cost, autocompact, worktree,
  permissions. "statusBar": false hides the whole bar. Left out, it keeps the default two-line
  layout. Changes to config.json apply live. Example:
  "statusBar": [["provider", "model"], { "left": ["ctx", "tps"], "right": ["permissions"] }]
- Text you type while the model is answering keeps its cursor: when the answer finishes, the cursor
  stays where it was in what you'd typed, instead of jumping to the start of the line.
- The built-in keyboard shortcuts moved off Ctrl, which collided with the shell and line editing
  (Ctrl+N/P history, Ctrl+T transpose, Ctrl+Q flow-control, Ctrl+\ quit), onto Alt/Option: tabs are
  Alt+T (new), Alt+W (close), Alt+N/Alt+P (switch, and Alt+1…9 to jump); the message queue is Alt+S
  (send first), Alt+A (send all), Alt+M (change when-done). Ctrl+PgUp/PgDn still cycle tabs for
  terminals without an Option-as-Meta key. Scrolling (Shift+↑↓, Alt+↑↓) is unchanged. On macOS
  Terminal.app, Alt shortcuts need "Use Option as Meta key" on (Settings → Profiles → Keyboard);
  keybindings.json can remap any of them.
- Voice input without the /voice command: when voice is set up, press Space while the input box is
  empty and it starts listening straight away (Space again to pause, Enter to finish, Esc to cancel).
  The shortcut is shown in the header hint ("Space talk (voice)"). With text already in the box, or
  when voice isn't set up, Space types a space as before.

## 0.1.26 (2026-10-31)

- edit_file can now change a file by line number: give start_line (and end_line for a range) with the
  new replace text and no search is needed — so a weak model that can't reproduce the file's exact
  bytes can still edit it, and a line edit can't mis-match. "replace": "" with a range deletes those
  lines. Text-based search still works exactly as before.
- A failed edit_file (the SEARCH text not matching) no longer sends the model in circles. The error
  now shows a line-by-line diff of what it sent (✗) against what the file actually has (✓) at the
  right place — found by how alike the lines are, not loose word overlap — so a one-character or
  whitespace mistake is obvious. If the same file misses twice in a row, the error includes the file
  itself with line numbers (the whole thing if short, else the lines around the target) and steers
  the model to edit by line number (start_line/end_line), copy an exact block, or use write_file —
  so it can't keep guessing. The count clears once an edit to that file lands.

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
