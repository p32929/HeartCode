# tests.md

What the settings page's Test asks your models (Test, Test all). Each `## name` below is one prompt.
A `<!-- … -->` note under a heading explains it and is never sent. To change one, copy its section
into ~/.heart/prompts/tests.md, or edit it on the settings page.

## hello

<!-- Does it answer? One short message to the model; any reply in time passes, and its time shows under Works?. -->
Reply with just the word OK.

## tool-check

<!-- A model that says it calls tools: can it do a small job with one? It gets HeartCode's write_file tool; it passes when it calls it with a path ending in notes.txt and content containing "hello" (keep those two, or it can't pass). -->
Create the file notes.txt containing exactly: hello
