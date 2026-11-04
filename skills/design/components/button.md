# Button

A button **does** something: saves, sends, deletes, opens. If it only goes to another page, it's a **link** (`<a href>`), even when it's styled like a button.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the button's own.

## At a glance
1. **One primary per view.** Everything else is quieter.
2. **The label says what happens**: a verb and its object, "Save changes", not "OK".
3. **Red only for a serious action that's hard to undo**, and not as the default.
4. **Hover, focus and loading are visible.** Avoid disabled buttons.

## Which kind
| Kind | Use for | Example |
|---|---|---|
| **Primary** (default) | the one main action of a page, dialog or card | Save changes · Create project |
| **Secondary** or **Outline** | the other actions beside it | Cancel · Export |
| **Ghost** | repeated, low-priority actions: toolbars, table rows, menus | ⋯ · Edit |
| **Destructive** | deleting or something else hard to undo; use it for the final confirmation | Delete project |
| **Link** | an action inside a sentence | Reset your password |

Too many actions? Put the rare ones in a **⋯ (More)** menu instead of adding loud buttons.

## Label
- A verb and its object, in sentence case, 1–3 words: **Save changes**, **Add member**, **Delete project**.
- True to what happens: "Save and continue" only if it saves.
- In a confirmation, repeat the question's verb: "Delete this project?" → **Delete project**, not "Yes".

## Icon
- **Before** the label for a well-known action (+ Add, ⬇ Download); **after** it for direction or a menu (Next →, Sort ▾).
- **Icon-only** only for universal actions in tight spaces (close, more, search, delete in a row). Give it an `aria-label` and a tooltip.
- No icon just for decoration.

## Size
| `data-size` | Height | Where |
|---|---|---|
| `xs` | 24 px | very dense UIs |
| `sm` | 32 px | tables, toolbars |
| default | 36 px | almost everywhere; same height as an input |
| `lg` | 40 px | a landing page's main call to action |
| `icon`, `icon-sm`, `icon-lg` | square 36 / 32 / 40 | icon-only buttons |

Keep 8 px (`gap-2`) between buttons. On touch screens make the tap area 44 px or more.

## Placement
- **Form:** the primary under the last field, left-aligned with it.
- **Dialog:** actions at the bottom right, the primary last (Cancel, then **Save**). Use the same order everywhere.

## States
- **Hover:** a slightly lighter or darker fill (shadcn's variants already do this).
- **Focus:** the visible focus ring; never remove it.
- **Loading:** a spinner and "Saving…" in the same button, same width; ignore extra clicks until it's done.
- **Disabled:** avoid it. Keep the button enabled and, on click, say what's missing.

## In code
- `<button type="button">`, or `type="submit"` for the one submit in a form. Never a clickable `<div>`.
- Plain HTML with Basecoat: `<button class="btn">`, plus `data-variant="secondary|outline|ghost|destructive|link"` and `data-size="xs|sm|lg|icon|icon-sm|icon-lg"`. Lucide icons go inside, before or after the text.

## Before you ship
- [ ] One primary per view
- [ ] Every label is a verb and its object
- [ ] Destructive only for hard-to-undo actions, never the default
- [ ] Icon-only buttons have an `aria-label`
- [ ] Focus ring and loading state visible

*Sources: shadcn/ui Button (variants, sizes) · GOV.UK Design System, Button (one default button, text that describes the action, left-aligned in forms, warning buttons, avoid disabled) · Nielsen Norman Group, "OK–Cancel or Cancel–OK?" (descriptive labels, a consistent order) · WCAG 2.2 SC 2.5.8 (24 px minimum target).*
