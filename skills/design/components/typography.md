# Typography

The text itself: headings, paragraphs, secondary (muted) text, lists and inline code. Use these styles for every block of text; a component's own text (a button's label, a field's help) follows that component's guide.

General rules (type scale, fonts, line length, contrast) are in `../general.md`; these are the text's own.

## At a glance
1. **Headings follow the structure**, not the size you want: `h1`, then `h2`, then `h3`, no skipped levels.
2. **Sentence case** for every heading.
3. **Muted text is secondary**: descriptions, help and metadata, never the main content.
4. **Lists**: bullets when the order doesn't matter, numbers when it does.

## Headings
- One heading level per level of structure: "headings with an equal or higher rank start a new section, headings with a lower rank start new subsections". Don't skip a level going down (`h2` → `h4`).
- Pick the element for the structure, then the size from `../general.md`. Need a smaller look? Change the class, not the level.
- Sentence case: **Billing details**, not "Billing Details".
- `tracking-tight` and `font-semibold` on headings (shadcn's style), plus `text-balance` so a heading's lines come out even. Where it isn't supported the text just wraps as usual, so nothing else is needed.

## Body and muted text
| Role | Class |
|---|---|
| Paragraph in reading text | `leading-7`, `mt-6` between paragraphs |
| Lead (the intro under a page title) | `text-xl text-muted-foreground`, at most once per page |
| Muted (description, help, metadata) | `text-sm text-muted-foreground` |
| Link in text | `font-medium text-primary underline underline-offset-4` |

## Lists
- **Bulleted** (`ul`, `my-6 ml-6 list-disc [&>li]:mt-2`): when the order doesn't matter, usually after a short lead-in line.
- **Numbered** (`ol`, `list-decimal`): when the order matters (steps).

## Inline code
- For code, commands, file names and keys inside a sentence: `<code>` with `rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold`.

## In code
- Real elements: `h1`–`h6`, `p`, `ul`/`ol` with `li`, `code`, `blockquote`. Never a styled `div` for a heading or a list.
- Basecoat has no typography classes: use the Tailwind classes above.

## Before you ship
- [ ] Heading levels in order, none skipped
- [ ] Every heading in sentence case
- [ ] Muted text only for secondary information
- [ ] Ordered steps are a numbered list; other lists bulleted
- [ ] Code, commands and file names in `<code>`

*Sources: shadcn/ui Typography examples (registry `typography-*.tsx`: classes for headings, paragraph, lead, muted, list, inline code, link) · MDN, `text-wrap` (balance: short blocks only; Baseline newly available, 2024) · W3C WAI Tutorials, Headings (nest by rank, avoid skipping) · GOV.UK Design System, Headings (sentence case, heading classes follow the levels), Paragraphs (lead paragraph once per page), Lists (bulleted vs numbered, lead-in).*
