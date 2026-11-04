# Field

Where people type: an **Input** for one line, a **Textarea** for more, each with a **Label**, wrapped in a **Field** that holds the label, the control, its help text and its error. Picking from options is Select or Choice, not a field.

General rules (layout, spacing, type, colors, focus) are in `../general.md`; these are the field's own.

## At a glance
1. **Every field has a visible label** above it. A placeholder is never the label.
2. **Input for one line, Textarea for more.** Size each to the answer it expects.
3. **The error sits under the field and says how to fix it.** What they typed stays.
4. **Mark required or optional one way, everywhere.**

## Which one
| Component | Use for | Example |
|---|---|---|
| **Input** | a short, one-line answer | Name · Email · Amount |
| **Textarea** | text longer than one line; its height (`rows`) follows the expected length | Description · Message |
| **Label** | the name of every input and textarea | Email address |
| **Field** | the wrapper: label, control, help, error | — |
| **Fieldset** + legend | related fields grouped under one title | Address · Profile |

## Label, help and placeholder
- The label: short, sentence case, no colon at the end, above the control.
- Help text (`FieldDescription`): one short sentence, muted, under the control.
- Placeholder: not a label, not a hint people need. It disappears once they type, and many miss it. At most a sample answer beside a real label.
- Width follows the content: a postcode field is short, a name field wider. Not every field stretched full width.
- Set the right `type` and `autocomplete` (`email`, `name`, `tel`…); `inputmode="numeric"` for whole numbers, `"decimal"` for decimals; `enterkeyhint` (`next`, `done`, `search`, `send`) for the phone keyboard's Enter key.
- A textarea that grows with its text: `field-sizing-content min-h-16` (shadcn's Textarea), capped with a `max-h-*` after which it scrolls; keep `rows` as the starting height for browsers without it.

## Required and optional
- Pick one convention and keep it: when most fields are required, add **(optional)** to the label of the few that aren't; if you mark required fields with an asterisk, mark **every** one.
- Put `required` on the control either way, so assistive tech announces it.

## Errors
- **Check a field when the person leaves it**, not while they type; check as they type only for rules like a new password's requirements.
- Show the error **right under the control**, in `text-destructive`, and set the field invalid (red border): `aria-invalid="true"` plus `aria-describedby` to the message. For the browser's own checks (`required`, `type="email"`), style with `user-invalid:` (`:user-invalid`), which turns red only after someone has used the field, never on an untouched form.
- Say what to do: **Enter your email address**, **Name must be 35 characters or less**. Not "Invalid", "Error" or "This field is required".
- Keep what they typed; never clear the field.

## In code
- `<label for>` matched to the control's `id`; `<input>` or `<textarea>`, never a `contenteditable` div.
- Basecoat: `<div role="group" class="field">` with `<label>`, the `<input>`/`<textarea>`, and a `<p>` for help. Invalid: `data-invalid` on the field, `aria-invalid="true"` on the control, `aria-describedby` pointing to the error `<p role="alert">`. Group: `<fieldset class="fieldset">` with `<legend>`.

## Before you ship
- [ ] Every control has a visible `<label>`; no placeholder used as one
- [ ] Textarea only for multi-line answers; widths fit the answers
- [ ] Required/optional marked one way across the form
- [ ] Checked when the person leaves a field; errors under it say how to fix it, with `aria-invalid` and `aria-describedby`
- [ ] `type`, `autocomplete`, `inputmode` and `enterkeyhint` set

*Sources: shadcn/ui Field (Field, FieldLabel, FieldDescription, FieldError, FieldSet; `data-invalid`, `aria-invalid`; error right after the control) · Basecoat Field (markup) · GOV.UK Design System, Text input (visible labels, no placeholder, width, autocomplete, inputmode), Textarea (longer than one line, height, labels without a colon), Error message (how to word it, keep entries), Question pages ("(optional)", no asterisks) · Nielsen Norman Group, "10 Design Guidelines for Reporting Errors in Forms" (error when the field is done; live only for passwords) · MDN, `enterkeyhint`, `:user-invalid` (Baseline widely available), `field-sizing` (Baseline 2026, newly available) · shadcn/ui Textarea source (`field-sizing-content min-h-16`) · Nielsen Norman Group, "Placeholders in Form Fields Are Harmful" · Nielsen Norman Group, "Marking Required Fields in Forms" (asterisk on every required field).*
