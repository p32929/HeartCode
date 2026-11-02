

# HeartCode

A coding agent for your terminal that works with any OpenAI-compatible model.

**Zero dependencies.** Nothing in `node_modules`, no install scripts, no packages pulled in
behind your back: only Node.js (20 or newer) and HeartCode's own code. What you install is
what you can read.

<!-- image: HeartCode in the terminal, answering a message -->
![HeartCode in the terminal](https://res.cloudinary.com/m0jnrul4/image/upload/v1793485425/Screenshot_2026-11-01_at_2.23.35_AM.png)

## Why I made it

Not to compete with other coding CLIs. I made it for my own use, because none of the ones I
tried did what I needed:

- **No dependencies, so no supply-chain attack.** Coding CLIs run with your files, your keys and
  your shell. Most pull in hundreds of npm packages, and any one of them, or any package those
  depend on, can be hijacked and ship malware in an update. HeartCode has none: no
  `node_modules`, no install scripts, only Node.js and HeartCode's own code. There's nothing for
  anyone else to poison, and you can read everything you run.
- **None of the other CLIs I've used did these**, so HeartCode does:
  - **Rotates through your models on its own, across providers.** Give it a list (free ones
    included). When one hits a rate limit, goes down or fails, the next answers, from another
    provider first, and the work goes on. A ↻ in the status bar shows when a fallback is answering.
  - **Moves to a bigger model instead of forgetting.** When the conversation outgrows a model's
    context window, it switches to one of your models with room before it summarizes anything away.
  - **Researches before it builds.** It assumes what it remembers is out of date and reads the
    current official docs first, not blogs or memory.
  - **Learns, per project, and keeps it.** Every web page it reads is kept whole in
    `.heartcode/research/`. When a task ends it saves what's worth knowing as notes
    (`.heartcode/memory/`), drops the junk and removes throwaway files, in the background, while
    you go on. A mistake it fixes becomes a
    lesson it won't repeat. The next task starts from what's known instead of searching again.
  - **Checks its work before calling it done**: a plan first, a run after every change, and another
    model reviewing the result against what you asked. Going round in circles hands the work to
    your next model; only you (Esc) stop it.
  - **Gets good work out of weak and local models.** Models that can't call tools are guided step
    by step. Edits by line number save a model that can't repeat text exactly. Each model's
    abilities come from [models.dev](https://models.dev), so nothing is spent finding out.
  - **Sends only what's needed.** MCP tools go as names until one is used, old tool output becomes a
    pointer to its saved file, and guides arrive when the task needs them.
  - **Tells you on Telegram** when a task finishes, fails or waits for you, so you can walk away.
  - **Never sends `max_tokens`**, so no provider cuts a reply short by a limit you didn't choose.

### And the rest you'd expect

- **Any OpenAI-compatible provider**, several at once: OpenRouter, Groq, NVIDIA, Gemini, Ollama,
  LM Studio, your own proxy…
- **Set up in a web page** on your own machine (`/settings`), not by editing config files.
- **Usable by other tools and AI agents**: `heart -p` runs one task headless, like `claude -p`
  (see [SKILL.md](SKILL.md)).
- **Logs each request and its reply** in a file of its own when you switch logging on, so you can
  see what went wrong.
- **Takes skills, MCP servers and hooks** in Claude Code's formats; `/import` brings yours over.
- **Tabs** (`Alt+T`), each with its own conversation, and git worktrees for work kept apart.
- **Servers and watchers in the background**: the model starts one and goes on working, reads its
  output when it needs to, and stops it. `Alt+B` (or `/background`) shows their logs live above the input,
  a tab each (←/→ or a click switches), while you work; nothing outlives HeartCode.
- **`/context`**: what fills the context window, part by part (system prompt, tools, messages, tool
  results) and the biggest single pieces.

## How I set it up and use it

### 1. Install

From npm:

```sh
npm install -g heartcode
```

Or from source:

```sh
git clone https://github.com/p32929/HeartCode.git
cd HeartCode
npm start
```

`npm start` links the `heart` command to that folder, so a `git pull` updates it.

### 2. Run `heart`

In the project you want to work on:

```sh
cd ~/code/my-app
heart
```

### 3. Open the settings page

Type `/settings`. The settings page opens in your browser. It runs on your machine only
(127.0.0.1, with a secret key in its link). A running HeartCode picks up what you change right
away.

<!-- image: the settings page -->
![The settings page](https://res.cloudinary.com/m0jnrul4/image/upload/v1793485584/8396c407-f5f8-48af-a242-0b5cbc1c0331.png)

The sidebar, in four groups:

- **Models**: *Your list* (the models HeartCode uses, in order) and *Providers* (where they
  come from).
- **General**: *Settings* (what it may do without asking, terminal colors, features, thinking
  effort, voice input, web search: your own SearXNG and the engines' order, and which outside tools are ready) and *Status bar* (drag and drop what the
  bottom lines show, with a live preview). **Notifications**: Telegram.
- **Skills**, **MCP servers** and **System prompt**: what HeartCode can do and how it's told.
- **Advanced**: *Logs* (requests and runs) and *Files* (the rest of the settings, as files).

### 4. Add a provider and pick models

On **Models → Providers**:

![The settings page](https://res.cloudinary.com/m0jnrul4/image/upload/v1793485944/HeartCode-Settings-11-01-2026_02_28_AM_1.png)

1. **Add a provider**: its name, base URL and API key. Pick one of the presets to fill in the URL.
2. **Choose the models to use**: click a model to add it to your list. I use the free models.

### 5. Put your list in order

On **Models → Your list**:

1. **Sort them by context and abilities.** Click the *Abilities* column, then *Context*: the
   models that can do the most come first, the biggest context window first among those (each
   column clicked breaks the ties of the ones before; click one again to reverse it, a third time to
   drop it). Click **Save list** to keep it.
2. **Rearrange a bit more.** Drag a row to move it. #1 is the one HeartCode uses; the others are
   its fallbacks, tried in order.
3. **Test them** (optional): **Test all** sends each a short message and shows which really answer.
   Each test waits up to 10 seconds; the **Timeout** box next to it changes that.
4. **Filter them** (optional): by name, provider, test result (works, doesn't, not tested, or one
   error like 402), context, tools, thinking, images or free. **Test all** then tests only the ones
   shown, and **Use these N** makes them the models HeartCode uses, in the order you see (the others
   stay under Providers). Filter to the working ones, sort by Works?, Use these: HeartCode uses your
   working models, fastest first.

If a model says *not found* in models.dev, **Retry** looks it up again, or **Set up** tells
HeartCode what it can do.

### 6. Optional: notifications and logs

- **Notifications**: a Telegram message when a task finishes, fails or waits for you. Make a bot
  with [@BotFather](https://t.me/BotFather), paste its token, press Start in the bot, and
  HeartCode finds your chat.
- **Advanced → Logs**: a log of each run, and each request with its reply, in files of their own.
  Logs older than 3 days are deleted (you can change that).

### 7. Back to HeartCode

Go back to the terminal. While the settings page is on, HeartCode shows a dialog and waits.
Your changes are already in.

### 8. Press Enter to stop the settings page

**Turn off** is selected: press Enter. The page stops and HeartCode is yours again.

<!-- image: the "settings page is on" dialog -->
![The settings dialog](https://res.cloudinary.com/m0jnrul4/image/upload/v1793486060/Screenshot_2026-11-01_at_2.34.15_AM.png)

### 9. Send "Hi" as a test

Type `Hi` and press Enter. Wait for the reply: your model works.

### 10. Start using it

Use HeartCode like any other coding agent: ask it to read, change, run and fix things in your
project. `/` shows every command, `Shift+Tab` changes what it may do without asking, `Esc` stops
it, and `heart --help` lists everything else. While it works, commands that leave the conversation
alone (`/help`, `/cost`, `/diff`, `/select_model`, `/settings`, `/tab`, `/exit`…) run at once; the
ones that change it (`/compact`, `/rewind`, `/resume`…) wait until it's done. Pickers, questions and what
commands show (`/help`, `/context`, `/diff`…) open in a dialog over the conversation; `Esc`
closes it.

## License

[MIT](LICENSE)
