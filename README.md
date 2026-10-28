# HeartCode

A coding agent for your terminal that works with any OpenAI-compatible model.

**Zero dependencies.** Nothing in `node_modules`, no install scripts, no packages pulled in
behind your back: only Node.js (20 or newer) and HeartCode's own code. What you install is
what you can read.

<!-- image: HeartCode in the terminal, answering a message -->
![HeartCode in the terminal](https://res.cloudinary.com/m0jnrul4/image/upload/v1793165332/Screenshot_2026-10-28_at_9.28.26_AM.png)

## Why I made it

Not to compete with other coding CLIs. I made it for my own use, because none of the ones I
tried did what I needed. In short, HeartCode:

- **Works with any OpenAI-compatible provider**, several at once: OpenRouter, Groq, NVIDIA,
  Gemini, Ollama, LM Studio, your own proxy…
- **Keeps a list of models and falls back on its own.** When one hits a rate limit or goes down,
  the next one in your list answers. Free models run out often; this way the work goes on.
- **Works with models that can't call tools.** It guides them step by step instead.
- **Knows each model from [models.dev](https://models.dev)**: its context window, whether it calls
  tools, thinks or reads images. Nothing is sent to the model to find out.
- **Is set up in a web page** on your own machine (`/settings`), not by editing config files.
- **Never sends `max_tokens`**, so no provider cuts the reply short by a limit you didn't choose.
- **Can be used by other tools and AI agents**: `heart -p` runs one task headless, like
  `claude -p` (see [SKILL.md](SKILL.md)).
- **Logs each request and its reply** in a file of its own, when you switch logging on, so you
  can see what went wrong.
- **Takes skills, MCP servers and hooks** in Claude Code's formats; `/import` brings yours over.
- **Has tabs** (`Ctrl+T`), each with its own conversation, and git worktrees for work kept apart.

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
(127.0.0.1, with a secret key in its link).

<!-- image: the settings page -->
![The settings page](https://res.cloudinary.com/m0jnrul4/image/upload/v1793165673/Dark_HeartCode_Models_Dashboard.png)

### 4. Providers & models

1. **Add a provider**: its name, base URL and API key. Pick one of the presets to fill in the URL.
2. **Choose the models to use**: click a model to add it to your list. I use the free models.

### 5. Your models

1. **Sort them by context and abilities.** Click the *Abilities* column, then *Context*: the
   models that can do the most, with the biggest context window, come first. Click
   **Use this order** to save it.
2. **Rearrange a bit more.** Drag a row to move it. #1 is the one HeartCode uses; the others are
   its fallbacks, tried in order.

If a model says *not found* in models.dev, **Retry** looks it up again, or **Set up** tells
HeartCode what it can do.

<!-- image: Your models, sorted -->
![Your models](https://res.cloudinary.com/m0jnrul4/image/upload/v1793165634/HeartCode-Settings-10-28-2026_09_33_AM.png)

### 6. Turn on logging (optional)

On the **Logging** page: a log of each run, and each request with its reply, in files of their
own. Logs older than 30 days are deleted (you can change that).

### 7. Back to HeartCode

Go back to the terminal. While the settings page is on, HeartCode shows a dialog and waits.
Your changes are already in.

### 8. Press Enter to stop the settings page

**Turn off** is selected: press Enter. The page stops and HeartCode is yours again.

<!-- image: the "settings page is on" dialog -->
![The settings dialog](https://res.cloudinary.com/m0jnrul4/image/upload/v1793165735/Screenshot_2026-10-28_at_9.35.28_AM.png)

### 9. Send "Hi" as a test

Type `Hi` and press Enter. Wait for the reply: your model works.

### 10. Start using it

Use HeartCode like any other coding agent: ask it to read, change, run and fix things in your
project. `/` shows every command, `Shift+Tab` changes what it may do without asking, `Esc` stops
it, and `heart --help` lists everything else.

## License

[MIT](LICENSE)
