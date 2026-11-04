# Card

A card holds a few short, related facts about **one thing** (a project, an article, a metric) and usually leads to its details. It suits a collection of **different** kinds of items, like a dashboard. Items of the same kind that people scan or compare go in a **list** or a **table**.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the card's own.

## At a glance
1. **One thing per card**, a few short facts; the details live on its own page.
2. **Comparing similar items? A table or list**, not cards.
3. **Header, content, footer**: title first, actions at the bottom (or one in the header's top right).
4. **A clickable card has one link**, in its title, stretched over the whole card.

## Card or something else
| Use | When |
|---|---|
| **Cards** | browsing a mix of items: a dashboard, a home page, a feed |
| **List** | items of one kind people scan: messages, files, search results |
| **Table** | items people compare by the same fields: plans, orders, users |

In a set of cards, put the same facts in the same place on every card, so the eye finds them.

## Parts
| Part | Holds |
|---|---|
| **Header** | the title, a one-line description under it, an optional action at the top right (a ⋯ menu) |
| **Content** | the body: a value, a short text, a small list, a form |
| **Footer** | the card's actions or secondary info |

- `default` size for most cards; `sm` (smaller spacing) for dense grids.
- **Laid out by its own width**, not the screen's: `@container` on the card (or its `<li>`) and `@md:` variants inside, so the same card works in a sidebar and in a wide grid (container queries: Baseline, widely available).
- Every card in a set uses the same heading level.

## Clickable card
- The title is the link (`<h3><a href>`); its `::after` covers the card (`relative` on the card, `after:absolute after:inset-0` on the link).
- Never wrap the whole card in `<a>`: everything inside becomes the link's label, and a button inside it is easy to miss.
- Few other controls in it (no "Read more" link): a card is not a small web page.
- The whole card shows hover, and the same look on `:focus-within` for the keyboard.

## In code
- A set of cards is a list: `<ul>` with each card in an `<li>`.
- Basecoat: `<div class="card">` (or `data-size="sm"`) with `<header>` (`<h2>`/`<h3>` title, `<p>` description, an action with `class="card-action"`), `<section>` for the content and `<footer>` for actions.

## Before you ship
- [ ] Each card is about one thing; comparable items are a table or list
- [ ] The same facts sit in the same place on every card
- [ ] A clickable card has one link, in its title, covering the card; hover and focus show on the whole card
- [ ] Narrow and wide, the card lays itself out by its own width (`@container`)
- [ ] Cards in a set are a `<ul>` list with the same heading level

*Sources: shadcn/ui Card (header, title, description, action, content, footer; `size="sm"`) · Basecoat 1.0.2 card CSS (markup) · Nielsen Norman Group, "Cards: UI-Component Definition" (one concept, heterogeneous collections, poor for comparing, consistent placement) · Heydon Pickering, Inclusive Components, "Cards" (link in the heading, pseudo-element to cover the card, no link around the card, few tab stops, `ul` list, `:focus-within`) · MDN, `@container` (Baseline widely available since February 2023) · Tailwind CSS, Responsive design: container queries (`@container`, `@md:` = 28rem).*
