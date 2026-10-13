# Hushloom spec audit — UX quality (Parts IV, X, XI, XIII, XVI)

Repository: `/home/claude/hushloom`, branch `claude/playbox-2-foundation-q7fpbs`, HEAD `9acac2e`. The last commit touching `src/` or `tests/` is `0987b7c`; the three commits after it change only `notes/`, `package-lock.json` and `.gitignore` (verified with `git log --oneline`). Read-only audit; nothing was run or modified. Spec: `/tmp/.../ctx/spec.md`.

How to read this document:
- **Verified** means I read the code or looked at an artifact in the repo (file:line, screenshot, test).
- **Inferred** means I reasoned from the code without executing it; those lines are marked *(inferred)*.
- Status values: **met**, **partial**, **missing**, **demo-only**.
- Generation being a labeled demo is expected (no AI credentials exist) and is not counted as a gap. Anything that would show demo or seeded material *as if real* is a defect and is listed under "Demo honesty".

Baseline evidence of health (not re-run by me): `notes/state.json` records typecheck/lint/vitest 79/79/build/e2e 8/8 all passing at `0987b7c`; `test-results/.last-run.json` says `"status": "passed"`. The e2e screenshots used below were produced by that run (`tests/e2e/journey.spec.ts:129-147`).

---

## 1. Part IV — Visual design and interaction

### 1.1 Design system with centralized tokens

| Requirement | Status | Evidence |
|---|---|---|
| Background / surface tokens | met | `src/app/globals.css:11-16` `--color-ink-950…600`; `body` background `:75`; `color-scheme: dark` `:68` |
| Text tokens | met | `globals.css:17-21` `--color-bone-50…500` |
| Border tokens | met | `globals.css:69-70` `--line`, `--line-strong` (color-mix of bone-50); `.hairline` `:101-103` |
| Accent tokens | met | `globals.css:22-32` ember (accent), brass (VIP), sage (new/success), iris (demo), danger |
| Radius tokens | partial | `--radius-petal: 20px`, `--radius-pin: 5px` `:38-39`, `.petal` `:97-99`. The panel shape `rounded-[24px_8px_24px_8px]` is a literal repeated in `src/app/page.tsx:30`, `templates/[id]/page.tsx:110`, `generate/[kind]/page.tsx:87`, `studio/page.tsx:50`, `admin/page.tsx:22`, `settings.tsx:28`, `pricing/page.tsx:59`, `projects.tsx:278,303,434`; `rounded-xl`/`rounded-2xl` are Tailwind defaults, not a Hushloom token |
| Spacing tokens | partial | Tailwind's default scale throughout; no project spacing tokens and no documented scale |
| Typography tokens | partial | Families tokenized `globals.css:34-36` (Fraunces/Manrope/JetBrains Mono, self-hosted via `@fontsource-variable`, `:2-4`). Sizes are not: 14 distinct arbitrary values (`text-[13px]` ×63, `text-[12.5px]` ×18, `text-[11px]` ×18, `text-[12px]` ×11, `text-[15px]` ×7, `text-[13.5px]` ×4, `text-[11.5px]` ×4, `text-[14px]` ×3, `text-[14.5px]` ×3, plus 34/26/22/17/10.5px once each; counted with grep over `src/components` and `src/app`) |
| Elevation tokens | missing | No shadow/elevation tokens. Ad-hoc Tailwind shadows: `shadow-2xl shadow-black/50` (`ui.tsx:184`), `shadow-2xl shadow-black/60` (`job-tray.tsx:88`), `shadow-lg shadow-ember-700/30` (`shell.tsx:193`) |
| Motion durations | met | `globals.css:42-44` `--duration-quick/base/slow` = 140/220/360 ms; used via `duration-[var(--duration-base)]` in `ui.tsx:37,77,121,123`, `template-card.tsx:63,82,125`, `projects.tsx:78` |
| Curves | met | `--ease-weave: cubic-bezier(0.2, 0.8, 0.2, 1)` `globals.css:41`; keyframes `thread/rise/pop` `:52-64` |
| Breakpoints | partial | Tailwind defaults (`sm/md/lg/xl/2xl`) used consistently; the one custom token `--breakpoint-xs: 420px` (`globals.css:46`) is never used (`grep "xs:"` over components/app returns nothing) |
| "Document assumed values" | missing | The only documentation is the 3-line comment at `globals.css:6-9`. There is no `docs/` directory and no README (`ls docs README*` fails). `notes/plan.md:71-80` records the palette rationale, but that is a handover note, not a design-system document |
| Components never hardcode colors (the file's own claim, `globals.css:7-8`) | partial | True for hex: the only hex in TSX is `viewport.themeColor: "#0f0a0d"` (`src/app/layout.tsx:16`), a duplicate of `--color-ink-950`. But two referenced shades do not exist in `@theme`: `text-bone-100` (`studio.tsx:27,85`, `train.tsx:87`, `settings.tsx:170`, `admin.tsx:58,108`) and `text-sage-300` (`pricing/page.tsx:44`). In Tailwind 4 an undefined shade generates no CSS, so those elements silently inherit the parent color *(inferred from Tailwind 4 behavior; the classes are verified)* |

### 1.2 Alive interface

| Requirement | Status | Evidence |
|---|---|---|
| Hover/touch previews | met | Card: hover or focus plays the muted preview (`template-card.tsx:56-62`, `:26-35`); explicit Preview/Pause button for touch on video cards (`:110-119`); detail page Play/Pause button (`template-detail.tsx:35-44`). Library video thumbs hover-play only (`library.tsx:62-63`); touch users get the poster and the detail page with `controls` (`creation-detail.tsx:46`) |
| Card transitions | met | Hover lift `group-hover:-translate-y-1` with token duration/easing (`template-card.tsx:63`); mount `animate-rise` (`:57`, `library.tsx:39`); project cover scale (`projects.tsx:78`) |
| Skeletons | partial | `.skeleton` shimmer (`globals.css:112-123`), `Skeleton`/`GridSkeleton` components (`ui.tsx:204`, `template-card.tsx:173-185`) used for infinite-scroll "load more" (`explore-feed.tsx:144-148`), missing posters (`template-card.tsx:70`), running creations (`library.tsx:70-78`, `creation-detail.tsx:36`). **No route-level loading state exists**: `find src/app -name loading.tsx` returns nothing and all 16 pages are `force-dynamic`, so a navigation to `/explore`, `/collection`, `/templates/[slug]` shows the previous page until the server response arrives *(inferred from Next.js App Router behavior)* |
| Button states | met | `Button` busy spinner + `aria-busy` + disabled while busy (`ui.tsx:43-52`); `disabled:opacity-45 disabled:pointer-events-none` (`:37`); hover/active per variant (`:22-28`); global `:focus-visible` ring (`globals.css:91-94`) |
| Favorite animations | met | Heart `animate-pop` on save, optimistic count update with rollback and error toast (`template-card.tsx:37-53, 95-107`) |
| Toasts | met | `ToastProvider` (`ui.tsx:166-202`): polite live region (`:179`), 5 s auto-dismiss (`:174`), max 4 kept (`:173`), optional action link; success/error tones |
| Drawer transitions | partial | `Sheet` is a native `<dialog>` with `showModal()` (`ui.tsx:130-162`), opens with `open:animate-rise` (`:149`), becomes a bottom sheet under `sm` (`:148`). No close animation (`d.close()` is immediate, `:136`) |
| Generation progress feedback | met | JobTray indeterminate thread bar + status label + elapsed time (`job-tray.tsx:91-110`); Library running tile with elapsed (`library.tsx:70-78`); detail "Weaving · Ns elapsed" (`creation-detail.tsx:36-41`). No percentages anywhere (grep for `%` in these components shows only the admin stat) |
| Gallery-to-detail transitions | missing | Plain `<Link>` navigation (`template-card.tsx:64`); no View Transitions API, no shared-element or crossfade |
| Subtle confirmations | met | Success toasts with a sage dot (`ui.tsx:188`), "Saved"/"Following" pressed states with `aria-pressed` (`creation-detail.tsx:255`, `template-detail.tsx:58`) |
| Animations communicate state | met | Thread bar renders only while jobs are active (`job-tray.tsx:83`); `animate-pulse` dot only for `processing` (`:104`, `studio.tsx:80`) |
| Honor reduced motion | met | `@media (prefers-reduced-motion: reduce)` forces 1 ms animations/transitions globally (`globals.css:132-141`); this also covers Tailwind's `animate-spin`/`animate-pulse` |
| No autoplay audio | met | Every `<video>` is `muted` (`template-card.tsx:76`, `template-detail.tsx:20`, `library.tsx:57`, `creation-detail.tsx:46,312`, `projects.tsx:31`) except the project `SequencePlayer` (`projects.tsx:543`), which only plays after the user presses "Play sequence" (`:208`). Demo clips are encoded with `-an` (`demo.ts:137`), so there is no audio track in this build anyway. Card autoplay is off by default (`schema.ts:125`) and opt-in in Settings (`settings.tsx:134`) |
| Accessible alternatives for hover-only | met | Focus plays the preview (`template-card.tsx:60`); the "Make" overlay is revealed on `focus:` and is always visible below `lg` (`:125`); every icon-only control has `aria-label` (checked by the e2e unlabeled-control count, `journey.spec.ts:158-166`) |
| Content gets more attention than controls | partial | Desktop: yes (screenshot `test-results/.../desktop_.png`: hero ≈ 420 px, then a media grid). Mobile: the home hero card fills the first viewport and the first media row starts at y ≈ 650 of 844 (`mobile_.png`); on the mobile template page the cover fills the viewport but the Make panel is below the description/stats/tags (`mobile_templates_velvet-hour.png`; panel order `templates/[id]/page.tsx:60-131`) |

Accessibility notes that belong to Part IV (also relevant to XI):
- **Contrast (computed from token values, not measured in a browser):** `--color-bone-500 #85736f` on `--color-ink-950 #0f0a0d` is ≈ 4.4:1 and on `--color-ink-900 #160f13` ≈ 4.3:1, below WCAG AA 4.5:1 for normal text. `text-bone-500` is used 63 times, mostly at 10.5–13 px: `.tag` kickers (`shell.tsx:113`, `admin/page.tsx:13`), timestamps `font-mono text-[11px] text-bone-500` (`library.tsx:106`, `template-card.tsx:143`, `job-tray.tsx` uses bone-400), hints (`ui.tsx:98`), placeholders (`:105`). `bone-400 #a8958f` is ≈ 6.9:1 and fine.
- `Chip` always sets `aria-pressed` (`ui.tsx:75`); the mode picker overrides `role="radio"` + `aria-checked` on the same element (`create-panel.tsx:262`), so the radio carries an `aria-pressed` it must not have.
- `role="tablist"`/`role="tab"` on the Explore sort (`explore-feed.tsx:94-110`) and the auth mode switch (`auth-forms.tsx:55-70`) have no `tabpanel`, no roving `tabIndex`, no arrow-key handling. They work with Tab/Enter; the ARIA pattern is incomplete.
- `Sheet` labels the dialog with `aria-label={title}` (`ui.tsx:145`); fine. Focus trap, Escape and backdrop close come from the platform (`:135,141-144`).

---

## 2. Part X — Mobile and performance

| Requirement | Status | Evidence |
|---|---|---|
| Responsive columns | met | Grid `grid-cols-2 sm:3 md:4 xl:5 2xl:6` (`template-card.tsx:153`, `library.tsx:267`); rails `w-[42vw] max-w-[220px]` (`template-card.tsx:165`); e2e asserts no horizontal overflow at 390/820/1440 on `/`, `/explore`, `/templates/velvet-hour`, `/pricing` (`journey.spec.ts:129-147`) |
| Touch cards | met | "Make" always visible below `lg` (`template-card.tsx:125`), heart 36 px (`:100`), Preview button present on video cards (`:110-119`) |
| Swipeable previews | partial | Rails are `snap-x snap-mandatory` horizontal scrollers (`template-card.tsx:163`); the version strip scrolls (`creation-detail.tsx:298`). There is no swipe between media in the detail view or between versions |
| Responsive nav | partial | Desktop rail (`shell.tsx:108-154`) + mobile tab bar Discover / Search / + / Library / You (`:189-199`). **Not in the mobile nav:** Projects (reachable only via the Library "Projects" button `library.tsx:208`), Studio (only via the Tweak panel link `create-panel.tsx:631`), Train (only from the character field when a reference mode is selected `create-panel.tsx:336`), Favorites (no mobile entry point at all; `grep href="/favorites"` finds only `shell.tsx:35`, which is `hidden lg:flex`). Admin is reachable only via the desktop rail icon (`shell.tsx:125`) |
| Compact controls | met, with small targets | Chips and selects are 32 px tall (`ui.tsx:30,77`; `library.tsx:230-257`; `page.tsx:50`; `favorites/page.tsx:65`); Preview button 28 px (`template-card.tsx:114`); scene reorder 28 px (`projects.tsx:240-243`); preset delete 28 px (`studio.tsx:35`). Primary CTAs are 40–48 px (`ui.tsx:31-32`). *(Inferred: 28–32 px is below the common 44 px touch guideline; there is no `min-h` bump on touch widths.)* |
| Persistent status access | met | `JobTray` fixed above the tab bar (`job-tray.tsx:88`), rendered for signed-in users on every page (`shell.tsx:186`); Studio has a Job monitor (`studio.tsx:56-114`) |
| Mobile uploads | met | `<input type="file" accept="image/jpeg,image/png,image/webp">` (`create-panel.tsx:304-318`), consent sheet before upload (`:679-698`), server re-encodes and strips EXIF (`media.ts:66`). Video upload from the panel is intentionally not offered (`create-panel.tsx:290-293`) even though `acceptUpload` accepts MP4 (`media.ts:49-54`) |
| Accessible dialogs/sheets | met | Native `<dialog>`/`showModal`, Close button labelled, bottom-sheet on phones (`ui.tsx:130-162`) |
| Efficient streaming | partial | `/api/media` reads the **entire** file into memory per request (`storage().get(key)` → `readFile`, `media/route.ts:28`, `storage/index.ts:51-53`) and then slices for `Range` (`:32-43`). Range support is correct and tested (`platform.test.ts:296-322`), but a 100 MB upload (`media.ts:27`) is read whole for every seek *(inferred cost)* |
| Adaptive images | partial | Plain `<img>` with signed URLs, `loading="lazy" decoding="async"` on cards (`template-card.tsx:68`), `loading="lazy"` in Library (`library.tsx:67`) and project covers (`projects.tsx:34`). No `srcset`/`sizes` anywhere (grep: none), no `next/image` (deliberate: signed URLs, `template-card.tsx:67`). Seeded posters are one 900 px-long-side WebP (`seed.ts:149-154, 220-222`) served at every column width |
| Clear downloads | met | Download button only when `completed` (`creation-detail.tsx:258-262`); route redirects to a signed URL with `Content-Disposition: attachment` and filename `hushloom-<id8>[-demo].webp|mp4` (`generations/[id]/download/route.ts:20-23`, `media/route.ts:30`) |
| Optimize initial render | partial | Every page is `force-dynamic` (16 files); home awaits 7 queries in parallel (`page.tsx:16-24`) then signs one HMAC per poster/preview (`discovery/templates.ts:105-106`, cheap). No `Suspense`/streaming and no `loading.tsx`, so first paint waits for the whole RSC payload *(inferred)* |
| Video previews | met | `preload="none"` on cards (`template-card.tsx:79`), poster frames for clips (`library.tsx:56,60`, `projects.tsx:31`), `preload="metadata"` where a poster may be absent |
| Route transitions | partial | `next/link` default prefetch; no `loading.tsx`; no transition animation |
| Bundle | met | Route chunks 4–20 KB raw (`.next/static/chunks/app/**`, largest `collection/[id]` 20.2 KB, `explore` 19.4 KB); shared `framework` 190 KB, two ~174 KB vendor chunks, `main` 129 KB, `polyfills` 113 KB (raw bytes, `ls -S .next/static/chunks`). `motion@12.43.0` is declared in `package.json` but never imported (`grep "from \"motion"` → none), so it is not bundled; it is a dead dependency. Fonts: 15 `woff2` subsets totalling 243 KB on disk; `@fontsource-variable` uses `unicode-range`, so browsers fetch only needed subsets *(inferred)* |
| Polling | partial | JobTray polls `/api/generations?active=1` every 3 s, 15 s when hidden — but `document.hidden` is read once when the interval is created (`job-tray.tsx:75`), so a tab backgrounded mid-job keeps the 3 s cadence until the job count changes. On `/studio`, `JobMonitor` additionally calls `router.refresh()` every 3 s (`studio.tsx:61-68`), and on `/projects/[id]` the workspace refreshes every 4 s (`projects.tsx:139-143`), each re-running the whole server page while the tray also polls |
| Fetching | met | Explore infinite scroll with `IntersectionObserver` (`rootMargin: 600px`, `explore-feed.tsx:62-68`) plus a visible "Load more" fallback (`:149-155`); de-duplication of pages (`:55`) |
| Caching | met | `/api/media` sends `Cache-Control: private, max-age=<remaining ttl>` (`media/route.ts:27`); signed URLs are aligned to the TTL window so they stay identical within a window (`storage/index.ts:59-60`), which makes browser caching effective; private TTL `MEDIA_URL_TTL_S` default 300 s, public 3600 s (`env.ts:11`, `media.ts:16`) |
| Avoid autoplay | met | Off by default (`schema.ts:125`); only `TemplateGrid` on home honours the opt-in (`page.tsx:25,90`) |
| Avoid heavy background work | met | All pollers stop when nothing is running (`job-tray.tsx:74`, `studio.tsx:62`, `projects.tsx:140`) |

Mobile layout note *(inferred from CSS, not screenshot)*: toasts are centered at `bottom-24` (`ui.tsx:179`) and the JobTray is right-anchored at `bottom-20` with width `min(340px, 100vw-24px)` (`job-tray.tsx:88`). On a 390 px phone both occupy almost the full width at the same height, so the "Weaving a demo placeholder" toast (`create-panel.tsx:231`) covers the tray header for 5 s right after confirm, which also opens the tray (`job-tray.tsx:65-68`).

---

## 3. Part XI — Quality, testing, security (UX-relevant subset)

### 3.1 "Every important action has a defined outcome; no dead buttons"

| Check | Status | Evidence |
|---|---|---|
| Buttons wired to real endpoints | met | Every `Button`/`ButtonLink` in `components/*.tsx` calls `api(...)` or navigates; none is a no-op. The admin page uses `window.prompt`/`window.confirm` (`admin.tsx:86`, `projects.tsx:178,423`) — functional but inconsistent with `Sheet` |
| Error feedback on failure | partial | Most handlers catch `ApiError` and toast. Exceptions with **no catch** (a failure becomes an unhandled rejection with no UI): `cancel()` `creation-detail.tsx:122-131`; `FollowButton` `template-detail.tsx:59-68`; `FolderSheet.add` and its new-folder submit `creation-detail.tsx:368-373, 385-391`; the Library new-folder submit's `api("/api/folders")` call `library.tsx:294-302` |
| Disabled states explain themselves | met | Make it disabled while blocked/short/locked/needs input (`create-panel.tsx:651`) with the reason shown inline (block suggestion, VIP banner `:250-256`, "Get credits" `:663-668`); Buy button carries a `title` when payments are unconfigured (`pricing.tsx:20`) and the page says why (`pricing/page.tsx:52-56`); model select shows `(Needs credentials)` (`create-panel.tsx:509-511`, `providers/index.ts:40`) |
| Edge: video card without a preview clip | low | The Preview button renders disabled with a "5s" label when `previewUrl` is null (`template-card.tsx:110-119`). User-published clips always get a preview (`publish.ts:112`); only a seeded template whose ffmpeg step failed (`seed.ts:176`) would hit this |
| Route-level error boundary | missing | No `error.tsx` / `global-error.tsx` (`find src/app -name error.tsx` → none); an uncaught server error renders Next's default error page outside the shell *(inferred)*. API routes do have a uniform error shape (`http.ts:46-73`) and map bad UUIDs to 404 (`:75-81`) |

### 3.2 Test coverage against the spec's list

Test inventory (verified): unit `tests/unit/{policy,copilot,registry,signatures}.test.ts`; integration `tests/integration/{generation,platform}.test.ts`; e2e `tests/e2e/journey.spec.ts` (8 specs on the production standalone build with a real worker, `playwright.config.ts:31-48`).

| Spec item | Status | Evidence |
|---|---|---|
| auth | met | e2e signup/signin/under-18 (`journey.spec.ts:17-27, 107-127`); `registerUser`/`deleteAccount` (`platform.test.ts:254-282`) |
| browsing | met | e2e layouts on `/`, `/explore`, template page (`:129-147`); template open (`:53-55`) |
| search | partial | e2e navigates to `/explore?q=velvet` and clicks the result (`:53-54`); no assertion on result sets; no unit/integration test of `browseTemplates` with `q` |
| filters | missing | No test exercises category/media/sort on Explore or status/model/folder/favorites on Library |
| favorites | missing | No test calls `POST/DELETE /api/favorites` or toggles the heart; `platform.test.ts:247` inserts a favorite row directly only to test For You |
| template opening | met | e2e (`:54-56`) |
| generation forms | met | e2e cost line, confirm sheet text, demo notice, blocked prompt disables Make (`:56-61, 116-127`) |
| validation | met | `unsupported_settings`, `input_required`, `model_unavailable` (`generation.test.ts:202-209`); registry unit (`registry.test.ts`) |
| uploads | partial | `acceptUpload` exercised through consent/publish tests (`platform.test.ts:136, 193`); no test of size/MIME rejection (`media.ts:50-65`) and no UI upload test, although `data-testid="upload-input"`/`consent-checkbox` exist (`create-panel.tsx:309, 683`) |
| job creation, queue, completion/failure | met | Full pipeline incl. retries, timeouts, dead-worker reconcile (`generation.test.ts:63-192`); e2e waits for the worker to reach Ready (`journey.spec.ts:64-69`) |
| credits | met | Reserve/settle/release and no double charge (`generation.test.ts:63-97`); admin idempotency (`platform.test.ts:283-292`) |
| webhooks | met | Stripe dedupe, forged signature, unpaid, out-of-order (`platform.test.ts:74-131`); Replicate signature (`signatures.test.ts:21-38`) |
| collection | met | e2e Library shows real state and the Demo badge (`journey.spec.ts:64-70`) |
| download | missing | No test of `/api/generations/[id]/download` or the `d=` disposition path |
| deletion | met (server) | `deleteJob` (`platform.test.ts:234-237`), account deletion (`:265-281`); no UI test of Library bulk delete |
| publishing | met (server) | Public copy, original private, personal-media refusal, cross-user refusal (`platform.test.ts:177-203`); no UI test |
| private access | met | e2e cross-user 404s, forged media 403, cross-origin 403 (`journey.spec.ts:84-105`); integration (`generation.test.ts:220-230`) |
| responsive layouts | partial | Overflow check only, anonymous only, 4 pages (`journey.spec.ts:129-147`). Signed-in pages (`/collection`, `/projects/[id]`, `/studio`, `/settings`, `/admin`) are not covered; `notes/plan.md:120-122` already records that the admin model row wraps at narrow widths |
| keyboard a11y | partial | Skip link focus + no unlabeled visible controls on `/explore` (`journey.spec.ts:149-167`); no dialog focus/Escape test, no axe run, no contrast check |
| consent | met | Upload-consent cascade, character removal, cross-user (`platform.test.ts:133-175`); e2e under-18 refusal |
| unit + integration + e2e | met | `vitest.config.ts`, `playwright.config.ts` |
| failure cases | met | retryable/fatal/timeout/hang/dead-worker (`generation.test.ts:126-192`) |
| cross-user URL manipulation blocked | met | above |
| retries never double-charge | met | `generation.test.ts:82-88, 141-153` |
| cancelled/failed reach terminal states | met | `generation.test.ts:114-140, 155-165` |
| mobile/tablet/desktop checks | partial | see responsive |
| resolve critical defects before complete | met at `0987b7c` | `notes/state.json` checks; `.last-run.json` passed |

Tooling: `tsconfig.json` has `strict` + `noUncheckedIndexedAccess`; ESLint is `next/core-web-vitals` + `next/typescript` (`eslint.config.mjs`), which brings only Next's small jsx-a11y subset; no `eslint-plugin-jsx-a11y` full ruleset.

---

## 4. Part XIII — Creative constitution

| Keep | Status | Evidence |
|---|---|---|
| 1 Media-first gallery | met (desktop) / partial (mobile) | Home: hero then "Trending tonight" grid (`page.tsx:79-91`); Explore is a grid (`explore-feed.tsx:141`). Mobile first viewport is the hero (`mobile_.png`) |
| 2 Template-driven discovery | met | Every card → `/templates/[slug]` with Make (`template-card.tsx:64,124`); sections For you / Continue exploring / Trending / Following / New (`page.tsx:57-110`); Similar on detail (`templates/[id]/page.tsx:152-157`) |
| 3 Fast simple generation | met | Template → "Make it" → confirm sheet → done; defaults preserved (`create-panel.tsx:72-76`); proven by e2e (`journey.spec.ts:53-61`) |
| 4 Dark immersive presentation | met | `color-scheme: dark`, ink palette, warm radial glow (`globals.css:67-85`); screenshots |
| 5 Adult entertainment identity | met | Age gate (`age-gate.tsx`), copy "After dark, made by you" (`page.tsx:33`), seeded categories Boudoir/Nightlife/Glamour… (`seed.ts:47-57`) |
| 6 Community exploration | met | Creator pages with follow, collections, published grid (`creators/[id]/page.tsx`); ratings and reports (`template-detail.tsx:76-173`); Following rail (`page.tsx:92-98`) |
| 7 Compact interaction patterns | met | Chips, rails, badges, inline cost line |
| 8 Core navigation concepts | met | Discover / Create / Library / Train primary; Projects / Studio / Favorites under "Go deeper" (`shell.tsx:26-36`); Explore tabs Trending / New / Top rated / Most loved (`explore-feed.tsx:11-16`) |
| 9 Clear template previews | met | Poster + hover/focus/tap preview + duration badge; VIP/4K/New badges (`template-card.tsx:89-93`) |
| 10 Optional experimentation | met | Tweak collapsed by default outside Studio (`create-panel.tsx:92`); Studio is a separate room (`studio/page.tsx`); Interpret is optional (`create-panel.tsx:413-487`) |

| Never | Status | Evidence |
|---|---|---|
| Replace gallery with dashboard | met | Admin is a separate route that 404s for non-admins (`admin/page.tsx:32`); home stays a gallery |
| Mandatory chatbot | met | No chat; inline suggestions that never auto-apply (`copilot.ts:1-4`, `create-panel.tsx:376-410`), Undo/Restore (`:119-141`), switchable to block-only (`:112`, `settings.tsx:135-140`) |
| Force beginners into advanced panels | met | see Keep 10 |
| Bury features | partial | On phones, Projects/Studio/Train/Favorites are outside the nav (see Part X "Responsive nav"); Favorites is unreachable from any mobile control |
| Excessive animation | met | Three keyframes, token durations ≤ 360 ms, reduced-motion override |
| Monetization interrupting browsing | met | No interstitials; VIP lock appears only inside the panel of a VIP template (`create-panel.tsx:250-256`); credit pill/Pricing links are passive (`shell.tsx:38-53,147`) |
| Sacrifice privacy/consent/accessibility/reliability | met | Private by default and signed URLs (`media.ts:13-18`); consent recorded before upload (`uploads/route.ts:15`); history toggle clears data (`me.ts:79`); `X-Robots-Tag: noindex` sitewide (`next.config.ts:9`, `layout.tsx:12`) |

---

## 5. Part XVI — Acceptance from three perspectives

| Perspective | Status | Evidence |
|---|---|---|
| Returning user: recognizable structure, browse and generate without learning | met | Familiar Explore sorts, VIP/4K badges, heart, "Make" on cards; a signed-in member needs two taps and a confirm from any card (`#make` anchor `template-card.tsx:124` → panel `create-panel.tsx:248`) |
| New user: understands the platform in seconds | met | Hero copy states the loop and privacy (`page.tsx:33-39`); age gate states what the site is and that it is a notice, not verification (`age-gate.tsx:18-21, 39-44`) |
| New user: previews without friction | met | Anonymous visitors (after the age cookie, `layout.tsx:28-30`) see public posters/previews because `assetUrl` allows public assets with `viewerId = null` (`media.ts:15`); hover/tap previews work signed out |
| New user: auth, costs, policies understandable | met, one layout caveat | Cost line visible signed out (`create-panel.tsx:657-671`); signup explains DOB and the two attestations (`auth-forms.tsx:95-113`); `/policies` in plain language with the demo section (`policies/page.tsx:76-84`). Caveat: on a 390 px phone the Make panel on a template page is below the fold (`mobile_templates_velvet-hour.png`) |
| Advanced creator: settings, variations, continuations, project histories, reusable workflows | met | Studio exposes seed/negative/atmosphere/project/scene (`create-panel.tsx:594-629`); derive Retry/Variation/Continue/Extend with cost confirm (`creation-detail.tsx:82-111, 231-279`); lineage comparison (`:293-322`, `views.ts:130-149`); presets (`creation-detail.tsx:405-438`, `studio.tsx:13-53`); project timeline with branches, takes, side-by-side compare and sequence playback (`projects.tsx:219-366`) |
| Advanced creator: returns to a project without losing context | partial | Scenes, continuity guide, takes and selection persist server-side (`projects.ts`, tested `platform.test.ts:325-353`). But the active scene is client state initialised to the first scene (`projects.tsx:129-131`) and not in the URL; after "Make a clip" from a scene the user lands on `/generate/video?scene=…` (`:268-273`) and, after confirming, stays there with a toast whose only action is "Library" (`create-panel.tsx:231`). Returning to the project reopens on scene 1 |

---

## 6. Demo honesty (the rule: a demo must never read as real)

**Verified labels that are present and consistent**
- Model names: "Demo Still (not AI)", "Demo Motion (not AI)" (`registry.ts:82,96`) with notes "no AI model is called" (`:91,106`); the Replicate model says "Requires REPLICATE_API_TOKEN" (`:120-121`) and renders disabled as `(Needs credentials)` (`providers/index.ts:40`, `create-panel.tsx:509-511`).
- Before paying: "DEMO MODEL" badge beside Make it (`create-panel.tsx:672-676`, visible in `desktop_templates_velvet-hour.png`); confirm sheet "You will get a labeled placeholder made locally, not an AI-generated result" (`:717-722`, asserted by e2e `journey.spec.ts:59`); derive sheet (`creation-detail.tsx:332`); project `window.confirm` text (`projects.tsx:178`).
- After: toast "Weaving a demo placeholder." (`create-panel.tsx:231`), tray " · demo" (`job-tray.tsx:109`), Library "Demo" badge (`library.tsx:89`, asserted `journey.spec.ts:70`), detail banner + badge (`creation-detail.tsx:187-198`), download filename `-demo` (`download/route.ts:21`), pixel watermark "DEMO OUTPUT · NOT AI-GENERATED" (`demo.ts:16,58-60`), admin "demo jobs" stat (`admin/page.tsx:44`), `/policies` "Demo models" section (`policies/page.tsx:76-84`), Train's "this build does not fine-tune a model" (`train.tsx:65-67`), Pricing "Prices below are placeholders" (`pricing/page.tsx:52-56`).
- `isDemo` is persisted on the job at draft time from the adapter (`service.ts:249`, `schema.ts:384`) and on the output (`processor.ts:212`, `schema.ts:428`), so the UI labels are data-driven, not inferred.

**Defects: places where demo or synthetic material reads as real**

D1. **Demo-origin template covers can appear with no demo marking.** `publishTemplate` copies the (watermarked) output as the public cover (`publish.ts:69-76, 111-112`) but records nothing about demo origin on the template; `TemplateCard` has no demo field (`discovery/templates.ts:17-38`). The only in-pixel label is a band at the **bottom 9 %** of the image (`demo.ts:46, 58-60`). Cards and the detail hero crop the cover into 4:5 with `object-cover` (`template-card.tsx:65-68`, `template-detail.tsx:31`), which trims the top and bottom of taller images: a 9:16 output loses ≈ 15 % from each end and a 2:3 output ≈ 8 %, so the band is cropped away *(geometry inferred from the CSS; the crop classes are verified)*. The "DEMO MODEL" badge appears only inside the Create panel further down. Result: a published demo template with a 9:16 or 2:3 cover is presented on Explore/home/detail-hero as an unlabeled example output. Severity: medium. Effort: small.

D2. **Seeded templates carry fabricated usage.** `generation_count = abs(hashtext(slug)) % 400` (`seed.ts:274`) is rendered as "Made 294 times" on the template page (`templates/[id]/page.tsx:77`; visible in `desktop_templates_velvet-hour.png`), shown on creator pages as "Uses", and feeds the Trending score (`discovery/templates.ts:42-45`). The seeded covers are procedural abstract art (`seed.ts:122-147`, comment `:3`) with no "sample" marker anywhere in the UI; the seeded video previews are ffmpeg zoom-pans of the same art (`:166-181`). Favorites and ratings are real rows but from the six seed accounts (`:260-275`). This is development seed, and `notes/plan.md:40-41` treats `db:seed` as part of setup; nothing distinguishes seeded from member-published templates. Severity: medium. Effort: small.

No other misrepresentation was found: no fake progress percentages, no "AI" wording on demo outputs, no claim that Replicate/Stripe/S3 are live.

---

## 7. Ranked gaps and defects, with effort and proposals

Ranked by user impact. "Small" ≈ under half a day, "medium" ≈ 1–2 days, "large" ≈ more.

1. **Demo-origin template covers unlabeled on cards (D1)** — defect, medium impact, **small**. Proposal: add `templates.cover_is_demo boolean not null default false` (migration 0002), set it from `job.isDemo` in `publish.ts:96-116`, include `coverIsDemo` in `TemplateCard` (`discovery/templates.ts:91-115`) and render `<Badge tone="demo">Demo</Badge>` beside VIP/New (`template-card.tsx:89-93`) and in the detail badge row (`templates/[id]/page.tsx:49-59`). Independently, make the watermark crop-proof: draw a second, diagonal centered "DEMO OUTPUT" text in `demoSvg` (`demo.ts:48-62`).

2. **Seeded usage counts and unlabeled sample covers (D2)** — defect, medium impact, **small**. Proposal: in `seed.ts:269-275` set `generation_count = 0` (or `(select count(*) from generation_jobs where template_id = t.id and status = 'completed')`, which is what real traffic would produce) and tag seeded templates (`tags: [...s.tags, "sample"]` or a `is_sample` column) so the card shows a plain "Sample" badge; keep seeded favorites/ratings since they are real rows from named seed accounts.

3. **No route-level loading states** — gap (IV skeletons, X route transitions), medium impact, **small**. Proposal: add `src/app/explore/loading.tsx`, `src/app/loading.tsx`, `src/app/collection/loading.tsx`, `src/app/templates/[id]/loading.tsx` that render `GridSkeleton` (`template-card.tsx:173`) under the page heading; the shell already renders instantly because it lives in `layout.tsx`.

4. **Mobile navigation buries Projects/Studio/Train/Favorites** — gap (X responsive nav, XIII "bury features"), medium impact, **small**. Proposal: make the "You" tab open a small `Sheet` (or a `/me` page) listing Favorites, Projects, Studio, Train, Settings, Pricing, Policies (reuse `secondary` from `shell.tsx:32-36`); alternatively add a "More" row at the top of `/settings`. Add `/favorites` and `/projects` to the e2e layout list.

5. **Generate action below the fold on the mobile template page; hero-first mobile home** — gap (V "Generate visible", XIII media-first), medium impact, **small–medium**. Proposal (a): on `< lg`, render a sticky bottom bar above the tab bar with "Make it · N credits" that scrolls to `#make` (one component in `templates/[id]/page.tsx`); (b): on `< sm`, shorten the hero to kicker + headline + the two CTAs and move the category chips below the first rail (`page.tsx:30-55`), so a media row is visible at 390×844.

6. **Return-to-project context lost** — gap (XVI advanced creator), medium impact, **small**. Proposal: read/write the active scene via `?scene=` on `/projects/[id]` (`projects.tsx:129-131` → `useSearchParams` + `router.replace`); when `projectId` is set, make the post-confirm toast action "Open project" → `/projects/${projectId}?scene=${sceneId}` (`create-panel.tsx:231`) and the pending-derive toast likewise (`creation-detail.tsx:102`).

7. **`bone-500` secondary text below 4.5:1** — defect (IV/XI accessibility), medium impact for small text, **small**. Proposal: raise `--color-bone-500` to about `#91807b` (computed ≈ 5.1:1 on ink-950 and ink-900) or switch the 10.5–12 px usages (`.tag`, timestamps, hints) to `bone-400`; add an axe or contrast assertion to the e2e keyboard test (`journey.spec.ts:149`).

8. **Touch targets of 28–32 px** — gap (X compact controls vs touch), low–medium impact, **small**. Proposal: in `ui.tsx:30,77` add `max-sm:h-10` to `sm` buttons and `Chip`; give the Preview button (`template-card.tsx:114`), reorder arrows (`projects.tsx:240-243`) and preset delete (`studio.tsx:35`) `size-9` with the icon unchanged.

9. **Media route is not streaming** — gap (X efficient streaming), low–medium impact (matters once real clips exist), **medium**. Proposal: add `getStream(key, {start, end}) → ReadableStream` to `StorageDriver` (`storage/index.ts:8-14`; local via `createReadStream`, S3 via `Range` header on `GetObjectCommand`), and have `/api/media` (`media/route.ts:28-44`) return the stream with `Content-Length` from `asset.bytes`.

10. **Polling cadence and duplicated pollers** — defect/gap (X polling), low impact, **small**. Proposal: in `job-tray.tsx:73-81` listen to `visibilitychange` and re-arm the interval; on `/studio` and `/projects/[id]` subscribe to the tray's completion event instead of their own `router.refresh()` timers (`studio.tsx:61-68`, `projects.tsx:139-143`), e.g. dispatch a `hl:job-finished` event from `job-tray.tsx:57`.

11. **Silent failures on cancel/follow/folder** — defect (XI defined outcomes), low impact, **small**. Proposal: wrap `creation-detail.tsx:122-131`, `template-detail.tsx:59-68`, `creation-detail.tsx:368-391`, `library.tsx:294-302` in the same `try/catch → toast({tone:"error"})` the other handlers use.

12. **No `error.tsx`** — gap (XI), low impact, **small**. Proposal: `src/app/error.tsx` and `global-error.tsx` with the not-found page's styling (`not-found.tsx`) and a "Try again" button.

13. **Token integrity and documentation** — gap (IV "document assumed values"; undefined shades), low impact, **small (fix) / medium (doc)**. Proposal: define `--color-bone-100` and `--color-sage-300` in `globals.css` or replace the 7 usages with existing shades; tokenize the panel radius (`--radius-panel: 24px 8px 24px 8px` + `.panel` class) and shadows (`--shadow-float`, `--shadow-sheet`); delete the unused `--breakpoint-xs` or use it; drop `motion` from `package.json`; write `docs/design-system.md` (Deliverable B) listing every token with its value and intent, the type sizes actually in use, spacing conventions, component states, responsive rules and the motion/reduced-motion policy.

14. **Toast/JobTray overlap on phones** — defect, low impact, **small**. Proposal: when the tray is mounted, raise the toast container (`ui.tsx:179`) to `bottom-[calc(5rem+var(--tray-h))]` or render toasts top-center on `< lg`.

15. **ARIA pattern details** — defect, low impact, **small**. Proposal: in `Chip` (`ui.tsx:71-84`) only emit `aria-pressed` when no `role` prop is given; replace the two `role="tablist"` groups (`explore-feed.tsx:94-110`, `auth-forms.tsx:55-70`) with `role="radiogroup"`/`aria-checked` or implement roving `tabIndex` + arrow keys.

16. **Sheet close animation; native `confirm`/`prompt`** — gap (IV drawer transitions), low impact, **small**. Proposal: add a `closing` state that applies `animate-[rise_reverse]` for `--duration-quick` before `d.close()` (`ui.tsx:132-137`, honoured by the reduced-motion rule); replace `window.confirm` in `projects.tsx:178,423` with the `Pending`/delete `Sheet` pattern already used in `creation-detail.tsx:326-343`.

17. **Adaptive images** — gap (X), low impact now, **medium**. Proposal: at publish/seed time also write a 480 px-long-side WebP (`publish.ts:69-76`, `seed.ts:220-222`) stored as a second asset, expose `posterSmallUrl` in `TemplateCard`, and use `<img srcSet sizes>` in `template-card.tsx:68`.

18. **Test gaps** — gap (XI), low–medium impact, **medium**. Proposal: add integration tests for `browseTemplates` (q/category/media/sort), favorites toggle via the route handlers, `/api/generations/[id]/download` (302 + `Content-Disposition`), upload MIME/size rejections; extend the e2e layout loop with a signed-in context over `/collection`, `/projects/[id]`, `/studio`, `/settings`, `/admin`; add a dialog test (open Sheet → Escape closes, focus returns).

19. **Gallery-to-detail transition; swipe between media** — gap (IV, X), low impact, **medium**. Proposal: enable `experimental.viewTransition` in `next.config.ts` and give the card image and the detail hero the same `view-transition-name`; defer the swipe gallery.

20. **`SequencePlayer` not muted** — observation only. It is user-initiated and demo clips have no audio track (`demo.ts:137`); if a real provider returns audio, consider starting muted with a visible unmute control (`projects.tsx:543`).

---

## 8. Summary by part

- **Part IV:** Color, radius, motion and font-family tokens are real and consistently used; the reduced-motion policy, button/favorite/toast/skeleton states and the hover-with-focus-fallback pattern are met. Gaps: no type/spacing/elevation tokens and no design-system document, two undefined shades, no route-level skeletons, no gallery-to-detail transition, `bone-500` contrast.
- **Part X:** Responsive grid, tab bar, bottom sheets, poster frames, `preload="none"`, Range support, cache headers and opt-in autoplay are met. Gaps: buried routes on phones, small touch targets, whole-file media reads, no responsive image variants, no loading states, polling cadence.
- **Part XI:** Server-side behaviour is well tested (79 vitest + 8 e2e on the production build). UI-side gaps: favorites/filters/download untested, signed-in responsive views untested, a handful of handlers without error feedback, no `error.tsx`.
- **Part XIII:** The constitution is respected: media-first (desktop), template-driven, two-tap generation, dark, adult, community, compact, optional depth, no chatbot, no monetization interruptions. The one "never" at risk is "bury features", on phones only.
- **Part XVI:** Returning and new users are served; the advanced creator has every tool but loses the active scene when leaving and re-entering a project.
- **Demo honesty:** Labels are thorough and data-driven for everything a member makes. Two leaks: demo-origin template covers can lose their label through cropping, and seeded templates show invented "Made N times" counts with unlabeled sample art.
