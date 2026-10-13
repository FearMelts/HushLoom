# Hushloom UI and design-system map

Read-only survey of `/home/claude/hushloom` at commit `a4752a9` (branch `claude/playbox-2-foundation-q7fpbs`). Every claim marked **verified** comes from reading the cited file. Claims marked **inference** are deductions I did not execute code to confirm. No npm scripts were run.

Scope: `src/app/globals.css`, `src/app/layout.tsx`, `src/middleware.ts`, every file under `src/components/`, every non-API page under `src/app/`, `src/lib/{api,cn,format}.ts`, `next.config.ts`, and the e2e layout/keyboard tests in `tests/e2e/journey.spec.ts`.

---

## 1. Design tokens (`src/app/globals.css`, 141 lines)

Tailwind 4 is configured entirely through the `@theme` block (lines 10–65); there is no `tailwind.config.*` file (verified: `ls tailwind.config.*` found nothing; `postcss.config.mjs` only loads `@tailwindcss/postcss`). Fonts are self-hosted via `@fontsource-variable/*` imports at lines 2–4; no Google Fonts.

### 1.1 Colors (lines 11–32)

| Token | Hex | Role (inferred from usage) |
| --- | --- | --- |
| `--color-ink-950` | `#0f0a0d` | page background (`html, body` line 75), `themeColor` in layout.tsx:16 |
| `--color-ink-900` | `#160f13` | panels, inputs, hero section |
| `--color-ink-850` | `#1c1419` | skeleton base, card media background, job tray |
| `--color-ink-800` | `#241a20` | hover surfaces, active nav |
| `--color-ink-700` | `#33252d` | toggle track off, progress track |
| `--color-ink-600` | `#47353f` | defined, **no usage found in components** |
| `--color-bone-50` | `#f7efe7` | primary text, bone buttons |
| `--color-bone-200` | `#e3d6cf` | field labels, body copy |
| `--color-bone-300` | `#c8b7b1` | secondary copy |
| `--color-bone-400` | `#a8958f` | tertiary copy, icons |
| `--color-bone-500` | `#85736f` | placeholders, mono meta |
| `--color-ember-300` | `#ffa98c` | italic emphasis in headings, link hover |
| `--color-ember-400` | `#ff8a66` | focus ring, kickers, active icons |
| `--color-ember-500` | `#ff6a4d` | primary CTA fill, favorite fill, toggle on |
| `--color-ember-600` | `#e6503a` | CTA active, hero glow |
| `--color-ember-700` | `#b83a29` | body radial glow, CTA shadow |
| `--color-brass-300` | `#f0cf96` | warn tone text, VIP lock notice |
| `--color-brass-400` | `#e2b46d` | VIP badge, star fill, credit pill coin |
| `--color-sage-400` | `#9cc5a1` | "new"/success tone, completed dot |
| `--color-iris-300` | `#cdbfff` | video badge text, demo notices |
| `--color-iris-400` | `#b39dff` | demo badge fill |
| `--color-danger-400` | `#ff6b81` | errors, failed state, danger buttons |

Non-theme CSS custom properties on `:root` (lines 67–71): `color-scheme: dark`, `--line` (bone-50 at 9% via `color-mix` in oklab), `--line-strong` (bone-50 at 16%). There is no light theme and no `prefers-color-scheme` switch; the app is dark-only (verified).

Note: `src/components/settings.tsx:171,295` and `studio.tsx:295` use `text-bone-100`; `src/app/pricing/page.tsx:44` uses `text-sage-300`. Neither `bone-100` nor `sage-300` is defined in `@theme`. **Inference**: Tailwind 4 will emit no rule for an undefined color utility, so those elements fall back to inherited color. Minor defect.

### 1.2 Typography (lines 34–36)

- `--font-display`: "Fraunces Variable", ui-serif, Georgia, serif. Used for all h1/h2, card titles, wordmark (italic at shell.tsx:21), stat values.
- `--font-sans`: "Manrope Variable", ui-sans-serif, system-ui. Body default (line 80).
- `--font-mono`: "JetBrains Mono Variable", ui-monospace. Handles, counts, timestamps, `.tag` labels.

Type scale is **not tokenized**; sizes are inline Tailwind arbitrary values. Observed scale (verified by grep across components): `text-[10.5px]` (tabbar labels, `.tag`), `[11px]`, `[11.5px]`, `[12px]`, `[12.5px]`, `[13px]`, `[13.5px]`, `[14px]`, `[14.5px]`, `text-sm` (14px), `[15px]`, `[17px]` (card title), `text-xl`, `text-2xl`, `[26px]`/`text-3xl` (section heading), `text-4xl` (page h1), `text-5xl` (hero/template h1), `[34px]` (hero mobile), `[22px]` (wordmark).

`.tag` utility (lines 105–110): mono, 10.5px, 0.08em tracking, uppercase. Used for kickers and badges.

### 1.3 Radii (lines 38–39)

- `--radius-petal: 20px`, `--radius-pin: 5px`.
- `.petal` (lines 97–99): `border-radius: 20px 5px 20px 5px` (asymmetric: large top-left/bottom-right, small top-right/bottom-left). This is the signature card shape.
- Variants hardcoded inline rather than tokenized: `rounded-[28px_8px_28px_8px]` (hero, page.tsx:30), `rounded-[24px_8px_24px_8px]` (panels: templates/[id]:110, generate:87, studio:50, settings.tsx:28, admin:22, pricing:59, projects.tsx:433), `rounded-[20px_6px_20px_6px]` (projects.tsx:277,302), `rounded-[16px_5px_16px_5px]` (mobile "+" tab, shell.tsx:193), `rounded-[40%_12%_40%_12%]` (Avatar, shell.tsx:226). Buttons/chips/pills are `rounded-full`; inputs `rounded-xl`; Sheet `rounded-[24px]`.

### 1.4 Spacing and layout

No spacing tokens beyond Tailwind defaults. Observed constants: rail width 236px (shell.tsx:108,157,182), top bar h-16, mobile tab bar h-16 with `pb-[env(safe-area-inset-bottom)]` (shell.tsx:189), content `max-w-[1600px]` with `px-4 sm:px-6` (shell.tsx:183), main `pb-28 lg:pb-12` to clear the tab bar. Page gutter at phone width is 16px (`px-4`).

### 1.5 Motion (lines 41–64)

- `--ease-weave: cubic-bezier(0.2, 0.8, 0.2, 1)`
- `--duration-quick: 140ms`, `--duration-base: 220ms`, `--duration-slow: 360ms`
- Keyframes: `thread` (translateX -100% → 100%, used for the indeterminate "weaving" bar and skeleton shimmer), `rise` (opacity 0→1 + translateY 8px→0), `pop` (scale 1→1.28→1, favorite heart).
- Animation tokens: `--animate-thread` (1.8s infinite), `--animate-rise` (360ms both), `--animate-pop` (320ms).
- Reduced motion (lines 132–141): `@media (prefers-reduced-motion: reduce)` forces `animation-duration: 1ms`, `animation-iteration-count: 1`, `transition-duration: 1ms`, `scroll-behavior: auto` on `*, *::before, *::after` with `!important`. **Consequence (inference)**: the skeleton shimmer and the job-tray "thread" bar become static after one 1ms run under reduced motion; running state is still conveyed by text ("Weaving", elapsed time).
- **The `motion` npm package (v12.43.0, package.json:35) is a declared dependency but has zero imports anywhere in `src/`** (verified with grep for `from "motion`). All motion is CSS keyframes/transitions. The spec's "motion library" requirement is nominally satisfied by the dependency only.

### 1.6 Breakpoints

- Custom: `--breakpoint-xs: 420px` (line 46). **No usage of `xs:` found in components** (grep).
- Tailwind defaults used: `sm` (640), `md` (768), `lg` (1024, rail/tabbar switch), `xl` (1280), `2xl` (1536). `max-sm:` and `max-lg:` variants are used in Sheet and TemplateCard.

### 1.7 Global rules

- `:focus-visible` (lines 91–94): `outline: 2px solid var(--color-ember-400); outline-offset: 2px`. Applies to everything. Inputs additionally use `focus:ring-2 focus:ring-ember-400/70` with `focus:outline-none` (ui.tsx:105, shell.tsx:74) — this replaces the outline with a ring on inputs; **inference**: ring is visible on both mouse and keyboard focus for inputs.
- `::selection` ember-500 at 45%.
- `.hairline`: `box-shadow: inset 0 0 0 1px var(--line)` (the ubiquitous 1px border).
- `.skeleton` (lines 112–123): ink-850 base with a shimmering `::after` gradient using `--animate-thread`.
- `.scrollbar-none`: hides scrollbars on horizontal rails.
- Body background: ink-950 plus a fixed radial ember-700 glow at 85% / -10% (line 83).

---

## 2. Root layout and gating (`src/app/layout.tsx`, `src/middleware.ts`)

**Verified**:
- `metadata`: title template `"%s · Hushloom"`, description "An adults-only playground for making images and short videos from templates.", `robots: { index: false, follow: false }` (layout.tsx:9–13). `next.config.ts` additionally sets `X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` on every path.
- `viewport.themeColor = "#0f0a0d"` — the only raw hex in TSX (layout.tsx:16); matches `ink-950`.
- `RootLayout` is an async server component: calls `getCurrentUser()`, `getBalance(user.id).available` for the credit pill, reads cookie `hl_age_ok === "1"`, reads `x-pathname` header (set by middleware.ts:20).
- Gate logic (line 30): `gated = !ageOk && !path.startsWith("/policies")`. Signed-in users are never gated. When gated the entire body is `<AgeGate />` and **no Shell renders** (line 34). `/policies` is reachable without passing the gate.
- Middleware (middleware.ts:10–16): mutating `/api/*` calls (except `/api/webhooks/*`) with an `Origin` header that matches neither the request origin nor `APP_URL` get `403 {"error":{"code":"bad_origin"}}`. Matcher excludes `_next/static`, `_next/image`, `favicon.ico`.
- No `loading.tsx`, `error.tsx`, `template.tsx`, `icon.*` or `favicon.*` exists under `src/app`; there is **no `public/` directory** (verified). **Consequence**: no favicon, no route-level Suspense skeletons, no error boundary UI; a thrown server error shows the Next default.
- Every page sets `export const dynamic = "force-dynamic"` except `/policies` (static) and `/auth`/`not-found` (dynamic by virtue of `getCurrentUser`).

---

## 3. Navigation shell (`src/components/shell.tsx`, 233 lines, client)

### 3.1 Exports
- `Wordmark({className})`: inline SVG (three stroked curves in ember-500, brass-400, bone-50/75%) plus "hushloom" in Fraunces italic 22px. `aria-hidden` on the SVG.
- `Shell({user, children})`, `Avatar({name, size=32})`, type `ShellUser`.

### 3.2 Nav model
- `primary` (lines 26–31): Discover `/` (matches `/`, `/explore*`, `/templates*`), Create `/generate/image` (matches `/generate*`), Library `/collection`, Train `/train`.
- `secondary` ("Go deeper", lines 32–36): Projects, Studio, Favorites.
- Active link: `aria-current="page"`, bg ink-800, icon ember-400 (line 92–96).

### 3.3 Desktop rail (`<aside aria-label="Main navigation">`, lines 108–154)
Fixed, 236px, `hidden lg:flex`, `bg-ink-950/80 backdrop-blur`, right hairline border. Contents top to bottom: Wordmark link (`aria-label="Hushloom home"`), primary nav, "Go deeper" tag, secondary nav, then `mt-auto` footer: signed-in → ember "New creation" button (to `/generate/video`), `CreditPill` (links to `/pricing`, `aria-label="{n} credits. Get more credits"`, `data-testid="credit-balance"`), admin Shield icon link (only `role === "admin"`), Settings icon link, profile row (Avatar + name + @handle, links to `/creators/{handle}`); signed-out → ember "Join or sign in". Always: Pricing, "Content policy & privacy" text links.

### 3.4 Top bar (`<header>`, lines 157–180)
Sticky, h-16, `lg:pl-[236px]`. Wordmark shown only `lg:hidden`. `SearchBox` (`role="search"`, `aria-label="Search templates"`, pushes to `/explore?q=`) is `hidden sm:block`. Right: signed-in → CreditPill on `lg:hidden` and a bone "Create" button on `lg:`; signed-out → bone "Sign in".

### 3.5 Mobile tab bar (`<nav aria-label="Main navigation">`, lines 189–199)
Fixed bottom, `lg:hidden`, 5-column grid: Discover, Search (`/explore`, never active), center "+" (ember-500 petal-ish `rounded-[16px_5px_16px_5px]`, size-12, `aria-label="Create"`, to `/generate/image`), Library, You/Sign in (to `/settings` or `/auth`). `TabLink` sets `aria-current="page"` on active; icon colored ember-400 when active.

Note: both the rail and the tab bar carry `aria-label="Main navigation"`; only one is visible at a time via CSS but both are in the DOM. **Inference**: screen readers will announce two landmarks with the same name on desktop, since `hidden` → `display:none` does remove it from the a11y tree — so actually fine; `lg:hidden` tab bar on desktop is `display:none`. Not a defect.

### 3.6 Skip link (line 104)
`<a href="#main">Skip to content</a>`, `sr-only focus:not-sr-only`, fixed top-left on focus. Target `<main id="main">` (line 182). Tested in `tests/e2e/journey.spec.ts:149–168` (first Tab focuses it; Enter navigates to `#main`; every visible `a`/`button` has an accessible name).

### 3.7 Other
- `JobTray` rendered when `user` is set (line 186).
- `ToastProvider` wraps everything (line 103).
- `Avatar`: initials on a deterministic HSL gradient hashed from the name; `aria-hidden` (the adjacent text carries the name).

---

## 4. Age gate (`src/components/age-gate.tsx`, 48 lines, client)

**Verified**: full-screen `<main>` with a petal card (`animate-rise`), Wordmark, h1 "Adults only", explicit copy about sexually suggestive/explicit AI material. Primary `Button variant="ember" size="lg"` → `POST /api/age-gate {confirm:true}` then `router.refresh()`; `busy` state while posting. "Leave" is a plain `<a href="https://www.google.com" rel="noreferrer">` styled `quiet lg`. Footer text states this is a notice not verification and links `/policies`. No focus trap needed (nothing else on the page). Reduced-motion handled by the global rule.

---

## 5. UI primitives (`src/components/ui.tsx`, 228 lines, client)

| Export | Props | States / a11y (verified) |
| --- | --- | --- |
| `buttonClass(variant, size, extra)` | variant `ember\|bone\|ghost\|quiet\|danger`, size `sm\|md\|lg` | base: inline-flex, `transition-colors duration-[--duration-quick]`, `disabled:opacity-45 disabled:pointer-events-none`. ember: hover ember-400, active ember-600. bone: hover bone-200. ghost: hairline + hover ink-800. quiet: text only. danger: hairline + danger text, hover danger/10. Sizes h-8/10/12, all `rounded-full`. |
| `Button` (forwardRef) | + `busy?: boolean` | `disabled={disabled \|\| busy}`, `aria-busy`, spinner (`animate-spin` border) when busy. |
| `ButtonLink` | Link props + variant/size | same classes on `next/link`. |
| `Badge` | tone `plain\|vip\|new\|video\|demo\|warn\|danger` | `.tag` style, h-5, `rounded-[4px]`, backdrop-blur. vip=brass-400 fill, new=sage-400 fill, demo=iris-400 fill, video=iris-300 text, warn/danger=15% tints. |
| `Chip` | `active?` + button attrs | `aria-pressed={active}`; active = bone-50 fill, inactive = hairline + hover ink-800. Can be overridden to `role="radio"` (create-panel.tsx:262). |
| `Field` | label, hint, error, htmlFor | `<label htmlFor>`; error `<p role="alert">` in danger-400; hint in bone-500. Error replaces hint. |
| `inputClass` | const string | rounded-xl, ink-900, hairline, `focus:ring-2 ring-ember-400/70`, `transition-shadow`. Used on input/select/textarea. |
| `Toggle` | checked, onChange, label, description, disabled | `<button role="switch" aria-checked aria-label>`; track ember-500/ink-700; knob translates with `--duration-base` + `--ease-weave`; wrapper label at 50% opacity when disabled. |
| `Sheet` | open, onClose, title, children, wide | Native `<dialog>` via `showModal()`/`close()` in `useEffect`; backdrop click (target === dialog) closes; `onClose` wired to the dialog `close` event so Esc works; `aria-label={title}`; sticky header with h2 + Close icon button (`aria-label="Close"`); width `min(100vw-24px, 480px)` or 880px when `wide`; on `max-sm` becomes a bottom sheet (`mb-0 w-full rounded-b-none`); `open:animate-rise`; backdrop ink-950/75 blur. Focus trap and focus restoration come from the platform `<dialog>`. |
| `ToastProvider` / `useToast` | push `{message, tone?: plain\|success\|error, action?: {label, href}}` | Keeps last 4 (`slice(-3)` + new), auto-dismiss 5000ms, container `role="status" aria-live="polite"`, fixed bottom-24 (above the tab bar) / `lg:bottom-6`, `animate-rise`, success shows a sage dot, error colors text danger-400, optional ember action link. No manual dismiss, no pause-on-hover. |
| `Skeleton` | className | `div.skeleton aria-hidden`. |
| `EmptyState` | title, body, action | centered petal hairline card, Fraunces title. |
| `SectionHeading` | title, kicker, action | kicker `.tag text-ember-400`, h2 26px/30px Fraunces, optional right-aligned action. |

---

## 6. Component inventory (by file)

### 6.1 `template-card.tsx` (185 lines, client)
- `TemplateCard({card, feature?, signedIn, autoplay?})`:
  - Structure: `<article class="group relative animate-rise">` → petal media box (`aspect-[4/5]`, hover `-translate-y-1` with `--duration-base`/`--ease-weave`) → caption.
  - Media: `<img loading="lazy" decoding="async" alt="">` from signed `posterUrl` (eslint-disabled `no-img-element` by design, line 68) or `.skeleton` when missing; optional `<video muted loop playsInline preload="none" aria-hidden>` that fades in (`opacity` transition) on hover/focus or when `autoplay`.
  - Hover/focus (lines 58–61): `onMouseEnter/onFocus` → play, `onMouseLeave/onBlur` → pause (unless autoplay). Touch users get an explicit Play/Pause pill (`aria-label` "Preview {title}" / "Pause preview", disabled when no previewUrl).
  - Badges top-left (pointer-events-none): VIP, New, 4K.
  - Favorite button top-right: `aria-pressed`, `aria-label` "Save/Remove {title} to/from favorites", optimistic toggle with rollback + error toast; `animate-pop` on the Heart when saving; signed-out → `router.push('/auth?next=/templates/{slug}')`.
  - "Make" CTA (ember pill, to `/templates/{slug}#make`): hidden on desktop until `group-hover`/`focus`; **always visible on `max-lg`** (line 125) so touch users are not dependent on hover.
  - Caption: Fraunces 17px title link, mono @handle link to `/creators/{handle}`, mono ♥ count with `title` attr.
  - Accessible name of main link: `"{title} by {creator.displayName}"`.
- `TemplateGrid({cards, signedIn, autoplay?, editorial?})`: `grid-cols-2 sm:3 md:4 xl:5 2xl:6`, `grid-flow-row-dense`; `editorial` makes every 11th card `sm:col-span-2 sm:row-span-2` (feature).
- `TemplateRail({cards, signedIn})`: horizontal `snap-x snap-mandatory`, `role="list"/"listitem"`, cards `w-[42vw] max-w-[220px] sm:w-[200px]`, bleeds to the gutter with `-mx-4 px-4`.
- `GridSkeleton({count=10})`: `aria-hidden` petal + two text bars per cell.

### 6.2 `template-detail.tsx` (173 lines, client)
- `TemplateMedia({posterUrl, previewUrl, title, isVideo})`: petal box; video with `poster`, `muted loop playsInline preload="metadata"`, `aria-label="{title} preview"`, explicit Play/Pause button bottom-left tracking `onPlay/onPause`; image with `alt="{title} cover"`; `.skeleton` fallback.
- `FollowButton({creatorId, initial, signedIn})`: `Button sm`, `aria-pressed`, busy state, POST/DELETE `/api/follows`, `router.refresh()`; signed-out → `/auth`. No error toast on failure (finally only).
- `RateStars({templateId, initial})`: `role="radiogroup" aria-labelledby="rate-label"`, five `role="radio" aria-checked` buttons with `aria-label "{n} star(s)"`, hover preview via mouse only, optimistic set with rollback; POST `/api/templates/{id}/rate`.
- `ReportButton({templateId})`: opens `Sheet` "Report this template"; fieldset of 6 radio reasons (`minor`, `non_consent`, `real_person`, `illegal`, `spam`, `other`) styled with `has-[:checked]:bg-ink-800`; textarea note (maxLength 1000); POST `/api/templates/{id}/report`; busy + toasts.

### 6.3 `explore-feed.tsx` (158 lines, client)
- `ExploreFeed({initial, categories, query, signedIn})`: h1 "Explore" / "Results for “q”"; mobile-only search form (`sm:hidden`, `role="search"`); sort `role="tablist" aria-label="Sort"` with `role="tab" aria-selected` buttons (Trending/New/Top rated/Most loved) — **note**: tabs are buttons with no `tabpanel` or arrow-key handling (inference: minor ARIA pattern gap); media Chips (Everything/Images/Videos) and category Chips (toggle); all navigation is URL-driven via `router.push` (page re-renders server-side; `key` on `ExploreFeed` in explore/page.tsx:21 resets state).
- Infinite scroll: `IntersectionObserver` sentinel with `rootMargin: 600px` (effect has no dependency array, re-subscribes every render, line 62–68) calls `GET /api/templates?offset&limit=24&sort&q&category&media`; dedupes by id; `GridSkeleton count=5` while loading; "Load more" button fallback when `hasMore && !loading`.
- Empty: `EmptyState` "Nothing matches yet" with "Clear filters" → `/explore`.
- Error: `loadMore` has no catch; a failed fetch rejects silently (finally resets `loading`). **Inference**: unhandled promise rejection logged to console, no toast.

### 6.4 `auth-forms.tsx` (127 lines, client)
- `AuthForms({next, initialMode})`: petal card; `role="tablist"` with two `role="tab" aria-selected` buttons (Create account / Sign in). Form `noValidate`; fields via `Field` with per-field errors from `ApiError.details.fieldErrors`; signup adds handle, display name, date-of-birth (`type="date"`), two checkboxes (`confirmAdult`, `acceptTerms`, `accent-[--color-ember-500]`) with the Terms link opening `/policies` in a new tab; form-level error `<p role="alert">`; submit `Button ember lg w-full busy`. POST `/api/auth/signup` or `/api/auth/login`, then `router.replace(next); router.refresh()`.
- Checkboxes are not wrapped by `Field`, so their errors are plain `<p>` without `role="alert"` (lines 102, 113).

### 6.5 `create-panel.tsx` (736 lines, client) — the core generation form
- Props: `output: image|video`, `models: ModelAvailability[]`, `template?: CreateTemplate`, `prefill?: CreatePrefill`, `signedIn`, `balance`, `characterRefs?`, `projects?`, `studio?`, `copilot?` (default true; when false only `severity === "block"` suggestions show).
- Container `id="make"` (anchor target of card "Make" CTA).
- Sections, top to bottom (all verified):
  1. VIP lock notice (brass tint, Lock icon, link to `/pricing`) when `template.locked`.
  2. Mode `role="radiogroup" aria-label="What to make"` of Chips with `role="radio" aria-checked` (only when the model offers >1 mode filtered by output type).
  3. Input section when the mode needs an image/video (`MODE_INPUTS`): uploaded preview card (img/video 64px, dimensions, "Private. Only you can see it.", Remove button `aria-label`), or dashed "Choose a photo (JPG, PNG or WebP)" button + `sr-only` file input (`data-testid="upload-input"`, accept jpeg/png/webp). Choosing a file opens the **consent Sheet** "Before you upload" (checkbox `data-testid="consent-checkbox"`; Upload button disabled until checked) before `POST /api/uploads` (multipart with `consent=true`, `purpose=source`). Video-input modes show a pointer to the Library instead.
  4. Character `<select>` when the mode needs a reference (or link to `/train` when none).
  5. Prompt `<textarea id="prompt">` (rows 3, 5 in studio; maxLength 2000) with Undo (history, max 20) and "Restore original" (when changed and a template/prefill prompt exists); continuity note hint in iris-300.
  6. Assistant suggestions `<ul aria-label="Assistant suggestions">`: tones block (danger tint), warn (brass tint), info (hairline); Apply (`patchLabel`) and Dismiss (`aria-label "Dismiss: {title}"`; not offered for block). Suggestion ids from `src/lib/copilot.ts`: `policy` (block), `short-prompt`, `long-prompt`, `conflict-camera-param`, `aspect-unsupported`, `low-res`, `aspect-crop`, `artifact-risk`, `camera`, `neg-unsupported`, `text`, `continuity`.
  7. "Say it plainly" interpreter form (`<input id="wish">` with sr-only label, Sparkles icon, "Interpret" button) → `role="region" aria-label="Interpreted settings"` panel listing field → value + reason, cost delta in brass-300 when it changes, unsupported list, Apply / Dismiss. Applying also expands Tweak.
  8. "Tweak" disclosure (`aria-expanded`, summary shows current aspect · duration · 4K): Model `<select>` (unavailable models disabled with reason), model notes, Aspect ratio Chips, Length Chips (video), Quality Chips ("4K (2× credits)"), Camera `<select>`, Motion intensity `<input type="range" 1–10>`, Pacing (video) / Lighting / Framing selects; **studio only**: Atmosphere, Negative prompt (if supported), Seed (if supported), Project + Scene selects; non-studio shows "More controls in Studio →".
  9. Error `<p role="alert">`.
  10. Action row: `Button ember lg` "Make it" (`disabled` when prompt empty, a block suggestion exists, template locked, required upload/character missing; `busy` while drafting), cost line `data-testid="cost-line"` ("{cost} credits · you have {balance}", short balance in danger-400 with "Get credits" link), Demo badge when `model.isDemo`.
  11. Confirm Sheet "Ready to make this?": `<dl>` Cost (`data-testid="confirm-cost"`), Balance after (danger when negative), Model; demo notice (iris tint); "If it fails, your credits come back automatically." Buttons "Not now" / "Confirm · {n} credits" (`data-testid="confirm-make"`, disabled when balance short).
- Flow: `startDraft` → signed-out redirect to `/auth?next=`; `POST /api/generations` with an idempotency key kept in a ref and reset on any edit; then `confirm` → `POST /api/generations/{id}/confirm {expectedCost}`; dispatches `window` event `hl:job-started`; toast "Weaving your creation." / "Weaving a demo placeholder." with Library action; `router.refresh()`.
- `switchModel` strips params the new model cannot use (aspect, camera, motion, seed, quality, duration).
- Fallback when no usable model: plain text "No {output} models are configured on this server."

### 6.6 `job-tray.tsx` (119 lines, client)
- `JobTray()`: fixed bottom-right card (`aria-label="Creations in progress"`), bottom-20 on mobile (above the tab bar) / `lg:bottom-5`. Header button with `aria-expanded`, an indeterminate ember "thread" bar (`animate-thread`), "{n} weaving", chevron rotates when collapsed. List of links to `/collection/{id}` with a status dot (ember pulse when processing), truncated prompt, `STATUS_LABEL · elapsed · demo`.
- Polling: `GET /api/generations?active=1` on mount, on `hl:job-started`, and every 3000ms while any job is active (15000ms when `document.hidden`); 1s tick re-renders elapsed time. When a job leaves the active list it fetches `GET /api/generations/{id}` and toasts success ("Your creation is ready." / "Demo creation ready." with Open action) or error (`failureMessage`), then `router.refresh()`. Renders nothing when there are no active jobs. Errors are swallowed (signed-out/offline).
- No progress percentage anywhere (matches the "no fake progress" rule).

### 6.7 `library.tsx` (316 lines, client)
- `CreationThumb({item, selectable?, selected?, onSelect?})`: petal link to `/collection/{id}` sized by the output's real aspect ratio (`style={{aspectRatio}}`, default 4/5); `aria-label "{status}: {prompt}"`; video hover-plays (mouse only), image `alt=""`; running → `.skeleton` with thread bar, status label, mono elapsed; failed/cancelled → AlertTriangle (danger for failed) + `failureMessage` (3-line clamp); badges Demo / Video; favorite heart (`aria-label="Favorite"`); selection checkbox icon when selectable (`ring-2 ring-ember-500` when selected). Caption: template title or prompt, relative time, and an inline **Retry** button for failed items (derive `retry` → confirm immediately, toast "Retrying for {n} credits." — **note**: this skips the cost confirmation Sheet; the cost is only reported after the fact).
- `LibraryView({items, folders, models, query})`: header "Private to you / Library"; Select mode toggles bulk "Add to folder", "Delete {n}", "Done"; filter row: Chips All / Images / Videos / ♥ Favorites, then native `<select>`s with `aria-label` Status (Any/Ready/Weaving/Queued/Failed/Cancelled), Model, Folder, Sort (Newest/Oldest). URL-driven via `router.push`. Grid `grid-cols-2 … 2xl:6`. Empty states: filtered → "Nothing here" + Clear filters; unfiltered → "Your Library is empty" + "Find a template". Sheets: delete confirmation (sequential `DELETE /api/generations/{id}`, counts failures for still-running items), Add to folder (list + "Create & add" form → `POST /api/folders`, `POST /api/folders/{id}/items`).

### 6.8 `creation-detail.tsx` (508 lines, client)
- `CreationDetail({item, details, versions, folders, categories, balance})`: back link; two-column `lg:grid-cols-[1.2fr_1fr]`.
  - `Media`: completed video with `controls loop playsInline muted preload="metadata" aria-label="Your video"`; image `alt="Your creation" object-contain`; otherwise a petal placeholder with status (skeleton shimmer while running, elapsed, failure message).
  - Demo notice (iris) when `isDemo`.
  - Status Badge (danger/new/plain), Demo badge, relation badge, relative time, prompt, negative prompt, "From {template}" / "From scratch", "in {project}".
  - Running → single `danger` Cancel button. Otherwise a 2/3-column action grid: Remix (`/generate/{kind}?from=`), Retry, Variation (disabled unless completed), Continue + Extend (video only, completed only), Reuse settings (`?from=&reuse=exact`), Save/Saved (`aria-pressed`, optimistic favorite), Download (`<a download href="/api/generations/{id}/download">`, completed only), Folder, Preset, Publish (completed only), Delete.
  - Settings `<dl>` grid: Mode, Model, Aspect, Length, Quality, Camera, Motion, Pacing, Lighting, Framing, Seed, Cost (empty values filtered out).
  - Versions rail (when >1): thumbnail buttons with `aria-label "Compare with {relation}"`; selecting one renders a side-by-side `grid-cols-2` figure pair with "Close comparison".
  - Sheets: pending-derive confirm ("{label}?" with cost and balance, demo note, Confirm disabled when short), delete confirm, `FolderSheet`, `PresetSheet` (`POST /api/presets {fromJobId, name}` → toast with Studio action), `PublishSheet` (blocked message when `usedPersonalMedia`; otherwise title/description/category/tags + policy checkbox → `POST /api/templates` → `router.push('/templates/{slug}')`).
  - Derive flow: `POST /api/generations/{id}/derive {relation, idempotencyKey}` returns a draft with cost; confirm → `POST .../confirm {expectedCost}`; dispatches `hl:job-started`.

### 6.9 `projects.tsx` (552 lines, client)
- `ProjectsIndex({projects})`: header + ember "New project"; cards `grid sm:2 xl:3`, petal `aspect-video` cover with `group-hover:scale-[1.03]` (`--duration-slow`), Fraunces title, mono "{scenes} scenes · {clips} finished · {time}"; `EmptyState` "No projects yet"; New project Sheet (name required + `autoFocus`, description) → `POST /api/projects` → push to the project.
- `ProjectWorkspace({data, characters})`: back link, h1, actions Play sequence (disabled without finished clips), Rename, Delete (icon button with `aria-label`). Auto `router.refresh()` every 4000ms while any take is running.
  - Scene timeline `<section aria-label="Scene timeline">` → `<ol>` of 176px-wide petal buttons (`aria-current="step"`, `ring-2 ring-ember-500` active, 2-digit mono index), reorder arrows (`aria-label "Move {title} earlier/later"`, `PUT /api/projects/{id}/scenes {order}`), dashed "Add scene" (`POST .../scenes`).
  - `SceneGuide` form (`aria-label="Continuity guide"`, sticky `lg:top-20`): title, Lighting/Framing selects, Palette, Character select (disabled without characters), Notes; Save disabled unless dirty (`PATCH /api/scenes/{id}`); "Remove scene" uses `window.confirm` (native) then `DELETE /api/scenes/{id}`.
  - Takes: "Make a clip" (`/generate/video?scene=`) / "Make a still" (`/generate/image?scene=`); version cards (`CreationThumb` + Take badge, branch badge, parent time) with Use as take (`POST /api/scenes/{id}/select`), Branch (variation), Continue (video), Compare (`aria-pressed`, max 2 → side-by-side panel). **Branch/Continue use `window.confirm` for the cost prompt (line 178) instead of the Sheet**, then confirm or cancel the draft. Empty: "No takes yet".
  - "Also in this project" loose creations grid.
  - `SequencePlayer`: wide Sheet with `<video controls playsInline>` that auto-advances `onEnded`; caption "Clip i of n".
  - `RenameSheet`: `PATCH /api/projects/{id}`.

### 6.10 `settings.tsx` (266 lines, client)
- `SettingsView({data, email})`, `max-w-3xl`, kicker shows the email. Sections (petal-ish `rounded-[24px_8px_24px_8px]` panels): Profile (display name, handle, bio → `PATCH /api/me`, field errors), Discovery and privacy (four `Toggle`s: Personalize For You, Keep viewing history, Autoplay previews, Creative assistant → `PATCH /api/me/preferences` optimistic with rollback; Interests Chips from `popularTags` ∪ interests, max 12; "Clear history now" → `DELETE /api/me/history`), Consents (active list with ShieldCheck, statement, granted time, Withdraw button except for `terms`/`adult_attestation`; `<details>` of withdrawn), Account ("Signed in on n devices", "Sign out everywhere" → `DELETE /api/me/sessions` then `location.assign('/auth')`; "Delete account" → Sheet with password → `DELETE /api/me {password}` → `location.assign('/')`). Withdraw Sheet explains cascade deletion → `DELETE /api/me/consents/{id}`.
- `#discovery` anchor referenced from the home "Tune" link (page.tsx:64) **does not exist** in settings.tsx (verified: no `id="discovery"`). Minor dead anchor.

### 6.11 `studio.tsx` (114 lines, client)
- `PresetList({presets, kind})`: rows with Bookmark icon, link to `/studio?kind=&preset=`, mono "image|video · modelKey", "switches" Badge when kind differs, delete icon (`aria-label "Delete preset {name}"`, `DELETE /api/presets/{id}`). Empty text.
- `JobMonitor({items})`: status dot (sage/danger/ember-pulse/bone), prompt link, mono "{status} · {elapsed|time} · {cost} cr · demo", inline Cancel (`aria-label="Cancel"`, `POST /api/generations/{id}/cancel`). `router.refresh()` every 3000ms while running. Empty "Nothing made yet."

### 6.12 `train.tsx` (187 lines, client)
- `TrainView({characters, statement})`: header with the honest note that nothing is fine-tuned; ember "Add a character". Grid of petal `aspect-[4/5]` reference photos (`alt "Reference photo for {name}"`), name, mono "consent {time}", Remove icon (`aria-label`), "Make a still" link (`/generate/image?character=`). `EmptyState`. Add Sheet: name, `sr-only` file input (`data-testid="character-input"`, label is a dashed petal drop-zone with preview), fieldset with two consent checkboxes (`data-testid` `consent-adult`, `consent-likeness`), submit disabled until all set → multipart `POST /api/characters`; low-res warning toast. Remove Sheet → `DELETE /api/characters/{id}` (cascade).

### 6.13 `admin.tsx` (175 lines, client)
- `ReportQueue({reports})`: ink-850 rows with reason Badge (danger when `severe`), template link (new tab), status badge, reporter + time, note; actions Remove content / Dismiss (`POST /api/admin/reports/{id} {action}`), Suspend creator (uses `window.prompt` for the reason → `POST /api/admin/users/{id}/suspend`).
- `ModelTable({models})`: `flex-wrap` rows: name + demo badge, mono key · provider · output · live/reason; "Price %" number input (10–1000, w-20) + Set (`PATCH /api/admin/models/{key} {priceMultiplierPct}`); `Toggle` Enabled in a `w-36` box. plan.md notes this row wraps badly at narrow widths (verified visually by the previous session, not by me).
- `CreditAdjust()`: account (email/handle), amount (negative removes), reason (3–200) → `POST /api/admin/credits` with a fresh idempotency key per submit.

### 6.14 `creator-manage.tsx` (151 lines, client)
- `CreatorManage({rows})`: analytics table (`min-w-[640px]`, horizontal scroll): thumbnail, title + version, status/VIP badges, Views 30d, Uses 30d, Uses, Saves, Rating; Edit (`aria-label`) and Publish/Unpublish eye icons (`PATCH /api/templates/{id} {status}`). `EditSheet`: title, description, VIP checkbox → `PATCH {title, description, isVip}`; note that prompts change only via a new version.

### 6.15 `pricing.tsx` (48 lines, client)
- `BuyButton({itemKey, signedIn, configured, label, featured})`: `disabled` when signed in and payments not configured (with `title` tooltip); signed-out → `/auth?next=/pricing`; `POST /api/checkout {itemKey}` → `location.assign(url)`; error toast.
- `PerkList({perks})`: sage Check bullets.

---

## 7. Page inventory (non-API routes)

Auth column: "redirect" means `redirect('/auth?next=…')` when signed out; "404" means `notFound()`; "public" means renders for anonymous (after the age gate).

| Route | File | Auth | Data loaded (server) | Renders | Actions offered |
| --- | --- | --- | --- | --- | --- |
| `/` | `app/page.tsx` | public | `listCategories`, `browseTemplates(trending,15)`, `browseTemplates(new,12)`, signed-in: `forYou`, `recentlyViewed`, `followingFeed`, `userPreferences.autoplayPreviews` | Hero (petal 28/8 radius, ember+brass blur orbs, "Pick a template. Make it yours."), category pill nav (`aria-label="Categories"`), sections For you (kicker "From what you love" or "Popular to start", Tune link → `/settings#discovery`), Continue exploring (rail), Trending tonight (`TemplateGrid editorial`), Following (rail), New (rail) | Make an image / Make a video CTAs, card favorite/preview/Make, Explore all |
| `/explore` | `app/explore/page.tsx` | public | `listCategories`, `browseTemplates({q, category, media, sort}, 24)`; sort ∈ trending/new/top_rated/most_favorited | `ExploreFeed` keyed by query | sort tabs, media chips, category chips, search, infinite scroll |
| `/templates/[id]` | `app/templates/[id]/page.tsx` | public (404 when `templateForViewer` returns null; VIP locks the panel when `isVip && !ctx.vip && !own`) | `templateForViewer`, inserts a `discoveryEvents` "view" row for signed-in users with history on, `createContext(user)`, `similarTemplates(10)`, `cardsByIds([id])`, `userPreferences` | Two-column sticky media + details: badges (VIP/4K/Video+duration/Image/category/non-published status), h1, creator row with Avatar + FollowButton (or "Manage template" for the owner), description, `<dl>` Made n times / ♥ / rating / Remix of, tag links, the `CreatePanel` in a petal panel (`id="make"` inside), RateStars + ReportButton (signed-in non-owner), `<details>` version history, "You might also like" rail | Make it (draft → confirm), follow, rate, report, favorite |
| `/generate/[kind]` | `app/generate/[kind]/page.tsx` | public (panel redirects to `/auth` on Make); 404 unless `image|video` | `createContext(user)`; prefill from `?from=<jobId>` (own job, seed dropped unless `reuse=exact`), `?scene=<sceneId>` (own project; builds a continuity note; `reference_guided` for images with a character), `?character=<id>` (images) | Kicker "Project scene"/"Remix"/"From scratch", h1 "Make an image/video", switch-kind + "Start from a template" buttons, `CreatePanel` (studio mode when a scene is set) | all CreatePanel actions |
| `/studio` | `app/studio/page.tsx` | redirect | `createContext`, `listPresets`, `listCreations(limit 15)`, `getPreset(?preset=)` | h1 "Studio", Image/Video segmented ButtonLinks (`aria-current`), `CreatePanel studio` (optionally prefilled from a preset), aside Presets + Job monitor (`xl:grid-cols-[1fr_320px]`) | everything in CreatePanel incl. seed/negative/project placement; preset delete; job cancel |
| `/collection` | `app/collection/page.tsx` | redirect | `listCreations(filters, limit 120)`, `listFolders`, `MODELS` | `LibraryView` | filters, select/bulk delete, add to folder, retry failed |
| `/collection/[id]` | `app/collection/[id]/page.tsx` | redirect; 404 on non-UUID or not-owned (`getCreation(user.id, id)`) | `getCreation`, the job row, `lineage`, `listFolders`, `listCategories`, `getBalance`, template + project titles | `CreationDetail` | remix, retry, variation, continue, extend, reuse, save, download, folder, preset, publish, delete, cancel, compare |
| `/favorites` | `app/favorites/page.tsx` | redirect | tab templates: `favorites` rows → `cardsByIds`; tab creations: `listCreations({favorites:true})` | h1 "Favorites", tab nav (`aria-label="Favorites type"`, `aria-current`), `TemplateGrid` or `CreationThumb` grid, EmptyStates | card actions |
| `/projects` | `app/projects/page.tsx` | redirect | `listProjects` | `ProjectsIndex` | create project |
| `/projects/[id]` | `app/projects/[id]/page.tsx` | redirect; 404 on non-UUID or `HttpError 404` | `getProjectDetail`, `listCharacters` | `ProjectWorkspace` | scenes CRUD/reorder, guide, takes, branch/continue, compare, play sequence, rename, delete |
| `/creators/[id]` | `app/creators/[id]/page.tsx` | public; 404 when handle unknown | `creatorPage(handle)`, owner-only `creatorAnalytics` | Avatar 72, h1, @handle, headline/bio, stats `<dl>` Followers/Templates/Uses, FollowButton (non-owner), owner-only "Your templates" `CreatorManage`, collections rails (public/private), "Templates"/"As others see it" grid or EmptyState | follow, manage (owner) |
| `/train` | `app/train/page.tsx` | redirect | `listCharacters`, `LIKENESS_STATEMENT` | `TrainView` | add/remove character, make a still |
| `/settings` | `app/settings/page.tsx` | redirect | `settingsFor(user.id)` | `SettingsView` | profile, preferences, interests, clear history, withdraw consent, sign out everywhere, delete account |
| `/pricing` | `app/pricing/page.tsx` | public (ledger/balance/plan only when signed in) | `paymentsConfigured()`, `getBalance`, `listLedger(40)`, `activePlan` | h1 "Credits and passes", cost explainer, `?checkout=success|cancelled` `role="status"` banners, not-configured `role="note"` banner (names `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`), balance panel (`data-testid="pricing-balance"`, Available / Held / Pass), Passes grid (petal, 2nd card tinted ember/6%), Credit packs grid, Credit history table (`min-w-[520px]`, kind labels, +/- deltas with held amounts) | BuyButton |
| `/auth` | `app/auth/page.tsx` | redirects signed-in users to `next` (sanitized: must start with `/` and not `//`) | none | `lg:grid-cols-2`: left (desktop-only) wordmark + "Your private corner of the loom." + three trust bullets; right `AuthForms` (`?mode=signin` picks the tab) | sign up / sign in |
| `/admin` | `app/admin/page.tsx` | **404 unless `role === "admin"`** (line 32) | `adminStats`, `moderationQueue`, `modelsForAdmin`, `recentAudit` | 8 `Stat` tiles (`grid-cols-2 md:4`), Panels: Reports, Models, Adjust credits, Audit log table (`min-w-[640px]`) | moderate reports, suspend, model price/enable, credit adjust |
| `/policies` | `app/policies/page.tsx` | public, bypasses the age gate | `pricing` constants only | `<article max-w-2xl>`: on-page nav pills (`aria-label="On this page"`), sections `#adults`, `#content`, `#consent`, `#privacy`, `#credits`, `#demo` with `scroll-mt-24`; explicit disclaimer that this is a product draft, not legal terms | none |
| 404 | `app/not-found.tsx` | — | — | "A loose thread" with Back to Discover / Your Library | — |

Other observations:
- No `/collection/[id]` for other users' creations: ownership is enforced in `getCreation(user.id, id)` and the page 404s (verified at collection/[id]/page.tsx:21–22). E2E covers cross-user 404 per plan.md.
- Every page h1 uses `font-display text-4xl` (or 5xl on hero/template), preceded by a `.tag text-ember-400` kicker; this is the consistent page-header pattern.
- Several pages wrap the CreatePanel in the same `rounded-[24px_8px_24px_8px] bg-ink-900/70 p-4 hairline sm:p-6` panel (templates/[id]:110, generate:87, studio:50); this pattern is repeated inline rather than extracted.

---

## 8. Cross-cutting patterns

### 8.1 Loading / empty / error states
- **Loading**: `.skeleton` shimmer on missing posters, running creations, `GridSkeleton` during explore pagination; `Button busy` spinner; `JobTray` thread bar; `animate-rise` on card/toast/dialog entry. **No route-level `loading.tsx`**, so full navigations show nothing until the server responds (all pages are `force-dynamic`).
- **Empty**: `EmptyState` used in Explore, Library (two variants), Favorites (two), Projects, Train, creator page, scene takes; plain text for presets, job monitor, reports, ledger.
- **Error**: inline `role="alert"` in auth forms, CreatePanel, PublishSheet; toasts (`tone: "error"`) elsewhere; `ApiError` from `src/lib/api.ts` carries `status`, `code`, `message`, `details`. No React error boundary (`error.tsx` absent).
- **Hover**: card lift `-translate-y-1`, video preview fade-in, "Make" reveal (desktop only), project cover scale 1.03, nav/button background shifts via `transition-colors`.
- **Focus**: global ember-400 2px outline with 2px offset; inputs swap to a 2px ember ring; card `onFocus` also plays the preview and reveals Make (`focus:translate-y-0 focus:opacity-100`, template-card.tsx:125).

### 8.2 Accessibility inventory (verified)
- Landmarks: `<aside aria-label="Main navigation">`, `<header>`, `<main id="main">`, `<nav aria-label="Main navigation">` (mobile), `<section aria-label>` on job tray, scene timeline, versions, continuity guide, presets, job monitor.
- Skip link present and e2e-tested.
- ARIA used: `aria-current="page"/"step"`, `aria-pressed` (favorites, follow, chips, compare, save), `role="switch" aria-checked` (Toggle), `role="radiogroup"/"radio"` (mode chips, rating), `role="tablist"/"tab" aria-selected` (explore sort, auth mode) without `tabpanel`/roving tabindex, `role="search"`, `role="status" aria-live="polite"` (toasts, checkout banners), `role="alert"` (field/form errors), `role="note"`, `role="region" aria-label` (interpreted settings), `aria-expanded` (tray, tweaks), `aria-busy` (Button), `aria-hidden` on decorative icons/orbs/videos/avatars, `sr-only` labels for file inputs and the wish field, `<dt class="sr-only">` on template stats, `<legend class="sr-only">`.
- Dialogs: native `<dialog>` with `showModal()` gives focus trap, Esc, and focus return for free.
- Media: card videos are `muted` and `aria-hidden` with an `img alt=""` beneath (decorative); detail videos carry `aria-label`. No audio autoplay anywhere; autoplay previews are opt-in via a user preference (settings.tsx:135; page.tsx:25).
- Gaps (inference): `window.confirm`/`window.prompt` in projects.tsx:178,423 and admin.tsx:86 are native dialogs (accessible, but inconsistent with the Sheet pattern and bypass the cost-confirm Sheet); `RateStars` hover preview is mouse-only (keyboard users still get `aria-checked` state); sort/auth tabs lack arrow-key navigation; toasts cannot be dismissed early; `#discovery` anchor missing.

### 8.3 Responsiveness (verified)
- Switch point: `lg` (1024px). Below: top bar with wordmark, bottom tab bar, search hidden below `sm` (640) and replaced by the Explore page's own search form. Above: rail + top bar search.
- Grids: templates `2/3/4/5/6` columns at base/sm/md/xl/2xl; library same; projects `1/2/3`; train `2/3/4`; favorites creations `2/3/4/5`.
- Sheets become bottom sheets on `max-sm`.
- Tables (pricing ledger, creator analytics, audit log) use `overflow-x-auto` wrappers with `min-w` to avoid page-level sideways scroll.
- E2E (`tests/e2e/journey.spec.ts:129–147`) asserts `scrollWidth - innerWidth <= 0` at 390×844, 820×1180, 1440×960 on `/`, `/explore`, `/templates/velvet-hour`, `/pricing`, and screenshots each.

### 8.4 Status vocabulary (`src/lib/format.ts:55–63`)
`draft` → Draft, `awaiting_confirmation` → "Waiting for you", `queued` → Queued, `processing` → **"Weaving"**, `completed` → Ready, `failed` → Failed, `cancelled` → Cancelled. "Weaving" and "loom" metaphors recur in copy (job tray "{n} weaving", toasts, not-found "A loose thread", auth "corner of the loom").

---

## 9. Playbox resemblance check

Task asked to flag anything that looks like playbox.com. I did not fetch playbox.com; the comparison below uses plan.md's description of it ("neutral black with blue/pink", decisions section lines 70–80) and the spec's structural list.

**Verified differences in appearance**:
- Palette is aubergine-tinted blacks (`#0f0a0d` family, red-shifted, not neutral) with a single coral-orange accent, brass, sage, iris; no blue, no pink primaries.
- Type is a serif display (Fraunces, often italic) plus Manrope and JetBrains Mono; plan.md states Playbox uses neutral sans.
- Card shape is the asymmetric "petal" radius (20/5), not uniform rounded rectangles.
- Wordmark is a custom three-curve SVG + lowercase italic serif.
- Copy voice is warm second person with loom/weaving metaphors.

**Structural similarities that are intentional per the spec** (Playbox "informs structure and interaction patterns only"): template gallery with VIP/4K/New badges, Trending/New/Top rated/Most loved sorts, image/video entry points, favorites, Train, Collection/Library, creator pages, credit pricing. These are required by the spec (`spec.md` Part I and VI) and are not visual copies.

**Residual references to the word "playbox"** (verified by grep): only `src/server/env.ts:7` default `DATABASE_URL` is `postgres://playbox@localhost:5432/playbox`, plus the dev/test database names in plan.md. Nothing user-facing. The e2e test fixture template slug `velvet-hour` and seed data are original. No Playbox branding, logo, color or copy appears in `src/`.

**Not verified**: actual pixel comparison against playbox.com. If the owner wants certainty, a side-by-side screenshot review is still needed (plan.md remaining-work item 1).

---

## 10. Defects and gaps observed (UI scope only)

1. `motion` (12.43.0) is a dependency with zero imports — either use it or drop it (`package.json:35`). Spec Part VI lists "motion library"; currently satisfied by CSS only.
2. Undefined color utilities `text-bone-100` (settings.tsx:171, studio.tsx:85,295-ish, train.tsx:87, admin.tsx:58,79,108) and `text-sage-300` (pricing/page.tsx:44) — tokens `bone-100`/`sage-300` are not in `@theme`. Inference: styles silently absent.
3. Home "Tune" link targets `/settings#discovery` (page.tsx:64) but no element has `id="discovery"` in settings.tsx.
4. No `favicon`/`icon` file and no `public/` directory → browser requests `/favicon.ico` 404 on every page (inference; middleware matcher excludes it so no header injection, but the file does not exist).
5. No `loading.tsx` or `error.tsx` anywhere; all pages `force-dynamic` → blank wait on navigation, Next default error page on server throw.
6. Three places use native `window.confirm`/`window.prompt` instead of the `Sheet` (projects.tsx:178 cost confirm for branch/continue, projects.tsx:423 remove scene, admin.tsx:86 suspend reason). The branch/continue path therefore bypasses the designed cost-confirmation Sheet.
7. `CreationThumb` inline Retry (library.tsx:23–36) drafts and confirms in one go; the user sees the cost only in the toast afterwards. Spec Part V requires confirming chargeable ops before execution.
8. `--breakpoint-xs` (420px) and `--color-ink-600` are defined but unused.
9. `ExploreFeed.loadMore` has no catch; a network error leaves no user feedback.
10. Sort/auth "tabs" use `role="tab"` without `tabpanel` or arrow-key support.
11. Admin `ModelTable` row wraps poorly at narrow widths (reported in plan.md:120–121; not re-verified by me).
12. Dark-only: no light theme and `color-scheme: dark` is fixed. Acceptable per spec ("dark immersive presentation"), noted for completeness.
13. Design tokens for type scale and spacing are not centralized (inline `text-[13px]` etc.), which the spec's design-system deliverable (Part XIV B) asks to document; the CSS file's own comment claims "every … font in the UI comes from here", which is true for families but not sizes.
