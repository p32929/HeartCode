# Alert

An alert is a message **inside the page**, near what it's about: a failed payment, a form that didn't send, something to know before you go on. It stays until it's fixed or dismissed. A short notice that comes and goes is a **toast**; a critical message that must be answered now is a **dialog**.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the alert's own.

## At a glance
1. **Alert, toast or dialog by how much it must interrupt** (table below).
2. **Near what it's about**: the top of the main content, or next to the item; in a form, just above its buttons.
3. **The title says the point; the text says what to do.** One or two short sentences.
4. **Stays until fixed or dismissed**, never on a timer. Few per page.

## Alert, toast or dialog
| Use | When | Example |
|---|---|---|
| **Alert** | about this page or task; people should see it but can keep working | "Your card was declined" above the payment form |
| **Toast** | brief, from the system or after an action, not tied to a place on the page | "Changes saved" · "You're offline" |
| **Dialog** | critical; needs attention or a decision **now**, and blocks the task | "Your session ends in 1 minute" |

Don't put anything critical in a toast: it can vanish before it's read.

## Which kind
| `data-variant` | Use for |
|---|---|
| default | information, success, warnings: the icon and the title say which |
| `destructive` | errors and failures |

## Words
- **Title:** short, the most important point, no full stop. An error says what failed: "Payment failed", not "Error".
- **Text:** one or two short sentences, not a repeat of the title. An error says how to fix it.
- **Action:** one at most, a button of 1–2 words ("Update card"). A close button only if people don't need to read or act on it.
- An alert about a field adds to that field's own error; it doesn't replace it.

## In code
- Basecoat: `<div class="alert">` (`data-variant="destructive"` for errors) with a Lucide icon, an `<h2>`–`<h4>` title, a `<section>` for the text and an optional `<footer>` for the action (top right).
- An alert that appears after something happens is a live region, and never moves focus:
  - `role="alert"` for errors and anything urgent (a form error after submit): it interrupts what the screen reader is saying.
  - `role="status"` for the rest ("Draft saved"): polite, read when the user is idle. Put the empty region in the page from the start and change its text later; one added with its text already in may not be read.

## Before you ship
- [ ] It's an alert because it belongs on the page; critical ones are dialogs, passing ones toasts
- [ ] Placed next to what it's about, or at the top of the main content
- [ ] Title says the point; errors say how to fix it
- [ ] Doesn't disappear on its own; at most one action
- [ ] Shown later: `role="alert"` if urgent, `role="status"` otherwise; focus stays where it was

*Sources: shadcn/ui Alert (title, description, action, `default`/`destructive`) · Basecoat 1.0.2 alert CSS · Carbon Design System, Notification usage (inline placement, in forms above the buttons, no auto-dismiss, statuses, title/body/action wording) and Notification pattern (inline vs toast vs modal) · WAI-ARIA APG, Alert pattern (`role="alert"`, announced only when added, never moves focus, no auto-dismiss, don't overuse) · MDN, ARIA `status` role (polite, advisory, don't move focus) and ARIA live regions (assertive only for urgent messages; create the region before updating it).*
