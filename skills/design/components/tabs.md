# Tabs

Tabs show **one of a few related panels** in the same place, one at a time. For a small set of choices that only change **how the same content is shown** (List / Grid, Day / Week / Month), use a **segmented toggle** (shadcn Toggle Group). For broad, unrelated content, use **separate pages**.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the tabs' own.

## At a glance
1. **Tabs only when people need one section at a time.** Comparing or reading in order? One page with headings.
2. **Few tabs, one row, 1–2 word labels.** No second row, no all caps.
3. **The most-used tab first,** and selected when the page opens.
4. **Tabs switch panels, links switch pages.** Never mix the two in one row.

## Which one
| Use | When | Example |
|---|---|---|
| **Tabs** | related sections with clear groups; most people need the first; nobody needs them all at once | Overview · Activity · Settings |
| **Segmented toggle** | 2–5 closely related choices that change the view, filter or state of the same content | List · Grid |
| **Separate pages** (links) | broad, dissimilar content; each changes the URL, so Back returns to it | Projects · Billing · Team |
| **One page with headings** | people compare across sections or read everything in order | a step-by-step guide |

## Tabs
- Labels: short, plain, predictable; 1–2 words, sentence case. Hard to name? The content isn't split well.
- The tab list sits **above** its panel. Keep each panel's layout the same; only the data changes.
- The selected tab is clearly marked and the others stay visible (shadcn's default: a filled tab; `line`: an underline).
- Don't disable a tab: remove it, or say in the panel why it's empty.
- Too many for the width? Fewer tabs, not a second row. On a phone, headings or an accordion often work better.

## Segmented toggle
- One choice on at a time; the content stays where it is, only its view changes.
- Labels are nouns, either all text or all icons. Icon-only segments get an `aria-label` and a tooltip.
- Segments the same width, about five at most.

## In code
- Tabs: WAI-ARIA tabs pattern. `role="tablist"` (with an `aria-label`), `role="tab"` buttons with `aria-selected` and `aria-controls`, `role="tabpanel"` with `aria-labelledby`. Arrow keys move between tabs; Tab moves into the panel. Show the panel on focus when it's already loaded.
- Basecoat: `<div class="tabs">`, then `<nav role="tablist">` (`data-variant="line"` for the underline) with `<button role="tab">`s and `<div role="tabpanel">`s; its `tabs.min.js` switches them.
- Segmented toggle: shadcn `ToggleGroup` (single), or `<button aria-pressed>`s in a `role="group"` with an `aria-label`. The label doesn't change when pressed.
- Separate pages: `<a href>` links in a `<nav>`, the current one with `aria-current="page"`.

## Before you ship
- [ ] Tabs only for sections people need one at a time
- [ ] One row of 1–2 word labels; the most-used tab first and selected
- [ ] Selected tab clearly marked; no disabled tabs
- [ ] Arrow keys move between tabs; panels and tabs linked with ARIA
- [ ] Links to other pages are `<a href>`, not tabs

*Sources: shadcn/ui Tabs (line variant, vertical) and Toggle Group · Nielsen Norman Group, "Tabs, Used Right" (when to use, 1–2 word labels, one row, highlight the selected tab, list above the panel, same layout per panel, don't mix navigation and in-page tabs, accordions on mobile) · GOV.UK Design System, Tabs (when not to use, the URL and Back, label clarity, most-needed first, don't disable tabs) · Apple HIG, Segmented controls (closely related choices, about five segments, nouns, text or images not both, equal widths) · WAI-ARIA APG, Tabs and Button patterns · MDN, aria-current · Basecoat, Tabs.*
