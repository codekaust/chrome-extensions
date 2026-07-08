# FocusBlock — Design System

A single source of truth for how FocusBlock looks and behaves across every
surface (toolbar popup, options page, block page). The goal: **sharp, calm,
utility-first.** It should feel like a precise tool, not a toy — dense where it
helps, breathable where it counts, with one confident accent color and a strict
grid.

All tokens and components live in **`styles/app.css`**. No surface defines its
own colors, radii, or button styles — they consume the shared system. Behavior
(IDs, JS-facing class names) is never changed by styling.

---

## 1. Principles

1. **One accent, used sparingly.** Indigo is the single brand color. It marks
   the primary action and the "now/selected" state — nothing else competes.
2. **Hierarchy through weight & size, not color.** Neutral text does the heavy
   lifting; color is reserved for meaning (primary, blocked, allowed).
3. **Everything on a 4px grid.** Spacing, sizing, and radii are multiples of 4.
4. **Crisp edges.** 1px hairline borders + one soft shadow tier. No heavy drop
   shadows, no glassmorphism.
5. **Numbers are data.** Timers and stats use tabular figures so they never jitter.
6. **Motion is feedback, not decoration.** 120–180ms ease on state changes only.

---

## 2. Color tokens

| Token | Value | Use |
| --- | --- | --- |
| `--brand` | `#4F46E5` | Primary actions, active states |
| `--brand-hover` | `#4338CA` | Primary hover/press |
| `--brand-100` | `#E0E7FF` | Selected chip bg, bar tracks |
| `--brand-50` | `#EEF2FF` | Subtle button bg, tints |
| `--ink` | `#111827` | Primary text, headings |
| `--text-2` | `#4B5563` | Secondary text |
| `--text-3` | `#9CA3AF` | Tertiary / captions / labels |
| `--surface` | `#FFFFFF` | Cards, popup body |
| `--surface-2` | `#F9FAFB` | Insets, nested panels |
| `--bg` | `#F3F4F6` | App background (options, block page) |
| `--border` | `#E5E7EB` | Hairlines, dividers |
| `--border-strong` | `#D1D5DB` | Input borders, focus rings base |
| `--success` | `#059669` | "Allowed / on a break" |
| `--danger` | `#DC2626` | Destructive actions, "Blocked" |
| `--danger-50` | `#FEF2F2` | Destructive subtle bg |

Gradients are allowed **only** for the brand (stat cards, chart "today" bar,
progress fills): `linear-gradient(135deg, #6366F1, #4F46E5)`.

---

## 3. Typography

- **Family:** system stack (`-apple-system, "Segoe UI", Roboto, sans-serif`).
- **Scale (px / weight / line-height):**
  - Display `30 / 800 / 1.1` — block-page headline, focus countdown
  - Title `20 / 700 / 1.2` — section headings
  - Subtitle `16 / 700 / 1.3` — card/host names
  - Body `14 / 500 / 1.5` — default
  - Label `13 / 600 / 1.4` — buttons, list headers
  - Caption `12 / 500 / 1.4` — secondary
  - Micro `11 / 600 / 1.3` — chart axis, tags (often uppercase, +0.4 tracking)
- **Numerals:** `font-variant-numeric: tabular-nums` on timers, stats, chart values.

---

## 4. Spacing, radius, elevation

- **Space scale:** `--s1:4  --s2:8  --s3:12  --s4:16  --s5:20  --s6:24  --s8:32`.
- **Radius:** `--r-sm:8  --r-md:10  --r-lg:14  --r-xl:18  --r-full:999`.
  Controls use `md`, cards use `lg`, hero/stat cards use `xl`, pills use `full`.
- **Elevation:**
  - `--shadow-1: 0 1px 2px rgba(17,24,39,.06), 0 1px 3px rgba(17,24,39,.08)` — cards
  - `--shadow-2: 0 10px 30px rgba(17,24,39,.12)` — popovers, modals, block card
  - `--shadow-brand: 0 6px 16px rgba(79,70,229,.25)` — brand stat cards only
- **Focus ring:** `0 0 0 3px rgba(79,70,229,.30)` on interactive focus-visible.

---

## 5. Layout

- **Popup:** fixed `width: 380px` with a `min-height: 520px` panel so every tab
  is the same tall rectangle (switching tabs never resizes the window, and Stats
  gets room). Sticky header (logo + settings), segmented underline tabs, then a
  `16px` padded panel. Primary actions on the Block/Focus tabs pin to the bottom.
- **Options:** centered column `max-width: 760px`, `bg` backdrop, sticky top bar
  with pill nav. Content grouped into titled sections with cards.
- **Block page:** centered card (`max-width: 460px`, `--shadow-2`) on a soft
  brand-tinted backdrop.

---

## 6. Components

### Buttons (`.btn`)
Base: `13px/600`, height 40 (`--btn-h`), radius `md`, gap `8`, centered, icon
`18px`. Variants:
- `.btn-primary` — solid brand, white text; hover `--brand-hover`.
- `.btn-soft` — `--brand-50` bg, brand text; hover `--brand-100`.
- `.btn-ghost` — transparent, `--border` outline, `--ink` text.
- `.btn-primary.danger` / `.btn-danger` — solid `--danger`.
- Modifiers: `.btn-block` (full width), press = `translateY(1px)`.

### Tabs (popup) `.tabs > .tab`
Equal-width, `13px/600`, icon+label, `--text-3` default → `--ink` hover →
`--brand` active with a 2px brand underline (animated).

### Pill nav (options) `.nav-btn`
Rounded-full, `--text-2` default, active = `--brand-50` bg + brand text.

### Toggle `.toggle`
44×26 track, 20px knob, `--border-strong` off → `--success` on, 180ms slide.

### Chip `.chip`
Pill, `--border` outline, brand text, `13px/600`; hover `--brand-50`. Used for
timed-break durations and the focus-duration grid (`.dur`, selected = solid brand).

### Card `.card` / rows `.row`
White, `--border`, radius `lg`, `--shadow-1`. Rows: 16px padding, hairline
divider, space-between.

### Input `.input`
Height 40, radius `md`, `1px --border-strong`, focus = brand border + focus ring.

### Stat card `.stat-card`
Brand gradient, white, radius `xl`, `--shadow-brand`. Big `24/800` value +
`11px` label.

### Bar chart `.week-chart`
Flex, bottom-aligned, 96px tall. Bars radius `6 6 3 3`, neutral `--brand-100`;
the latest day uses the brand gradient. Micro day labels beneath.

### Progress list (top sites) `.top-sites`
Favicon (22px) + name/time row + a 7px `--brand-100` track with brand-gradient
fill. Time in brand, tabular.

### Modal `.modal`
Scrim `rgba(17,24,39,.45)`, centered `.modal-card` (radius `lg`, `--shadow-2`).

---

## 7. Iconography

Lucide-style line icons, `stroke-width: 2`, `currentColor`, 18px in controls /
20px in the header. Rounded joins. The brand mark is the bullseye target.

---

## 8. States & feedback

- **Blocked** → `--danger` text/label. **Allowed / on break** → `--success`.
- Destructive actions (unblock, clear data, end focus) are always `danger`
  styled and, when a password is set, gated by the password modal.
- Empty states: centered `--text-3` caption, never a blank panel.
- Hover on all interactive elements; `:active` depresses 1px; `:focus-visible`
  shows the brand ring.

---

## 9. Do / Don't

- ✅ Use `--brand` for exactly one primary action per view.
- ✅ Keep destructive actions red and gated.
- ✅ Align everything to the 4px grid.
- ❌ No second accent hue, no colored body text for emphasis.
- ❌ No heavy shadows, gradients outside the brand, or ad-hoc radii.
- ❌ Never restyle by editing JS-facing IDs/class contracts.
