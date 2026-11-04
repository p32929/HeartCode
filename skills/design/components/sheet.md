# Sheet

A **sheet** slides in from an edge and covers part of the page: for a secondary task done without leaving it (edit a record, filters, settings). A **drawer** is the bottom sheet for phones, dragged by its handle. A short task belongs in a dialog (`dialog.md`), a long or complex flow on its own page.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the sheet's own.

## At a glance
1. **A brief, secondary task**, not a page: never use sheets for page-to-page navigation or long flows.
2. **One at a time.** Never open a sheet on top of a sheet.
3. **Always a title and a visible ✕**: the handle and swiping are never the only way out.
4. **The footer stays put** (Cancel beside Save); only the body scrolls.

## Which one
| Use | When | Example |
|---|---|---|
| **Dialog** (`dialog.md`) | a short task or a decision, centered | Rename file · Delete project? |
| **Sheet** (side, right by default) | a secondary task or details on a larger screen; the page stays in place behind | Edit customer · Filters |
| **Drawer** (bottom) | on a phone: a brief task or a few options | Share · Sort by |
| **Page** | long or complex flows, anything people stay in | Checkout · Settings with many sections |

- **Same task on desktop and phone?** A Dialog on desktop and a Drawer on a phone (shadcn's responsive dialog).
- A sheet is modal: the page behind can't be used. If people need to read or work with what it covers, use a page or a nonmodal panel instead.

## Side sheet
- **Width:** three quarters of the screen, up to 384 px (`w-3/4 sm:max-w-sm`).
- Header (title, one line of description), scrolling body, footer with **Cancel** and the primary (**Save changes**).
- Closes by ✕, Esc and a click outside; focus returns to the button that opened it.

## Bottom sheet (drawer) on phones
- **Handle:** a short pill centered at the top (`h-2 w-[100px] rounded-full bg-muted`) on a sheet that can be dragged. Swiping down closes it; keep the ✕ too, and let Back close it.
- **Height:** sized to its content, at most the screen minus 6rem (`max-h-[calc(100dvh-6rem)]`), so the page still shows above. Use `dvh`, not `vh`: on a phone the address bar comes and goes, and `vh` hides the bottom under it. Rounded top corners (`rounded-t-lg`).
- **Snap points** (optional): let a sheet that can grow rest at a few set heights (e.g. half, then full), dragged up for more.
- **Safe area:** pad the footer by the home bar, `pb-[calc(1rem+env(safe-area-inset-bottom))]` (with `viewport-fit=cover` in the viewport meta).
- **Unsaved changes:** swiping away asks first.

## In code
- Native `<dialog>` opened with `showModal()`: the page behind turns inert, focus stays inside, Esc closes, `::backdrop` dims the page. A sheet built some other way sets `inert` on the page itself. `aria-labelledby` → the title.
- Basecoat: `<dialog class="drawer" data-side="right">` (`left`, `top`; none = bottom) › `<article>` › `<header><h2>…</h2><p>…</p></header>`, `<section>` (scrolls), `<footer>`. Add a ghost ✕ button (`aria-label="Close"`).

## Before you ship
- [ ] A brief secondary task; never a sheet on a sheet, never for page-to-page navigation
- [ ] A title and a visible ✕; Esc, click outside and (phones) Back close it
- [ ] Footer visible while the body scrolls; Cancel beside the primary
- [ ] Bottom sheets: handle, at most `100dvh` minus 6rem, footer clear of the home bar

*Sources: shadcn/ui Sheet (sides, `side="right"`, `w-3/4 sm:max-w-sm`, source) and Drawer (responsive Dialog/Drawer, height capped at `calc(100dvh - 6rem)`, snap points only vertical, the handle `h-2 w-[100px]`) · Basecoat Drawer (markup, `data-side`) · Nielsen Norman Group, "Bottom Sheets: Definition and UX Guidelines" (brief tasks, not for page-to-page flows, visible close button, Back closes, no stacking, the handle is easy to miss) · Apple Human Interface Guidelines, Sheets (brief and occasional, one at a time, Cancel with Done, grabber on resizable sheets, detents, swipe to dismiss and confirm unsaved changes) · Atlassian Design System, Drawer (secondary task without leaving the page, not when people need what's behind, a title, Esc and blanket close) · Base UI Drawer (snap points, swipe direction) · MDN `env()` and viewport `viewport-fit=cover` (safe-area insets), viewport units (`dvh` vs `vh`), `<dialog>` and `inert` (Baseline widely available).*
