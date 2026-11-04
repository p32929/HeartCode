# Dialog

A **dialog** sits over the page and blocks it until it's done: for a short task the person must finish now. An **alert dialog** is a dialog that asks for a decision (usually "are you sure?") and can only be closed by answering. Anything longer, optional or not urgent belongs in a sheet, a page or inline.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the dialog's own.

## At a glance
1. **A dialog interrupts, so it has to be worth it**: a short task or a critical decision, never promos or newsletter sign-ups.
2. **Always a title**, and the main button repeats its verb ("Rename file" → **Rename**).
3. **Confirm only what's serious and hard to undo.** Everyday actions get Undo instead.
4. **A confirmation names the thing and the result**, with buttons like **Delete file** / Cancel, not Yes / No.

## Which one
| Use | When | Example |
|---|---|---|
| **Dialog** | a short task the flow can't continue without; closes by ✕, Esc or a click outside | Rename file · Invite member |
| **Alert Dialog** | a decision that must be answered: confirming something hard to undo; no ✕, no click-outside | Delete project? |
| **Sheet** (`sheet.md`) | a longer form or details the person reads next to the page | Edit customer · Filters |
| **Page** | many steps, complex interactions, large tables | Checkout · Import wizard |
| **Inline / Popover** | information or a few controls that shouldn't block anything | a message under the form · a date picker |

- Never open a dialog from a dialog.
- Not for nonessential things (newsletter, upsell): they cost attention and give nothing back.

## Layout
- **Header:** the title (`text-lg font-semibold`) and, if needed, one line of description under it.
- **Body:** short; if it scrolls, keep the header and the actions in view.
- **Footer:** actions bottom right, the primary last (Cancel, then **Rename**). On a phone they stack full width, the primary on top.
- **Width:** up to 512 px (`sm:max-w-lg`), always 16 px from the screen's edges (`max-w-[calc(100%-2rem)]`).

## Confirmations (Alert Dialog)
- Only for actions that destroy work or cost real money and can't be undone. Asking every time teaches people to click through without reading.
- **Everyday actions** (archive, move, delete something that can come back): do it, then offer **Undo** in a toast.
- Say **what** and **what happens**: "Delete 'Q3 report'? Its 14 comments go too." Not "Are you sure?".
- Buttons named by outcome: **Delete file** (destructive) and **Cancel** (outline). Never Yes / No / OK.
- Focus starts on **Cancel**, the least destructive choice, so a stray Enter does no harm.

## In code
- Native `<dialog>` opened with `showModal()`, not a `div` and a script: it goes on top of everything, the page behind turns inert, focus moves in and stays inside, Esc closes, and focus goes back to the button that opened it. Style the dimmed page with `::backdrop`. Put `autofocus` on the element to use first (on **Cancel** in a confirmation).
- Name it: `aria-labelledby` → the title, `aria-describedby` → the description. A confirmation gets `role="alertdialog"` (WAI-ARIA APG Alert Dialog).
- Open and close animation: `@starting-style` with `transition-behavior: allow-discrete` (Tailwind `starting:`); Basecoat's dialogs already do it. It's newly available (Baseline 2024), so it's an extra: the dialog must work without it.
- Basecoat: `<dialog class="dialog">` (or `class="alert-dialog"`) › `<div>` › `<header><h2>…</h2><p>…</p></header>`, `<section>` body, `<footer>` buttons. A Dialog adds a ghost `✕` button (`aria-label="Close"`) and closes on a backdrop click; an Alert Dialog has neither.

## Before you ship
- [ ] A dialog is really needed (not a sheet, page or inline message), and none opens another
- [ ] A title, and the primary button repeats its verb
- [ ] Confirmations only for hard-to-undo actions, naming the thing; outcome buttons, focus on Cancel
- [ ] A native `<dialog>` with `showModal()`: Esc closes it, focus returns to the trigger; fits a 390 px screen

*Sources: shadcn/ui Dialog and Alert Dialog (pages and source: `sm:max-w-lg`, `max-w-[calc(100%-2rem)]`, footer `flex-col-reverse sm:flex-row sm:justify-end`) · Basecoat Dialog and Alert Dialog (markup; omit the close button and backdrop handler when an explicit choice is required) · Nielsen Norman Group, "Modal & Nonmodal Dialogs" (when to interrupt, not for nonessential content, a full page for many steps) and "Confirmation Dialogs Can Prevent User Errors" (only for serious consequences, be specific, outcome labels, no default Yes, undo) · Atlassian Design System, Modal dialog (a title always, primary repeats it, not for complex interactions or large tables, no dialog from a dialog, popup/inline alternatives) · MDN `<dialog>` (Baseline widely available: `showModal()`, inert page, `::backdrop`, `autofocus`) and `@starting-style` (Baseline 2024) · Tailwind CSS `starting:` variant · WAI-ARIA APG, Dialog (Modal) and Alert Dialog patterns (focus, Esc, focus return, least destructive initial focus, roles).*
