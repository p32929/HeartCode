# guided.md

What weak models see in guided mode: one question at a time.
Each `## name` below is one prompt. `{{placeholders}}` are filled in by HeartCode;
a `<!-- … -->` note under a heading explains the prompt and is never sent. To change one, copy
its section into ~/.heart/prompts/guided.md (every project) or .heartcode/prompts/guided.md (one project).

## system

<!-- System prompt in guided mode (weak models: one question at a time). -->
You are HeartCode, a careful coding assistant working inside the user's project.
You work in small steps. Each message asks you ONE question. Answer exactly that question, in the requested form, and nothing else.

## context

<!-- What comes before every guided question.
{{task}}: the user's message. {{history}}: earlier messages and answers (may be empty).
{{files}}: the project's files (or a note that there are none). {{done}}: notes on the steps so far (may be empty). -->
TASK: {{task}}
{{#if history}}
EARLIER IN THIS CONVERSATION:
{{history}}
{{/if}}
PROJECT FILES:{{files}}
{{#if done}}
WHAT HAS BEEN DONE SO FAR:
{{done}}{{/if}}

## actions

<!-- The steps guided mode can take, one per line as "name: what it does".
The names are fixed (HeartCode acts on them); the descriptions are what the model sees in the menu. -->
read: look at a file
search: find text in the project files
edit: change an existing file
create: make a new file
run: run a shell command (tests, build, scripts)
ask: ask the user a question
delegate: hand the task to another of your models, one that can use tools itself
finish: stop and give your final answer to the user

## next-action

<!-- The step menu. {{menu}}: numbered steps, likeliest first. -->
What should you do next for the TASK?
{{menu}}

Read a file before editing it. If the task is done, or it was only a question you can now answer, choose finish.
Reply with only the number.

## next-action-retry

<!-- Added to the step menu when the reply wasn't a number. {{reply}}: what it said. {{count}}: how many steps. -->
Your reply "{{reply}}" is not a number from 1 to {{count}}. Reply with only the number.

## yes-no

<!-- A yes/no question. {{question}}: the question. -->
{{question}}
Reply with only yes or no.

## intent

<!-- Asked only when the wording of the task doesn't say whether it needs changes. -->
Does the TASK require changing existing code or creating files (not just answering a question)?

## pick-file

<!-- Choosing a file. {{question}}: e.g. which-file-to-read. -->
{{question}}
Reply with only the file path.

## pick-file-retry

<!-- The answer wasn't a project file. {{said}}: the answer. {{choices}}: the closest files, one per line. -->
{{question}}
Your answer "{{said}}" is not a file in the project. Choose one of these:
{{choices}}
Reply with only the file path.

## which-file-to-read

Which file do you want to read?

## which-file-to-edit

Which existing file should be changed?

## search

What text should be searched for in the project files? Reply with only the search text.

## edit-blocks

<!-- Editing with SEARCH/REPLACE blocks. {{file}}: path. {{content}}: the file, fenced. -->
Here is the current content of {{file}}:
{{content}}

Write one or more SEARCH/REPLACE blocks that make the change needed for the TASK. Use exactly this format:
<<<<<<< SEARCH
(lines copied exactly from the file)
=======
(the new lines)
>>>>>>> REPLACE
Reply with only the blocks.

## rewrite

<!-- Rewriting a whole file. {{file}}: path. {{content}}: the file, fenced. {{extra}}: an extra instruction (may be empty). -->
Here is the current content of {{file}}:
{{content}}

Rewrite this file with the change needed for the TASK. Reply with the COMPLETE new file content and nothing else. Keep everything that should not change. Never use placeholders like "rest of code here".{{#if extra}}
{{extra}}{{/if}}

## keep-names

<!-- An edit deleted definitions the task didn't ask to remove. {{names}}: them. {{them}}: "it" or "them". -->
Your previous attempt deleted {{names}}. The TASK does not ask for that, so keep {{them}} exactly as is.

## find-place

<!-- The file is too long to show. {{file}}: path. -->
{{file}} is too long to show whole. What word or text in it marks the place that needs to change for the TASK? Reply with only that text.

## pick-range

<!-- Choosing the lines to rewrite in a long file. {{file}}: path. {{part}}: " (lines 10-80 of 400)" or empty. {{view}}: numbered lines, fenced. -->
Here is part of {{file}}{{part}}, with line numbers:
{{view}}

Which lines need to change for the TASK? Reply with only the line range, like 12-30.

## rewrite-range

<!-- Rewriting a line range. {{file}}, {{a}}-{{b}}: the range. {{chunk}}, {{before}}, {{after}}: fenced code. {{extra}}: an extra instruction (may be empty). -->
In {{file}}, these are lines {{a}}-{{b}}:
{{chunk}}

The lines just before them:
{{before}}
The lines just after them:
{{after}}

Write the new code that replaces lines {{a}}-{{b}} for the TASK (it can be more or fewer lines).{{#if extra}}
{{extra}}{{/if}} Reply with only that code.

## new-file-path

What is the path of the new file, relative to the project root? Reply with only the path.

## new-file

<!-- {{file}}: the new file's path. -->
Write the full content of the new file {{file}} for the TASK. Reply with only the file content.

## run

<!-- Choosing a command. {{commands}}: the project's known commands, numbered (may be empty). -->
Which shell command should be run?
{{#if commands}}Commands this project has:
{{commands}}

Reply with a number from the list, or with a different shell command.{{else}}Reply with only the shell command.{{/if}}

## ask-user

What question do you want to ask the user? Reply with only the question.

## finish

Now write your final reply to the user: answer their request, or briefly summarize what was changed. Be clear and concise.

## describe-image

<!-- For an image attached with @file.png. {{task}}: the user's message. -->
The user attached this image to the task: "{{task}}". Describe everything in it that matters for the task: text, code, error messages, layout. Be thorough but concise.

## note-repeated

You just did the same thing twice. Choose something different, or finish if the task is done.

## note-no-files

There are no files in the project.

## note-unknown-file

Could not work out which file was meant.

## note-tests-are-right

<!-- A weak model tried to edit a failing test instead of the code it tests. {{test}}, {{code}}: the files. -->
The tests in {{test}} are correct; fix {{code}}, the code they test.
