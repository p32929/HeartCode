# compact.md

/compact and auto-compact: summarizing a long conversation.
Each `## name` below is one prompt. `{{placeholders}}` are filled in by HeartCode;
a `<!-- … -->` note under a heading explains the prompt and is never sent. To change one, copy
its section into ~/.heart/prompts/compact.md (every project) or .heartcode/prompts/compact.md (one project).

## summarizer

<!-- The system prompt of the summary request. -->
You summarize conversations between a user and a coding assistant. Don't continue the work. No tools: write only the summary, as plain text.

## findings

<!-- Asked of the model doing the task, as the next message of its own conversation, just before it's compacted. Its reply leads the summary that replaces the conversation. -->
The earlier part of this conversation will be replaced by a summary, and your reasoning will be gone. Write down what you need to carry on: what you found and concluded (causes, decisions, what works and what doesn't), where things are (files, lines, names), what's done, and what's next. Plain notes, only what matters. No tools.

## summarize-again

<!-- Added when the first reply wasn't a summary (empty, or a tool call). -->
Your last reply was not a summary. No tools, don't continue the task: write the summary now, as plain notes.

## summarize

<!-- Asks for a summary of a conversation. {{conversation}}: it, as text. {{branch}}: set for /tree, when the user is leaving this part (a branch) for an earlier point; then {{files}}: the files it changed (may be empty). Else /compact and auto-compact, and {{focus}}: what the user asked to keep (may be empty). -->
<conversation>
{{conversation}}
</conversation>

{{#if branch}}The user is leaving the conversation above: they went back to an earlier point to try something else. Summarize it for the conversation they go on with:
- what was tried and how it went (what worked, what failed, why)
- decisions and findings worth keeping
- files changed there (with paths){{else}}Summarize the conversation above. Work continues from your summary alone; the original will be gone. Keep:
- what the user asked for (their words where it matters), and their preferences and decisions
- what was done: files read, created or changed (with paths) and the key details
- commands run and what they showed (errors, test results)
- what is unfinished or next{{/if}}{{#if files}}
Files it changed: {{files}}{{/if}}{{#if focus}}
Keep especially: {{focus}}{{/if}}

Write compact notes. No preamble, no tool calls.

## summary

<!-- Replaces the compacted part of the conversation. {{summary}}: the summary. {{findings}}: the model's own notes, written just before (may be empty). {{requests}}: the user's messages so far, word for word ("- …" lines; may be empty). -->
This conversation was compacted to save space.{{#if findings}}

Your own notes, written just before:

{{findings}}{{/if}}

Summary of everything before this point:

{{summary}}{{#if requests}}

The user's messages so far, word for word:
{{requests}}{{/if}}

## branch-note

<!-- Goes into the branch the user went to, before their next message. {{summary}}: the summary. {{files}}: the files the left branch changed. {{kept}} or {{restored}}: whether those changes are still on disk (one is set, only when it changed files). -->
(The user came back to this point from another branch of this conversation. What happened there:

{{summary}}{{#if files}}

That branch changed {{files}}.{{/if}}{{#if kept}} Those changes are still in the files.{{/if}}{{#if restored}} The files are back as they are on this branch.{{/if}})

## branch-note-task

<!-- Guided mode: the "user" side of the branch summary in the exchange history. -->
(another branch of this conversation, which the user left)

## summary-lost

<!-- Stands in for a summary an older HeartCode lost. -->
(The summary of the earlier conversation was lost. Look at the project files to see where things stand.)

## continue

<!-- Sent after an automatic compaction in the middle of a task, so the model carries on. {{task}}: the request it was working on, word for word (may be empty). -->
Continue the task from where you left off.{{#if task}} The request you are working on:
{{task}}{{/if}}

## acknowledged

<!-- After a manual /compact: the model's side of the exchange (keeps user and assistant turns alternating). -->
Understood. I have the summary and will continue from it.
