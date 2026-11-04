# Dropdown menu

A **dropdown menu** is a list of actions behind a button: Edit, Duplicate, Delete, or a ⋯ menu for the rare ones. It's for doing things, not for picking a value in a form (that's a Select or radio buttons) and not for a site's main navigation.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the dropdown menu's own.

## At a glance
1. **Actions, not form values.** Choosing a value → Select, radio buttons or checkboxes.
2. **Short and grouped:** about 5–15 items, the most used first, related ones together between separators.
3. **Each item a verb and its object**, one line, sentence case: "Duplicate project".
4. **Works by keyboard:** Enter, Space or ↓ opens it, arrows move, Esc closes and focus goes back to the button.

## Which one
| Use | When | Example |
|---|---|---|
| **Dropdown menu** | actions on a page, row or card; rare actions behind ⋯ | ⋯ → Rename · Duplicate · Delete |
| **Select** | one value in a form; searchable or several → combobox | Country · Assignee |
| **Radio buttons** | one choice from a short list, all visible | Shipping speed |
| **Checkboxes** | several choices, all visible | Email me about… |
| **Links in the nav** | the site's main navigation on desktop | Products · Pricing · Docs |

## Items
- Verbs for actions, nouns for pages ("Profile"); no articles ("Add flag", not "Add a flag"); one line each.
- Most used first. Group related items with a separator, and give a group a short label when there are several.
- On/off settings: **checkbox items**; one of several: a **radio group** (the check shows the current one).
- A keyboard shortcut, if there is one, on the right of the item.
- An action that can't be undone: the **destructive** (red) item; still confirm it if it's serious (`dialog.md`).
- An item that can't be used now: shown greyed out, not removed, so the menu keeps its shape.
- No more than two levels of submenus; very long, scrolling menus hide choices.

## Trigger
- A button with a ▾ chevron and a label ("Export ▾"), or an icon-only ⋯ button with `aria-label="More actions"` for row and card menus.
- The button stays visible while the menu is open; the menu opens next to it, items left-aligned.

## In code
- Trigger `<button aria-haspopup="menu" aria-expanded="false">`; the list `role="menu"`; items `role="menuitem"`, `menuitemcheckbox` or `menuitemradio` with `aria-checked`; `<hr role="separator">` between groups; unavailable items `aria-disabled="true"` (still focusable). Keys as in the WAI-ARIA APG Menu Button pattern: arrows, Home/End, typing a letter jumps to an item, Tab leaves and closes.
- **`popover` attribute** for the open list (`<button popovertarget="m">` + `<div id="m" popover role="menu">`): on top of everything, a click outside or Esc closes it, one open at a time, focus returns to the button. Newly available (Baseline 2025), so keep a fallback: check `Object.hasOwn(HTMLElement.prototype, "popover")`, else show/hide it with your script (Basecoat's). Arrow keys still need your script.
- **Position** it under the button with CSS anchor positioning (`position-anchor`, newly available in every browser since 2026), and a few lines of JS as the fallback for older ones.
- Basecoat: `<div class="dropdown-menu">` › trigger `button` › `<div data-popover aria-hidden="true">` › `<div role="menu">` with `role="group"` + `role="heading"`, items, `<kbd>` shortcuts, `data-variant="destructive"`; needs Basecoat's `dropdown-menu.js`.

## Before you ship
- [ ] Only actions; values in forms use a Select, radios or checkboxes
- [ ] Most used first, grouped, about 5–15 items, at most two levels
- [ ] Every item a verb and its object; destructive ones red
- [ ] Opens and works by keyboard; Esc returns focus to the button; ⋯ has an `aria-label`

*Sources: shadcn/ui Dropdown Menu (groups, labels, separators, shortcuts, checkbox and radio items, submenus, `variant="destructive"` for irreversible actions) · Basecoat Dropdown Menu (markup) · Atlassian Design System, Dropdown menu (5–15 items, select/radio/checkbox instead, most used first, groups, verbs and nouns, no articles, one line, a ⋯ or avatar trigger, two levels at most) · Nielsen Norman Group, "Drop-Down Menus: Use Sparingly" (not for desktop global navigation, keep the label in view, left-aligned, grey out unavailable items, avoid long scrolling menus, keyboard) · WAI-ARIA APG, Menu Button and Menu patterns (roles, `aria-checked`, `aria-disabled`, keys, focus return) · MDN Popover API and "Using the Popover API" (Baseline 2025, light dismiss, Esc, one at a time, focus, feature check) · MDN `position-anchor` (Baseline 2026, newly available).*
