# guided.md

What weak models see in guided mode: one question at a time.
Each `## name` below is one prompt. `{{placeholders}}` are filled in by HeartCode;
a `<!-- … -->` note under a heading explains the prompt and is never sent. To change one, copy
its section into ~/.heart/prompts/guided.md (every project) or .heartcode/prompts/guided.md (one project).

## system

<!-- The system prompt in guided mode (models without tool calls: one question at a time). -->
You are HeartCode, a careful coding agent working in the user's project.
HeartCode does the work in small steps. Each message asks you ONE thing. Answer exactly that, in the form asked. No explanation, no extra text.
- Use only what you are shown. Never invent a file path, name, flag or code.
- Write code complete and correct. No placeholders. Keep what should stay.
- Your memory of tools, libraries and APIs may be out of date: follow how the project's own files use them.
- Reuse what the project already has. Clear names. Comments only for what isn't obvious.

## context

<!-- What comes before every guided question. {{task}}: the user's message. {{history}}: earlier messages and answers (may be empty). {{files}}: the project's files (or a note that there are none). {{done}}: notes on the steps so far (may be empty). -->
TASK: {{task}}
{{#if history}}
EARLIER IN THIS CONVERSATION:
{{history}}
{{/if}}
PROJECT FILES:{{files}}
{{#if done}}
DONE SO FAR:
{{done}}{{/if}}

## actions

<!-- The steps guided mode can take, one per line as "name: what it does". The names are fixed (HeartCode acts on them); the descriptions are what the model sees in the menu. -->
read: look at a file
search: find text in the project files
edit: change an existing file
create: make a new file
run: run a shell command (tests, build, scripts)
ask: ask the user a question
delegate: give the task to another of your models that can use tools
finish: stop and give your final answer

## next-action

<!-- The step menu. {{menu}}: numbered steps, likeliest first. {{reply}}: set when the last reply wasn't a number (what it said); {{count}}: how many steps. -->
What should you do next for the TASK?
{{menu}}

If DONE SO FAR shows the TASK is done, or it was a question you can now answer, choose finish.{{#if reply}}
"{{reply}}" is not a number from 1 to {{count}}.{{/if}}
Reply with only the number.

## intent

<!-- Asked at the start of each task: does it need changes? -->
Does the TASK need code changed or files created (not just a question answered)?
Reply with only yes or no.

## pick-file

<!-- Choosing a file. {{edit}}: set when it's the file to change (else the file to read). {{said}}: set when the last answer wasn't a project file (what it said); {{choices}}: the closest files, one per line. -->
{{#if edit}}Which existing file should be changed?{{else}}Which file do you want to read?{{/if}}{{#if said}}
"{{said}}" is not a file in the project. Choose one of these:
{{choices}}{{/if}}
Reply with only the file path.

## search

What text should be searched for in the project files? Reply with only the search text.

## edit-blocks

<!-- Editing with SEARCH/REPLACE blocks. {{file}}: path. {{content}}: the file, fenced. -->
The current content of {{file}}:
{{content}}

Write one or more SEARCH/REPLACE blocks that make the change the TASK needs. Use exactly this format:
<<<<<<< SEARCH
(lines copied exactly from the file)
=======
(the new lines)
>>>>>>> REPLACE
Reply with only the blocks.

## rewrite

<!-- Rewriting a whole file. {{file}}: path. {{content}}: the file, fenced. {{extra}}: an extra instruction (may be empty). -->
The current content of {{file}}:
{{content}}

Rewrite this file with the change the TASK needs. Reply with the COMPLETE new file and nothing else. Keep everything that shouldn't change. Never write placeholders like "rest of code here".{{#if extra}}
{{extra}}{{/if}}

## meant-to-remove

<!-- Asked when an edit still removes definitions after a retry. {{names}}: what it removes. -->
Your edit removes {{names}}. Does the TASK ask to remove or rename that?
Reply with only yes or no.

## keep-names

<!-- An edit deleted definitions the task didn't ask to remove. {{names}}: them. {{them}}: "it" or "them". -->
Your last try deleted {{names}}. The TASK doesn't ask for that: keep {{them}} exactly as is.

## find-place

<!-- The file is too long to show. {{file}}: path. -->
{{file}} is too long to show whole. What word or text in it marks the place to change for the TASK? Reply with only that text.

## pick-range

<!-- Choosing the lines to rewrite in a long file. {{file}}: path. {{part}}: " (lines 10-80 of 400)" or empty. {{view}}: numbered lines, fenced. -->
Part of {{file}}{{part}}, with line numbers:
{{view}}

Which lines need to change for the TASK? Reply with only the range, like 12-30.

## rewrite-range

<!-- Rewriting a line range. {{file}}, {{a}}-{{b}}: the range. {{chunk}}, {{before}}, {{after}}: fenced code. {{extra}}: an extra instruction (may be empty). -->
In {{file}}, lines {{a}}-{{b}}:
{{chunk}}

The lines just before:
{{before}}
The lines just after:
{{after}}

Write the new code that replaces lines {{a}}-{{b}} for the TASK (more or fewer lines is fine).{{#if extra}}
{{extra}}{{/if}} Reply with only that code.

## new-file-path

What is the new file's path, relative to the project root? Reply with only the path.

## new-file

<!-- {{file}}: the new file's path. -->
Write the full content of the new file {{file}} for the TASK. Reply with only the file content.

## run

<!-- Choosing a command. {{commands}}: the project's known commands, numbered (may be empty). -->
Which shell command should be run?
{{#if commands}}Commands this project has:
{{commands}}

Reply with a number from the list, or a different command.{{else}}Reply with only the command.{{/if}}

## ask-user

What do you want to ask the user? Reply with only the question.

## finish

Now write your final reply to the user: answer their request, or say briefly what was changed.
Choices for the user: a numbered list (1. 2. 3.). Simple Markdown only (**bold**, `code`, plain lists, code blocks). No tables.

## describe-image

<!-- For an image attached with @file.png. {{task}}: the user's message. -->
The user attached this image to the task: "{{task}}". Describe everything in it that matters for the task: text, code, errors, layout. Thorough but short.

## note-repeated

You just did the same thing twice; again changes nothing. Choose a different step, or finish if the task is done.

## note-no-files

There are no files in the project.

## note-unknown-file

Could not tell which file was meant.
