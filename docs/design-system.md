# Hushloom Design System

Deliverable B: Hushloom at commit `342afb4` (14 October 2026). Values come from the code; anything unlabeled is built. Labels: **Demo** or **sandbox** (runs, labeled on screen, without the outside service), **Unverified** (written from public documentation, never run against the real service), **Unseen** (not exercised by any test).

Evidence: vitest passes 503 tests in 44 files. Playwright passed 36 of 36 on a production build at `ce84bff`, whose code `342afb4` keeps (`notes/evidence/e2e-ce84bff.log`). It checks sideways scroll at 390, 820 and 1440 px on four pages, and the skip link once, at the Desktop Chrome viewport. Screenshots: `/mnt/project-files/playbox-2/evidence/journey/`. Cascade and focus findings were confirmed in headless Chromium. A parallel visual review may change some styles.

## Visual principles

1. **Content first.** Media fills the card; controls are small pills on it.
2. **A dark room with warm light.** Aubergine-black `ink`, off-white `bone` text, a faint ember glow top right. Dark only.
3. **One color, one meaning.** Ember is action, focus, favorite and the current page. Brass is VIP, credits and caution. Sage is new and success. Iris is simulated (filled) and video (text; also the continuity note). Danger is failure.
4. **The petal.** Cards round two opposite corners large and two small.
5. **Three type voices.** Serif names things; sans carries reading and controls; mono carries counts, handles and small labels.
6. **Motion reports state.** A loop means something is pending (shimmer, spinner, thread bar) or a preview is playing. Status words carry the meaning; the pipeline has no percentages.
7. **Honesty is visible.** Anything simulated wears an iris label saying what it is not.
8. **Its own look.** Playbox informs structure only: gallery-first discovery, template cards, rail and tab bar. `notes/plan.md` records avoiding the reference's neutral black with blue and pink.

## Tokens

Tokens live in the `@theme` block of `src/app/globals.css` (Tailwind 4.3.3). Components use generated classes, never hex. Exceptions: `themeColor` `#0f0a0d` in `layout.tsx` and the manifest, `Avatar`'s hashed gradient, `bg-black` behind the project player.

**Cascade rule.** Tailwind 4 puts utilities in `@layer utilities`; `globals.css` leaves `:focus-visible`, `.petal`, `.panel`, `.hairline`, `.tag` and `.skeleton` unlayered, so they win whatever the specificity. On one element, `.hairline` replaces `ring-*` and `shadow-*`, `:focus-visible` beats `focus:outline-none`, `.tag` beats `text-[…]`, and `.skeleton` (`position: relative`) beats `absolute`. Effects are flagged below. Fix in code: move them into `@layer components` or `@utility`.

### Color

| Token | Value | Intent | Text on ink-950 / 900 |
| --- | --- | --- | --- |
| `ink-950` | `#0f0a0d` | Page; text on fills; translucent bars and pills |  |
| `ink-900` | `#160f13` | Panels, inputs, sheets, hero |  |
| `ink-850` | `#1c1419` | Card media base, skeletons, job tray, rail hover |  |
| `ink-800` | `#241a20` | Hover and current-page surfaces, toasts |  |
| `ink-700` | `#33252d` | Toggle and progress tracks |  |
| `ink-600` | `#47353f` | Defined, unused |  |
| `bone-50` | `#f7efe7` | Primary text; bone button, active chip | 17.26 / 16.60 |
| `bone-100` | `#efe5de` | Emphasized values in lists | 15.83 / 15.23 |
| `bone-200` | `#e3d6cf` | Field labels, plain badge text | 13.82 / 13.30 |
| `bone-300` | `#c8b7b1` | Secondary copy, inactive nav and chips | 10.16 / 9.77 |
| `bone-400` | `#a8958f` | Tertiary copy, handles | 6.88 / 6.62 |
| `bone-500` | `#958480` | Hints, timestamps, placeholders, tab labels | 5.51 / 5.30 |
| `ember-200` | `#ffc4ad` | Link hover | 12.86 / 12.37 |
| `ember-300` | `#ffa98c` | Heading italics, inline links | 10.57 / 10.17 |
| `ember-400` | `#ff8a66` | Focus outline, kickers, current-page icon, ember hover | 8.49 / 8.17 |
| `ember-500` | `#ff6a4d` | Primary fill, favorite heart, sort underline, thread bar; its selection rings never render |  |
| `ember-600` | `#e6503a` | Ember button pressed, hero glow |  |
| `ember-700` | `#b83a29` | Page glow, glow shadow; never text |  |
| `brass-300` | `#f0cf96` | Warnings, offline banner | 13.16 / 12.66 |
| `brass-400` | `#e2b46d` | VIP fill, credit coin, stars | 10.27 / 9.88 |
| `sage-300` | `#bcdcbf` | Success text | 13.21 / 12.71 |
| `sage-400` | `#9cc5a1` | New fill, success dot, checks | 10.21 / 9.82 |
| `iris-300` | `#cdbfff` | Video badge text, demo notice text | 11.68 / 11.24 |
| `iris-400` | `#b39dff` | Demo and Sandbox fill; notice tint | 8.59 / 8.26 |
| `danger-400` | `#ff6b81` | Errors, failed state, danger button | 7.17 / 6.90 |

`--line` on `:root` (bone-50 at 9% in oklab) draws every `.hairline`, an inset 1px shadow; `--line-strong` (16%) draws the dashed upload zone.

### Type families

| Token | Value | Intent |
| --- | --- | --- |
| `--font-display` | Fraunces Variable, ui-serif, Georgia, serif | Headings, card titles, wordmark (22px italic) |
| `--font-sans` | Manrope Variable, ui-sans-serif, system-ui, sans-serif | Body and controls |
| `--font-mono` | JetBrains Mono Variable, ui-monospace, monospace | Handles, counts, credits, `.tag` |

All three are self-hosted (`@fontsource-variable`).

### Radius and elevation

| Token | Value | Intent |
| --- | --- | --- |
| `--radius-petal`, `--radius-pin` | 20px, 5px | `.petal` (20 5 20 5): cards, empty states, gate screens |
| `--radius-panel`, `--radius-panel-pin` | 24px, 8px | `.panel` (24 8 24 8): create panel, project guide; `rounded-panel` (24px all round): sheets |
| `--shadow-float` | `0 25px 50px -12px rgb(0 0 0 / 0.55)` | Toasts and job tray, which also carry `.hairline`, so it never renders |
| `--shadow-glow` | `0 10px 15px -3px` and `0 4px 6px -4px`, ember-700 at 30% | Create tab, make bar |

Outside the tokens: hero 28/8, Create tab 16/5, avatars 40%/12%, badges 4px, inputs 12px, toasts 16px, buttons and chips fully round.

### Motion

| Token | Value | Intent |
| --- | --- | --- |
| `--ease-weave` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Keyframes, backdrop, card lift, Make pill, Toggle knob |
| `--duration-quick` | 140ms | Button and chip color changes, sheet exit |
| `--duration-base` | 220ms | Card lift, preview fade, Make reveal, toggle |
| `--duration-slow` | 360ms | Entrances, cover zoom |
| `--animate-thread` | `thread` 1.8s, `--ease-weave`, infinite | Shimmer, weaving bar |
| `--animate-rise` | `rise` 360ms, `--ease-weave` | Enter: fade in, up 8px |
| `--animate-pop` | `pop` 320ms, `--ease-weave` | Favorite: scale to 1.28 and back |
| `--animate-sink` | `sink` 140ms, `--ease-weave` | Sheet exit: fade out, down 12px |

Untokenized: buttons, chips, the Toggle track and the preview fade set a token duration but keep Tailwind's default curve, `cubic-bezier(0.4, 0, 0.2, 1)`. Rail links, the auth switch, the card's favorite and the tray chevron also take Tailwind's default 150ms. Spinners use `animate-spin` (1s linear loop), processing dots `animate-pulse` (2s loop).

### Contrast

`tests/unit/contrast.test.ts` computes WCAG ratios from the token hex values and fails below 4.5:1. It checks bone-500 on ink-950, 900, 850 and 800 (lowest 4.74, on ink-800), every text token on ink-950 and ink-900, and ink-950 text on seven fills. Text ratios sit in the Color table; the fill checks repeat them (contrast is symmetric), plus ink-950 on ember-500 at 6.94.

Not measured by any test:

- Alpha surfaces: bone-500 tab labels on the `ink-950/90` tab bar and `ink-950/80` top bar; badges and pills over media (on a white poster, iris-300 on `ink-950/70` is 4.48:1, under AA); tinted notices, toasts and translucent panels.
- bone-100 on `WithheldMedia`'s gradient; ink-950 on pressed ember-600 (5.21 computed); the make bar's 10.5px demo tag (`.tag` beats its `text-[10px]`).
- Non-text contrast: hairline, toggle track, focus outline.

## Typography hierarchy

Named sizes keep Tailwind's paired line heights; pixel sizes inherit 1.5. Fraunces never takes a weight class, so headings render at 400.

| Role | Family | Size | Weight | Line height |
| --- | --- | --- | --- | --- |
| Hero (auth 48px) | display | 30px, 48px from sm | 400; ember-300 italic emphasis | 1.05 |
| Page title | display | 36px; template and sandbox pages 48px from sm; gates 30px | 400 | 40px, or 1.25; gates 36px |
| Section heading | display | 26px, 30px from sm | 400 | 1.25 |
| Empty state, sheet title | display | 24px, 20px | 400 | 32px, 28px |
| Card title | display | 17px, one line | 400 | 1.375 |
| Lead | sans | 15px | 400 | 1.5 to 1.625 |
| Body, inputs, md buttons | sans | 14px | 400; 600 on filled buttons | 20px |
| Compact UI (chips, rows, nav) | sans | 13px to 14.5px | 400; 600 active chip | 1.5 |
| Field label, hint, error | sans | 13px, 12.5px | 500 label, 400 | 1.5 |
| Meta | mono | 11px to 11.5px | 400 | 1.5 |
| `.tag` and tab labels | mono uppercase 0.08em; tabs sans | 10.5px | 400 | 1.5 |

## Spacing and grid

Spacing uses Tailwind's 4px unit; no custom tokens. Breakpoints are Tailwind's defaults: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px.

Gutters are 16px, 24px from sm, within 1600px. Main content pads 112px at the bottom below lg to clear the tab bar, 48px from lg beside the 236px rail. Home sections sit 48px apart.

| Grid | Base | sm | md | lg | xl | 2xl | Gap x / y |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Template grid (also Favorites' Templates tab) | 2 | 3 | 4 | 4 | 5 | 6 | 12 (16 from sm) / 24 |
| Library | 2 | 3 | 4 | 4 | 5 | 6 | 12 / 20 |
| Favorites' Your creations tab | 2 | 3 | 3 | 4 | 5 | 5 | 16 |
| Train characters | 2 | 3 | 3 | 4 | 4 | 4 | 20 |
| Projects | 1 | 2 | 2 | 2 | 3 | 3 | 20 |

The template grid flows densely. On Home's Trending grid the first card and every eleventh after it span two columns and rows from sm. Rails scroll sideways with snap points, edge to edge: cards are 42% of the viewport (max 220px) on phones, 200px from sm. Template cards are 4:5; creation tiles take the output's ratio (4:5 when unknown); project covers are 16:9.

Two-column pages switch at lg: template 1.05fr/1fr with a 40px gap, creation detail 1.2fr/1fr, project workspace 340px/1fr, auth 1fr/1fr. Studio switches at xl (320px side column).

## Components and their states

`src/components/ui.tsx` exports `buttonClass`, `Button`, `ButtonLink`, `Badge`, `Chip`, `Field`, `inputClass`, `Toggle`, `Sheet`, `radioGroupKeys`, `ToastProvider`, `useToast`, `Skeleton`, `EmptyState` and `SectionHeading`.

| Button | Default | Hover |
| --- | --- | --- |
| ember (primary) | ember-500 fill, ink-950 text, 600 | ember-400; pressed ember-600 |
| bone (Create, Sign in) | bone-50 fill, ink-950 text, 600 | bone-200 |
| ghost (secondary) | hairline, bone-50 text | ink-800 |
| quiet (tertiary) | bone-300 text | bone-50 on ink-800 |
| danger | hairline, danger-400 text | danger-400 at 10% |

Sizes: `sm` 32px (40px below 640px), `md` 40px, `lg` 48px.

- **`Chip`**: 13px pill, 32px tall (40px below sm). Off: hairline, bone-300; hover bone-50 on ink-800. On: bone-50 fill, ink-950 at 600. `aria-pressed` unless given a role.
- **`Toggle`**: `role="switch"`, a 40 by 24px track, ink-700 off, ember-500 on; its 20px knob slides 18px. Disabled dims the row to 50%.
- **`Field`, `inputClass`**: 13px bone-200 label, 12.5px bone-500 hint; inputs ink-900 with a hairline and 12px radius.
- **`SectionHeading`**: an ember-400 `.tag` kicker over the title; an optional action link sits bottom right.

| Badge tone | Look | Use |
| --- | --- | --- |
| plain | bone-200 on ink-950/70 | 4K, category, status |
| vip | ink-950 on brass-400 | VIP |
| new | ink-950 on sage-400 | New, Ready, Take |
| video | iris-300 on ink-950/70 | Video, duration |
| demo | ink-950 on iris-400 | Demo, Sandbox, dev scanner |
| warn | brass-300 on brass-300/15 | Draft, scanner warnings |
| danger | danger-400 on danger-400/15 | Failed, not configured |

### States

| State | Rule |
| --- | --- |
| Default | Token colors; inactive chips and ghost buttons carry a hairline |
| Hover | Surface steps to ink-800 (rail: ink-850) or text to bone-50. Cards lift 4px |
| Focus-visible | 2px ember-400 outline, 2px offset; inputs too (no ring renders). Clipping: see Accessibility |
| Active | `aria-current`, ink-800 surface, ember-400 icon; selected chip bone-50. No selection ring renders: a selected Library tile shows only its check icon, the chosen take a 5% ember tint and Take badge, the active scene nothing |
| Disabled | 45% opacity, no pointer events. `OfflineGuard` disables Make, Confirm, Retry and Buy offline |
| Busy | `Button busy`: spinner, disabled, `aria-busy` |
| Error | `Field` swaps the hint for danger-400 text in `role="alert"`. Error pages: "A thread snapped", Try again, the digest |
| Empty | `EmptyState`: petal outline, display title, one sentence, one action |
| Loading | Skeletons for Home, Explore, Favorites, Library and Projects; other routes have none, so 404s and redirects survive. A poster-less card's skeleton renders 0px tall; a running Library tile's shimmer covers only its text |
| Withheld | No media URL is sent; a shield and a "Verify your age…" line stand in on templates ("Sign in and verify…" signed out), Library, detail (no Download) and Train. Gap: project covers, the scene strip and compare show a bare clapperboard |

### Composites

**Template card.** A 4:5 petal: poster, plus a muted preview on hover or focus. Badges top left (VIP, New, 4K, Demo); a favorite top right pops on save and reverts on error with a toast. Bottom: Verify now when withheld, or a Preview pill on video cards; the ember Make pill, hidden until hover or focus from lg.

**Sheet.** `showModal()` gives the focus trap and return. Escape, backdrop and Close call `onClose`; content stays while it sinks out. 480px wide (880px `wide`), at most 92dvh.

**Toasts.** A polite live region; up to four stack, each clearing after 5 seconds. Tones: plain, success (sage dot), error (danger text); optional ember link.

**Job tray.** Shown only while something runs: a thread bar, "N weaving", collapsible rows with prompt, status, elapsed time and "· demo". Offline, the bar stops and a brass line explains.

**Make bar.** Below lg, a 48px ember link to `#make` floats while the Create panel is off screen ("Make it · N credits", "VIP template · see options" or "Make your own", plus a Demo tag). It scrolls; only the panel starts a run.

## Responsive behavior

| Width | Navigation | Notes |
| --- | --- | --- |
| Below 640px | Tab bar, no top-bar search | Sheets dock to the bottom, full width; small controls grow to 40px |
| 640 to 1023px | Tab bar, top-bar search | Sheets center |
| 1024px up | Rail | Tab bar and make bar hidden; two-column pages |

The tab bar holds Discover, Search, a 48px ember Create button, Library, and You (or Sign in). The rail adds Train, Projects, Studio, Favorites, credits, Settings, Admin, sign-out, and Pricing and Policies links for everyone. A member's You tab opens a Sheet (Unseen) with every rail page the tab bar lacks, as 48px rows. Signed-out phone visitors get Sign in instead, and no navigation entry for Pricing or Policies. Top bar and tab bar are 64px plus safe areas.

Safe areas: `viewport-fit=cover`; the top bar pads by the top inset, the tab bar and phone sheets by the bottom one. Below lg the make bar sits 4.75rem plus the inset up, the job tray above it (`--dock-h`), toasts above both (`--tray-h`; stacking Unseen). From lg the tray sits bottom right.

## Motion principles

- Exits beat entrances: a sheet rises in 360ms and sinks in 140ms; its backdrop fades in over 220ms, out over 140ms. Closing sets `data-closing` and calls `close()` 20ms after the animation, so no overlay support is needed.
- Reduced motion: a global rule cuts every animation and transition to 1ms, plays each animation once and turns smooth scrolling off, so sheets close in about 21ms. The make bar checks the preference before scrolling.
- Gaps: grid arrow keys always scroll smoothly, and hover still plays looping previews, under reduced motion.

## Accessibility

**Contrast.** Text tokens pass 4.5:1 on page and panel surfaces, by test.

**Focus.** Everything focusable gets the ember outline, inputs included, but a parent that clips overflow hides it. A card's link fills its `overflow-hidden` petal, so a focused card shows no ring; nor does the job tray's header. Chips and category links in sideways-scrolling rows keep only the ring's sides. Focus still reveals Make pills and plays previews.

**Skip link.** "Skip to content" is the first Tab stop and lands on `<main id="main">`.

**Patterns.**

- Roving-tabindex radio groups: the auth switch and Explore's sort. Only the checked radio is tabbable; Arrows, Home and End move and select, wrapping (`radioGroupKeys`, keys Unseen).
- Create's "What to make" chips and the rating stars are radios without arrow keys (stars on purpose).
- Template grids: Left and Right step, Up and Down jump to the nearest card on screen (Unseen). Duplicate title links are out of the Tab order.
- `aria-pressed`, `role="switch"` with `aria-checked`, `aria-current="page"`, `aria-expanded` on the tray. Route loading and toasts are polite `role="status"` regions; errors use `role="alert"`.

**Labels.** `Field` ties `<label>` to its control but sets no `aria-invalid` or `aria-describedby`. The takedown form adds `aria-invalid`; nothing in `src` sets `aria-describedby`, so no hint or error is tied to a field. Icon-only buttons carry `aria-label`. Card links name the title, creator and ", demo media".

**Touch targets.** Below 640px, small buttons, chips, category links, Favorites tabs, the auth switch, stars, Report and filter pills reach 40px. Still under 40px on phones (code scan of controls and standalone links):

- 36px: the card's favorite, Preview, Make and Verify pills, sheet Close, the credit pill, Remove upload, Studio's delete preset, scene move arrows. Explore's sort radios: about 38px.
- 32px at every width: the Library's Status, Model, Folder and Sort selects; Train's remove-character button.
- Text only, about 17 to 20px: Home's Tune, All saved, Explore all and See all; the card's creator handle; a toast's action; the Library's Retry.

## Labeling rules for demo and sandbox

Without accounts or keys, AI generation is a labeled demo; payments, age verification and scanning run in labeled sandbox or dev modes; push is off without VAPID keys. The live adapters (CCBill, Segpay, Stripe, Yoti, PhotoDNA, Cloudflare edge scanning, Replicate) are Unverified.

1. An iris fill means simulated; `Badge tone="demo"` is the only one.
2. Say what it is not: "not AI-generated", "No money moves", "proves nothing", "not live".
3. Label every touchpoint, not one. Gap: project covers and the scene strip carry no Demo badge, only the burned-in watermark.
4. The server backs the label: the payment sandbox and dev scanner refuse a live deployment, where `/verify/sandbox` returns 404.

| System | Labels |
| --- | --- |
| AI generation (Demo) | "Demo" badges on cards and Library; models "Demo Still (not AI)" and "Demo Motion (not AI)"; tray "· demo"; the watermark "DEMO OUTPUT · NOT AI-GENERATED" |
| Payments (sandbox) | "Sandbox · no money moves" on Pricing; Buy tagged "· sandbox"; `/pricing/sandbox`: "This is a sandbox. No money moves." |
| Age verification (sandbox) | Settings "Sandbox" badge, "a labeled demo that proves nothing"; `/verify/sandbox` footer "Demo · not age verification"; "(simulated)" toasts |
| Scanning (dev) | `/admin/review`: "Development scanner · not live" |
| Push | Not a demo. Without VAPID keys the toggle is disabled: "Push is not configured on this server." (asserted in e2e). Real delivery is Unverified |

## Do and don't examples

| Do | Don't |
| --- | --- |
| One `variant="ember"` button per view | Two ember buttons side by side |
| `Badge tone="demo"` beside anything simulated | Iris fills on real features |
| New custom classes in `@layer components` | `ring-*` or `shadow-*` beside `.hairline` |
| Room between focusable children and clipping parents | A link that fills an `overflow-hidden` frame |
| `Sheet` for confirmations | `window.prompt` (admin suspend and Clear flag still use it) |
| `size="sm"`, which grows on phones | New 36px tap targets |
| `--duration-*` with `ease-[var(--ease-weave)]` | A missing easing, motion that ignores the preference |
