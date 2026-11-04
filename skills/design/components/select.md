# Select

Picking **one option from a list** that opens from a button. Few options? Show them all as a **Radio Group**. Many, or people know what they want? A **Combobox** they can type into. Same job, the browser's own control? A **Native Select**.

General rules (layout, spacing, type, colors, focus) are in `../general.md`; these are the select's own.

## At a glance
1. **5 or fewer options: Radio Group**, not a select. Everyone sees every option.
2. **Native Select first**; the custom Select only for styling it can't do. A long list, or a value people know: **Combobox**.
3. **Options in a logical order**: most common first, alphabetical, or in sequence for numbers and dates.
4. **No default for a question**; a sensible default for a setting.

## Which one
| Component | Use for | Example |
|---|---|---|
| **Radio Group** (see `choice.md`) | 5 or fewer options, one answer | Plan: Free · Pro · Team |
| **Native Select** | one option from about 5–15, where space is tight: the browser's own behavior, better on phones, faster | Sort by · Theme |
| **Select** | the same job when it needs custom styling or richer options | Status with a colored dot |
| **Combobox** | many options, or the person knows the value: type to filter | Assignee · Time zone |
| **Combobox** with `multiple` (chips), or **Checkboxes** | more than one option | Labels · Notify me about |

A select never takes more than one value.

**Native Select first**; the custom Select only when the options need custom styling or richer content. The newer customizable `<select>` (`appearance: base-select`) is only an extra: it isn't in every browser yet and falls back to a classic select, so the form must work with that.

## The list
- Order: the most often picked first, or alphabetical; numbers and dates in sequence.
- Long lists: group with `SelectGroup` + `SelectLabel`, divide with `SelectSeparator`; it scrolls. If it's still very long, use a Combobox.
- An option that can't be picked right now: show it disabled, don't remove it.
- Combobox: say what happens when nothing matches ("No people found.").

## Value and label
- A visible label above it, in a Field, like any input.
- **A setting** (Theme, Sort by): pre-select the usual value.
- **A question** (Which team?): no pre-selected option, so it doesn't sway the answer; the trigger shows a placeholder ("Select a team").
- Errors: `data-invalid` on the Field, `aria-invalid` on the trigger, and the message under it (see `field.md`).

## In code
- **Native Select**: `<select class="select">` with `<option>`s and `<optgroup label>`; `data-size="sm"` for 32 px.
- **Select** (Basecoat, needs `select.min.js`): `<div class="select">` with a `<button aria-haspopup="listbox">` trigger, a `[data-popover]` holding `role="listbox"` of `role="option" data-value`, and a hidden `<input>` for the value.
- **Combobox** (Basecoat, needs `combobox.min.js`): `<div class="combobox">` with `<input role="combobox" aria-autocomplete="list" aria-expanded aria-controls>`, a `role="listbox"` with `data-empty` for the no-match text. ARIA: the WAI-ARIA APG Combobox pattern.

## Before you ship
- [ ] 5 or fewer options are radios; a long list is a Combobox; otherwise a Native Select unless custom styling is needed
- [ ] Options in a logical order, long lists grouped
- [ ] Questions start with no value; settings with the usual one
- [ ] A visible label; errors set `aria-invalid`
- [ ] Unavailable options disabled, not hidden

*Sources: shadcn/ui Select (groups, labels, separators, scrolling, invalid), Native Select (when vs Select), Combobox (autocomplete, `multiple` with chips) · MDN, Customizable select elements (limited availability, falls back to a classic select) · Basecoat Select, Native Select, Combobox (markup) · Nielsen Norman Group, "Listboxes vs. Dropdown Lists" (5 or fewer: radios, ordering, defaults) and "Drop-Down Menus: Use Sparingly" (typing can be faster, keep unavailable options visible) · GOV.UK Design System, Select (no pre-selected answer to a question, checkboxes for several) · WAI-ARIA APG, Combobox pattern.*
