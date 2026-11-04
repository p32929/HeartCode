# Date picker

How people enter a date. **Typed fields** for a date they know (a birthday); a **calendar in a popover** when seeing the month helps (a booking, a deadline, a range); the browser's **`<input type="date">`** for a plain single date, especially on phones.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the date picker's own.

## At a glance
1. **A date people know is typed,** in Day / Month / Year fields. Never make them page back through years.
2. **A calendar for dates near today** (within about a year) and for ranges; typing still works.
3. **Impossible dates can't be picked:** before today when that makes no sense, an end before its start.
4. **Never three dropdowns** for day, month and year.

## Which one
| Use | When | Example |
|---|---|---|
| **Typed fields** (Day, Month, Year) | a date people know or can look up | date of birth · passport issued |
| **`<input type="date">`** | a single date, no special calendar needs; good default on phones | due date in a simple form |
| **Calendar in a popover** | a date near today where weekday and month matter | delivery date · meeting |
| **Range calendar** | a start and an end | trip · report period |

## Typed fields
- A `<fieldset>` whose `<legend>` asks the question ("What is your date of birth?"), a hint with an example ("For example, 27 3 2007"), then **Day**, **Month**, **Year**, each labeled.
- `inputmode="numeric"`; for a birthday `autocomplete="bday-day|bday-month|bday-year"`. Accept "jan" or "january" in Month.
- Never jump to the next field automatically.
- Errors: "Enter your date of birth", "Date of birth must be a real date". Highlight only the wrong field, or the whole date when it's empty or out of range.

## Calendar in a popover
- The trigger is an outline button with a calendar icon showing the chosen date ("November 4th, 2026"), or "Pick a date" when empty. Better: a text field people can type into, with the button beside it.
- Month names spelled out; **today** marked; dates outside `min`/`max` shown disabled.
- Picking a date closes the popover and fills the field.

## Ranges
- Two months side by side (`numberOfMonths={2}`); the start and end marked, the days between highlighted. The trigger shows both: "Nov 20, 2026 – Dec 4, 2026".
- After the start is picked, the months stay where they are; an end before the start can't be picked.

## In code
- Native: `<label>` + `<input type="date" min max>` (Baseline, widely available). It shows the date in the person's locale; its value is always `yyyy-mm-dd`. It holds one date, not a range.
- Calendar: WAI-ARIA date picker dialog. A text input and a "Choose date" button; the calendar is a grid: arrows move by day and week, Page Up/Down by month, Enter picks, Esc closes and returns focus to the button; the chosen day has `aria-selected="true"`.
- shadcn: `Popover` + `Calendar` (React DayPicker), `mode="single"` or `mode="range"` (outline trigger button, `CalendarIcon`); set `timeZone` so a picked date doesn't shift by a day.

## Before you ship
- [ ] Known dates typed in Day / Month / Year, with the right `autocomplete`
- [ ] Calendars only for dates near today or ranges; typing still works
- [ ] Today marked; impossible dates disabled
- [ ] Ranges: two months, start and end clear, the end can't precede the start
- [ ] Keyboard: arrows in the grid, Esc closes and returns focus

*Sources: GOV.UK Design System, Date input (memorable dates, fieldset and legend, Day/Month/Year, hint, `inputmode="numeric"`, `bday-*` autocomplete, month names, no auto-tab, errors) · Nielsen Norman Group, "Date-Input Form Fields: UX Design Guidelines" (calendars for dates within about a year, allow typing, avoid split drop-downs, ranges in two months, mark today, disable illogical dates, spell out month names) · MDN, `<input type="date">` (Baseline widely available since April 2021, locale display, `yyyy-mm-dd`, `min`/`max`) · WAI-ARIA APG, Date Picker Dialog example · shadcn/ui Date Picker (outline trigger, "Pick a date", two-month range, input) and Calendar (React DayPicker, `mode`, `timeZone`).*
