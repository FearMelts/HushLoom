# Copilot prototype on `origin/main`: evidence notes

Source: `/home/claude/hushloom` at `origin/main` = `d2d6cad` ("Merge pull request #1 from FearMelts/copilot/transform-playbox-into-ai-playground", merged by Hamsa, 2026-10-12). The Copilot commits are `08a7a17` "Initial plan" (empty), `026080a` "Scaffold Playbox foundation" (package.json only) and `6d79f00` "Build Playbox discovery preview and docs" (+1109/-12 across 10 files). The remote branch `copilot/transform-playbox-into-ai-playground` still points at `6d79f00`.

How this was gathered. Files were read with `git ls-tree -r -l origin/main` and `git show origin/main:<path>`. Nothing in `/home/claude/hushloom` was modified or checked out, and its `git status` is clean. To check runtime behaviour, the blobs were copied with `git show` into `scratchpad/copilot-main-extract/` and run there:
- `npm test` and `node --check`, on Node v22.22.0
- the server on ports 48173 to 48175, probed with curl
- Playwright Chromium 1194 (headless), with scripts in `scratchpad/scripts/` and screenshots in `scratchpad/shots/`

Line numbers below are 1-indexed lines of the `origin/main` blob.

---

## 1. Files and sizes (`git ls-tree -r -l origin/main`)

| Path | Bytes | Lines | Role |
| --- | ---: | ---: | --- |
| `README.md` | 713 | 16 | Short run instructions and an honesty disclaimer |
| `docs/engineering.md` | 8,491 | 90 | Status, IA table, proposed architecture and API, "verification report" |
| `docs/playbox-2-vision.md` | 6,587 | 76 | Product vision, design tokens, journey, phases |
| `index.html` | 7,746 | 133 | Static shell: header, welcome, sidebar, gallery, footer, `<dialog>`, toast |
| `package.json` | 274 | 12 | `start` and `test` scripts; no dependencies |
| `server.mjs` | 2,056 | 53 | Static file server with an allowlist of 4 files |
| `src/app.js` | 10,812 | 273 | All client behaviour (render, filters, dialog, localStorage) |
| `src/catalog.js` | 4,271 | 130 | 8 hard-coded templates plus the `filterTemplates()` pure function |
| `styles.css` | 25,499 | 293 | All styling, including CSS-gradient "artwork" for each template |
| `test/catalog.test.js` | 1,589 | 39 | 5 `node:test` tests of `catalog.js` only |

Total: 10 files, 67,948 bytes. The repo has no images, video, fonts, lockfile, `.gitignore`, CI config, `.env` or Dockerfile.

---

## 2. What `index.html` renders

Everything is static markup. The only dynamic parts are the template grid, counts, headings and the dialog fields, which `src/app.js` fills at runtime. The head loads `/styles.css` (L9) and `<script type="module" src="/src/app.js">` (L10). The page title is "Playbox — make a little magic" (L8).

### Sections, in DOM order
1. **Skip link**: "Skip to templates", pointing at `#main` (L13).
2. **Top bar** (`header.topbar`, L14-32):
   - "playbox." brand linking to `#explore` (L15-18)
   - Nav with **Explore** (`#explore`) and **Collection** (`#collection`), via `data-view-link` (L19-22)
   - Search `<input id="search" type="search">` with a `/` kbd hint (L24-29)
   - Avatar button "Y" (L30). It has no click handler. Its aria-label and title say sign-in is not available or not connected.
3. **Welcome hero** (`section#welcome`, L35-46). Eyebrow "YOUR CREATIVE PLAYGROUND", h1 "A little inspiration. A lot of possibility.", subtitle, and a decorative "Curiosity looks good on you" note. Hidden in Collection view (app.js L85).
4. **Workspace** (L48-90):
   - **Side nav** (`aside.side-nav`, L49-62). Six `data-category` buttons: For you, All templates, Images, Videos, Recently viewed, Saved (with a `#saved-count` badge), plus a static "Good ideas like company" note.
   - **Gallery** (`section.gallery`, L64-89):
     - Kicker and h2, rewritten by app.js (L67-68)
     - "Clear history" button, hidden by default (L71)
     - `#result-count`, `aria-live="polite"` (L72)
     - **Mobile chip strip** (L75-81): For you, All templates, Images, Videos, Saved. There is **no Recently viewed chip**.
     - `#template-grid`, `aria-live="polite"` (L82)
     - Empty state with a "Back to exploring" button (L83-88)
5. **Footer** (L93-96): "Made for curiosity" and "Playbox preview · Generation and accounts are not connected".
6. **Template `<dialog id="template-dialog">`** (L98-129):
   - Close button "×" (L99), art panel (L100), kicker, h2 and description (L102-104)
   - Hard-coded creator line "Playbox picks" plus `#dialog-type` (L105)
   - `<textarea id="prompt" maxlength="500">` (L107)
   - `<details>` "Make it more yours · OPTIONAL" (L108-124), containing:
     - Frame shape `<select>`: template / portrait / square / landscape (L111-117)
     - Motion range 1-3 (L120-121)
     - A note: "saved on this device… No model has validated or received them" (L123)
   - "Start creating ↗" button (L125)
   - `#generation-notice` status, hidden (L126)
   - Privacy note: "Nothing is uploaded or generated in this preview" (L127)
7. **Toast** `#toast` with `role="status"` and `aria-live="polite"` (L131).

### Data is hard-coded
- The catalog is a literal array of **8 templates** in `src/catalog.js` L1-106:
  - Images: moon-motel, soft-focus, petal-study, little-worlds
  - Videos: cloud-nine, after-hours, velvet-sky, slow-bloom
- Each template has these fields: `id, title, creator ("Playbox picks"), category, media, duration ("5 sec"/"8 sec"/null), palette, description, prompt, aspectRatio, intensity`.
- There is **no real media**. The "artwork" for every card is CSS gradients and positioned spans, one `.art-<palette>` rule set per template (`styles.css` L154-185).
- The "Video" templates contain no video. Only the duration label (`app.js` L102-104) marks them as video.
- No data is fetched. `app.js` contains no `fetch`, XHR, WebSocket, `sendBeacon` or EventSource; grep found only `localStorage` at L27 and L36. In the browser run, the only network requests were the 4 local assets plus Google Fonts (`fonts.googleapis.com` and two `fonts.gstatic.com` woff2 files).

### Interactions (`src/app.js`)

| Interaction | Code | Observed in Chromium |
| --- | --- | --- |
| Category filter (side links and chips) | `selectCategory` L174-179; listeners L197-199. Sets `view="explore"` and `replaceState('#explore')`. | Videos showed 4, Images showed 4, All showed 8 |
| "For you" vs "All templates" | `filterTemplates` returns `true` for any category that is not Images, Videos, Saved or Recently viewed (`catalog.js` L117-122) | Both show the same 8 cards in the same order, so "For you" is not personalized |
| Search | input listener L209-212. Matches title, creator, category and description, case-insensitive (`catalog.js` L114, L126-129). It does **not** search the prompt. | "moon" gave Moon Motel. "playbox" gave all 8 because creator matches. "terrarium" (a word only in a prompt) gave 0. |
| `/` focuses search; Escape clears it | L214-228 | `/` focused `#search` |
| Favorite toggle | grid click delegation L181-192. Persists `playbox.favorites.v1`, shows a toast. | Toast "Saved to your collection.", count 1 |
| Collection view | nav click L201-207, `hashchange` L263-267, initial hash L269-272. Forces category "Saved" and hides the welcome hero. | `#collection` showed only saved items. Persisted across reload. |
| Open template dialog | `openTemplate` L132-151. Pushes the id to the front of recentlyViewed (max 12, L136), fills fields from `state.edits[id] ?? template` defaults, then calls `dialog.showModal()`. | Kicker "VIDEO TEMPLATE · VIDEOS", type "Video · 8 sec" |
| Edit prompt, frame or motion | `saveEdits` L157-165 on the `input`/`change` listeners at L250-255. Persists `playbox.edits.v1`. | An edited prompt and aspect ratio were restored after reload |
| "Start creating" | L257-261. Only unhides a notice: "Generation isn't connected in this preview. No job was submitted and no credits were charged…". | Notice shown. No network request. |
| Recently viewed shelf and Clear history | category "Recently viewed". The Clear history button is shown only in that category (L84); its handler is L238-243. | Works on desktop. **The shelf shows items in catalog order, not recency order.** Stored `["slow-bloom","moon-motel","cloud-nine"]` displayed as Moon Motel, Cloud Nine, Slow Bloom. Cause: `filterTemplates` filters `items` in catalog order (`catalog.js` L117-122). |
| Close dialog (× button, Escape, backdrop click) | L245-248 plus the native Escape key | **Bug: `dialog.open` becomes false but the panel stays on screen**, with no backdrop and covering the gallery. See below. |
| Empty state and "Back to exploring" | L62, L97, L230-236 | Shown for a zero-result search |

### Defects confirmed in the browser
1. **A closed dialog stays visible.**
   - Cause: `styles.css` L191 sets `.template-dialog { position: fixed; … display: grid; … }`. That author rule overrides the browser's built-in `dialog:not([open]) { display: none }`, and no `[open]` or `:not([open])` rule restores hiding. The only `[open]` selector in the file is for `.advanced-settings` (L210).
   - Before the dialog is ever opened, it is rendered empty below the fold: rect y = 1457 at 1280×900 and y = 1498 at 390×844.
   - After it is opened and then closed (Escape or ×), `open === false` but the panel stays fixed mid-viewport. Rects: y = 209, h = 481 at 1280; y = 107, h = 629 at 390.
   - It stays there when the page scrolls, and it intercepts clicks. Playwright reported that the "dialog subtree intercepts pointer events" when it tried to click the Moon Motel card.
   - Screenshots: `scratchpad/shots/after-close-viewport.png` and `after-escape-390.png`.
2. **On viewports up to 620px wide, Recently viewed and Clear history cannot be reached.**
   - `styles.css` L257 sets `.side-nav { display: none }`.
   - The chip strip (`index.html` L76-80) has no Recently viewed chip.
   - Verified at 390px: side nav hidden; chips are For you, All templates, Images, Videos, Saved.
3. **Corrupt localStorage blanks the app.**
   - `readStorage` (`app.js` L25-32) accepts any JSON value, with no shape check.
   - Setting `playbox.favorites.v1` to `{"a":1}` throws "object is not iterable" from `new Set(favorites)` (`catalog.js` L115) and renders 0 cards.
4. **Recently viewed is in the wrong order.** It is shown in catalog order, not most-recent-first (see the interactions table).

---

## 3. What `server.mjs` serves

Imports: `node:http`, `node:fs/promises`, `node:path` and `node:url` only (L1-4).

| Aspect | Evidence | Behaviour |
| --- | --- | --- |
| Bind address and port | L50-53 | `127.0.0.1` only. `PORT` env var, default `4173`. Logs "Playbox preview available at…". |
| Methods | L16-19 | GET and HEAD. Anything else returns `405` with `Allow: GET, HEAD` and an empty body (POST and OPTIONS verified). |
| URL parsing | L21-27 | `decodeURIComponent(new URL(req.url,"http://localhost").pathname)`. A malformed escape returns `400 "Bad request"` with no content type (`/%E0%A4%A` verified). The query string is ignored. |
| **Routes** (an allowlist, not a router) | L7, L28-32 | `/` is mapped to `index.html`. Only `index.html`, `styles.css`, `src/app.js` and `src/catalog.js` are in the `publicFiles` Set. Everything else returns `404 text/plain "Not found"`. |
| Verified 200 | curl | `/`, `/index.html`, `/styles.css`, `/src/app.js`, `/src/catalog.js`, `/index.html?x=1`, `/src/../index.html` (the URL parser normalizes it), `/src%2fapp.js` (decoded) |
| Verified 404 | curl | `/server.mjs`, `/package.json`, `/README.md`, `/docs/engineering.md`, `/test/catalog.test.js`, `/explore`, `/collection`, `/favicon.ico`, `/api/templates`, `/index.html/`, `/%2e%2e/etc/passwd`, `/..%2fpackage.json` |
| Path traversal | L29, L33 | Not possible, because `resolve(root, relativePath)` runs only after the exact-string allowlist check |
| Data source | L36 | `readFile` from disk on every request. No cache, no ETag, no `Cache-Control`, no compression. |
| Content types | L8-13, L38 | `.css`, `.html`, `.js` and `.mjs` map to explicit types, with `application/octet-stream` as the fallback |
| Security headers (200 only) | L37-42 | `X-Content-Type-Options: nosniff`; a CSP of `default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`; and `Referrer-Policy: strict-origin-when-cross-origin`. The **404, 400 and 405 responses carry none of these headers** (verified). |
| HEAD | L43 | Sends the headers without a body |
| Read error | L45-46 | Any `readFile` failure is reported as 404, which would also hide permission and IO errors |
| **Persistence** | none | No database, files, sessions or cookies. All persistence is browser `localStorage` (keys `playbox.favorites.v1`, `playbox.recentlyViewed.v1`, `playbox.edits.v1`; `app.js` L3-7). |
| **Auth** | none | No auth of any kind. The avatar button is decorative. |
| **Validation** | minimal | Only the method check, URI decoding and allowlist membership. There is no request-body handling at all. |
| API | none | No `/api/*` routes; `docs/engineering.md` L45 calls them "a design sketch". |
| Logging | L52 only | No request logging |

---

## 4. `package.json`

| Field | Value (line) |
| --- | --- |
| name / version | `hushloom` / `1.0.0` (L2-3) |
| description | "A lightweight, media-first Playbox creative playground prototype." (L4) |
| private | `true` (L5) |
| main | `server.mjs` (L6) |
| scripts | `start: node server.mjs` (L8); `test: node --test` (L9) |
| type | `module` (L11) |
| dependencies / devDependencies | **none** |
| engines | **absent**, so the README's "Node.js 18 or newer" is not enforced |

There is no lint, build, format or e2e script, and no lockfile.

---

## 5. Tests (`test/catalog.test.js`, 39 lines)

The file imports `filterTemplates` and `templates` from `../src/catalog.js` (L3). Only the pure catalog module is tested. **There are no tests of `server.mjs`, `app.js`, the DOM, localStorage, the dialog or the CSS.**

| # | Test name (line) | What it asserts |
| --- | --- | --- |
| 1 | "the catalog contains discoverable image and video templates" (L5-9) | At least one `Images` and one `Videos` item exist; every item has a truthy `id` and `prompt` |
| 2 | "category filters show only matching media" (L11-14) | Every result of `Images` has category Images, and likewise for `Videos`. This passes vacuously if the result is empty, because it uses `every`. |
| 3 | "search is case-insensitive and ignores surrounding whitespace" (L16-21) | The query `"  MOON "` returns exactly `["moon-motel"]` |
| 4 | "saved and recently viewed filters respect their local identifiers" (L23-32) | `Saved` with favorites `["petal-study"]` gives `["petal-study"]`; `Recently viewed` with `["cloud-nine"]` gives `["cloud-nine"]`. Each list has one item, so ordering is never tested. |
| 5 | "a search is combined with the selected category" (L34-39) | `query:"bloom"` with category `Videos` gives `["slow-bloom"]` |

Result reproduced: `npm test` reported **5 pass, 0 fail** (Node 22.22.0, ~125 ms). `node --check` passes on all 4 JS files.

Not covered by the tests: "For you" being identical to "All templates"; the order of the Recently viewed shelf; prompt-text search; unknown categories; malformed stored values; any server route or header; and the dialog close bug.

---

## 6. Claims in each doc compared with the code

Verdicts used below:
- **Backed**: the code does it.
- **Partly**: the code does some of it, or the claim needs a caveat.
- **Not backed**: the code does not support the claim, or it cannot be checked from the repo.
- **N/A (design)**: the doc explicitly labels it as future work or not implemented.

### README.md

| # | Claim (line) | Verdict | Evidence |
| --- | --- | --- | --- |
| R1 | "no-dependency" (L3) | Backed | `package.json` has no dependencies |
| R2 | "responsive" (L3) | Backed | `styles.css` L227-290; no horizontal scroll at 390px (scrollWidth 390) |
| R3 | "demonstrates template discovery and personalization" (L3) | Backed | `catalog.js` filter; dialog edits in `app.js` L157-165 |
| R4 | "clearly identifying generation and account features that are not connected" (L3) | Backed | `index.html` L30, L95, L123, L127; `app.js` L259 |
| R5 | "Requires Node.js 18 or newer" (L7) | Partly | Plausible, since `node:test` exists in 18, but there is no `engines` field. Ran on 22 only. |
| R6 | `npm test` / `npm start` (L10-11) | Backed | `package.json` L8-9 |
| R7 | Open `http://127.0.0.1:4173` (L14) | Backed | `server.mjs` L50-52 |
| R8 | Favorites, recently viewed, edited prompts and settings "saved in this browser only" (L14) | Backed | `app.js` L3-7, L25-40 (localStorage only) |
| R9 | "No media is uploaded, no AI job is submitted, and no credits are charged." (L14) | Backed | No network APIs in `app.js`; the server accepts only GET/HEAD; observed requests were local assets and Google Fonts only |
| R10 | Links to the two docs (L16) | Backed | Both files exist |

### docs/engineering.md

| # | Claim (line) | Verdict | Evidence |
| --- | --- | --- | --- |
| E1 | "no-dependency, static browser preview served by a small Node HTTP server" (L5) | Backed | `server.mjs`, `package.json` |
| E2 | "real local discovery-to-template-edit interaction: catalog filtering, search, favorites, recently viewed templates, prompt editing, and saved local settings" (L5) | Partly | All of these exist, but: the dialog does not hide when closed (`styles.css` L191); Recently viewed is in catalog order; Recently viewed cannot be reached at ≤620px |
| E3 | "no database, authentication, AI provider, job queue, worker, credit ledger, payment integration, upload service, creator API, or deployment target" (L7) | Backed | None of these appear in any file |
| E4 | "Template artwork and catalog entries are local illustrative content" (L7) | Backed | `catalog.js` L1-106; `styles.css` L154-185 |
| E5 | "Browser storage is device-local and is not an account-backed private collection" (L7) | Backed | `app.js` L25-40 |
| E6 | "does not upload media, submit a generation, estimate costs, or charge credits" (L7) | Backed | `app.js` L257-261 |
| E7 | IA table: `/` and `/explore` give "One page at `/`; hash `#explore`" (L13) | Backed | `/explore` returns 404 from the server; the hash is handled in `app.js` L263-272 |
| E8 | `/templates/[id]`: "Accessible template dialog; no deep route" (L14) | Partly | Native `<dialog aria-labelledby>` (`index.html` L98) with a labelled close button (L99), and there is no deep route. But a closed dialog stays rendered and blocks clicks. |
| E9 | `/generate/*`: "submission explains the limitation" (L15) | Backed | `app.js` L257-261 |
| E10 | `/collection`: "Saved templates at `#collection`" (L16) | Backed | `app.js` L201-207, L263-272 |
| E11 | All other routes "Not implemented" (L17-25) | Backed | The server allowlist has 4 files only |
| E12 | `/studio`: "Small optional controls live in the template dialog only" (L20) | Backed | `index.html` L108-124 |
| E13 | `/creators`: "'Playbox picks' is illustrative" (L21) | Backed | `catalog.js` `creator`; `index.html` L105 is hard-coded |
| E14 | "CSS variables in `styles.css` centralize surface, text, accent, radius, spacing, and motion values" (L31) | Partly | Variables are defined at L3-34. However, `--space-1` … `--space-12` (L17-23) and `--surface-raised` (L7) are **never used**: there are 0 `var(--space-*)` references, and all spacing is literal px. `--radius-card` is used once. |
| E15 | "Layout breakpoints adapt the gallery and sidebar to mobile" (L31) | Backed | `styles.css` L227-290 |
| E16 | "Focus rings, a skip link, accessible names, native dialog/details controls, live result counts, and reduced-motion handling are included" (L31) | Backed | Focus: `styles.css` L42-45. Skip link: `index.html` L13 and `styles.css` L47-48. aria-labels: `index.html` L30, L99; `app.js` L108, L117. `<dialog>` and `<details>`: `index.html` L98, L108. aria-live: L72, L82. Reduced motion: `styles.css` L291-293. Caveats: many text sizes are 6-9px (for example `styles.css` L106, L253, L260, L275), and the dialog-hide bug remains. |
| E17 | "Fonts currently load from Google Fonts with system fallbacks" (L33) | Backed | `styles.css` L1, L27-28; CSP at `server.mjs` L40; observed requests |
| E18 | Production architecture, entities, API contracts and worker/credit rules (L35-64) | N/A (design) | Labelled "(not implemented)" and "a design sketch, not implemented routes" (L35, L45). `/api/templates` returns 404. |
| E19 | Auth, consent, privacy and storage requirements (L66-70) | N/A (design) | Not implemented. Nothing in the code relates to it. |
| E20 | "There are no npm dependencies or secrets required" (L74) | Backed | `package.json`; no env reads except `PORT` |
| E21 | "`PORT` can select another local port" (L81) | Backed | `server.mjs` L50 (tested with 48173-48175) |
| E22 | "the preview server is local-only" / no migrations, workers, build, container, deployment, or `.env` (L81) | Backed | Binds 127.0.0.1 (`server.mjs` L51); no such files in the tree |
| E23 | Verification report: "Implemented: responsive static UI; catalog search and image/video filters; favorites and recently viewed templates with a clear-history control; template detail dialog; editable prompts and optional frame/motion settings; browser-local persistence; explicit unavailable-generation messaging" (L85) | Partly | Each feature exists. Defects: the dialog close leaves the panel visible; the clear-history control cannot be reached on mobile; Recently viewed order is wrong. |
| E24 | "`npm test` passed (5 tests)" (L86) | Backed | Reproduced: 5 pass, 0 fail |
| E25 | "JavaScript syntax checks passed" (L86) | Backed (reproduced) | `node --check` passes. No committed script runs it. |
| E26 | "A headless Chromium interaction check verified initial rendering (8 templates), search, video filtering, template details, unavailable-generation messaging, local prompt persistence, favorites/Collection, and clearing recent history" (L86) | Not backed by repo evidence | No script or artifact is committed. Re-running these flows confirmed most of them, but the template-details dialog cannot be dismissed visually and blocks clicks on cards behind it. A plain Playwright `click()` on a second card timed out. The claimed check either missed this or did not exist in this form. |
| E27 | "Direct HTTP checks confirmed app resources return 200, non-public repository files return 404, and security headers are present" (L86) | Backed, with a caveat | Reproduced. The security headers are only on 200 responses, not on 404, 400 or 405. |
| E28 | "Integrations configured: none" (L87) | Backed | |
| E29 | "Not operational: authentication, age verification, generation, …, deployment" (L89) | Backed | |

### docs/playbox-2-vision.md

| # | Claim (line) | Verdict | Evidence |
| --- | --- | --- | --- |
| V1 | "This repository currently contains a browser-only design prototype, not the connected Playbox product" (L9) | Backed | There is also a tiny static Node server, but no backend. |
| V2 | "Evolve discovery with opt-in saved and recently viewed shelves" (L13) | Partly (direction) | Recently viewed is recorded automatically on every dialog open (`app.js` L136-137), so it is not opt-in. |
| V3 | "original abstract artwork, curated starter templates, and 'Playbox picks' attribution… illustrative" (L15) | Backed | `styles.css` L154-185; `catalog.js` |
| V4 | "No personalized recommendation model is active" (L15) | Backed | "For you" returns the full catalog (`catalog.js` L121), identical to "All templates" |
| V5 | "Explain and allow clearing discovery signals" (L19) | Partly | Clear history exists (`app.js` L238-243) but only in the Recently viewed view, and not on mobile. Saved prompt edits cannot be cleared. |
| V6 | "Editing the prompt, frame, or motion is optional" (L20) | Backed | Defaults come from the template (`app.js` L144-146) |
| V7 | "Touch and keyboard: touch targets, visible focus, keyboard-operable dialogs and filters, and no hover-only functionality" (L32) | Partly | Focus and keyboard: yes (native buttons, dialog, `/` shortcut). Touch targets are small: favorite 31px, or 28px on mobile (`styles.css` L136, L272); chips 31px (L260); avatar 29px (L247). The closed dialog is not dismissible visually. |
| V8 | "Respect reduced motion" (L31) | Backed | `styles.css` L291-293 |
| V9 | "Honesty: show real loading and job states only when the corresponding backend exists. No fabricated generation progress…" (L33) | Backed | No progress UI; the notice says nothing was submitted |
| V10 | "centralizes core values in `styles.css` under `:root`" (L37) | Backed | `styles.css` L3-34 |
| V11 | Token table: bg/surface/raised `#10100f/#171715/#1d1d1b`; text `#f1efe8/#a5a39b`; accent `#d9f36a/#1b1e0f`; supporting `#f4a9a3`; radius `15px/20px`; breakpoints `1400/900/620/370`; motion `160ms/260ms` (L41-47) | Backed | `styles.css` L5-16, L24-25, L227, L230, L236, L285. Values match exactly. `--surface-raised` is defined but unused. |
| V12 | "The grid moves from four columns on wide screens to three, two, and one/two on progressively narrower screens" (L49) | Partly | Computed columns: 1500px gives 4, 1280px gives 3, and 800, 600, 390 and 360px all give 2. There is **no single-column layout**. |
| V13 | "Mobile filters become a horizontal chip row" (L49) | Partly | `styles.css` L114, L256-262. But the chip row omits Recently viewed (`index.html` L76-80). |
| V14 | "dialogs become bottom-friendly stacked panels" (L49) | Partly | Below 620px the dialog stacks into one column (`styles.css` L279-283). It is not anchored to the bottom (no bottom sheet). |
| V15 | Journey step 1, Discover: "browse… without an account" (L53) | Backed | |
| V16 | Journey step 2, Choose: "open a template to see its preview, description, media type, and starting prompt" (L54) | Backed | `app.js` L139-147. The preview is CSS art. |
| V17 | Journey step 3, Personalize: "Preserve the defaults until the user changes them" (L55) | Backed | Edits are saved only on input/change (L250-255). There is no reset-to-default control. |
| V18 | Journey steps 4-7 and phases 2-4 (L56-70) | N/A (design) | Not implemented, and the doc frames them as direction |
| V19 | Phase 1 "Foundation: … private collection…" (L67) | Partly | The "collection" is device-local favorites, not private account storage |

---

## 7. Overall characterization
- This is a polished-looking, **front-end-only mock**. It has 8 hard-coded templates with CSS-gradient art, client-side filtering and search, and localStorage persistence of favorites, recents and prompt edits. A ~50-line static file server sits behind it with an allowlist of 4 files.
- There is **no backend, API, auth, database, generation, upload or credits**, and the docs say so plainly and repeatedly. Most of the docs (about 60% of engineering.md, plus the vision doc) describe future architecture and are labelled as not implemented.
- The docs are honest about scope. Where they overstate is QA:
  - The "verified" headless Chromium check (`engineering.md` L86) does not match a reproducible dialog defect: a closed `<dialog>` stays displayed because of `display: grid` at `styles.css` L191.
  - The test suite covers only the pure filter function.
  - Several design-doc details are only partly true: no one-column grid, spacing tokens defined but unused, no Recently viewed on mobile, and recents not opt-in or ordered by recency.

---

## 8. Observed by running it

Run on 2026-10-13 in a fresh export at `scratchpad/copilot-main/`, not in `/home/claude/hushloom`. Afterwards `git -C /home/claude/hushloom status --short` printed nothing (0 lines). Tools: Node v22.22.0, npm 10.9.4, Playwright 1.56.1 (required by absolute path from `/home/claude/hushloom/node_modules/playwright`), headless Chromium 141.0.7390.37 (build 1194, found through `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). The probe scripts are `scratchpad/copilot-main/pw-run.cjs` and `pw-extra.cjs`. The full log is `scratchpad/ctx/copilot-shots/pw-run.log`.

### 8.1 Export
```sh
rm -rf scratchpad/copilot-main && mkdir -p scratchpad/copilot-main \
  && git -C /home/claude/hushloom archive origin/main | tar -x -C scratchpad/copilot-main
```
`origin/main` = `d2d6cad499b0037f96a3c0b4c5da4851ee672967`. The export has the same 10 files and byte sizes as `git ls-tree -r -l origin/main` (section 1).

### 8.2 `npm install`: skipped, nothing to install
`package.json` has no `dependencies` or `devDependencies` (only `scripts.start`, `scripts.test` and `"type": "module"`), so `npm install` was not run and nothing was installed. The app ran with nothing besides Node's built-in modules.

### 8.3 Test script: `npm test` (exit 0)
```
> hushloom@1.0.0 test
> node --test

TAP version 13
# Subtest: the catalog contains discoverable image and video templates
ok 1 - the catalog contains discoverable image and video templates
  ---
  duration_ms: 0.926082
  type: 'test'
  ...
# Subtest: category filters show only matching media
ok 2 - category filters show only matching media
  ---
  duration_ms: 0.27218
  type: 'test'
  ...
# Subtest: search is case-insensitive and ignores surrounding whitespace
ok 3 - search is case-insensitive and ignores surrounding whitespace
  ---
  duration_ms: 1.339749
  type: 'test'
  ...
# Subtest: saved and recently viewed filters respect their local identifiers
ok 4 - saved and recently viewed filters respect their local identifiers
  ---
  duration_ms: 0.196358
  type: 'test'
  ...
# Subtest: a search is combined with the selected category
ok 5 - a search is combined with the selected category
  ---
  duration_ms: 0.32696
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 101.451964
```

### 8.4 Server
The server reads `process.env.PORT` and defaults to 4173 (`server.mjs` L50). It binds `127.0.0.1` (L51).
```sh
cd scratchpad/copilot-main && PORT=4590 nohup node server.mjs > scratchpad/copilot-server.log 2>&1 &
# log: "Playbox preview available at http://127.0.0.1:4590"
```
It was stopped at the end with `kill 1054`, after checking that `/proc/1054/cwd` was the scratch export. Afterwards `curl http://127.0.0.1:4590/` returned exit 7 (connection refused).

### 8.5 Every route, with curl
The server has no router. It defines one route shape: GET or HEAD for the 4 allowlisted files, with `/` mapped to `index.html`. Everything else gets 404, 405 or 400.

| Request | Status | Content-Type | Body |
| --- | --- | --- | --- |
| `GET /` | 200 | `text/html; charset=utf-8` | 7,746 B, `<!doctype html>…` (index.html) |
| `GET /index.html` | 200 | `text/html; charset=utf-8` | 7,746 B |
| `GET /styles.css` | 200 | `text/css; charset=utf-8` | 25,499 B |
| `GET /src/app.js` | 200 | `text/javascript; charset=utf-8` | 10,812 B, `import { filterTemplates, templates } from "./catalog.js";` |
| `GET /src/catalog.js` | 200 | `text/javascript; charset=utf-8` | 4,271 B, `export const templates = [` |
| `GET /index.html?x=1` | 200 | html | 7,746 B (query ignored) |
| `GET /src/../index.html` (sent with `--path-as-is`) | 200 | html | 7,746 B (URL parser normalises it) |
| `GET /src%2fapp.js` | 200 | js | 10,812 B (decoded before the allowlist check) |
| `HEAD /styles.css` | 200 | css | 0 B body, with the same security headers as GET |
| `GET /server.mjs`, `/package.json`, `/README.md`, `/docs/engineering.md`, `/test/catalog.test.js` | 404 | `text/plain; charset=utf-8` | `Not found` (9 B) |
| `GET /explore`, `/collection`, `/favicon.ico`, `/api/templates`, `/index.html/` | 404 | `text/plain; charset=utf-8` | `Not found` |
| `GET /%2e%2e/etc/passwd`, `/..%2fpackage.json` | 404 | `text/plain; charset=utf-8` | `Not found` |
| `GET /%E0%A4%A` (malformed escape) | 400 | *(none)* | `Bad request` (11 B) |
| `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS /` | 405 | *(none)* | empty; `Allow: GET, HEAD` |
| `POST /api/templates` with a JSON body | 405 | *(none)* | empty; the body is never read |

Headers on 200 responses: `X-Content-Type-Options: nosniff`, the CSP quoted in section 3, and `Referrer-Policy: strict-origin-when-cross-origin`. The 404, 405 and 400 responses carried only `Date`, `Connection`, `Keep-Alive` and `Transfer-Encoding`, plus `Content-Type` on 404 and `Allow` on 405. This confirms section 3 again.

### 8.6 Screenshots (Playwright, headless Chromium, deviceScaleFactor 1)
Saved in `scratchpad/ctx/copilot-shots/`:
- **`copilot-390.png`, `copilot-820.png`, `copilot-1440.png`**: the first viewport at 390×844, 820×1180 and 1440×900, fresh storage. `-full.png` versions are full-page.
- Extra states:
  - `copilot-1440-dialog-open.png` and `copilot-1440-dialog-notice.png` (after Start creating)
  - `copilot-1440-after-close.png`, `copilot-820-after-close.png` and `copilot-390-after-close.png` (closed dialog still on screen)
  - `copilot-1440-empty-recent.png` and `copilot-390-empty-saved.png` (a never-opened, empty dialog shell showing at the bottom)
  - `copilot-1440-saved-view.png`, `copilot-1440-recent.png` (shelf in catalog order) and `copilot-1440-corrupt-storage.png` (blank grid)
  - `copilot-390-dialog-open.png`, `copilot-820-dialog-open.png` and `copilot-390-search-tap.png`

Layout measured at load:

| Viewport | Grid columns | Side nav | Chip strip | Search input | `scrollWidth` | Never-opened `<dialog>` |
| --- | ---: | --- | --- | --- | ---: | --- |
| 390×844 | 2 | hidden | visible: For you, All templates, Images, Videos, Saved | **hidden** (35×35 icon only) | 390 | `display:grid; position:fixed`, rect y=1498 (off-screen) |
| 820×1180 | 2 | visible, 155 px | hidden | visible, 113×18 | 820 | y=1751 (off-screen) |
| 1440×900 | 4 | visible, 184 px | hidden | visible, 203×18 | 1440 | y=1175 (off-screen) |

There is no horizontal overflow at any size. At all three sizes the visual design rendered as intended: dark theme, gradient "art" cards, side nav or chips, hero.

### 8.7 Console errors and network
- **No console messages and no page errors** at any of the 3 sizes, nor during the desktop, tablet and mobile interaction runs.
- The only page error came from the deliberate corrupt-storage test (8.9 #6): `TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))`.
- Requests on load were the same at every size, and all returned 200: `/`, `/styles.css`, `/src/app.js`, `/src/catalog.js`, `fonts.googleapis.com/css2?family=DM+Sans…&family=Manrope…`, `fonts.gstatic.com/…/dmsans/v17/…woff2` and `fonts.gstatic.com/…/manrope/v20/…woff2`. There were **0 failed requests**.
- Clicking **Start creating** made **0 network requests**.

### 8.8 Interactive elements: which do something
Fresh storage at each size unless noted. "No change" means a snapshot of the grid, count, title, toast, dialog state, hash, selection and localStorage was identical before and after a real pointer click.

| Element | Where | Result |
| --- | --- | --- |
| Side nav **For you** | 1440, 820 | Works: 8 cards, "Made for wandering." |
| Side nav **All templates** | 1440 | Works, but only the hash (`#explore`) and highlight change. It shows the **same 8 cards in the same order** as For you. |
| Side nav **Images** / **Videos** | 1440, 820 | Works: 4 cards each (Moon Motel, Soft Focus, Petal Study, Little Worlds / Cloud Nine, After Hours, Velvet Sky, Slow Bloom). The headings change. |
| Side nav **Recently viewed** | 1440, 820 | Works: empty state plus a **Clear history** button; it lists viewed items once some exist. |
| Side nav **Saved** | 1440 | Works: shows favorites, "Your saved sparks." |
| Chips (For you, All templates, Images, Videos, Saved) | 390 | Work: 8 / 8 / 4 / 4 / 0 cards. **There is no Recently viewed chip** (count 0) and the side nav is hidden, so Recently viewed and Clear history **cannot be reached at 390**. |
| **Search** input | 1440, 820 | Works. `/` focuses it. Results by query: `moon` 1 (Moon Motel); `MOON ` 1; `playbox` 8 (it matches the creator "Playbox picks"); `video` 4; `terrarium` 0 (a word only in a prompt); `cassette` 0. Escape clears it and blurs. `bloom` with Videos gives 1 (Slow Bloom). Search stays inside the current category: at 820 in Recently viewed (empty), `moon` gave 0. |
| **Search** on mobile | 390 | **Does nothing; search cannot be reached.** See 8.9 #1. |
| Empty state **Back to exploring** | 1440 | Works: resets to For you with 8 cards and clears the query |
| **Favorite** heart | 1440, 390 | Works: toast "Saved to your collection.", Saved count +1, `playbox.favorites.v1` updated. Un-favoriting inside Saved removes the card and toasts "Removed from your collection." |
| Top nav **Collection** | 1440, 390 | Works: hash `#collection`, hero hidden, only saved cards shown (2 at 1440) |
| Top nav **Explore** | 1440 | Works: hash `#explore`, 8 cards, hero shown again |
| Brand **playbox.** (`href="#explore"`, aria-label "Playbox home") | 1440 | **No change** when the hash is already `#explore`: clicked from the Saved category, it stayed on Saved and only moved focus. From the code (`hashchange`, L263-267) it resets only when coming from `#collection`. |
| Avatar **Y** | 1440 | **Does nothing** (focus only). This matches its label: "sign-in is not available". |
| Card media tag, `↗` quick-arrow, welcome note, sidebar note | 1440 | **Do nothing**: decorative. The `↗` arrow and the "Take a closer look ↗" hover hint look like links. The art and the title open the dialog; the arrow does not. |
| Card **title** / **art** | 1440, 820, 390 | Works: the dialog opens with kicker "VIDEO TEMPLATE · VIDEOS", title "Cloud Nine", "Video · 5 sec", the default prompt, aspect `landscape`, motion 1 ("Gentle"). The id is pushed to `playbox.recentlyViewed.v1`. |
| **Make it more yours** (`<details>`) | 1440 | Works: toggles open |
| Prompt textarea, Frame select, Motion range | 1440 | Work: the label changes "Gentle" → "Expressive". Stored as `{"cloud-nine":{"prompt":"A tiny cloud city at dusk, with paper lanterns","aspectRatio":"square","intensity":3}}`. **Restored after reload** (prompt, `square`, 3, "Expressive"). |
| **Start creating** | 1440, 390 | Works as designed. It only shows "Generation isn't connected in this preview. No job was submitted and no credits were charged. Your settings remain saved on this device." 0 requests. |
| Dialog **×**, **Escape**, **backdrop click** | 1440, 820, 390 | Each sets `dialog.open=false`, **but the panel stays on screen** and blocks the gallery. See 8.9 #2. |
| **Clear history** | 1440 | Works: toast "Your recent views were cleared on this device.", 0 cards, `playbox.recentlyViewed.v1 = []`. The saved prompt edits are kept. |
| Skip link | 1440 | Works: it is the first Tab stop ("Skip to templates"); Enter goes to `#main` (scrollY 76) |
| Favorites, edits and recents after reload | 1440 | Persist: `savedCount=1`, `fav=["moon-motel"]`, `recent=["moon-motel","cloud-nine"]` |

### 8.9 Defects seen while running it
1. **NEW: search cannot be reached at widths up to 620px.**
   - Cause: `styles.css` L244 hides `.search-box input` with `display:none`. The input is only shown again by `.search-box:focus-within` (L245-246). But the hidden input is the only focusable thing inside `.search-box`, so `:focus-within` can never match.
   - Observed at 390×844:
     - a mouse click on the icon, and a touchscreen tap on the box or on its svg (`hasTouch`/`isMobile` context), both left `document.activeElement` on `BODY` and the input at `display:none`
     - typing `moon` afterwards left `search.value=""` with 8 results
     - `/` left focus on `BODY`
     - `document.querySelector('#search').focus()` also failed
     - `#search` was not among the first 40 Tab stops; the order was skip link → brand → Explore → Collection → avatar → chips → …
   - So at phone width the magnifier icon is decorative and search is unusable.
2. **Confirmed again: a closed dialog stays visible and intercepts clicks.**
   - After × at 1440: `open=false`, `display:grid`, `position:fixed`, rect `[275,106,890,688]`. `elementFromPoint` at the first card's centre (440,450) returned `#dialog-art` (inside the dialog).
   - Playwright `click()` on Moon Motel then timed out with `<div id="dialog-art" …> from <dialog id="template-dialog" …> subtree intercepts pointer events`.
   - After Escape, and after a backdrop click at (8,8): `open=false`, rect `[275,209,890,481]`, still showing.
   - At 820: rect `[16,359,788,462]`, and the hit test at a card returned `#dialog-art`.
   - At 390: rect `[12,78,366,687]`; the hit test returned `label.field-label`; clicking Moon Motel timed out (`<h2 id="dialog-title">Cloud Nine</h2> … intercepts pointer events`).
   - Controls outside the panel still worked: the side nav at 1440, the search box, top-nav Collection at 390, and the Images chip at 390 once it was scrolled clear.
   - Screenshots: `copilot-*-after-close.png`.
3. **NEW (same cause as #2): an empty, never-opened dialog shell shows at the bottom of short pages.**
   - With `display:grid` and `position:fixed`, the closed dialog sits at its static position just after the footer, fixed to the viewport.
   - On a full page it is off-screen (y=1175 at 1440). When the gallery is short it rises into view:
     - Recently viewed (empty) at 1440×900: rect y=823 (77 px of a 381 px panel visible)
     - Saved with 2 cards: y=848
     - Saved (empty) at 390×844: y=778 (66 px visible)
   - The empty panel's × button and "Playbox picks ·" line can be seen under the footer (`copilot-1440-empty-recent.png`, `copilot-390-empty-saved.png`).
4. **Confirmed again: Recently viewed is in catalog order.**
   - Templates were opened in the order Slow Bloom, Petal Study, After Hours (last), with a reload between each to get past #2. The stored list was `["after-hours","petal-study","slow-bloom","cloud-nine","moon-motel"]`.
   - The shelf showed `Moon Motel, Cloud Nine, After Hours, Petal Study, Slow Bloom`.
   - A seeded re-run, given time to settle, gave the same result (`copilot-1440-recent.png`).
5. **Confirmed again: Recently viewed and Clear history cannot be reached at 390** (no chip; side nav `display:none`).
6. **Confirmed again: corrupt storage blanks the app.** With `playbox.favorites.v1 = {"a":1}`, 0 cards rendered, `#result-count` was `""`, and the page error was `TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))` (`copilot-1440-corrupt-storage.png`).
7. "For you" equals "All templates": the same 8 cards in the same order.

### 8.10 What this means for engineering.md L86 ("A headless Chromium interaction check verified … template details …")
- A plain headless Chromium run reproduces #2 on the first close, at all three sizes, and finds #1 the moment search is tried at phone width.
- The parts of the claim that do hold: 8 templates on load, search, video filtering, unavailable-generation messaging, local prompt persistence, favorites/Collection and clearing recent history all work on desktop.
- "Template details" can be opened, but it cannot be dismissed: the closed panel stays on screen and blocks the cards behind it.
