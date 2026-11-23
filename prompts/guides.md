# Guides: how to do one kind of work

<!-- Each section is the guide for one kind of project or task. The model reads one with the guide tool
(agent/tool-guide lists them), and HeartCode adds one by itself, once per conversation, when the project's
files or the message show what kind of work it is (src/guides.js). Every guide has the same parts: done
when, start, run, check, traps. Short and general on purpose: what any model, the smallest too, can follow.
Variables (all guides get all of them; use or ignore): {{page}}: the command for HeartCode's headless
browser check. {{memory}}: set when there's a memory tool. {{noUser}}: set when nobody can answer. -->

## web

<!-- Web sites and web apps: pages, front ends, single-page apps, full-stack apps' front end. -->
Guide: web site or web app (keep it in mind for this work)
Done when: it starts with one command, the pages the user asked for show and work in a browser (checked with screenshots), no errors in the console, and it fits a phone-width screen.
1. Start: an existing project: follow its framework and scripts (package.json). A new one: plain HTML/CSS/JS for a simple page; for an app, the framework's official create command (read its current docs first), not files written by hand.
2. Run: start the dev server with run_command in the background (background tool), note its URL, stop it when done.
3. Check: `{{page}} <url or file>`: it opens the page headless and gives errors and screenshots. Look at every screenshot. Click through what the user asked for. Check a narrow (phone) width too.
4. Traps: paths that work only from one folder; a blank page from one JS error (read the console); styles not loaded; a form that does nothing; text or buttons off screen on a phone.
5. End your answer with the command to start it and the URL to open.

## api

<!-- Back ends: HTTP APIs, servers, webhooks, the server part of a full-stack app. -->
Guide: API or server (keep it in mind for this work)
Done when: it starts with one command, every endpoint the user asked for answers right to a real request, bad input gets a clear error with the right status code, and no secret is in the code.
1. Start: an existing project: its framework and its patterns (routes, handlers, models). A new one: the smallest common framework for the language, set up as its docs say.
2. Settings (port, database URL, keys) come from environment variables with a safe default for local use; secrets never in files you commit. Add a .env.example if there are any.
3. Run: start it in the background (background tool), wait until it listens, stop it when done.
4. Check: call every endpoint with run_command (curl or the language's own client): one normal request, one with bad or missing input, one for something that doesn't exist. Read the status code and the body.
5. Traps: the server crashes on bad input; CORS blocks a browser front end; the port is already in use; errors that leak stack traces or secrets.

## mobile

<!-- Mobile apps: Flutter, React Native/Expo, native Android (Kotlin) and iOS (Swift). -->
Guide: mobile app (keep it in mind for this work)
Done when: the app builds without errors, starts on an emulator or simulator (or the closest check this machine has), the screens the user asked for show and work, checked with a screenshot.
1. Start: an existing project: its framework (pubspec.yaml: Flutter; app.json/package.json with expo or react-native; build.gradle: Android; .xcodeproj: iOS). A new one: the framework's official create command, from its current docs.
2. Check what's installed first (find_command: flutter, npx, adb, xcrun, java). Missing: say what is needed; install only what the plan needs.
3. Build for one platform first (Android or iOS, whichever this machine can), then the other.
4. Check: the framework's analyzer and tests (flutter analyze, flutter test, npm test); then run on an emulator or simulator and take a screenshot (adb exec-out screencap -p, xcrun simctl io booted screenshot) and look at it. No emulator here: build it and say plainly it wasn't run.
5. Traps: permissions missing from AndroidManifest.xml or Info.plist; a package that doesn't support one platform; hard-coded sizes that break on small screens; network calls to localhost from an emulator (Android uses 10.0.2.2).

## desktop

<!-- Desktop apps: Electron, Tauri, native GUI (Qt, GTK, WinUI, SwiftUI, Python GUIs). -->
Guide: desktop app (keep it in mind for this work)
Done when: it starts with one command on this OS, its window shows what the user asked for (checked with a screenshot), what they asked works, and it closes cleanly.
1. Start: an existing project: its framework (electron in package.json, src-tauri/, a .pro or CMakeLists.txt…). A new one: the framework's official create command, from its current docs.
2. Run it in the background (background tool), give it a few seconds, take a screenshot of its window (macOS: screencapture -x; Linux: import -window root or gnome-screenshot; Windows: PowerShell), look at it, then stop it.
3. Check what it does with real input, not only that it opens. Read its log and terminal output for errors.
4. Package it (installer, .app, .exe) only when the user asks, and last.
5. Traps: works in dev, fails packaged (paths to files inside the app); a blocked main thread freezes the window; Electron security settings (contextIsolation on, no nodeIntegration in pages).

## cli

<!-- Command-line tools and terminal programs. -->
Guide: command-line tool (keep it in mind for this work)
Done when: it runs with one command, does what the user asked with real arguments, gives a clear error and a non-zero exit code on wrong input, and --help says how to use it.
1. Start: an existing tool: its argument parser and style. A new one: the language's standard argument parsing (or the usual small library), one entry point.
2. Output: results to stdout, errors to stderr, plain text that can be piped; colors only on a terminal.
3. Exit codes: 0 when it worked, non-zero when it didn't.
4. Check: run it with run_command: --help, a normal case, an edge case (empty input, a missing file), a wrong argument. Read the output and the exit code each time.
5. Traps: paths relative to the wrong folder; hangs waiting for input that never comes; Windows vs macOS/Linux path and quoting differences.
6. End your answer with the exact command to run it.

## automation

<!-- Scripts and automation: bots, scraping, file processing, scheduled jobs, workflows that run unattended. -->
Guide: automation or script (keep it in mind for this work)
Done when: it runs unattended from one command, a test run on safe or sample data did the right thing, running it twice does no harm, and failures are logged with a reason.
1. Start: one script in the language the project uses (else the one this machine has: python3 or node). Settings (paths, URLs, times, keys) at the top or in environment variables.
2. Safe first: a dry run (--dry-run) that only says what it would do; test on a copy or sample data, never the user's real data or accounts until they say so.
3. Robust: timeouts and a few retries for network calls; safe to run again (skip what's done, don't duplicate); a log line for each step and each failure.
4. Scraping: read the site's terms and robots.txt; slow down between requests; prefer an official API.
5. Scheduling: the OS's own scheduler (cron or launchd on macOS/Linux, Task Scheduler on Windows). Show the user the exact entry; install it only when they ask.
6. Check: run it for real on the safe data and read its output and log.
7. Traps: works from one folder only (use paths relative to the script); a secret printed in the log; an infinite loop with no stop.

## long-task

<!-- Big or long work: many parts, many files, migrations, rewrites, work that goes on for hours. -->
Guide: long or big task (keep it in mind for this work)
Done when: every part of the plan is done and checked, one by one, and the whole works together at the end.
1. Plan: break it into parts with the todo tool, each small enough to finish and check on its own, in an order where each part leaves things working.
2. One part at a time: do it, check it (run it, run the tests), mark it done, then the next. Never start the next part on top of a broken one.
3. Keep notes so you can pick up after a restart or compaction: {{#if memory}}save progress with the memory tool (what's done, what's next, how to check){{else}}keep the todo list current: what's done, what's next, how to check{{/if}}.
4. Long commands (builds, installs, test suites, servers): run them in the background (background tool) and look at their output; don't wait idle.
5. Don't stop to ask "want me to continue?": keep going until all parts are done. Truly blocked on one part: mark it stuck with why, and do the others.
6. Traps: changing everything at once and then nothing works; losing track of what's done; a part "done" that was never run.

## game

<!-- Games: browser games (canvas, WebGL), and games in engines or other languages. -->
Guide: game (keep it in mind for this work)
Done when: it starts with one command or one file, it is playable from start to end (start, play, win or lose, play again), the controls work, and it has no errors, checked with screenshots.
1. Start: a browser game: plain HTML/JS with a canvas unless the user named an engine. Another kind: the engine or library the user named, set up from its docs.
2. Structure: a game loop (requestAnimationFrame), input handling, update, draw; game state in one place; a start screen and a game over/restart.
3. Check: `{{page}} <file or url>`: errors and screenshots after it starts. Look at the screenshots: is the game drawn, is the score there? Check the rules in code: collisions, scoring, winning and losing.
4. Traps: speed that depends on the frame rate (use the time between frames); keys that scroll the page; nothing drawn because of one error; no way to restart.
5. End your answer with how to start it and the controls.

## data

<!-- Data work: processing files (CSV, JSON, Excel), analysis, charts, notebooks, machine learning. -->
Guide: data work (keep it in mind for this work)
Done when: the result comes from the real data, it was checked against a few values worked out another way, and the outputs (files, charts) are saved where the user can open them.
1. Look first: read the data's first rows, its columns and types, how many rows, missing values. Never assume a column's meaning: check.
2. Small first: try the steps on a sample, then on all of it.
3. Tools: what the project uses; else the usual ones (Python with pandas, or plain csv/json). Install only what's needed, into the project (a virtual environment).
4. Check: compare a few results with a hand count or a second method; look at charts (read the image) before you say they're right.
5. Save outputs as files (CSV, PNG, HTML) and say where they are. Never change or delete the original data.
6. Traps: wrong encoding or separator; dates and numbers read as text; dropping rows silently; a model "trained" on its own test data.

## library

<!-- Libraries and packages others will use: npm, PyPI, crates, SDKs. -->
Guide: library or package (keep it in mind for this work)
Done when: its public functions do what the README says, tests cover them and pass, a README example runs as written, and it builds as a package.
1. Start: an existing one: its structure and style. A new one: the language's standard package layout (package.json, pyproject.toml, Cargo.toml) from its current docs.
2. Keep the public API small and clear; everything else private. Don't break what users already call: add, don't change, unless the user asks.
3. Tests for every public function: normal use, edge cases, wrong input.
4. Check: run the tests; build or pack it (npm pack, python -m build, cargo package); run a README example against the built package.
5. Version and changelog when the user asks for a release. Never publish yourself: say the command.
6. Traps: files missing from the package; a dependency that should be a dev dependency; types or docs that don't match the code.

## extension

<!-- Browser extensions (Chrome, Firefox, Edge) and editor extensions (VS Code and others). -->
Guide: browser or editor extension (keep it in mind for this work)
Done when: it loads without errors in its host (unpacked or dev mode), what the user asked works in a real page or editor, and it asks only for the permissions it needs.
1. Start: a browser extension: manifest.json with manifest_version 3, from the browser's current docs. A VS Code extension: the official generator (yo code) or its current docs; package.json declares commands and activation.
2. Permissions: only what the features need; say why each is there.
3. Check: browser: validate the manifest, load it unpacked in a headless browser if possible, check the background script and pages for errors; VS Code: compile and run its tests (the test runner starts an editor). Say plainly what couldn't be checked here.
4. Traps: Manifest V2 code in a V3 extension (background pages vs service workers); content scripts that run on the wrong pages; scripts blocked by the content security policy.

## devops

<!-- Docker, CI (GitHub Actions…), deploying, servers and infrastructure config. -->
Guide: Docker, CI or deploying (keep it in mind for this work)
Done when: the image builds and runs locally (or the config is valid and checked), the CI file follows the official docs, and nothing was deployed or pushed without the user saying so.
1. Docker: a small official base image; copy the dependency files first, then the code (faster builds); run as a non-root user; .dockerignore. Build it and run it locally, and check the app answers.
2. CI: start from the official template for the language; the same commands the project uses locally (install, test, build). Check the YAML is valid.
3. Secrets: in the platform's secrets, never in files.
4. Deploying, pushing, changing a live server or cloud account: only when the user asks, and say exactly what will happen first.
5. Traps: works on your machine but the image misses a file; a different OS or architecture in the image; CI using a different version than local.

## database

<!-- Databases: schemas, migrations, queries, ORMs. -->
Guide: database work (keep it in mind for this work)
Done when: the change is a migration that can be undone, it ran on a test or copy database, the queries return the right rows, and no data was lost.
1. Start: the project's own tool for schema changes (its ORM's migrations, a migrations folder). Never change a database by hand when the project has migrations.
2. Every migration has a way back (down/rollback). Changes that remove or rewrite data: copy or back up first, and ask the user before running them on real data.
3. Check on a test database or a copy: run the migration, run it back, run it again; run the queries and look at the rows.
4. Queries: parameters, never strings glued together (SQL injection); an index for what is searched often.
5. Traps: a migration that works on an empty database but fails on real data; a column dropped that code still uses; different behavior between SQLite in tests and the real database.

## upgrade

<!-- Upgrades and refactors: new versions of frameworks or dependencies, moving to another library, restructuring code. -->
Guide: upgrade or refactor (keep it in mind for this work)
Done when: everything that worked before still works (tests and a real run, same as before the change), and the change the user asked for is complete.
1. First: run the tests and the app as they are, and note the result: that's what "still works" means.
2. Upgrades: read the official migration guide and changelog for every version in between; note the breaking changes that touch this code.
3. One step at a time (one dependency, one module, one rename), checking after each step; never everything at once.
4. A rename or move: find every use (lsp or search) and update them all, docs and configs too.
5. Check at the end: the same tests and run as at the start, and compare.
6. Traps: a lock file not updated; deprecated calls left that break in the next version; behavior changed silently (dates, defaults, sorting).
