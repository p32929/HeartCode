# compact.md

/compact and auto-compact: summarizing a long conversation.
Each `## name` below is one prompt. `{{placeholders}}` are filled in by HeartCode;
a `<!-- … -->` note under a heading explains the prompt and is never sent. To change one, copy
its section into ~/.heart/prompts/compact.md (every project) or .heartcode/prompts/compact.md (one project).

## summarizer

<!-- System prompt of the summary request. -->
You write summaries of conversations between a user and a coding assistant. You don't continue the work and you can't use tools: you only write the summary, as plain text.

## findings

<!-- Asked of the model doing the task, as the next message of its own conversation, just before the
conversation is compacted. Its reply leads the summary that replaces the conversation. -->
The earlier part of this conversation is about to be replaced by a summary, and your reasoning so far will be gone. Write down now what you'd need to carry on without reading everything again: what you found and concluded (causes, decisions, what works and what doesn't), where things are (files, lines, names), what's done, and what's next. Plain notes, only what matters. Don't call tools.

## summarize-again

<!-- Added when the first reply wasn't a summary (empty, or a tool call). -->
Your last reply was not a summary. Don't call tools or continue the task: write the summary now, as plain notes.

## summarize

<!-- /compact and auto-compact: asks the model to summarize the conversation so far.
{{conversation}}: the conversation as text. {{focus}}: what the user asked to keep (may be empty). -->
<conversation>
{{conversation}}
</conversation>

Summarize the conversation above so that it can continue from your summary alone; the original will be gone.

Keep:
- what the user asked for, in their words where it matters, and any preferences or decisions they stated
- what has been done: files read, created or changed (with paths) and the important details of those changes
- commands that were run and what they showed (errors, test results)
- anything still unfinished or planned next
{{#if focus}}
The user asked to keep especially: {{focus}}
{{/if}}
Write it as compact notes. No preamble, no tool calls.

## summary

<!-- Replaces the compacted part of the conversation. {{summary}}: the summary; {{findings}}: the
model's own notes of what it had found, written just before (may be empty).
{{requests}}: the user's messages so far, word for word ("- …" lines; may be empty). -->
This conversation was compacted to save space.{{#if findings}}

Your own notes, written just before, of what you had found:

{{findings}}{{/if}}

Summary of everything before this point:

{{summary}}{{#if requests}}

The user's messages so far, word for word:
{{requests}}{{/if}}

## branch-summarize

<!-- /tree: the part of a branch the user is leaving, summarized for the branch they go to.
{{conversation}}: that part as text. {{files}}: the files it changed (may be empty). -->
<conversation>
{{conversation}}
</conversation>

The user is leaving the conversation above (a branch: they went back to an earlier point to try something else). Summarize it for the conversation they go on with, so what was learned isn't lost:
- what was tried and how it went (what worked, what failed and why)
- decisions and findings worth keeping
- files changed there (with paths){{#if files}}: {{files}}{{/if}}

Compact notes. No preamble, no tool calls.

## branch-note

<!-- Goes into the branch the user went to, before their next message. {{summary}}: the summary;
{{files}}: the files the left branch changed; {{kept}} or {{restored}}: whether those changes are
still on disk (only one is set, and only when it changed files). -->
(The user went back to this point from another branch of this conversation. What happened on that branch, summarized:

{{summary}}{{#if files}}

That branch changed {{files}}.{{/if}}{{#if kept}} Those changes are still in the files.{{/if}}{{#if restored}} The files are back as they are on this branch.{{/if}})

## branch-note-task

<!-- Guided mode: the "user" side of the branch summary in the exchange history. -->
(another branch of this conversation, which the user left)

## summary-lost

<!-- Stands in for a summary an older HeartCode lost (the model wrote a tool call instead). -->
(The summary of the earlier conversation was lost. Look at the project files to see where things stand.)

## continue

<!-- Sent after an automatic compaction in the middle of a task, so the model carries on.
{{task}}: the user's request it was working on, word for word (may be empty). -->
Continue the task from where you left off.{{#if task}} The request you are working on:
{{task}}{{/if}}

## acknowledged

<!-- After a manual /compact, the model's side of the exchange (keeps user/assistant turns alternating). -->
Understood. I have the summary and will continue from it.
