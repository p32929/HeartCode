# tests.md

What the settings page's tests ask the models (Test all, and Test with an orchestrator).
Each `## name` below is one prompt. `{{placeholders}}` are filled in by HeartCode; a `<!-- … -->`
note under a heading explains the prompt (and what its scoring relies on) and is never sent. To
change one, copy its section into ~/.heart/prompts/tests.md, or edit it on the settings page.

## hello

<!-- Does it answer? One short message to every model; any reply in time passes, and its time is what the orchestrator sees as how quick it is. -->
Reply with just the word OK.

## tool-check

<!-- A model that says it calls tools: can it do a small job with one? It gets HeartCode's write_file tool; it passes when it calls it with a path ending in notes.txt and content containing "hello" (keep those two, or it can't pass). -->
Create the file notes.txt containing exactly: hello

## skill-code

<!-- Skills: code. HeartCode runs the reply's code against 15 hidden tests that call parseDuration(text) and expect milliseconds, or null for anything that isn't a duration. Keep the function's name and these rules, or the scores mean nothing. -->
Write a JavaScript function parseDuration(text) that turns a duration like "1h30m", "45s", "2d 4h" or "1.5h" into milliseconds.
- Units: d, h, m, s (any case). A number may have decimals. Parts may be separated by spaces.
- Anything else returns null: an empty string, a number without a unit ("10"), an unknown unit ("5x"), a unit without a number ("h"), other characters ("1h-2m"), or something that isn't a string.
Reply with only the code, in one ```js block.

## skill-page

<!-- Skills: web page. HeartCode opens the reply's page in a real browser and uses it: the ids item, add, list and count, Add and Enter adding trimmed text, empty text adding nothing, a remove button per item, the count, no errors, fitting a 390px-wide phone. Keep the ids and the behaviour, or the checks can't find what they test. -->
Write a single HTML file (CSS and JS inside it, nothing loaded from elsewhere): a shopping list app.
- A text input with id "item", a button with id "add", a list with id "list" (each item an <li>), and an element with id "count" showing how many items there are (e.g. "2 items").
- Add (the button, or Enter in the input) adds the typed text, trimmed, and clears the input; empty text adds nothing.
- Each item has its own remove button (×) that removes it.
- It must look good and tidy on a phone (390px wide) and on a desktop.
Reply with only the file, in one ```html block.

## skill-vision

<!-- Skills: vision. Sent with a 640×400 picture HeartCode draws (so the answer is known): one red triangle, a few blue circles, green squares and yellow circles. Scored on the triangle's centre (how close), and the two counts. Keep the JSON's four names, or the answer can't be read. -->
This image is 640×400 pixels (x from the left, y from the top). Reply with only JSON: {"x": …, "y": …, "blue_circles": …, "green_squares": …}, where x and y are the pixel centre of the red triangle.

## skill-tools

<!-- Skills: tools. In a folder of its own with sum.js (a bug: it joins strings instead of adding numbers) and test.js, with HeartCode's read, edit, write, list and run tools. HeartCode runs `node test.js` afterwards: fixed or not. -->
`node test.js` fails in this folder. Find out why and fix sum.js so it passes. Use the tools; when it passes, say so in one line.

## scene-hello

<!-- Orchestrator scene "Hello": passes when it answers itself, handing nothing out. -->
hi

## scene-question

<!-- Orchestrator scene "Question": something it knows; passes when it answers itself. -->
in JavaScript, what's the difference between let and const?

## scene-small-job

<!-- Orchestrator scene "Small job": passes with exactly one handoff a model can work from (a real model of yours, a prompt of 40 characters or more that doesn't point at text it can't see). -->
list the files in this folder

## scene-big-job

<!-- Orchestrator scene "Big job": passes with one handoff a model can work from, with a check, and without the work written in its reply (asking the user how first passes too). -->
make me a car racing game in 3D with beautiful looking cars and nice roads, in the browser

## scene-job

<!-- The job in the scenes "After a failure" and "Reports back": handed to a model already, then that model fails (or reports back). -->
write lru.py: a thread-safe LRU cache with per-key TTL and O(1) get/put, plus test_lru.py with edge cases, and run the tests

## scene-failure

<!-- Orchestrator scene "After a failure": what the handoff of scene-job came back with. Passes when it hands the job to another model, with a check. {{model}}: the model it had picked. -->
error: {{model}} is out of quota for 600 more minutes (its provider said so); hand it to another model

## scene-report

<!-- Orchestrator scene "Reports back": what the handoff of scene-job came back with. Passes when it tells the user the result instead of handing the work out again. -->
Created lru.py (LRUCache: OrderedDict + a lock, per-key TTL checked on get) and test_lru.py (11 tests: eviction order, TTL expiry, update, capacity 1, threads).

$ python3 -m pytest -q
...........  11 passed in 0.31s
