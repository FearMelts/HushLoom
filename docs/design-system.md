# Hushloom Design System

Deliverable B, describing Hushloom at commit `c52f843` (14 October 2026) with all seven build tracks merged. Every value comes from the code; anything unlabeled is built. Labels: **Demo** or **sandbox** (runs and is labeled on screen, without the outside service), **Unverified** (written from public documentation, never run against the real service) and **Unseen** (typechecked and linted, never rendered in a browser).

Most interface work from the two fix tracks is Unseen: the sheet exit, the phone make bar, toast offsets, grid arrow keys, radio-group keys, the You sheet and the offline guards (`track-reports/fixes-ui.json`, `fixes-core.json`). The Playwright layout check (no sideways scroll at 390, 820 and 1440 px) and the skip-link check last passed at `0686f87`, before that track merged.

## Visual principles

1. **Content first.** Media fills the card. The caption is a title and a handle. Controls are small pills on the media.
2. **A dark room with warm light.** Aubergine-black surfaces (`ink`), warm off-white text (`bone`), a faint ember glow behind the top right. Dark only.
3. **One color, one meaning.** Ember is action, focus, favorite and the current page. Brass is VIP, credits and caution. Sage is new and success. Iris is demo and sandbox (filled) and video (text only). Danger is failure.
4. **The petal.** The signature shape: cards round two opposite corners large and two small.
5. **Three type voices.** A display serif names things, a sans carries reading and controls, a mono carries counts, handles and small labels.
6. **Motion reports state, then stops.** No progress percentages: the pipeline has none to report.
7. **Honesty is visible.** Anything simulated carries an iris label saying what it is not.
8. **Its own look.** Playbox informs structure only: gallery-first discovery, template cards, rail and tab bar. `notes/plan.md` records the choice to avoid the reference's neutral black with blue and pink.

## Tokens

Tokens live in the `@theme` block of `src/app/globals.css` (Tailwind 4.3.3, no config file). Components use the generated classes, never hex. Exceptions: `themeColor` `#0f0a0d` in `layout.tsx` and the manifest (mirrors ink-950), the hashed gradient of `Avatar` and `bg-black` behind the project player.

### Color

| Token | Value | Intent |
| --- | --- | --- |
| `ink-950` | `#0f0a0d` | Page; dark text on fills; translucent bars and pills |
| `ink-900` | `#160f13` | Panels, inputs, sheets, hero |
| `ink-850` | `#1c1419` | Card media base, skeletons, job tray |
| `ink-800` | `#241a20` | Hover and current-page surfaces, toasts |
| `ink-700` | `#33252d` | Toggle and progress tracks |
| `ink-600` | `#47353f` | Defined, unused |
| `bone-50` | `#f7efe7` | Primary text; bone button and active chip fill |
| `bone-100` | `#efe5de` | Emphasized values in lists |
| `bone-200` | `#e3d6cf` | Field labels, plain badge text |
| `bone-300` | `#c8b7b1` | Secondary copy, inactive nav and chips |
| `bone-400` | `#a8958f` | Tertiary copy, handles |
| `bone-500` | `#958480` | Hints, timestamps, placeholders, tab labels |
| `ember-200` | `#ffc4ad` | Link hover |
| `ember-300` | `#ffa98c` | Italic heading emphasis, inline links |
| `ember-400` | `#ff8a66` | Focus outline, kickers, current-page icon, ember hover |
| `ember-500` | `#ff6a4d` | Primary fill, favorite heart, selection ring |
| `ember-600` | `#e6503a` | Ember button pressed, hero glow |
| `ember-700` | `#b83a29` | Page glow, glow shadow; never text |
| `brass-300` | `#f0cf96` | Warnings, offline banner |
| `brass-400` | `#e2b46d` | VIP fill, credit coin, stars |
| `sage-300` | `#bcdcbf` | Success text |
| `sage-400` | `#9cc5a1` | New fill, success dot, checks |
| `iris-300` | `#cdbfff` | Video badge text, demo notice text |
| `iris-400` | `#b39dff` | Demo and Sandbox fill; notice tint |
| `danger-400` | `#ff6b81` | Errors, failed state, danger button |

On `:root`, `--line` (bone-50 at 9%, mixed in oklab) draws every hairline through `.hairline`, an inset 1px shadow. `--line-strong` (16%) draws the dashed upload zone.

### Type families

| Token | Value | Intent |
| --- | --- | --- |
| `--font-display` | Fraunces Variable, ui-serif, Georgia, serif | Headings, card titles, wordmark |
| `--font-sans` | Manrope Variable, ui-sans-serif, system-ui, sans-serif | Body and controls |
| `--font-mono` | JetBrains Mono Variable, ui-monospace, monospace | Handles, counts, credits, `.tag` |

All three are self-hosted through `@fontsource-variable`; no font request leaves the site.

### Radius and elevation

| Token | Value | Intent |
| --- | --- | --- |
| `--radius-petal`, `--radius-pin` | 20px, 5px | `.petal` (20 5 20 5): cards, empty states, gate screens |
| `--radius-panel`, `--radius-panel-pin` | 24px, 8px | `.panel` (24 8 24 8): create panel, project guide; `rounded-panel` (24px all round): sheets |
| `--shadow-float` | `0 25px 50px -12px rgb(0 0 0 / 0.55)` | Toasts, job tray |
| `--shadow-glow` | `0 10px 15px -3px` and `0 4px 6px -4px`, ember-700 at 30% | Create tab, make bar |

Outside the tokens: hero 28/8, Create tab 16/5, avatars 40%/12%, badges 4px, inputs 12px, toasts 16px, buttons and chips full pills. Eight sections still inline `rounded-[24px_8px_24px_8px]` instead of `.panel`.

### Motion

| Token | Value | Intent |
| --- | --- | --- |
| `--ease-weave` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | The one curve |
| `--duration-quick` | 140ms | Color changes, sheet exit |
| `--duration-base` | 220ms | Card lift, preview fade, Make reveal, toggle |
| `--duration-slow` | 360ms | Entrances, cover zoom |
| `--animate-thread` | `thread` 1.8s, `--ease-weave`, infinite | Shimmer, weaving bar |
| `--animate-rise` | `rise` 360ms, `--ease-weave` | Enter: fade in, up 8px |
| `--animate-pop` | `pop` 320ms, `--ease-weave` | Favorite: scale to 1.28 and back |
| `--animate-sink` | `sink` 140ms, `--ease-weave` | Sheet exit: fade out, down 12px |

### Contrast

`tests/unit/contrast.test.ts` computes WCAG ratios from the token hex values and fails below 4.5:1. It checks bone-500 on ink-950, 900, 850 and 800 (5.51, 5.30, 5.06, 4.74), every text token on ink-950 and ink-900, and ink-950 text on seven fills. Two more tests check the formula against WCAG reference values and fail when a class names an undefined shade. The suite passed, 258/258, at the infra merge.

| Text | ink-950 | ink-900 | Text | ink-950 | ink-900 |
| --- | --- | --- | --- | --- | --- |
| bone-50 | 17.26 | 16.60 | bone-100 | 15.83 | 15.23 |
| bone-200 | 13.82 | 13.30 | bone-300 | 10.16 | 9.77 |
| bone-400 | 6.88 | 6.62 | bone-500 | 5.51 | 5.30 |
| ember-200 | 12.86 | 12.37 | ember-300 | 10.57 | 10.17 |
| ember-400 | 8.49 | 8.17 | brass-300 | 13.16 | 12.66 |
| brass-400 | 10.27 | 9.88 | sage-300 | 13.21 | 12.71 |
| sage-400 | 10.21 | 9.82 | iris-300 | 11.68 | 11.24 |
| iris-400 | 8.59 | 8.26 | danger-400 | 7.17 | 6.90 |

ink-950 on fills: ember-500 6.94, ember-400 8.49, brass-400 10.27, sage-400 10.21, iris-400 8.59, bone-50 17.26, bone-200 13.82.

Not measured by any test:

- Text on translucent surfaces over media (badges on `ink-950/70`, card pills on `/55` and `/60`). Over a pure white poster, iris-300 on `ink-950/70` computes to 4.48:1, just under AA.
- Tinted notices (`iris-400/10`, `sage-400/10`, `danger-400/15`, `brass-300/15`), toasts on `ink-800/95`, panels on `ink-900/70`.
- ink-950 on ember-600 (pressed; 5.21 computed) and the make bar's 10px demo tag.
- Non-text contrast: the 9% hairline, toggle track and focus outline.
- Real rendering: anti-aliasing and weight.

## Typography hierarchy

Named sizes keep Tailwind's paired line heights; pixel sizes inherit 1.5. Fraunces never takes a weight class, so headings render at 400.

| Role | Family | Size | Weight | Line height |
| --- | --- | --- | --- | --- |
| Hero (home; auth is 48px) | display | 30px, 48px from sm | 400; ember-300 italic emphasis | 1.05 |
| Page title | display | 36px; template and sandbox pages 48px from sm | 400 | 40px, or 1.25 |
| Gate title (age gate, offline) | display | 30px | 400 | 36px |
| Section heading | display | 26px, 30px from sm | 400 | 1.25 |
| Empty state, sheet title | display | 24px, 20px | 400 | 32px, 28px |
| Card title | display | 17px, one line | 400 | 1.375 |
| Wordmark | display italic | 22px, tight | 400 | 1.5 |
| Lead | sans | 15px | 400 | 1.5 to 1.625 |
| Body, inputs, md buttons | sans | 14px | 400; 600 on filled buttons | 20px |
| Compact UI (chips, rows, nav) | sans | 13px to 14.5px | 400; 600 active chip | 1.5 |
| Field label, hint, error | sans | 13px, 12.5px | 500 label, 400 | 1.5 |
| Meta | mono | 11px to 11.5px | 400 | 1.5 |
| `.tag` and tab labels | mono uppercase 0.08em; tabs sans | 10.5px | 400 | 1.5 |

Credit balances use mono with tabular figures.

## Spacing and grid

Spacing uses Tailwind's 4px unit, with no custom tokens. Breakpoints are Tailwind's defaults: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px.

Page gutters are 16px, then 24px from sm. Content is centered at most 1600px wide. The rail is 236px from lg. The top bar and tab bar are 64px plus safe areas. Main content pads 112px at the bottom below lg to clear the tab bar, 48px from lg. Home sections sit 48px apart; a section heading sits 16px above its content. Panels pad 20px, then 24px from sm.

| Grid | Base | sm | md | lg | xl | 2xl | Gap x / y |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Template grid, skeleton | 2 | 3 | 4 | 4 | 5 | 6 | 12 (16 from sm) / 24 |
| Library | 2 | 3 | 4 | 4 | 5 | 6 | 12 / 20 |
| Favorites, creations | 2 | 3 | 3 | 4 | 5 | 5 | 16 |
| Train characters | 2 | 3 | 3 | 4 | 4 | 4 | 20 |
| Projects | 1 | 2 | 2 | 2 | 3 | 3 | 20 |

The template grid flows densely. On Home's Trending grid the first card and every eleventh after it span two columns and two rows from sm. Rails scroll sideways with snap points: cards are 42% of the viewport (max 220px) on phones and 200px from sm, and the rail bleeds to the screen edge. Cards are 4:5; project covers 16:9.

Two-column pages switch at lg: template page 1.05fr and 1fr with a 40px gap, creation detail 1.2fr and 1fr, project workspace 340px and the rest, auth two equal columns. Studio switches at xl, with a 320px side column.

## Components and their states

`src/components/ui.tsx` exports `buttonClass`, `Button`, `ButtonLink`, `Badge`, `Chip`, `Field`, `inputClass`, `Toggle`, `Sheet`, `radioGroupKeys`, `ToastProvider`, `useToast`, `Skeleton`, `EmptyState` and `SectionHeading`. `Button` adds a `busy` state; `Chip` reports `aria-pressed` unless given a role.

| Button | Default | Hover | Use |
| --- | --- | --- | --- |
| ember | ember-500 fill, ink-950 text, 600 | ember-400; pressed ember-600 | One primary action per view |
| bone | bone-50 fill, ink-950 text, 600 | bone-200 | Create, Sign in, Follow |
| ghost | hairline, bone-50 text | ink-800 | Secondary |
| quiet | bone-300 text | bone-50 on ink-800 | Tertiary, Leave |
| danger | hairline, danger-400 text | danger-400 at 10% | Destructive |

Sizes: `sm` 32px (40px below 640px), `md` 40px, `lg` 48px.

| Badge tone | Look | Use |
| --- | --- | --- |
| plain | bone-200 on ink-950/70 | 4K, category, status |
| vip | ink-950 on brass-400 | VIP |
| new | ink-950 on sage-400 | New, Ready |
| video | iris-300 on ink-950/70 | Video, duration |
| demo | ink-950 on iris-400 | Demo, Sandbox, dev scanner |
| warn | brass-300 on brass-300/15 | Draft, scanner warnings |
| danger | danger-400 on danger-400/15 | Failed, not configured |

### States

| State | Rule |
| --- | --- |
| Default | Token colors; inactive chips and ghost buttons carry a hairline |
| Hover | Surface steps to ink-800 or text to bone-50. Cards lift 4px |
| Focus-visible | 2px ember-400 outline, 2px offset. Inputs use a 2px ember-400/70 ring instead |
| Active | `aria-current`, ink-800 surface, ember-400 icon. Selected chip: bone-50 fill |
| Disabled | 45% opacity, no pointer events. `OfflineGuard` disables Make, Confirm, Retry and Buy offline |
| Busy | Spinner, disabled, `aria-busy` |
| Error | `Field` swaps the hint for danger-400 text in `role="alert"`. Page errors read "A thread snapped" with Try again and the digest |
| Empty | `EmptyState`: petal outline, display title, one sentence, one action |
| Loading | A root `loading.tsx` plus eight route-level ones: the real heading when known, then a shimmer shaped like the content |
| Withheld | A viewer who must verify their age gets no media URL: a shield and "Verify your age to see previews" |

### Composites

**Template card.** A 4:5 petal: poster, then a muted preview that fades in on hover or focus. Badges top left (VIP, New, 4K, Demo); a 36px favorite with `aria-pressed` top right, which pops on save and reverts with an error toast on failure. Bottom: Preview (or Verify now) and the ember Make pill. From lg, Make waits for hover or focus.

**Sheet.** `showModal()` gives the focus trap and focus return. Escape, backdrop and Close call `onClose`; the sheet keeps its last content while it sinks out. 480px wide, or 880px when `wide`; at most 92dvh tall.

**Toasts.** A polite live region; up to four stack, each clearing after 5 seconds. Tones: plain, success (sage dot), error (danger text); optional ember link.

**Job tray.** Shown only while something runs: an ember thread bar, "N weaving", collapsible. Rows give the prompt, the real status, elapsed time and "· demo" where it applies. Offline, the bar stops and a brass line explains. It is the only poller: 3 seconds visible, 15 seconds in a background tab.

**Make bar** (Unseen). Below lg, a 48px ember link to `#make` floats while the Create panel is off screen: "Make it · N credits", "VIP template · see options" or "Make your own", with a Demo tag on demo models. Only the panel's button starts a creation.

## Responsive behavior

| Width | Navigation | Notes |
| --- | --- | --- |
| Below 640px | Tab bar, no top-bar search | Sheets dock to the bottom, full width; small controls grow to 40px |
| 640 to 1023px | Tab bar, top-bar search | Sheets center |
| 1024px up | Rail | Tab bar and make bar hidden; two-column pages |

The tab bar holds Discover, Search, a 48px ember Create button, Library, and You (or Sign in). The rail adds Train, a "Go deeper" group (Projects, Studio, Favorites), credits, Settings, Admin and sign-out.

You (Unseen) opens a Sheet: profile, credits, then Favorites, Projects, Studio, Train, Settings, Pricing, Content policy & privacy and Admin as 48px rows, then sign-out for this device. Nothing in the rail is desktop-only.

Safe areas: `viewport-fit=cover`. The top bar pads by the top inset; the tab bar and phone sheets by the bottom inset. Below lg, floating layers stack upward (Unseen): the make bar sits 4.75rem plus the inset up, the job tray adds the bar's height (`--dock-h`), and toasts add the tray's height too (`--tray-h`). From lg the tray sits 20px from the bottom right and toasts sit above it; from xl toasts sit 24px up.

## Motion principles

- One curve, three durations. Exits beat entrances: a sheet rises in 360ms and sinks in 140ms; its backdrop fades in over 220ms and out over 140ms.
- Sheet exit sets `data-closing`, runs `sink`, then closes after the computed duration plus 20ms, so it works without overlay support.
- The thread bar and pulsing dots appear only while a job runs. Status words carry the meaning.
- Previews are muted. Autoplay on Home's Trending grid is a member preference, off by default.
- Reduced motion: a global rule cuts every animation and transition to 1ms and one run, and turns smooth scrolling off. Shimmers stop and sheets close in about 21ms. The make bar checks the preference before scrolling.
- Gaps: grid arrow keys always scroll smoothly, and hover still plays previews under reduced motion.

## Accessibility

**Contrast.** Every text token meets 4.5:1 on page and panel surfaces, enforced by test.

**Focus.** Every focusable element shows the ember outline; inputs show a ring. Hidden Make pills appear on focus, and focus plays a card's preview.

**Skip link.** "Skip to content" is the first Tab stop and lands on `<main id="main">`.

**Patterns.**

- Roving-tabindex radio groups (Unseen): the auth switch and Explore's sort. Only the checked radio is tabbable; Arrows, Home and End move and select, wrapping (`radioGroupKeys`).
- The Create panel's "What to make" chips are radios without roving or arrows. Rating stars are too, on purpose, so arrowing never posts a rating per key.
- Template grids (Unseen): Left and Right step, Up and Down jump to the nearest card on screen. Tab still reaches every control; the duplicate title link is out of the Tab order.
- `aria-pressed` on toggles, `role="switch"` with `aria-checked`, `aria-current="page"`, `aria-expanded` on the tray.
- Toasts and route loading are polite `role="status"` regions; errors use `role="alert"`.

**Labels.** `Field` ties `<label>` to its control but sets no `aria-invalid` or `aria-describedby`; callers must (the takedown form does). Icon-only buttons carry `aria-label`; decorative icons are hidden. Card links name the title, creator and ", demo media".

**Touch targets.** Below 640px, small buttons, chips, category links, Favorites tabs, the auth switch, stars, Report and filter pills grow to 40px. Tab cells are 64px tall, You rows 48px. Still under 40px on phones: the card's favorite, Preview, Make and Verify pills, the sheet Close button and the credit pill (all 36px), and the Library's Retry text button.

## Labeling rules for demo and sandbox

With no accounts or keys, AI generation is a labeled demo; payments, age verification and scanning run in labeled sandbox or dev modes; push stays off until VAPID keys are set. The live adapters (CCBill, Segpay, Yoti, PhotoDNA, Replicate) are Unverified, so screens such as "Payments are handled by CCBill" have never shown a real result.

1. Iris means simulated. `Badge tone="demo"` is the only iris fill.
2. Say what it is not: "not AI-generated", "No money moves", "proves nothing", "not live".
3. Label every touchpoint, not one.
4. The server backs the label: the payment sandbox and dev scanner refuse a live deployment, and `/verify/sandbox` returns 404 there.

| System | Labels |
| --- | --- |
| AI generation (Demo) | "Demo" badges on cards and Library; "Demo media"; "Demo model"; models "Demo Still (not AI)" and "Demo Motion (not AI)"; "Demo creation ready."; tray "· demo"; the creation note; the pixel watermark "DEMO OUTPUT · NOT AI-GENERATED" |
| Payments (sandbox) | "Sandbox · no money moves" on Pricing; Buy tagged "· sandbox"; `/pricing/sandbox` titled "This is a sandbox. No money moves." |
| Age verification (sandbox) | Settings "Sandbox" badge and "a labeled demo that proves nothing"; `/verify/sandbox` footer "Demo · not age verification"; "(simulated)" toasts |
| Scanning (dev) | `/admin/review`: "Development scanner · not live" on an iris panel |
| Push | Not a demo. Without VAPID keys the toggle is disabled: "Push is not configured on this server." |

## Do and don't examples

| Do | Don't |
| --- | --- |
| One `variant="ember"` button per view | Two ember buttons side by side |
| `text-bone-500` for the quietest text | A new grey hex or an undefined shade |
| `Badge tone="demo"` beside anything simulated | Iris fills on real features |
| `className="panel"` | Another inline `rounded-[24px_8px_24px_8px]` |
| `Sheet` for confirmations | `window.prompt` (admin suspend still uses it) |
| `radioGroupKeys` with a roving tabindex | `role="radio"` chips without arrow keys |
| `size="sm"`, which grows on phones | New 36px tap targets |
| `--duration-*` and `--ease-weave` | Fixed milliseconds, motion that ignores the preference |
