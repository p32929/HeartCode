

# HeartCode

A coding agent for your terminal. It works with any OpenAI-compatible model: free ones, paid
ones, local ones, several at once.

**Zero dependencies.** Only Node.js (22 or newer) and HeartCode's own code. No `node_modules`, no
install scripts. What you install is what you can read.

<!-- SCREENSHOT: HeartCode in the terminal, answering a message -->

## Why I made it

Not to compete with other coding CLIs. I made it for myself, because none of the ones I tried
did what I needed.

**Safety first.** A coding CLI runs with your files, your keys and your shell. Most pull in
hundreds of npm packages, and any of them can be hijacked to ship malware in an update. HeartCode
has none, so there's nothing for anyone to poison.

## What it does differently

**It keeps working when a model doesn't**
- Give it a list of models, from any providers (free ones too). When one hits a rate limit, goes
  down or fails, the next one answers and the work goes on. A ↻ in the status bar shows it.
- When a conversation gets too long for a model, it moves to one of your models with more room
  instead of summarizing things away.
- When a model goes round in circles, another takes over. Only you stop it (Esc).
- A model that shows it can't do the task (stuck, going round, or saying "done" while the work is
  still broken) hands it to the best-ranked of your models it hasn't tried (LMArena's rankings),
  not just the next in your list. Your list still decides who starts, and who answers when one is
  down.
- Models are told to say when they're stuck, and believed: first a different approach, then a
  second opinion from another of your models, then the next model takes over (not another version
  of the same one). The same happens when a model says "I can't" without trying its tools, or
  answers again without doing anything after being told it isn't done.

**It works carefully**
- It asks what you want before it builds, reads the current docs before it uses something, and
  makes a plan before it changes anything.
- It runs and tests what it changed before it says "done", and another of your models checks the
  result against what you asked.
- A web page or game it changed, HeartCode opens in a real browser itself before it accepts "done":
  errors, a blank page or a canvas that draws nothing send it back to work, whatever the model's own
  checks said.
- It writes the least code that works and changes only what the task needs.

**It learns, per project**
- Every web page it reads is saved in `.heartcode/research/`.
- After a task, it saves what's worth knowing as notes (`.heartcode/memory/`) and deletes the junk
  and throwaway files, in the background.
- A mistake it fixes becomes a lesson it won't repeat. So does what blocked a task, or what got it
  unstuck, so the next task like it starts knowing.

**It gets good work out of small and local models**
- Models that can't call tools are guided one simple question at a time.
- What each model can do comes from [models.dev](https://models.dev), so nothing is wasted
  finding out.
- It sends only what's needed, and never sends `max_tokens`, so no reply is cut short.

**And the rest you'd expect**
- **Set up in a web page** (`/settings`), not by editing config files.
- **Skills, MCP servers and hooks** in Claude Code's formats; `/import` brings yours over.
- **Tabs** (`Alt+T`) and git worktrees, for work kept apart.
- **Servers in the background**: the model starts a dev server and keeps working. `Alt+B` shows
  the running ones' logs live (`A`: the stopped ones too).
- **Telegram messages** when a task finishes, fails or waits for you.
- **Logs** of exactly what you choose (seven kinds, all off by default), readable on the settings page.
- **`heart -p`** runs one task without the screen, for other tools and AI agents, like `claude -p`
  (see [SKILL.md](SKILL.md)).
- **`heartcode page index.html`** checks a web page in a real browser (errors, blank page, faint
  text, missing icons) and saves desktop and phone screenshots.
- **`/context`** shows what fills the context window. `/update` installs a newer version.

## What happens when you ask it to make something

1. **It asks first.** If your request leaves something open (how it should look, how far to go,
   whether to test it), it asks you, with its own suggestion first. Small fixes it just does.
2. **It reads up** on whatever it's about to use, instead of trusting its memory.
3. **It makes a plan**: a todo list you can see. Its first change of each message waits for one.
4. **It does the work**: reading files, running commands, editing.
5. **It splits the work, if you want.** When the plan has several steps, HeartCode asks: several
   agents at once, or one? With several, steps that stand alone run at the same time, each on its
   own files and on the model best at it. A step no model is sure to do well is done by two of your
   best-ranked models, each in a copy of the project, and the better result is kept (HeartCode checks
   both, another model picks). Nobody to answer (`heart -p`): several. Pick your helpers yourself
   (below), or let HeartCode pick them; without any, it can use any of your models. Every step on
   screen names the model doing it.
6. **It checks before it says it's done**: it must have tested what it changed, finished its todo
   list and made the files it names. A web page it changed, HeartCode opens in a browser itself.
   Then your next models say yes or no (also when it changed no
   files but ran commands or a browser); a no sends it back.
7. **It tidies up** in the background: saves notes for next time, removes throwaway files.

## How I set it up

There are many ways to set HeartCode up. This is how I do it: every free model I can get, tested,
the ones that work kept, the best at coding first.

### 1. Install

```sh
npm install -g heartcode
```

Or from source (installed the same way: `/update` updates it):

```sh
git clone https://github.com/p32929/HeartCode.git
cd HeartCode
npm start
```

### 2. Run `heart` in your project

```sh
cd ~/code/my-app
heart
```

### 3. Open the settings page

Type `/settings`. The page opens in your browser. Its link also works from another device on your
network (handy when HeartCode runs on a server over SSH). Only that link works: it has a secret
key. A running HeartCode picks up your changes right away.

<!-- SCREENSHOT: the settings page -->

### 4. Add your providers and pick their models

On **Models → Providers**:

1. **+ Add a provider**: its name, base URL and API key. A preset fills in the URL.
2. **Pick models.** I take all of them: tick the box at the top (*select every model shown*), then
   **Add N to the list**. Or click a model to add just that one.
3. Do the same for every provider you have.

<!-- SCREENSHOT: Models → Providers, models ticked, "Add N to the list" -->

### 5. Update model info

On **Models → List**, click **Update model info**. It fetches what each model can do and costs
(from [models.dev](https://models.dev)) and its places in LMArena's public rankings for coding, web
apps and vision. The rankings become columns you can sort by (step 9).

### 6. Test all

Click **Test all**. It sends each model a short message and shows in the *Works?* column which ones
answer, and how fast.

Why: most providers have free and paid models side by side, and not every model they list works
for your key. The test shows which ones really answer for you. (A paid model charges for its few
tokens.)

The three time limits next to the buttons are already set the way I use them:

| Setting | Default | What it does |
|---|---|---|
| **Give up** | 45 s | How long a model gets to start answering (its first word, thought or tool call). Nothing by then: it counts as failed and the next model takes over. |
| **Stalled** | 60 s | How long a reply may go quiet once it has started. A model that keeps sending is never cut off; one silent for this long is asked again, or another takes over. |
| **Tests wait** | 60 s | Only for the Test buttons: how long each model gets to answer the test message. No answer by then shows as *no answer*. |

Give up and Stalled apply to real work too. They're kept consistent: Stalled and Tests wait are
never shorter than Give up. Change one so they would clash and the other moves with it (the page
says so). Hover any setting for what it does.

<!-- SCREENSHOT: Test all running, the Works? column filling in -->

### 7. Wait for every test to finish

With many models this takes a while. When it's done, a message says how many work.

### 8. Keep only the ones that work

In the filters above the list, set *Result* to **✓ Works**. Only the models that answered show.

### 9. Sort by coding

Click the **`</>`** column header (*Coding*): the 9th header counting from *#*, right after the
wrench, bulb and image icons, before the globe and eye. The models best placed in LMArena's coding ranking come first. #1 is
the one HeartCode uses first, so the best coder answers, and the next ones take over when it fails.

<!-- SCREENSHOT: filtered by Works, sorted by Coding -->

### 10. Save

Click **Use only these N**. HeartCode uses just these models, in the order shown. The others stay
under Providers, and the sort and filter stay as they are for next time.

### 11. Back to HeartCode

Go back to the terminal. While the settings page is on, HeartCode shows a dialog and waits.
**Turn off** is selected: press Enter to stop the settings page. Your changes are already in.

<!-- SCREENSHOT: the "settings page is on" dialog -->

### 12. Start coding

Ask it to read, change, run and fix things in your project, like any coding agent.

- `/` shows every command; `heart --help` lists the rest.
- `Shift+Tab` changes what it may do without asking.
- `Esc` twice stops it; `Esc` also closes a dialog.
- While it works, `Enter` queues a message. `Esc` (or `↑`) takes queued messages back into the box
  to change or drop, without stopping the work.
- `Shift+Enter` (or `Option+Enter`) adds a new line. `Alt+O` shows all of the model's thinking (two lines
  of it show otherwise), `Alt+L` the whole plan (three of its steps show while it works). The same
  call made again and again shows once, with a count (×4).
- While it works, commands that don't change the conversation (`/help`, `/cost`, `/diff`,
  `/settings`…) run at once; the ones that do (`/compact`, `/rewind`…) wait until it's done.

## More on the settings page

What's in the sidebar:

- **Models**: *List* (the models HeartCode uses, in order) and *Providers* (where they come from).
- **General**: what it may do without asking, colors, thinking effort, voice input, web search,
  and the *Status bar* (drag and drop what it shows). **Notifications**: Telegram.
- **Skills**, **MCP servers** and **System prompt**: what HeartCode can do and what it's told.
- **Advanced**: *Logs* and *Files* (the rest of the settings, as files).

On **Models → List**, also:

- **Drag rows** to fine-tune the order. **Clear sort** puts the list back in its own order; **Clear
  all** turns off the filters too.
- **Filter** by name, provider, test result, context, abilities or free.
- **Helpers**: the models #1 can hand parts of a task to. In the *Helper* column, switch a model on
  and pick what it's good at: **UI & visuals**, **Code & logic**, **Big & hard**, **Quick & cheap**
  (hover an icon to see what it covers). **Suggest helpers** proposes them from the models that
  passed **Test all** and the rankings; or set *Helpers* (at the top) to **Automatic**. *Used*:
  which helper #1 takes first: **by score** (the default: best placed in LMArena's rankings first),
  in your order, or by your provider ranking.
- A model *not found* in models.dev: **Retry** looks it up again, or **Set up** tells HeartCode what
  it can do.

### Recommended: let it see what it builds

Out of the box, HeartCode reads, writes and runs code. It can't see a page it made or click
through an app. These three fix that. They're optional, but you'll get much better results with
them, especially for anything with a screen.

**The design skill**: so the pages and apps it makes look right.
AI-made interfaces often look generic, crowded or broken. This skill gives the model a method
(understand the job, break the design down, take every size and color from one system, check it)
plus a theme, a starter page and guides for common components, in shadcn/ui's look.
- Install: **Skills** → paste `p32929/p32929_design_skill` in *Install a skill* → **Install**.
  Or type `/install_skill p32929/p32929_design_skill` in HeartCode.
- The model loads it when a task is about how something looks. To have it in every message, set
  *Who uses it* to *Always on*.

**Chrome DevTools MCP**: so it can check web pages in a real browser.
The model opens what it built in Chrome, clicks through it, reads the console errors and takes
screenshots, instead of guessing whether it works.
- Install: **MCP servers** → **+ Add a server** → paste `npx -y chrome-devtools-mcp@latest --isolated`
  → **Add server**. Its name (*chrome-devtools*) comes from the command.
- `--isolated` gives it a fresh browser profile each time, so it never touches your own Chrome.
  Add `--headless` with the *+ flag* box to hide the window; untick a flag to turn it off.
- Needs Google Chrome installed.

**Computer use MCP**: so it can use apps outside the browser.
Screenshots, mouse, keyboard and apps on your computer: for testing a desktop app or a game, or
anything a browser can't reach.
- Install: **+ Add a server** → paste `npx -y @zavora-ai/computer-use-mcp@latest` → **Add server**.
  Its name is *computer-use*.
- On macOS, give your terminal app **Accessibility** and **Screen Recording** access (System
  Settings → Privacy & Security), and install the Xcode command line tools
  (`xcode-select --install`).
- It can click anything on your screen. Switch it off in the list when you don't need it.

For screenshots to be useful, one of your models must be able to see images. If #1 can't, it
hands the looking to the first of your models that can.

**Also useful:**
- **Notifications**: a Telegram message when a task finishes, fails or waits for you. Make a bot with
  [@BotFather](https://t.me/BotFather), paste its token, press Start in the bot; HeartCode finds your chat.
- **Advanced → Logs**: switch on only the kinds you need and read them there (by run, searched,
  live). Logs older than 3 days are deleted.

## Thanks

A lot of what HeartCode handles, I learned from other coding agents and the problems they ran into
first. Thank you to [Reika](https://github.com/alexwkleung/reika) (its measured findings on small
models: sending a "no, do this instead" as your own message, counting code's tokens honestly,
keeping the provider's prompt cache, checking what uses a changed function, saving what the model
found before compacting), [OpenCode](https://github.com/anomalyco/opencode),
[Cline](https://github.com/cline/cline), [OpenClaw](https://github.com/openclaw/openclaw) and
[Pi](https://github.com/earendil-works/pi), for the many use cases like these they showed me. Its
working rules (ask before building, root cause first, the least code that works, prove it, answer
short) come from Karpathy's guidelines, Grill Me, Superpowers, Ponytail and Caveman.

## License

[MIT](LICENSE)
