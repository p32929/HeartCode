# Toast

A toast is a short notice that floats over the page after an action or from the system ("Project archived", "You're offline") and goes away by itself. Anything critical, or anything people must fix, goes in an **alert** on the page or a **dialog** (see `alert.md`).

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the toast's own.

## At a glance
1. **Short, and never the only place it's said.** One line: what happened.
2. **Undo, not "Are you sure?"**, for everyday actions: do it at once, offer Undo in the toast.
3. **A toast with an action stays** until it's used or closed; one without may go after a few seconds.
4. **One corner for the whole app**, clear of the screen's safe areas; announced politely.

## Undo instead of asking
- Archive, delete, remove, move: do it straight away, then show a toast with **Undo** ("Conversation archived · Undo").
- Ask first, in a dialog, only for serious actions that can't be undone, naming the thing and the outcome (**Delete project** / **Keep project**).
- Asking every time teaches people to click Yes without reading.

## Which type
| Type | Use for | Example |
|---|---|---|
| default | a plain notice | Link copied |
| `success` | an action finished | Changes saved |
| `info` · `warning` | news from the system | You're offline |
| `error` | something in the background failed; offer **Retry** | Couldn't send message |
| `loading` → promise | something running; the same toast turns into success or error | Uploading… → Report uploaded |

## Words and actions
- **Title:** a few words, the most important point, no full stop. A description only if it adds something, one short line.
- **One action at most**, 1–2 words: Undo, Retry, View.

## Timing and place
- **Without an action:** it may close by itself after a few seconds (Sonner: 4 s; Basecoat: 3 s, errors 5 s), but only if what it says can also be found elsewhere.
- **With an action:** no timer (Basecoat `data-duration="-1"`, Sonner's `duration`). An Undo that vanishes before it's read is no Undo.
- **Position:** one corner for every toast, newest on top of the stack; bottom right by default.
- **Safe areas:** keep the stack off notches and the home bar: `padding-bottom: calc(1rem + env(safe-area-inset-bottom))` (Baseline, widely available).

## In code
- React: shadcn/ui's Toast or Sonner: `toast.success("Changes saved")`, an action with `Undo`, `toast.promise` for loading.
- Basecoat: an empty `<div id="toaster" class="toaster" aria-live="polite">` in the page **from the start**; each `.toast` (`role="status"`, `data-category="success|info|warning|error"`) has a `.toast-content` with an icon, `<section>` (`<h2>` title, `<p>`) and an optional `<footer>` with a `data-toast-action` button.
- A toast never takes focus.

## Before you ship
- [ ] Nothing critical or only-said-here is in a toast
- [ ] Everyday deletes and archives happen at once, with Undo in the toast
- [ ] A toast with an action doesn't time out
- [ ] One corner, clear of the safe areas
- [ ] The toaster is in the page from load; focus never moves to a toast

*Sources: shadcn/ui Toast (types, Undo action, `toast.promise`) · Sonner docs, Toast (4000 ms default, bottom-right, action and cancel buttons, `closeButton`) · Basecoat 1.0.2 Toast (markup, `role="status"`, `data-duration="-1"`, 3000/5000 ms defaults) · Carbon Design System, Notification usage and pattern (toasts for messages not tied to a place, one action, nothing critical on a timer, newest on top) · WCAG 2.2 Understanding SC 2.2.1 Timing Adjustable (a timed toast only if the content is available elsewhere) · Nielsen Norman Group, "Confirmation Dialogs Can Prevent User Errors (If Not Overused)" (undo, confirm only serious actions, specific buttons, automatic clicking) · MDN, ARIA live regions (create the region before updating it, polite) and `env()` (safe-area-inset-*, Baseline widely available since January 2020).*
