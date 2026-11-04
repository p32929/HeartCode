# Tooltip

A **tooltip** is a short text label that appears when a control is hovered or focused: what an icon-only button does, or a brief hint. Anything people click into belongs in a **popover**; a preview of what's behind a link is a **hover card**; anything people need to finish the task stays on the screen.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the tooltip's own.

## At a glance
1. **Never the only place for something people need.** Requirements and rules stay on the screen.
2. **Short plain text, nothing to click.** Links, buttons or fields → a popover.
3. **On keyboard focus too**, not just hover; Esc hides it.
4. **Only when it adds something**: name an icon-only button; don't repeat a visible label.

## Which one
| Use | Opens on | Holds | Example |
|---|---|---|---|
| **Tooltip** | hover and keyboard focus | a few words of plain text | "Delete row" on a trash-icon button |
| **Popover** | a click or tap on a button | rich content: text, links, a small form | Date picker · "What's this?" details |
| **Hover Card** | hovering a link | a preview, for sighted users, of what the link opens | a profile card on @sam |
| **On the screen** | always visible | what people need to finish the task | password rules under the field |

- Touch screens have no hover: a hint that matters there is a popover opened by tapping.
- A hover card only previews; everything in it must also be reachable by following the link.

## Tooltip rules
- **Text:** a few words ("Delete row"). A keyboard shortcut may follow it ("Bold ⌘B").
- **Icon-only buttons:** the tooltip shows the button's name; the button still needs its `aria-label`.
- **Consistent:** give all comparable controls a tooltip (every icon in a toolbar), or none.
- **Timing:** appears after a short delay, stays while the pointer moves onto it, and hides on mouse leave, blur or Esc (without moving the pointer).
- **Placement:** above by default (`data-side="top"`); move it if it would cover what it explains or what's next to it.

## In code
- The tooltip `role="tooltip"`, linked from its trigger with `aria-describedby`. It never takes focus; focus stays on the trigger.
- Basecoat: `data-tooltip="Delete row"` on the trigger (plus `data-side`, `data-align`); CSS-only and text-only, so Esc to hide needs a few lines of script.
- **Popover API:** a popover is `<button popovertarget="p">` + `<div id="p" popover>` (a click outside or Esc closes it, focus goes back to the button). A tooltip can be `popover="hint"`, shown from `mouseover`/`focus` and hidden on `mouseout`/`blur`; it doesn't close an open menu. The Popover API is newly available (Baseline 2025): keep a fallback (check `Object.hasOwn(HTMLElement.prototype, "popover")`); `hint` acts as `manual` where it isn't supported.
- **Position** it with CSS anchor positioning (`position-anchor`, newly available since 2026), with a few lines of JS as the fallback.

## Before you ship
- [ ] Nothing needed to finish the task is only in a tooltip
- [ ] Plain text only; anything clickable is in a popover
- [ ] Shows on hover and keyboard focus; Esc hides it; the pointer can move onto it
- [ ] Icon-only buttons have an `aria-label` and a tooltip; comparable controls all have one

*Sources: shadcn/ui Tooltip (hover or keyboard focus, `side`, keyboard-shortcut example), Popover (rich content, triggered by a button, with a form) and Hover Card ("for sighted users to preview content available behind a link") · Basecoat Tooltip (`data-tooltip`, `data-side` default top, `data-align`, CSS-only and text-only) · Nielsen Norman Group, "Tooltip Guidelines" (helpful content only, never essential information, brief and not redundant, keyboard focus, not on touchscreens: use popup tips, don't block related content, consistent) · WAI-ARIA APG, Tooltip pattern (work in progress: delay, Esc, no focus inside, `role="tooltip"`, `aria-describedby`) · WCAG 2.2 SC 1.4.13 Content on Hover or Focus (dismissible, hoverable, persistent) · MDN Popover API and "Using the Popover API" (Baseline 2025, `auto` light dismiss, `hint` with mouseover/focus, fallback to `manual`, feature check) · MDN `position-anchor` (Baseline 2026).*
