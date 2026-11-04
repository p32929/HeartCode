# Sidebar

A sidebar is an app's **main navigation**, a vertical list of sections on the left. Use it when there are many sections, more will come, or people use the app every day. A **top nav** suits a handful of sections that fit in one row and leaves the content more room.

General rules (layout, spacing, type, colors, focus, icons) are in `../general.md`; these are the sidebar's own.

## At a glance
1. **Sidebar for many or growing sections, top nav for a few.** Never both for the same links.
2. **Every item has a visible word,** left-aligned; an icon only beside it.
3. **The current page stands out** by more than color, and is marked `aria-current="page"`.
4. **Always visible on desktop;** on phones it opens as a sheet from a menu button.

## Which one
| Use | When |
|---|---|
| **Sidebar** | many sections, the list will grow, an app people use daily |
| **Top nav** | a few sections that fit in one row; the content needs the width |

## Items and groups
- Specific labels with the keyword first ("Invoices", not "Manage"); left-aligned, never centered.
- Related items in a labeled group (`SidebarGroupLabel`); the most used at the top, the less important lower down.
- The app or workspace name in the header; the account and settings in the footer.
- Sub-pages nest under their section (`SidebarMenuSub`).
- A count goes at the item's end (`SidebarMenuBadge`).

## Current page
- shadcn's `isActive` gives the item a filled background and medium weight: the fill plus the weight, not color alone.
- Mark the link `aria-current="page"`. Only one item is current.

## Collapsed and phones
- Desktop: 16rem wide. Let people collapse it to 3rem of icons (`collapsible="icon"`) only in an app used daily; each icon keeps its name as a tooltip (`SidebarMenuButton tooltip`) and an accessible name. Toggle: a `SidebarTrigger` button and ⌘B / Ctrl+B.
- Don't hide the desktop sidebar behind a ☰ menu.
- Phones: the sidebar is a sheet (18rem) that slides over the page from a menu button at the top; choosing a page closes it. Build it as a modal `<dialog>` (`showModal()`: the page behind goes inert, Esc closes) or shadcn's Sheet.
- Full height with `h-dvh`, not `h-screen` (`100vh` runs under a phone's address bar); on desktop `sticky top-0 h-dvh` keeps it in place while the page scrolls.

## In code
- `<nav aria-label="…">` with `<a href>` links in lists; buttons only for actions.
- shadcn: `SidebarProvider` › `Sidebar` › `SidebarHeader`, `SidebarContent` (`SidebarGroup` › `SidebarGroupLabel`, `SidebarMenu` › `SidebarMenuItem` › `SidebarMenuButton isActive`), `SidebarFooter`; `SidebarTrigger` in the page header.
- Basecoat: `<aside class="sidebar">` › `<nav aria-label>` › `<section>` › `<div role="group" aria-labelledby>` with an `<h3>` and a `<ul>` of links; sub-menus are `<details>`/`<summary>`; `sidebar.min.js` adds the toggle and the phone overlay.

## Before you ship
- [ ] Sidebar or top nav chosen by the number of sections; links not repeated in both
- [ ] Every item has a visible, left-aligned label
- [ ] Current page: filled and bolder, with `aria-current="page"`
- [ ] Phones: a menu button opens it as a modal sheet (page inert, Esc closes); a link closes it; height in `dvh`
- [ ] Collapsed icons have tooltips and accessible names

*Sources: shadcn/ui Sidebar (parts, `isActive` = accent fill + medium weight, `tooltip` when collapsed, `collapsible` offcanvas/icon/none, 16rem / 18rem mobile / 3rem icons, Sheet on mobile, ⌘B / Ctrl+B) · Nielsen Norman Group, "Left-Side Vertical Navigation on Desktop" (scales and scans better, less room for content, left-aligned text labels, icon-only only for daily-use apps, don't hide desktop nav, don't duplicate menus, less important lower) and "Navigation: You Are Here" (current item stands out by more than color) · MDN, aria-current, `<dialog>` (showModal: inert page, Esc; Baseline widely available) and length (`dvh` vs `vh`) · Basecoat, Sidebar (markup, mobile overlay closes on a link).*
