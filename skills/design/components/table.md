# Table

A table lets people **compare records** across rows and columns. A plain **Table** for a short, fixed list; a **Data Table** (Table + TanStack Table) when people need to sort, filter, page or act on many rows. Never use a table for page layout.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the table's own.

## At a glance
1. **The first column says what the row is**: a readable name, not an auto-generated ID.
2. **Numbers right-aligned, header and cells alike;** text left.
3. **Row actions:** one or two inline, more in a ⋯ menu; actions on many rows through checkboxes.
4. **Every table has its empty state** ("No results.") and still reads on a phone.

## Columns
- Order columns by importance; keep related ones side by side.
- Numbers: `text-right` on the `TableHead` and the `TableCell`s, formatted (`Intl.NumberFormat`: $1,250.00), `tabular-nums`.
- A total goes in a `TableFooter` row.
- A `<caption>` names the table like a heading (shadcn: `TableCaption`).

## Data Table
| Feature | How |
|---|---|
| **Sorting** | the header is a ghost button with a sort icon; one column sorted at a time |
| **Filtering** | a search input above the table; show clearly when a filter is on |
| **Column visibility** | a "Columns" dropdown of checkboxes |
| **Pagination** | Previous / Next below the table (shadcn: 10 rows a page) |
| **Row selection** | a checkbox per row and one in the header to select all; "2 of 48 row(s) selected." below |

- **Row actions:** a ghost icon button (⋯, `aria-label="Open menu"`) in the last column opening a dropdown menu. One or two common actions can sit inline instead.
- **Batch actions:** buttons above the table that act on the selected rows.
- **Long tables keep the header in view:** `sticky top-0` (with a background) on the `<th>`s, inside a container that scrolls.
- **Editing a row:** a side panel (sheet) keeps the table in view; a dialog hides the rows around it.

## States
- **Empty:** one cell spanning every column: "No results." when a filter matched nothing, or what goes here and a button to add the first one.
- **Loading:** skeleton rows in the columns' shape.
- **Selected row:** a muted background (`data-state="selected"`).

## On phones
- Fewer columns first: hide the less important ones, or let people choose them. Size by the table's box, not the screen: a container query (`@container` on the wrapper, `hidden @md:table-cell` on a column) also works in a narrow panel.
- Still too wide? Scroll the table sideways inside its container (never the page), with the first column fixed (`sticky left-0`) and a cut-off column showing there's more.

## In code
- A real `<table>`: `<caption>`, `<thead>` with `<th scope="col">`, `<tbody>`, `<tfoot>`; row headers `<th scope="row">`.
- Sortable header: a `<button>` inside the `<th>`; `aria-sort="ascending|descending"` on the sorted `<th>` only.
- Basecoat: `<div class="table-container">` (scrolls sideways) around `<table class="table">`; `data-state="selected"` on a selected `<tr>`.

## Before you ship
- [ ] First column names the row; columns in order of importance
- [ ] Numbers right-aligned and formatted, header too
- [ ] Row actions: inline for one or two, else a ⋯ menu with an `aria-label`
- [ ] Header stays in view on long tables; empty and loading states in place
- [ ] Checked at 390 px: fewer columns, or sideways scroll inside the table only

*Sources: shadcn/ui Table (parts, `text-right` amounts, caption, footer) and Data Table (TanStack Table, sorting, filtering, pagination, column visibility, row selection, actions menu, "No results.") · Nielsen Norman Group, "Data Tables: Four Major User Tasks" (readable first column, column order, active filters, inline vs batch actions, editing in a panel, frozen headers) and "Mobile Tables" (fewer columns, sideways scroll with a fixed first column, choosing columns) · GOV.UK Design System, Table (compare data, not for layout, caption, `scope`, numbers right-aligned) · WAI-ARIA APG, Sortable Table example · MDN, `position: sticky` and `@container` (both Baseline widely available) · Basecoat, Table.*
