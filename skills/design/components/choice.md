# Choice

On/off and pick-from-a-few controls: **Checkbox** (any number, including none), **Radio Group** (exactly one), **Switch** (a setting that takes effect at once). Many options, or a list that opens: see `select.md`.

General rules (layout, spacing, type, colors, focus) are in `../general.md`; these are the controls' own.

## At a glance
1. **One answer: radios. Any number: checkboxes. Applies at once: a switch.**
2. **The label is clickable** and says what "on" means, in positive words.
3. **One option per line**, grouped under a legend that asks the question.
4. **Visible when unchecked**: the box or circle's outline 3:1 against the background.

## Which one
| Component | Use for | Example |
|---|---|---|
| **Radio Group** | exactly one of 2–5 options | Plan: Free · Pro · Team |
| **Checkbox** list | any number of options, including none | Notify me about: comments · mentions |
| **Checkbox**, alone | one yes/no inside a form that is saved with a button | I agree to the terms |
| **Switch** | a setting that changes right away, with no Save button | Dark mode · Email notifications |

- A switch takes effect immediately; never put one in a form that needs Submit. If the change waits for Save, use a checkbox.
- None of these runs an action: that's a button.

## Labels and layout
- Every control has its own `<label>`; clicking the label toggles it.
- Positive and specific: **Email me about new comments**, not "Don't email me". A switch's label stays the same in both states.
- Stack them, one per line. Side by side only for two short options.
- A group sits in a fieldset whose legend is the question (**How should we contact you?**). For checkboxes add the hint **Select all that apply**.
- Help for one option goes under its label (`FieldDescription`); for a big choice, a whole card can be the label (shadcn's Choice Card).

## Defaults
- **A question:** no radio pre-selected, so nobody submits an answer they didn't pick. Add "None" or "I don't know" when they're valid answers.
- **A setting:** pre-select the current value.
- A "None" checkbox goes last, after a divider, and clears the others.

## Errors
- On the group: `data-invalid` on the Field, `aria-invalid` on the controls, the message under the legend.
- Say what to choose: **Select how we should contact you**; **Select if you agree to the terms**.

## In code
- Native inputs with Basecoat: `<label class="label"><input type="checkbox" class="input">Email me</label>`; radios `type="radio"` sharing a `name`; a switch is `<input type="checkbox" role="switch" class="input">`. Group in `<fieldset class="fieldset">` with a `<legend>`.
- This theme's `--input` is very light: give unchecked boxes a visible outline with `not-checked:border-muted-foreground`.
- Don't rely on `accent-color` to theme native boxes: it isn't Baseline. Basecoat draws them.
- Keyboard (APG): Space toggles a checkbox or switch; in a radio group Tab enters, arrows move and check.

## Before you ship
- [ ] Radios for one, checkboxes for many, switches only where changes apply at once
- [ ] Every control has a clickable label in positive words
- [ ] Groups in a fieldset with a question as legend
- [ ] Questions have no pre-selected radio; settings show their current value
- [ ] Unchecked controls are clearly visible in light and dark

*Sources: shadcn/ui Checkbox, Radio Group (description, Choice Card, fieldset, invalid), Switch (sizes, invalid) · Basecoat (classes for checkbox, radio, switch) · Nielsen Norman Group, "Checkboxes vs. Radio Buttons" (when each, standalone checkbox, vertical lists, clickable labels, positive wording, not for actions) and "Toggle-Switch Guidelines" (immediate effect, not in forms with Submit) · GOV.UK Design System, Radios (no pre-selection, inline only for two short options, legend as question, "None", error wording) and Checkboxes ("Select all that apply", "None" last after a divider) · WAI-ARIA APG, Switch (label doesn't change, Space) and Radio Group (arrow keys) · WCAG 2.2 Understanding 1.4.11 Non-text Contrast (a checkbox outline 3:1) · MDN, `accent-color` (limited availability).*
