# Badge

A badge is a small label on an item: its **status** ("Draft", "Overdue") or a **count** ("12"). It only shows; it doesn't do anything. An action is a **button**, going somewhere is a **link**.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the badge's own.

## At a glance
1. **Not clickable.** No link or button made to look like a badge.
2. **One or two words**, a state not an action: "Active", not "Activate".
3. **Quiet by default** (secondary or outline); a solid one sparingly.
4. **Color has one meaning everywhere**, and the word carries it too. Red only for errors and danger.

## Which kind
| `data-variant` | Use for | Example |
|---|---|---|
| `secondary` | most statuses and labels | Draft · Owner |
| `outline` | plain metadata, many in a row | v2.4 · PDF |
| default (primary, solid) | the one status that must stand out; sparingly | Live |
| `destructive` | something failed or needs action now | Failed · Overdue |
| blue tint (classes: `bg-chart-1/15 text-chart-4 dark:text-chart-1`) | new or in progress | New · Syncing |

- Keep the set small: the more statuses, the harder they are to remember. Same status, same badge, on every screen.
- One badge can be enough: people read an item without it as not having that status ("Completed" on finished tasks only).

## Words
- An adjective or a state, sentence case: **Active**, **Paid**, **Overdue**. No verbs (they look clickable) and no ALL CAPS.
- A count is a number only, next to what it counts (Inbox **12**), in the user's number format.
- An icon may go before the word (`data-icon="inline-start"`); a spinner for a state still running (**Deleting**).

## In code
- `<span class="badge">` (Basecoat), plus `data-variant="secondary|outline|destructive|ghost"`. A Lucide icon goes inside.

## Before you ship
- [ ] No badge is a link or a button
- [ ] Every badge is one or two words, a state, sentence case
- [ ] Mostly secondary or outline; solid and red only where they mean something
- [ ] The same status looks the same everywhere
- [ ] Counts sit next to what they count

*Sources: shadcn/ui Badge (variants, icons, spinner, custom colors as classes) · Basecoat 1.0.2 badge CSS · GOV.UK Design System, Tag (status only, not interactive, adjectives not verbs, few tags, consistent color, not color alone, no uppercase, dark tags looked like buttons) · Atlassian Design System, Badge usage (numbers only, with context, bold sparingly, user's locale).*
