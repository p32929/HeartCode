# Prompts

Everything HeartCode sends to a model, in four files. Each `## name` heading is one prompt.

| file | used for |
|---|---|
| `agent.md` | tool mode (capable models): the system prompt, tool descriptions, memory, notes HeartCode adds |
| `guided.md` | guided mode (weak models): one question at a time |
| `compact.md` | `/compact` and auto-compact |
| `probe.md` | the one-time test of a new model |

In a prompt, `{{name}}` is filled in by HeartCode (the note under each heading lists them),
`{{#if name}} … {{else}} … {{/if}}` keeps a part only when `name` has a value, and a
`<!-- … -->` note right under the heading is never sent.

## Your own changes

Don't edit these files (updates replace them). Copy the sections you want to change into a
file with the same name:

- `~/.heart/prompts/agent.md` changes it for every project
- `.heartcode/prompts/agent.md` (in a project) changes it for that project only

A section there replaces the built-in one of the same name; the rest stay as they are.

## Your own instructions

For standing instructions ("use tabs", "answer in French", "run `make test` after changes"),
write them in `HEARTCODE.md` (or `AGENTS.md`) in the project, or `~/.heart/HEARTCODE.md` for
every project. They're added to the system prompt, and nothing is added when there are none.
