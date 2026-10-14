# Hushloom Design System

Deliverable B describes commit `09a436e` (14 October 2026), with all build tracks and fixes merged. Unlabeled statements describe the code as read, not a test result. Labels: **Demo** or **sandbox** (runs, labeled on screen, without the outside service); **Unverified** (from public documentation, never run against the real service). Statuses: **verified** (a test or the capture checks it), **implemented but not verified** (nothing does).

Evidence at `09a436e`: vitest passes 507 tests in 45 files; `npm run test:e2e` passes 40, fails 0 and skips 32 (`notes/evidence/e2e-09a436e.log`). The 32 are the visual capture (`tests/e2e/visual.spec.ts`, `VISUAL_REVIEW=1`); phase 4 ran it at 390, 820 and 1440px (223 screenshots), fixed all 43 defects and recaptured with no overflow, contrast violation or new defect (`notes/analysis/visual/visual-review.json`).

## Visual principles

1. **Content first.** Media fills the card; small pills sit on it.
2. **A dark room with warm light.** Aubergine-black `ink`, off-white `bone` text, a faint ember glow top right. Dark only.
3. **One color, one meaning.** Ember: action, focus, favorite, current page. Brass: VIP, credits, caution. Sage: new, success. Iris: simulated, and video badge text; iris-300 also colors one real Create-panel note and another's icon (`create-panel.tsx:558, 519`). Danger: failure.
4. **The petal.** Cards round two opposite corners large and two small.
5. **Three type voices.** Serif names things; sans carries reading and controls; mono carries counts, handles and small labels.
6. **Motion reports state.** Loops mean pending work (shimmer, spinner, thread bar) or a playing preview; status words, not percentages, carry progress.
7. **Honesty is visible.** Simulated output is labeled, mostly in iris (see Labeling rules).
8. **Its own look.** Playbox informs structure only: gallery-first discovery, template cards, rail and tab bar. `notes/plan.md` rules out its neutral black with blue and pink.

## Tokens

Tokens live in the `@theme` block of `src/app/globals.css` (Tailwind 4.3.3). Components use generated classes, not hex, except `themeColor` (`#0f0a0d`), `Avatar`'s hashed gradient and the sequence player's `bg-black`.

**Cascade rule.** `globals.css` leaves `:focus-visible` and its custom classes (`.petal`, `.hairline`, `.tag`, `.skeleton` and more) unlayered, so they beat Tailwind's utilities: `.hairline` replaces `ring-*` and `shadow-*`, `:focus-visible` beats `focus:outline-none`, `.tag` beats `text-[…]`, `.skeleton` beats `absolute`.

### Color

| Family | Steps | Intent |
| --- | --- | --- |
| ink | 950 `#0f0a0d`, 900 `#160f13`, 850 `#1c1419`, 800 `#241a20`, 700 `#33252d`, 600 `#47353f` | 950: page, text on fills, translucent bars. 900: panels, inputs, sheets. 850: card media, skeletons, tray. 800: hover, current page, toasts. 700: tracks. 600: unused |
| bone | 50 `#f7efe7`, 100 `#efe5de`, 200 `#e3d6cf`, 300 `#c8b7b1`, 400 `#a8958f`, 500 `#958480` | 50: primary text, bone button, active chip. 100: emphasized values. 200: labels, plain badges. 300: secondary copy, inactive nav. 400: tertiary copy, handles, back links. 500: hints, timestamps, tab labels |
| ember | 200 `#ffc4ad`, 300 `#ffa98c`, 400 `#ff8a66`, 500 `#ff6a4d`, 600 `#e6503a`, 700 `#b83a29` | 200: Verify pill hover. 300: heading italics, inline links. 400: focus, kickers, current-page icon, hover. 500: primary fill, heart, sort underline, thread bar. 600: pressed, hero glow. 700: glows, withheld gradient; never text |
| brass | 300 `#f0cf96`, 400 `#e2b46d` | 300: warnings, offline banner. 400: VIP, credit coin, stars |
| sage | 300 `#bcdcbf`, 400 `#9cc5a1` | 300: success text. 400: New, success dot, checks |
| iris | 300 `#cdbfff`, 400 `#b39dff` | 300: video badge text, demo notices. 400: demo badge fill, 10% notice tint |
| danger | 400 `#ff6b81` | Errors, failed state, danger button |

`--line` on `:root` (bone-50 at 9% in oklab) draws every `.hairline`, an inset 1px shadow, and the real borders of sheets and bars; `--line-strong` (16%) draws the dashed upload zone.

### Type, shape and motion

- **Fonts** (self-hosted with `@fontsource-variable`, system fallbacks): Fraunces Variable (`--font-display`, also the 22px italic wordmark), Manrope Variable (`--font-sans`), JetBrains Mono Variable (`--font-mono`).
- **Radius.** `.petal` is 20 5 20 5 (`--radius-petal`, `--radius-pin`): cards, empty states, gate screens. `.panel` is 24 8 24 8 (`--radius-panel`, `--radius-panel-pin`): the template page's Create panel, the project guide; sheets use `rounded-panel` (24px). Untokened: hero 28/8, Create tab 16/5, the project's Side by side box and take cards 20/6, avatars 40%/12%, badges 4px, inputs 12px, toasts 16px, buttons and chips fully round.
- **Elevation.** `--shadow-float` never renders: toasts and the tray also carry `.hairline`. `--shadow-glow` (ember-700 at 30%) lights the Create tab and make bar.
- **Motion.** `--ease-weave` is `cubic-bezier(0.2, 0.8, 0.2, 1)`. Durations: `--duration-quick` 140ms, `--duration-base` 220ms, `--duration-slow` 360ms. Animations: `--animate-thread` (1.8s loop: shimmer, weaving bar), `--animate-rise` (360ms fade up 8px), `--animate-pop` (320ms favorite pop to 1.28), `--animate-sink` (140ms sheet fade down 12px).

### Contrast

`tests/unit/contrast.test.ts` fails any token pair under 4.5:1. It covers every text token on ink-950 and ink-900 (lowest bone-500, 5.51 and 5.30), bone-500 on ink-850 and ink-800 (4.74 on ink-800) and ink-950 on seven fills (6.94 on ember-500). Phase 4's axe check found 9 contrast violations, one element on 9 pricing screenshots: the ember Buy button's "· sandbox" tag in 70% ink (4.32:1). It is now full ink-950 (0 after); ghost Buy buttons keep a 70% tag (`pricing.tsx:56`), which axe did not flag. Axe cannot judge text over gradients (8,922 undecided nodes, mostly the page glow) or media.

Outside the unit test: tab labels on the translucent bar; badges over media (iris-300 on `ink-950/70` over a white poster: 4.48:1, under AA); the withheld gradient; tinted notices, toasts, panels and the make bar's demo tag; non-text contrast (hairline, toggle track, focus outline).

## Typography hierarchy

Named sizes keep Tailwind's line heights; pixel sizes inherit 1.5. Weight is 400 unless noted; Fraunces never takes a weight class.

| Role | Family | Size / line height |
| --- | --- | --- |
| Hero (auth 48px) | display | 30px, 48px from sm / 1.05; ember-300 italic emphasis |
| Page title | display | 36px / 40px; template and sandbox pages 48px from sm / 1.25; gates 30px / 36px; creator 36px / `leading-none` |
| Section heading | display | 26px, 30px from sm / 1.25 |
| Empty state, sheet title | display | 24px / 32px, 20px / 28px |
| Card title | display | 17px, one line / 1.375 |
| Lead | sans | 15px / 1.5 to 1.625 |
| Body, inputs, md buttons | sans | 14px / 20px; 600 on filled buttons |
| Compact UI (chips, rows, nav, links) | sans | 13px to 15px / 1.5; 600 active chip |
| Field label, hint, error | sans | 13px (500), 12.5px / 1.5 |
| Meta | mono | 11px to 12px / 1.5 |
| `.tag`; tab labels | mono uppercase 0.08em; sans | 10.5px / 1.5 |

## Spacing and grid

Spacing uses Tailwind's 4px unit; no custom tokens. Breakpoints are Tailwind's defaults: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px.

Gutters are 16px, 24px from sm, within 1600px. Main's bottom padding is 112px plus the inset below lg (tab bar) and 48px from lg (beside the 236px rail), plus `--tray-h` while the job tray shows and, below lg, `--dock-h` while the make bar does.

Columns, with gaps in px:

- Template grid (also Favorites' Templates tab) and Library: 2, then 3 from sm, 4 from md, 5 from xl, 6 from 2xl. Gaps 12 (16 from sm) by 24; Library 12 by 20.
- Favorites' Your creations tab: 2, 3 from sm, 4 from lg, 5 from xl. Gap 16.
- Train characters: 2, 3 from sm, 4 from lg. Gap 20.
- Projects: 1, 2 from sm, 3 from xl. Gap 20.

The template grid flows densely; Home's Trending grid makes its first card 2 by 2 from sm and hides a partial last row. Rail cards are 42% of the viewport (max 220px) on phones, 200px from sm. Template cards are 4:5, creation tiles the output's ratio (4:5 when unknown), project covers and scene tiles 16:9; phone scene tiles are 40% of the viewport (max 176px), so the next peeks in.

Two-column pages switch at lg: template 1.05fr/1fr (40px gap), creation detail 1.2fr/1fr, project workspace 340px/1fr, auth 1fr/1fr; Studio at xl (320px side column). Flexible tracks are `minmax(0, …)`, also below the split in Studio and the project workspace, so nowrap text truncates instead of widening the page. Below lg, creation media is capped at 60% of the screen height.

## Components and their states

`src/components/ui.tsx` exports the primitives below plus `radioGroupKeys`, `ToastProvider`, `useToast`, `Skeleton` and `EmptyState`.

- **`Button`, `ButtonLink`, `buttonClass`** (`ButtonLink` is a Next `Link`): ember (ember-500 fill, ink-950 text at 600; hover ember-400, pressed ember-600), bone (bone-50 fill: Create, Sign in, Follow, the selected Studio kind, new-folder and copilot Apply; hover bone-200), ghost (hairline, bone-50 text; hover ink-800), quiet (bone-300; hover bone-50 on ink-800), danger (hairline, danger-400; hover a 10% tint). Sizes: `sm` at least 32 by 32px (40 by 40 below 640px, icon-only ones included), `md` 40px, `lg` 48px.
- **`Chip`**: 13px pill, 32px tall (40px below sm). Off: hairline, bone-300; hover bone-50 on ink-800. On: bone-50 fill, ink-950 at 600. `aria-pressed` unless given a role.
- **`Toggle`**: `role="switch"`, a 40 by 24px track in a full-row `<label>` (the tap target); ink-700 off, ember-500 on; its 20px knob slides from 2px to 18px.
- **`Field`, `inputClass`**: 13px bone-200 label, 12.5px bone-500 hint; inputs ink-900 with a hairline and 12px radius.
- **`SectionHeading`** puts an ember-400 `.tag` kicker over the title and an optional action at bottom right, usually a **`SectionLink`** ("See all", "Tune": 13px bone-300). **`BackLink`** is every page back link (13px bone-400). Both are 40px targets; negative margins keep their text in place.
- **`Badge`**: 20px tall `.tag` text. Tones: plain (bone-200 on ink-950/70: 4K, Image, category, status), vip (ink-950 on brass-400), new (ink-950 on sage-400: New, Ready, Take), video (iris-300 on ink-950/70: Video, duration), demo (ink-950 on iris-400: simulated, ten texts under Labeling rules), warn (brass-300 on brass-300/15: Draft, scanner warnings), danger (danger-400 on danger-400/15: Failed, not configured).

### States

- **Default.** Token colors; inactive chips and ghost buttons carry a hairline.
- **Hover.** Surface to ink-800 (rail: ink-850) or text to bone-50; cards lift 4px.
- **Focus-visible.** 2px ember-400 outline, 2px offset; inputs too (no ring renders).
- **Active.** `aria-current`, ink-800 surface, ember-400 icon; selected chip bone-50. No selection ring renders: a selected Library tile shows only its check icon, the chosen take a 5% ember tint and Take badge, the active scene nothing.
- **Disabled.** `buttonClass` dims to 45% with no pointer events; scene reorder arrows dim to 30%, a disabled `Toggle`'s row to 50%. `OfflineGuard` disables Make, Confirm, Retry and Buy offline.
- **Busy.** `Button busy`: spinner, disabled, `aria-busy`.
- **Error.** `Field` swaps the hint for danger-400 text in `role="alert"`. The Create panel's alert shows the server's message, plus an ember "Verify your age" button on a 451 age-check refusal. Error pages: "A thread snapped", Try again, the digest.
- **Empty.** `EmptyState`: petal outline, display title, one sentence, one action.
- **Loading.** Skeletons for Home, Explore, Favorites, Library and Projects; other routes have none, so 404s and redirects survive. A poster-less card's skeleton renders 0px tall; a running Library tile's shimmer covers only its text.
- **Withheld.** No media URL is sent; a shield and "Verify your age to see previews" stand in ("Sign in and verify…" signed out; an ember button on the template page), "…to see this" in Library and detail (no Download), "…this photo" in Train. Gaps: project media shows a bare clapperboard; creation detail's Versions strip shows the status word ("Ready").

### Composites

**Template card.** A 4:5 petal: poster, plus its muted preview clip on hover or focus. Top left: VIP, New, 4K and Demo badges; top right: the favorite, which pops on save. Bottom left: a one-line Verify now (signed out: Sign in) pill when withheld, else Preview on video cards. Bottom right: the ember Make pill (icon only when withheld), hidden until hover or focus from lg. All four are 40px, as is the creator handle's tap box.

**Sheet.** `showModal()` gives the focus trap and return. Escape, backdrop and the 40px Close call `onClose`; content stays while it sinks out. 480px wide (880px `wide`), at most 92dvh, with a real 1px `--line` border, none at a phone sheet's bottom.

**Toasts.** A polite live region; up to four stack, each clearing after 5 seconds. Tones: plain, success (sage dot), error (danger text); an optional ember-400 action on a 40px target.

**Job tray.** Shown while something runs: a thread bar, "N weaving", collapsible rows with prompt, status, elapsed time and "· demo". Offline, the bar stops and a brass line explains.

**Make bar.** Below lg, a 48px ember link to `#make` floats while the Create panel is off screen ("Make it · N credits", "VIP template · see options" or "Make your own", plus a Demo tag unless locked). It scrolls; only the panel starts a run.

## Responsive behavior

| Width | Navigation | Notes |
| --- | --- | --- |
| Below 640px | Tab bar, no top-bar search | Sheets dock to the bottom, full width; small controls grow to 40px |
| 640 to 1023px | Tab bar, top-bar search | Sheets center |
| 1024px up | Rail | Tab bar and make bar hidden; two-column pages |

The top bar holds the wordmark (a 40px link below lg), search from sm, and Sign in, or for members the 40px credit pill (below lg) and a bone Create button from lg. The tab bar holds Discover, Search, a 48px ember Create button, Library, and You (or Sign in). The rail adds Train, Projects, Studio, Favorites, an ember New creation button, credits, Settings, Admin, sign-out, the profile, Pricing and Policies. A member's You tab opens a Sheet of 48px rows with every rail page the tab bar lacks; signed out below lg, only in-page links reach Pricing or Policies (age gate, sign-up terms, a locked VIP note). Both bars are 64px plus safe areas.

Safe areas: `viewport-fit=cover`; the top bar pads by the top inset, the tab bar and phone sheets by the bottom one. Below lg, above that inset, the make bar sits 4.75rem up, the job tray 5rem plus `--dock-h`, toasts 6rem plus both heights (captured over the tray; over the make bar implemented but not verified). From lg the tray sits 20px from the bottom right, toasts 2rem plus `--tray-h` up (24px from xl). Known issue (low): the brief "Weaving a demo placeholder" toast covers Make it on phones.

**Sideways scrollers.** `.edge-fade`, a scroll-driven mask, fades a scroller's right 40px while more waits; at the end, on a row that fits or without browser support, it shows nothing. It marks the Library filter row, scene timeline, Pricing's tables, the creator's template table and the admin audit log, not rails, chip rows or the Versions strip. Below sm, Pricing's credit history and the creator's template list become stacked rows.

## Motion principles

- **Exits beat entrances.** Sheets rise in 360ms and sink in 140ms (backdrop 220ms in, 140ms out). `close()` follows the sink by 20ms.
- **Easing.** Time-based keyframes use `--ease-weave`; `.edge-fade` runs linear. Buttons, chips, the Toggle track and the preview fade keep Tailwind's default easing.
- **Reduced motion.** A global rule cuts every animation and transition to 1ms, plays each once and turns smooth scrolling off, so sheets close in about 21ms.
- **Gaps.** Under reduced motion, grid arrow keys still scroll smoothly and hover still plays looping previews.

## Accessibility

**Contrast.** Tested pairs pass 4.5:1 and axe found no violation; Tokens lists the gaps.

**Focus.** Everything focusable gets the ember outline, but a parent that clips overflow hides it: a focused card (its link fills an `overflow-hidden` petal) and the job tray's header show none, and chips in sideways rows keep only the outline's sides. Focus still reveals Make pills and plays previews.

**Skip link and headings.** "Skip to content" is the first Tab stop and lands on `<main id="main">`. The capture found an h1 on every page but the five loading skeletons; creation detail's is visually hidden. Gap: `/auth`'s only h1 sits in a `hidden lg:block` column, so below 1024px none is exposed (the capture counted hidden headings).

**Patterns.**

- Roving-tabindex radio groups: the auth switch and Explore's sort. Only the checked radio is tabbable; Arrows, Home and End move and select, wrapping (`radioGroupKeys`; keys implemented but not verified).
- Create's "What to make" chips and the rating stars are radios without arrow keys (stars on purpose: each arrow would post a rating).
- Template grids: Left and Right step, Up and Down jump to the nearest card on screen (implemented but not verified).
- Also `aria-pressed`, `aria-checked` switches, `aria-current="page"` and the tray's `aria-expanded`; polite `role="status"` for route loading and toasts, `role="alert"` for errors.

**Labels.** `Field` ties `<label>` to its control. Only the takedown form sets `aria-invalid`, and nothing sets `aria-describedby`, so no hint or error is tied to a field. Icon-only buttons carry `aria-label`. Card links name the title, creator and ", demo media".

**Touch targets.** `tests/e2e/layout.spec.ts` fails if, at 390px on eight main routes, a visible header or tab-bar control or a filled ember or bone button or link is under 40 by 40px. Explore's sort tabs and the template page's creator and Manage links are 40px at every width, as is its category badge link (a 40px box around the 20px badge; negative margins keep the row 20px tall). Below 640px, Library selects, filter pills, Favorites tabs, the auth switch, stars, Report, Policies chips, tag pills, copilot Apply and Dismiss, Remove upload, preset delete and scene arrows grow to 40px.

Still under 40px on phones: in the final capture (369 flags at 390px, from 1,916), duplicate card title links (about 21px, out of the Tab order) and `Toggle` switches (the row is the target); by code scan, Train's remove-character button (32px everywhere), Library's Retry text, creation detail's Close comparison icon and inline links such as "Remix of".

## Labeling rules for demo and sandbox

Without accounts or keys, AI generation is a labeled demo; payments, age verification and scanning run in labeled sandbox or dev modes; push is off without VAPID keys. The live adapters (CCBill, Segpay, Stripe, Yoti, PhotoDNA, Cloudflare edge scanning, Replicate) are Unverified.

1. A solid iris fill means simulated; only `Badge tone="demo"` has one. A 10% iris tint marks seven notices: five demo notes in iris-300 (the Create panel's cost sheet, Library's retry sheet, creation detail twice, the project derive sheet) and two bone-text panels led by a demo badge (the dev scanner on `/admin/review`, the sandbox on `/pricing/sandbox`).
2. Say what it is not, where there is room: "not AI-generated", "No money moves", "proves nothing", "not live". Demo badges (uppercase via `.tag`) say "Demo" (template cards, Library tiles, creation detail, project covers, scene tiles, Side by side), "Demo media" (template page), "Demo model" (Create panel), "demo" (admin models), "Sandbox" (Settings age card, `/verify/sandbox`), "Sandbox · no money moves" (Pricing), "Sandbox · demo" (`/pricing/sandbox`), "sandbox" (payment history, sandbox purchase and pass lists), "Development scanner · not live" (`/admin/review`) and "dev scanner drill" (its escalations).
3. Label every touchpoint. The 16:9 crop cuts off the placeholder's band, so project covers, scene tiles and Side by side draw the badge. Gaps (no badge): creation detail's Versions strip, the creator Manage tab's template thumbnails and the project's Sequence sheet (`SequencePlayer`). They rely on the burned-in band, which crops can remove: 4:5 strip tiles cut it from 2:3 and 9:16 outputs, and demo clips zoom or pan over the still (`demo.ts`), hiding it for part or all of each clip, so the Sequence sheet can play demo video with no readable label.
4. The server backs the label: the payment sandbox refuses a live deployment, as does the dev scanner while fail-closed is on; `/verify/sandbox` returns 404 there.

Beyond the badges:

- **AI generation:** models "Demo Still (not AI)" and "Demo Motion (not AI)"; "· demo" in the tray and Studio's Job monitor; the make bar's Demo tag; the placeholder still's "DEMO OUTPUT · NOT AI-GENERATED" band (bottom 9%; clips crop it, see rule 3).
- **Payments:** Buy tagged "· sandbox"; `/pricing/sandbox`: "This is a sandbox. No money moves."
- **Age verification:** "a labeled demo that proves nothing" in Settings; "Demo · not age verification" on `/verify/sandbox`; "(simulated)" toasts.
- **Push:** Not a demo. Without VAPID keys the toggle is disabled: "Push is not configured on this server." (asserted in e2e). Real delivery is Unverified.

## Do and don't examples

| Do | Don't |
| --- | --- |
| `Badge tone="demo"` beside anything simulated | Iris fills on real features |
| New custom classes in `@layer components` | `ring-*` or `shadow-*` beside `.hairline` |
| `className="panel"` | Another inline `rounded-[24px_8px_24px_8px]` (eight remain) |
| `Sheet` for confirmations | `window.prompt` (admin suspend and Clear flag still use it) |
| `size="sm"`, `BackLink`, `SectionLink`: 40px on phones | New phone targets under 40px |
| `minmax(0,1fr)` tracks; `.edge-fade` on hidden-scrollbar scrollers | Tracks a nowrap line can widen; a scroller with no cue |
