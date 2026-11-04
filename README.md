

# HeartCode

A coding agent for your terminal. It works with any OpenAI-compatible model: free ones, paid
ones, local ones, several at once.

**Zero dependencies.** Only Node.js (22 or newer) and HeartCode's own code. No `node_modules`, no
install scripts. What you install is what you can read.

<!-- image: HeartCode in the terminal, answering a message -->
![HeartCode in the terminal](https://res.cloudinary.com/m0jnrul4/image/upload/v1793485425/Screenshot_2026-11-01_at_2.23.35_AM.png)

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
- When a model goes round in circles, the next one takes over. Only you stop it (Esc).

**It works carefully**
- It asks what you want before it builds, reads the current docs before it uses something, and
  makes a plan before it changes anything.
- It runs and tests what it changed before it says "done", and another of your models checks the
  result against what you asked.
- It writes the least code that works and changes only what the task needs.

**It learns, per project**
- Every web page it reads is saved in `.heartcode/research/`.
- After a task, it saves what's worth knowing as notes (`.heartcode/memory/`) and deletes the junk
  and throwaway files, in the background.
- A mistake it fixes becomes a lesson it won't repeat.

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
  their logs live.
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
3. **It makes a plan**: a todo list you can see. It can't change a file before there's one.
4. **It does the work**: reading files, running commands, editing.
5. **It may split the work.** Your #1 model can hand a job to a helper, or run separate parts at
   the same time, each on its own files. Helpers use your models in your order. The model decides.
6. **It checks before it says it's done**: it must have tested what it changed, finished its todo
   list and made the files it names. Then your next models say yes or no; a no sends it back.
7. **It tidies up** in the background: saves notes for next time, removes throwaway files.

## How to set it up

### 1. Install

```sh
npm install -g heartcode
```

Or from source (a `git pull` then updates it):

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

<!-- image: the settings page -->
![The settings page](https://res.cloudinary.com/m0jnrul4/image/upload/v1793485584/8396c407-f5f8-48af-a242-0b5cbc1c0331.png)

What's in the sidebar:

- **Models**: *Your list* (the models HeartCode uses, in order) and *Providers* (where they come from).
- **General**: what it may do without asking, colors, thinking effort, voice input, web search,
  and the *Status bar* (drag and drop what it shows). **Notifications**: Telegram.
- **Skills**, **MCP servers** and **System prompt**: what HeartCode can do and what it's told.
- **Advanced**: *Logs* and *Files* (the rest of the settings, as files).

### 4. Add a provider and pick models

On **Models → Providers**:

![The settings page](https://res.cloudinary.com/m0jnrul4/image/upload/v1793485944/HeartCode-Settings-11-01-2026_02_28_AM_1.png)

1. **Add a provider**: its name, base URL and API key. A preset fills in the URL.
2. **Pick models**: click a model to add it to your list. I use the free ones.

### 5. Put your list in order

On **Models → Your list**:

1. **Sort.** Click *Abilities*, then *Context*: the most capable models come first, the biggest
   context window first among those. Click **Save order**.
2. **Drag rows** to fine-tune. #1 is the one HeartCode uses; the rest are its fallbacks, in order.
3. **Test** (optional): **Test all** sends each model a short message and shows which answer and
   how fast (*Works?*). Sort by it to put the fastest first.
4. **Filter** (optional): by name, provider, test result, context, abilities or free. **Use only
   these** keeps just the ones you see, in that order.

**Update model info** fetches what each model can do and costs (from models.dev) and its places in
LMArena's public rankings for coding, web apps and vision, as columns to sort by. A model *not
found* in models.dev: **Retry** looks it up again, or **Set up** tells HeartCode what it can do.

### 6. Recommended: let it see what it builds

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

### 7. Back to HeartCode

Go back to the terminal. While the settings page is on, HeartCode shows a dialog and waits. Your
changes are already in.

### 8. Press Enter to stop the settings page

**Turn off** is selected: press Enter.

<!-- image: the "settings page is on" dialog -->
![The settings dialog](https://res.cloudinary.com/m0jnrul4/image/upload/v1793486060/Screenshot_2026-11-01_at_2.34.15_AM.png)

### 9. Send "Hi" as a test

Type `Hi` and press Enter. A reply means your model works.

### 10. Start using it

Ask it to read, change, run and fix things in your project, like any coding agent.

- `/` shows every command; `heart --help` lists the rest.
- `Shift+Tab` changes what it may do without asking.
- `Esc` stops it, or closes a dialog.
- While it works, commands that don't change the conversation (`/help`, `/cost`, `/diff`,
  `/settings`…) run at once; the ones that do (`/compact`, `/rewind`…) wait until it's done.

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
