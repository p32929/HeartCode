# General rules

These apply to every screen. Each component's own rules are in `components/<name>.md`.

## At a glance
1. **Use the full width.** No narrow column with empty sides; rows of cards fill the screen at every size.
2. **The theme's tokens only** (`theme.css`): neutral surfaces, blue for highlights, red for danger.
3. **One spacing scale**: tight inside a group, more space between groups.
4. **Every screen has its states**: loading, empty and error.
5. **Accessible**: real HTML elements, labels, keyboard, visible focus, 4.5:1 text.

## Stack
- Use the project's own design system when it has one.
- Otherwise: **shadcn/ui's look in HeartCode's theme**. React: shadcn/ui. Plain HTML: **Tailwind** + **Basecoat** (shadcn's classes for HTML: `class="btn"`, `class="card"`, `class="input"`…) + **Lucide** icons, versions pinned from a CDN. Utility classes, not hand-written CSS.
- **The theme is `theme.css`** (next to this file); copy it into the project:
  - **Tailwind v4 build:** it's the CSS entry as it is.
  - **Tailwind's browser build** (reads only inline styles): link it as a stylesheet after Basecoat, and put its `@custom-variant`, `@theme inline` and `@layer base` blocks in a `<style type="text/tailwindcss">`.
  - **Fonts:** load **DM Sans** and **Geist Mono** from Google Fonts.

## Layout
- **Full width:** no `max-width` page container. Page padding `px-5 sm:px-8 lg:px-10`.
- **Rows fill:** cards that grow to share a row (`flex flex-wrap` with `flex-[1_1_18rem]` children), so no row ends in a gap.
- **Line length:** long paragraphs stay readable, about 50–75 characters (`max-w-prose`), inside the full-width layout.
- **Every size:** from 360 px up, nothing scrolls sideways or overlaps.

## Spacing
- Tailwind's 4 px scale only (`gap-2` 8 · `gap-4` 16 · `gap-6` 24 · `gap-8` 32…); no arbitrary values.
- Related things close together (8–12 px); separate groups further apart (24–48 px).

## Type
| Role | Class |
|---|---|
| Page title | `text-2xl`–`text-3xl font-semibold tracking-tight` |
| Section title | `text-lg`–`text-xl font-semibold` |
| Body in an app | `text-sm` (14 px), reading text `text-base` (16 px) |
| Secondary text | `text-sm text-muted-foreground` |

- `font-sans` (DM Sans) everywhere; `font-mono` (Geist Mono) for code, keys and IDs. Weights 400–600.
- Sentence case; no ALL CAPS for text people read. `tabular-nums` for numbers in tables.

## Color
- Only the theme's tokens: `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-1`…`chart-5`, `sidebar-*`, each with its `-foreground`. No hex values, no palette colors (`violet-600`).
- **Neutral by default.** `primary` (near-black; near-white in dark) for the main action.
- **Blue** (`chart-1` light … `chart-5` dark) for highlights, links, charts and info; tint with opacity (`bg-chart-1/15`).
- **`destructive`** (red) only for danger and errors.
- **Dark mode** is the `.dark` class: the same tokens, so a screen written with tokens already works in both.
- Text contrast at least **4.5:1**, icons and focus indicators **3:1**. Never color alone: add an icon or a word.
- The theme's `border` and `input` are deliberately soft: fine for dividers and cards, too faint where the outline is the only thing that shows a control. Give unchecked checkboxes, radios and switches `not-checked:border-muted-foreground` (3:1, WCAG 1.4.11).

## Shape and depth
- The theme's radius (`--radius` 1rem): `rounded-md` for controls, `rounded-lg`/`rounded-xl` for cards and panels, `rounded-full` for pills and avatars.
- A card has a border **or** a soft shadow (`shadow-sm`), not both heavy. What floats (menus, dialogs, toasts) gets `shadow-lg`.

## Icons
- Lucide only, `size-4` next to text, the same stroke everywhere.
- An icon goes with a word unless it's universal (close, search, more). Icon-only controls get an `aria-label`; decorative icons `aria-hidden="true"`.

## States
| State | Shows |
|---|---|
| Loading | a skeleton in the content's shape, or a spinner in the control; no layout jump |
| Empty | what goes here and a button to add the first one |
| Error | what went wrong and how to fix it, next to where it happened |

## Accessibility
- Real elements: `<button>` for actions, `<a href>` for navigation, a `<label>` for every field, headings in order.
- Everything works by keyboard, with a visible focus ring.
- Click targets at least 24 × 24 px; images have `alt` text.
- Motion short (150–300 ms) and off under `prefers-reduced-motion`.

## Modern practice
Use the platform before JavaScript, and match a feature to how widely it works (Baseline, Nov 2026).

**Use freely** (works in every current browser):
- `<dialog>` with `showModal()` for modals: focus stays inside, Esc closes, the page behind is inert, `::backdrop` dims it. `<details>`/`<summary>` for show/hide.
- `inert` on whatever sits behind an overlay; `:focus-visible` for the focus ring; `:has()` to style a parent by its state.
- **Container queries** (`@container`; Tailwind `@container` + `@md:`) so a component fits the space it's put in, not just the screen width.
- `dvh`/`svh` instead of `vh` for full-height on phones (the address bar moves); `env(safe-area-inset-*)` with `viewport-fit=cover` to keep clear of notches and the home bar.
- `color-scheme: light dark` so native controls and scrollbars match the theme.
- Inputs: the right `type`, `inputmode`, `autocomplete` (WCAG 1.3.5) and `enterkeyhint`; style errors with `:user-invalid` (Tailwind `user-invalid:`) so a field turns red only after someone has used it.
- `prefers-reduced-motion` (Tailwind `motion-safe:` / `motion-reduce:`).

**Use with a fallback** (newly in every browser; older ones lack it):
- The `popover` attribute for menus and popovers (top layer, light dismiss, Esc).
- `@starting-style` + `transition-behavior: allow-discrete` (Tailwind `starting:`) for enter and exit animations of dialogs and popovers.
- `text-wrap: balance` on headings; `scrollbar-gutter: stable` so content doesn't shift; `field-sizing: content` for a textarea that grows.
- Same-page view transitions (`document.startViewTransition`, only when it exists).
- `<details name="…">` for an accordion where one opens at a time.
- CSS anchor positioning (`anchor-name`, `position-anchor`, `position-try`) to place a menu or tooltip by its button; keep a few lines of JS positioning for older browsers.

**Only as an extra** (not in every browser yet; the screen must work without it): cross-page view transitions, the customizable `<select>`, `text-wrap: pretty`.

**Patterns:**
- **Undo over "Are you sure?"** for everyday actions (delete, archive): do it, then offer Undo in a toast. Confirm only serious actions that can't be undone, naming the thing and the outcome ("Delete project" / "Keep project").
- **Validate a field when the person leaves it**, not while they type; live checks only for rules like password requirements. The error sits next to the field; a summary at the top only in addition.
- **Show feedback at once:** a pressed state, then a spinner in the control or a skeleton in the content.

## Words
- Real content, never lorem ipsum. Actions are verbs ("Save changes"). Errors say what happened and what to do.

## Before you ship
- [ ] Full width at 390, 768, 1280 and 1920 px; no row ending in a gap; no sideways scroll
- [ ] The theme's tokens and fonts only; looks right in light and dark
- [ ] Loading, empty and error states
- [ ] Keyboard works; labels, `alt` and `aria-label` in place; text 4.5:1
- [ ] Looked at it rendered, not just in code

*Sources: WCAG 2.2 (1.4.1 Use of color, 1.4.3 Contrast, 1.4.11 Non-text contrast, 2.4.7 Focus visible, 2.5.8 Target size, 2.3.3 Animation from interactions) · shadcn/ui (tokens, theming) · Tailwind CSS (spacing, type scale) · Baymard Institute (line length) · Nielsen Norman Group (icon usability, empty states, "Confirmation dialogs can prevent user errors", "10 design guidelines for reporting errors in forms") · Baseline status: web-features data / MDN (Nov 2026) · the theme: tweakcn.com/themes/cmho4nr9l000h04l1gu419ckw.*
