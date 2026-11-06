# UI kit — Better DSH bundle and sub-plugins

One flat visual system for every browser surface in this bundle: the Better DSH hub,
all row-config settings pages, and the conversation surfaces owned by
`dsh-better-goal` and `dsh-better-ask-user`.

The clients are independent, zero-build module-loader closures. They cannot
share a runtime package without adding a dependency or a build step, so the
contract is duplicated in each client's CSS and verified by a browser
computed-style audit. Keep the values here and in every client in sync.

## 1. Tokens

Every client root maps host tokens to these local names. Use the local names in
component rules; do not hard-code surfaces.

| Role | Light | Dark |
| --- | --- | --- |
| surface canvas | `var(--dsw-alias-bg-layer-1)` | host dark layer 1 |
| surface raised | `var(--dsw-alias-bg-layer-2)` | host dark layer 2 |
| surface overlay | `var(--dsw-alias-bg-layer-3)` | host dark layer 3 |
| surface sunken | `color-mix(in srgb, ink-1 4%, canvas)` | same rule |
| ink 1 / 2 / 3 | `--dsw-alias-label-primary/secondary/tertiary` | host dark labels |
| line 1 / 2 / 3 | `--dsw-alias-border-l1/l2/l3` | host dark borders |
| accent | `#3388BB` | `#4eb0e8` |
| accent solid | `#20709e` | `#4eb0e8` |
| accent foreground | `#fff` | `#0e1014` |
| accent text | `#14587f` | `#6fc0ee` |
| accent soft | `color-mix(in srgb, accent 10%, transparent)` | 14% |
| success / danger / warn | `--dsw-alias-state-*` | host dark state tokens |
| radius sm / md / lg / xl | `6 / 8 / 10 / 12px` | same |
| control / control-sm | `32 / 28px` | same |
| duration | `140ms` | same |

Ink 3 is mixed 80% tertiary + 20% ink 1 so 12px labels reach AA on white
(the host tertiary alone is 3.7:1). Semantic text mixes 60% host state color
+ 40% ink 1 for the same reason; dots and borders may use the pure host color.
Keep the same mixes in every client.

Rules:

- All borders are 1px solid. No dashed decorative borders, no gradients, no
  grid/dot backgrounds, no glass blur, no glow, no decorative vertical bars.
- Shadows only on overlays (menus, dialogs, toasts).
- Use `tabular-nums` for every comparable number.
- Use the mono stack only for model ids, paths, ids and shortcuts.
- Dark theme is detected by `[data-ds-dark-theme]` on the host body.

## 2. Layout

### Hub

- Dialog max width 1240px, content height `min(760px, 100dvh - 96px)`.
- Header 56px: brand mark + wordmark (14/500) + 28px close. No subtitle.
- Rail 200px: 36px items, 8px radius. Active = accent-soft background +
  accent-text + 1px line; no left decoration bar.
- Content padding 24px 32px; each page is a max-920px column, centered.
- Narrow `<= 640px`: rail becomes a horizontal scrolling tab strip; content
  padding 16px; dialog full-bleed.

### Settings page

- Content column `max-width: 920px; margin: 0 auto`.
- Page title 20/28/500, letter-spacing -0.01em.
- Section title 12/500, ink-3, 1px bottom line; section spacing 24px.
- Setting row: label 13/500; one consequence line 12/ink-3 max two lines;
  control right-aligned. Row padding 10–12px, 1px line-1 between rows.
- Use sections, not card grids. Cards are reserved for selectable strategy
  cards, read-only budget panels, conversation cards and overlays.
- Save footer: sticky, 1px top line, canvas background, 12px padding; only
  visible while dirty, busy or showing a notice. Status left, actions right.

### Narrow `<= 640px`

- Rows stack: label above, control full width, touch targets 44px.
- Tables become cards; diagrams shrink or become 3–4 value rows.
- No horizontal scrolling at 390px.

## 3. Controls

| Control | Contract |
| --- | --- |
| Button | 32px; radius 8; 13/500; primary accent-solid, secondary 1px line-2, ghost transparent; hover line-1 fill; focus 2px accent ring offset 2; disabled .4; loading spinner 12px |
| Text input / textarea | 32px; radius 8; 1px line-2; raised background; focus accent border + ring; number inputs tabular, no native spinners |
| Combobox | trigger shaped like text input; menu overlay surface, 1px line-3, radius 10, 4px padding, shadow; option 30px, radius 6, selected accent-soft + accent-text + check; ArrowUp/Down, Home/End, Enter/Space, Escape, typeahead; flip above when short; no native select/datalist |
| Segmented | container 32px, sunken, 1px line-2, radius 8; item 28px radius 6; selected raised + 1px line + accent-text 500; Arrow keys/Home/End; used for tabs and exclusive modes |
| Switch | 34×20 track, 2px padding, 14px thumb; on accent-solid, off sunken + line-3; focus ring; disabled .4 |
| Range | 4px track, accent filled portion, 14px thumb with 2px accent ring; number readout tabular and 76px wide |
| Choice card | 1px line-2, radius 10, padding 12; selected 1px accent + accent-soft; title 13/500, one line of 12/ink-3, schematic 120–160px; radio semantics |
| Chip / badge | 20px high, 11px, 1px line, radius 999; status only; at most one emphasized badge per screen |
| Details | summary 28–32px, 6px chevron, Escape closes; only for advanced/diagnostics/compatibility |
| Dialog / overlay | 1px line-2, radius 12; focus trapped and returned; Escape closes; shadow only here |

Keyboard:

- Tab follows visual order; Enter activates; Escape closes the innermost layer.
- Segmented groups use arrow keys, Home and End.
- Combobox keeps focus on the trigger and uses aria-activedescendant.
- IME composition never triggers global shortcuts.

## 4. Copy

Visible copy is only: label, current value, unit, state, action, error or
dependency. Move mechanism explanations into `title`, `aria-describedby` or a
collapsed details region.

Remove:

- duplicate page/section headings;
- long mechanism paragraphs, budget rule prose, keyboard hints;
- "typing restarts", "you can still answer", repeated disabled explanations;
- bilingual duplicates and slogans.

Keep:

- consequences that prevent a wrong choice: both scopes off, invalid route,
  unsupported effort, model outside catalog, reload required, read-only,
  conflict, save failure, permission consequences;
- page titles that match the hub navigation.

## 5. Test contracts

Do not rename or remove selectors/ids/data attributes asserted by existing
tests. Add classes instead. In particular:

- Better DSH: one `.apollo-root`, `.apollo-cfg[data-settings-dirty]`,
  `.apollo-footer` hidden semantics, `.apollo-pageTitle`, `.apollo-switch`,
  hub tab roles.
- Subagent: `.bs-root`, `.bs-title h2`, `.bs-header`, `.bs-switch`,
  `.bs-advanced`, `.bs-cellLabel`, `.bs-footer` first child `.bs-status`,
  `.bs-feedback`, `.bs-overviewGlyph`, combobox roles/ids, CSS literals.
- Compact: `.dsh-bc-page`, three `data-diagram` SVGs, `.dsh-bc-row`,
  `.dsh-bc-current-line`, `.dsh-bc-explanation`, mode radios, `data-bc` hooks,
  form names/ids.
- Goal: `.dbg-cfg`, `h3.dbg-title`, `.dbg-section`, `.dbg-segmented` ids,
  `.dbg-advanced`, `.dbg-help.dbg-info`, `.dbg-runtime`, `.dbg-footer`,
  `.dbg-status`, dock/history ids.
- Ask-user: `better-ask-user-*` ids, `data-settings-dirty/busy`,
  `data-settings-save`, `data-question-wait`, exact labels/aria.

## 6. Review checklist

- [ ] Light, dark and 390px screenshots inspected; no clipping or horizontal scroll.
- [ ] Only 1px solid borders; no gradients, dot/grid backgrounds, glass or glow.
- [ ] The same control has the same geometry on every page.
- [ ] At most one solid accent block per screen; at most two semantic color families.
- [ ] Numeric values tabular; mono only for ids/paths/model names.
- [ ] Keyboard can complete every flow; Escape closes the innermost layer.
- [ ] Save bar appears only when dirty/busy; close guard still works.
- [ ] Hidden panes do not poll or fetch.
