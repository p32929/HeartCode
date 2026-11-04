---
description: How to make anything people look at or use beautiful and right — web pages, apps, dashboards, components, forms, landing pages, browser games and 3D scenes. Load it before building or restyling any interface, and before calling one done.
use: model
---

# Designing so it's beautiful and works

Good design is a set of decisions that fit this product and its people, carried out with care and then checked on the real, rendered result. Every familiar pattern (cards, gradients, a centered hero, pills, glass) is allowed when it has a job here; none is allowed as a reflex.

## 1. Decide before you build

- **Who, where, doing what.** The audience, the device and the setting (a phone on a bus, a desk all day), and the one thing they came to do or decide.
- **What kind of surface it is.** Set your ambition by it:
  - *Persuade* (landing pages, pricing): earn attention and action; bold, distinctive, a clear point of view.
  - *Operate* (apps, dashboards, settings, tools): scanning, consistency and speed beat expression; brand lives in the details.
  - *Read* (docs, articles): structure for understanding, then make reading pleasant.
  - *Experience* (games, portfolios, showcases): the work itself leads from the first screen; the interface recedes.
- **One sentence of direction** specific enough to rule things out. "A calm, dense field notebook for researchers, evidence always next to the claim" — not "clean and modern".
- **Two or three supporting decisions** that follow from it: a type pairing, a density, a material or lighting model, one signature interaction. Not a pile of unrelated effects.
- **An existing brand or design system wins.** Extend it; don't import a house style. What the user asked for (an era, a palette, a font) wins over your taste.
- **No invented facts.** No fake metrics, logos, testimonials or user counts to fill space; use real content or clearly placeholder content.

## 2. Structure first, then style

- Sketch the order of sections or screens, what's biggest, what's grouped, and how it reflows on a phone, before any styling.
- For each step of a flow, answer: what does the person want here, what do they see, what do they do, what happens next. Do the most used and most costly-to-get-wrong paths first.
- Every screen has five states: **ideal, empty, loading, partly filled, error**. Build all that apply, plus hover, focus, active, disabled and success.
- Containers follow meaning: group with spacing, alignment or a background change before reaching for a card. Never put cards inside cards.

## 3. A small system, as variables

Define only what the work needs, once, as CSS variables or tokens:

- **Type:** one or two families chosen for character, not the default (avoid Inter or system fonts as the display face). Clear steps of size and weight, body text 16px or more, lines 65–75 characters, display text at most about 6rem, tracking no tighter than −0.04em, balanced headings (`text-wrap: balance`), tabular numerals for data.
- **Colour:** neutrals tinted towards the brand hue, one accent used sparingly for action and state, semantic colours for success, warning and error. Text contrast at least 4.5:1 (3:1 for large text). On a coloured surface, tint secondary text from that colour, never plain grey. Choose light or dark from where it's used, not by habit, and support both when it's an app.
- **Space:** one scale (4/8-based). Tight inside groups, generous between them, more space above a heading than below it.
- **Surfaces:** pick one depth model, border or shadow, not both on the same thing. Shadows have an offset and a soft blur, tinted by the background. Radii vary with size: tighter on small controls, softer on containers.
- **Motion:** one considered moment rather than effects everywhere. Ease-out, 150–300 ms for interface responses; animate transform and opacity (and blur, clip-path, mask when they stay smooth). The page must look right with no motion, and honour `prefers-reduced-motion`.

## 4. Build the real thing

- Semantic HTML (header, nav, main, section, button, label), keyboard reachable, visible focus rings, alt text, form labels.
- Real copy in the product's own voice: buttons name their action ("Save changes"), errors say what went wrong and how to fix it.
- Theme the parts you didn't draw: text selection, caret, scrollbars, focus rings, link underline offset, `accent-color` on form controls. This is where built pages differ from assembled ones.
- Icons from one real set (inline SVG), one stroke weight; never emoji or Unicode glyphs as an icon system.
- Responsive from 360px up: no sideways scroll, nothing clipped or overlapping, tap targets at least 44px, `min-height: 100dvh` rather than `100vh`.
- Use real images where they carry meaning; reuse the project's assets; don't fake a brand mark.

## 5. Defaults to refuse unless the brief earns them

- The launch-page stack: pill badge, centered headline with a gradient word, vague subline, two buttons, floating mockup, logo strip, three icon cards, stats, testimonials, FAQ.
- Same-size cards of icon + heading + text as the whole page; an icon in a tinted rounded square above every heading.
- Purple-to-blue gradients, gradient text, glow on everything, glass over blurred blobs, decorative dot grids and stripes.
- A small label or eyebrow above every heading; "01 / 02 / 03" section numbers that mean nothing.
- Coloured thick left borders on cards and alerts; hard offset "brutalist" shadows outside a brutalist world.
- Pills on everything; one huge radius on everything.
- Monospace as a costume for "technical"; fake charts, sparklines and dashboards as decoration.
- Every section the same height, padding and weight: no rhythm, no hierarchy.
- A fade-in on every section, parallax and floating objects in place of hierarchy.
- A modal for something that doesn't need to interrupt.

Ask of any conspicuous choice: what job does it do here, what simpler choice did I consider, and does it hold with real content on a narrow screen? Could this page belong to another product by swapping the logo? If so, it isn't designed yet.

## 6. Games, canvas and 3D

- **Art direction first:** a palette (3–5 colours plus neutrals), a lighting mood (golden hour, night neon, overcast), and a level of stylisation, chosen together.
- **Light and materials do the work:** a sun (directional) light with soft shadows, a sky or hemisphere fill, fog for depth, physically based materials with real roughness and metalness, tone mapping and sRGB output. Shapes built from many simple primitives (bevels, wheels with rims, windows, lights) read far better than single boxes.
- **Motion and feel:** smooth camera follow with lag, acceleration and drift curves, screen-space speed cues, particles for dust and sparks, a short countdown and clear feedback on every action.
- **The interface over it:** a readable HUD on a translucent panel, at screen edges, large numerals; start, pause and finish screens with one clear action; controls shown on the first screen; touch controls on phones.
- **Solid:** resize handling, devicePixelRatio capped around 2, a steady 60 fps (reuse geometries and materials, no allocations per frame), no console errors, works opened from a local server.

## 7. Look at it, then fix it

Code that looks right is not evidence. Render it and look:

- `heartcode page <file>` opens the page in a real browser, reports errors, clicks its first button and presses keys, and saves desktop and phone screenshots to `.heartcode/page-shots/`. Open the screenshots (read_file) if you can see images. If not, use the report.
- **Function pass:** no errors; every state works; keyboard and focus; nothing overflows, clips or overlaps at 390px, about 820px and 1440px; long text and empty data hold.
- **Look pass:** what are the first three things the eye lands on, and are they the right three? Is there one strong idea, carried through? Remove the effects in your head: if the hierarchy disappears, fix layout and type, not decoration.
- Fix causes in this order: content and order, layout, hierarchy, type, colour, then decoration. Look again after big changes; batch small fixes between looks.

Done means: a clear hierarchy and a reason for the look, every state and size working, contrast and focus right, nothing generic left by reflex, and the render checked.

---
Built on ideas from [Impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0, © Paul Bakaus), [AI Web Design](https://github.com/jasenf/ai-web-design) by Jasen F., and [User Flow Specs](https://github.com/rae-pendergrass/user-flow-specs) (MIT, © Rae Pendergrass), written anew for HeartCode.
