> **Draft, not final.** Written 2026-10-12 against commit 9e1db60; a critique asked for revisions (see `critiques.json` beside this file). Phase 5 of the run plan re-checks it against the merged build before it moves to `docs/`.

# Hushloom Product Vision

Deliverable A of the Hushloom build: the product as it exists in the repository (code through commit `9e1db60`, 12 October 2026) and the four launch-readiness additions being built on it. Everything described is in the code unless marked planned or, for the four additions, marked build status; parts that run without external accounts are marked demo or sandbox.

## 1 Opening product framing

Hushloom is an adults-only web app for making images and short videos from templates. A member opens a gallery of templates made by other members, picks one, changes as much or as little as they like, and gets a result in a private Library. From there they can remix it, make a variation, continue a scene, file it in a project, or publish it as a new template for others.

The product is one loop: Discover, Choose, Personalize, Generate, Remix, Continue, Explore again. Generation is two taps and a confirmation from any card. Depth exists for anyone who wants it (projects, scene continuity, presets, seeds, a Studio room) and is invisible to anyone who does not.

Three rules shape every decision. What a member makes is theirs and private by default. Nothing is faked: generation with no real model behind it is labeled demo in the pixels, in the data and on every screen. Trust is enforced on the server, where it cannot be bypassed.

This is a real application: Next.js 15 App Router, React 19, strict TypeScript, PostgreSQL through Drizzle, Redis queues with a BullMQ worker, local or S3-compatible storage, a credit ledger, a generation state machine, and 87 automated tests including an end-to-end journey on the production build. AI generation sits behind provider adapters; today's adapters are labeled demo, because the owner has not yet chosen a provider that permits explicit output.

## 2 Current identity and experience

The reference category is the template-driven adult AI playground. What it does well, as structure and interaction patterns:

- A media-first gallery: cards are the content, text is one line beneath.
- Templates as the unit of discovery: a recipe (prompt, model, defaults) with a creator's name.
- Browsing modes for different moods: Trending, New, Top rated, Most favorited, plus categories and search.
- Indicators a buyer cares about: VIP, 4K, video length.
- Generation one tap from any preview, with credits as the unit of cost.
- A personal Collection, a Train area for identity references, visible creator attribution.

Hushloom keeps all of that as structure and borrows none of the appearance: colors, type, card shape, wordmark, copy and motion are its own, and it must look nothing like any existing site in the category.

## 3 Core visual and emotional personality

Hushloom's look is a dark room with warm light, not a neutral black screen. Every color is a token in `src/app/globals.css`.

Surfaces are an aubergine-black "ink" scale: `ink-950` `#0f0a0d` for the page, `ink-900` `#160f13` for panels and inputs and `ink-850` `#1c1419` for card media. The blacks are red-shifted, never gray or blue.

Text is "bone", a warm off-white: `bone-50` `#f7efe7` for primary text, `bone-200` `#e3d6cf` for body copy and field labels, `bone-300` `#c8b7b1` for secondary copy and `bone-400` for tertiary text.

There is one accent. "Ember" is a coral-orange: `ember-500` `#ff6a4d` fills the primary button, the favorite heart and the toggle; `ember-400` `#ff8a66` is the focus ring and the kicker; `ember-300` is the italic emphasis inside headings. Three secondary tones carry meaning only: `brass-400` `#e2b46d` for VIP and credits, `sage-400` `#9cc5a1` for new and success, `iris-400` `#b39dff` as the Demo badge fill and `iris-300` `#cdbfff` for video badge text and demo notices.

Type is three self-hosted variable families (`@fontsource-variable`, no third-party font requests). Fraunces, a display serif, carries every heading, card title and the lowercase italic wordmark; its italic in ember is the signature emphasis ("Pick a template. *Make it yours.*"). Manrope is the body face. JetBrains Mono carries handles, counts, timestamps and the uppercase `.tag` kickers.

Shape is the petal: `--radius-petal` 20px and `--radius-pin` 5px, so a `.petal` card rounds two opposite corners large and two small. Panels and the hero use the same asymmetry; buttons and chips are full pills.

Voice is short, warm and second person. The hero says "After dark, made by you" and "Everything you make stays private unless you publish it." The age gate says "Adults only" and "This screen is a notice, not age verification." A running job is "Weaving"; the 404 page is "A loose thread."

The emotional target: a private, dim, well-made place where trying something takes a tap and nothing is embarrassing or unsafe. Sophisticated and a little mischievous, never corporate, never clinical.

## 4 What stays versus what evolves

What stays, because the category gets it right: the gallery as home page with no dashboard; templates as recipes with a creator's name; the four browse sorts; VIP and 4K badges; two-tap generation with the cost visible first; a private Library, Train, creator profiles, following, favorites and credits; compact controls.

What evolves, because the build makes it possible:

- From input, generate, output to a loop: every creation carries Remix, Retry, Variation, Continue, Extend, Reuse settings, Save preset and Publish.
- From one-off clips to projects: scenes on a timeline, a continuity guide that copies forward, takes, branches, side-by-side compare, sequence playback.
- From a form to a companion: inline suggestions that catch conflicts, unsupported settings and low-resolution inputs, and a plain-language interpreter that shows what it would change and cost.
- From "generate and hope" to a state machine with reserved credits, real retries, timeouts, cancellation and automatic refunds, and no invented progress bar.
- From a checkbox to enforceable trust: server-checked date of birth, consent records per upload and likeness, withdrawal that deletes dependent creations, signed media, private by default.
- From card-processor dependence to adult-friendly payments; from a notice to provider-backed age verification where the law requires it; from trust to fail-closed scanning; from an app-store app to an installable web app with push.

## 5 Seven major experience upgrades

### System one: AI-powered discovery

Built: the home page shows For you, Continue exploring, Trending tonight, Following and New. Explore has the four sorts, media and category chips, search, and infinite scroll with skeletons. For you uses only the member's own signals (favorites, generations, views, chosen interests), never any attribute of the person (`src/server/discovery/templates.ts`); with no signal, or personalization off, the rail is labeled "Popular to start". Settings toggles personalization and history (off deletes it) and offers Clear history.

Planned: a visual-style similarity layer, and Quick Generate on the card itself; today Make opens the template with the panel in view.

### System two: intelligent template remix

Built: a template page carries its recipe into the create panel, and "Make it" works untouched. A collapsed Tweak section offers model, aspect ratio, length, quality, camera, motion, pacing, lighting and framing, each only when the model supports it. "Say it plainly" turns a plain sentence into settings, lists each with a reason and any cost change, and applies nothing until the member clicks Apply. The server validates every setting against the model's declared capabilities. Restore original brings the template's prompt back.

Demo: outputs come from the demo adapters until a real provider is configured. Planned: a preset picker inside the panel, and recording a remix's parent (a remix starts a fresh root today).

### System three: invisible creative copilot

Built: a rules engine (`src/lib/copilot.ts`) runs inside the create panel as the member types. It blocks prohibited prompts before any credit is spent, flags short or overlong prompts, contradictions, camera conflicts, unsupported aspect ratios, low-resolution uploads and warping risk, suggests a camera move, and adds a continuity caveat where a model cannot guarantee it. Every suggestion shows its change and applies nothing without a click. Undo keeps twenty steps; Restore original is one tap. A preference turns suggestions off, leaving only policy blocks. There is no chat window.

Not AI: the engine is deterministic, fully built and unit-tested, and the UI never calls it AI. Planned: template recommendations from the prompt, and an adapter seam for a model-backed assistant.

### System four: scene continuity engine

Built: Projects hold scenes on a timeline. Each scene has a continuity guide (lighting, framing, palette, a consented character, notes) that copies into the next scene and folds into the prompt and settings when a take starts from it. A scene holds takes; one is selected. Branch makes a variation, Continue and Extend derive from a finished clip with it as input, Compare puts two takes side by side, scenes reorder, and Play sequence plays the selected takes in order. Character references live in Train behind a likeness consent with two checkboxes.

Demo: the demo motion adapter renders a fresh labeled clip and ignores the source clip. Planned before launch: passing the character reference to the adapter (today it is validated and consent-checked but not sent; the Train copy will be corrected), a one-tap alternate-angle action, and Branch and Continue confirming through the standard cost sheet instead of a browser dialog.

### System five: living collection

Built: the Library is a media-dominant grid sized to each output's real aspect ratio, with media, favorites, status, model, folder and sort filters, multi-select for bulk delete and Add to folder, and inline Retry on failed items. A creation page shows the media, a Demo notice when applicable, the prompt, every setting down to seed and cost, a versions strip with side-by-side compare, and twelve actions from Remix to Delete. Deleted files are purged after 30 days.

Planned: date, template, creator and quality filters; remove-from-folder and folder rename; a cost sheet before inline Retry charges (today the cost appears only in the toast afterward).

### System six: creator ecosystem

Built: a creator page with Follow, the published grid and, for the owner, a 30-day analytics table that counts events only. Publishing starts from a completed creation, requires an explicit "this becomes public" checkbox, runs the content policy, copies the output to a new public asset so the original stays private, and records remix attribution. Creations made from an upload or a character reference can never be published. Members rate and report with a reason; admins work a severity-sorted queue, remove or dismiss, suspend accounts, and read an audit log.

Planned: editable collections (seed-only today), a prompt-versioning UI (the API already versions on prompt change), avatar upload, and the takedown request flow being built with the scanning addition.

### System seven: optional advanced studio

Built: `/studio` is the same create panel in studio mode, with Image and Video tabs, negative prompt and seed where supported, atmosphere, project and scene placement, presets with load and delete, and a job monitor with cancel. It is never required: Tweak is collapsed by default elsewhere, and "More controls in Studio" is a link, not a gate.

Planned: version comparison inside Studio; it lives on the creation page today.

## 6 Interface and motion principles

Content first. Cards are the whole tile; the caption is one line. Controls are compact pills and chips and never compete with the pictures.

One accent, one meaning. Ember marks the primary action, the focus ring, the favorite and the active state. Brass means VIP or credits, sage means new or success, iris means demo or video.

Motion communicates state and stops when there is nothing to say. Three keyframes: `thread` (the weaving bar and skeleton shimmer), `rise` (cards, toasts and sheets entering) and `pop` (the heart). Durations are tokens, 140ms, 220ms and 360ms, on one curve, `--ease-weave`. The weaving bar renders only while a job is active. There are no progress percentages, because the pipeline has none to report. Under `prefers-reduced-motion`, every animation is cut to 1ms.

Hover is never the only way. Focus plays a preview and reveals Make; below 1024px Make is always visible; video cards carry a tap button for Preview. Every icon-only control has a label; the end-to-end suite verifies accessible names on Explore, and other pages rely on the component inventory. Every preview is muted; autoplay is off by default and a per-member preference.

Dialogs are native `<dialog>` sheets, bottom sheets on phones; toasts are a polite live region; the skip link is the first Tab stop. Dark only.

Honesty is a visual principle. Demo generation carries the iris Demo badge, an explanatory note, the watermark "DEMO OUTPUT · NOT AI-GENERATED" in the pixels and a labeled model name ("Demo Still (not AI)"), so no screen can present a placeholder as a result. A visible sandbox label for payments, verification and scanning is being added with those additions; none exists in the UI yet.

## 7 Ideal user journey

The seven steps, as the app implements them.

1. Discover. A new visitor meets the age notice first: "Adults only", Enter, or Leave. The home page opens on the gallery; Explore adds sorts, chips and search. Previews play on hover, focus or tap.

2. Choose. A card opens `/templates/[slug]`: a large preview, badges, the creator with Follow, description, stats, tags, and the create panel with "Make it" in view. The cost line is visible even when signed out.

3. Personalize. The member presses Make it with the defaults, or opens Tweak, types a wish into "Say it plainly", uploads a photo (a consent sheet comes first), or picks a consented character. Suggestions appear inline and never apply themselves.

4. Generate. Make it creates a draft on the server (`POST /api/generations`), which checks the session, the jurisdiction's age rules, the content policy, input ownership and consent, model capabilities and VIP entitlement, then returns the cost. The confirmation sheet shows cost, balance after and model. Confirm sends the expected cost; a mismatch is refused. On success, credits are reserved and a real job is queued to the worker.

5. Receive the result. The job tray shows "Weaving" and elapsed seconds, polling only while something runs. On completion a toast offers Open. A failure shows a plain reason ending "Your credits were returned", and it is true: the reservation is released in the transaction that marks the job failed.

6. Remix or continue. The creation page offers Remix, Retry, Variation, Continue, Extend, Reuse settings, Save, Download, Folder, Preset, Publish and Delete. Derived jobs started here go through the same draft, cost and confirm sheet. Two shortcuts do not, and both are listed fixes: the Library's inline Retry confirms at once and shows the cost only in the toast afterward, and the project workspace's Branch and Continue use a browser confirm dialog. A take placed in a project scene appears on the timeline.

7. Return to discovery. The creation links back to its template and project, and the home page's Continue exploring and For you rails reflect what the member just did. A related-templates rail on the creation page is planned.

## 8 Non-visual reliability, quality, privacy and cost improvements

State machine. A job moves `awaiting_confirmation` to `queued` to `processing` to `completed`, `failed` or `cancelled`. Every transition is a database update guarded by the current status, most under a row lock; the retry back to queued is a plain conditional update (`src/server/generation/service.ts`, `processor.ts`). Draft creation and confirm are idempotent; the worker claims a job only if it is still queued. Retryable provider errors return the job to queued with the reservation held, up to three attempts with exponential delay. A provider exceeding `PROVIDER_TIMEOUT_S` is aborted. A reconciler runs every minute: stale queued jobs are re-enqueued, stuck processing jobs are failed and refunded. Cancellation is exact for each state.

Ledger. Every balance change goes through one function that locks the account row, checks an idempotency key, applies the movement and writes a ledger row with the balance after, in one transaction (`src/server/credits/ledger.ts`). Reserve on confirm, settle on completion, release on failure, cancel or timeout. Settle and release share one key per job, so a job is charged once or refunded once, never both.

Consent. Signup records terms and an adult attestation. Each upload creates its own consent record; each character reference creates a likeness consent needing two checkboxes. Generation refuses inputs without active consent. Withdrawing a consent soft-deletes every creation made with it and purges the files immediately. Creations from personal media can never be published. Account deletion needs the password and purges after 30 days.

Signed media. Every asset is private by default; the only path to public is the explicit publish copy. URLs are issued after an ownership check and carry an HMAC over key, expiry and download name; the media route verifies with a constant-time compare, refuses forged links with 403 and deleted assets with 404, and sends `noindex`. Private links last five to ten minutes. The site is `noindex, nofollow`, cannot be framed, and every mutating API call is refused when its Origin does not match.

Fail-closed scanning. Every upload and every generated output passes through the scanning adapter before it can be served, shared or published (`src/server/safety/scan`). On a match the asset is blocked, the account is suspended and flagged (`account_flags`, kind `csam_match`), moderation and audit events are written, the asset goes under legal hold so purge and deletion skip it, and the case goes to a human review queue for reporting to NCMEC or the relevant authority. If the scanner is unreachable, content waits: `SCAN_FAIL_CLOSED` defaults to true, and while true, production refuses to start on the development scanner; false is an explicit opt-out. Adapters: `photodna` and `cloudflare` for hash matching; until the owner has PhotoDNA approval or Cloudflare's scanner, the labeled `dev` scanner runs, matching only hashes listed for drills. Build status at `9e1db60`: the `scan_status` and `legal_hold` columns, the variables and the `scanAsset` hooks at upload and output exist, but the hook returns clean unconditionally and neither the media route nor purge reads the verdict or the hold yet; the enforcement above is being completed now and is not yet true of the current build.

Age verification. The age notice and the server-side date-of-birth check at signup remain step one. On top, a provider-backed verification adapter is required in the jurisdictions that demand it (`src/server/age`, `src/config/jurisdictions.ts`): the United Kingdom and the US states with age-verification laws, on by default and overridable by configuration. Status (unverified, pending, verified, failed, expired) is stored per member with timestamps and the provider's reference only; no ID images or biometrics are kept. Members who need verification cannot generate or upload until verified; the check runs at draft creation and at upload, and a gate on viewing explicit content is being added. The jurisdiction comes from country and region headers the owner's edge must set; with no header, `AGE_VERIFICATION_FAIL_CLOSED` decides, and it defaults to false, so creation is allowed until the owner sets it true. Callbacks are signature-checked and every status change is audit-logged. Adapters: `yoti` and `veriff`, with methods that meet the UK "highly effective" standard; until the owner opens a provider account, the labeled `sandbox` provider runs and never marks a real member verified. Build status at `9e1db60`: the jurisdiction list, the status columns and the `assertAgeVerified` hooks exist, but the hook is empty, so no member is blocked yet; the gate is being completed now.

Payments adapters. Checkout, webhook verification, credit issuance, refunds and chargebacks sit behind one interface (`src/server/payments/types.ts`), selected by `PAYMENT_PROVIDER`, default `sandbox`. CCBill and Segpay adapters accept adult merchants. Stripe stays selectable but off by default; the comment citing its policy banning mature content, AI-generated included, sits on `PAYMENT_PROVIDER` in `src/server/env.ts`, and the existing Stripe code is being moved behind the interface. Every webhook is verified with the processor's documented scheme; unsigned, malformed and replayed events are rejected, and events are recorded once by provider and event id, so a duplicate delivery issues credits once. A refund or chargeback finds its purchase by transaction reference and claws credits back through the ledger; a chargeback also flags the account. Until the owner adds account keys, the labeled `sandbox` processor runs; it never charges anyone and never fakes a successful payment. Build status at `9e1db60`: the interface, the variables and the refund and chargeback ledger kinds exist; the provider directory is empty, and the CCBill, Segpay and sandbox adapters are being written now.

Installable web app. Apple's and Google's store rules exclude sexually explicit apps, so mobile is the web app installed from the browser: a manifest, icons, standalone display, and a service worker that caches the app shell only, never private media or private API responses. Push is opt-in per member and per device, stored against the session and removed at sign-out; until the owner sets VAPID keys, push is off and the app says so. A payload says only "Your creation is ready" or that it failed. Install is offered from Settings, never as a popup. Offline, the app shows a clear state and queues nothing chargeable. Build status at `9e1db60`: the `push_subscriptions` table, the VAPID variables and the `notifyJobFinished` hook on completion and failure exist; the hook is empty, and the manifest, service worker, push route and install control are being built now.

Quality and cost. Structured JSON logs, a worker health endpoint, Redis rate limits, per-member concurrency caps that plans can raise, and placeholder prices the operator sets. The suite covers exactly-once charging, cancel in every state, retries, timeouts, dead-worker recovery, policy blocks, cross-member isolation, consent cascades, webhook deduplication, forged media links, cross-origin writes, under-18 refusal, three layout widths and keyboard reachability.

## 9 Four-phase evolution plan

Phase one, Foundation: tokens and primitives, navigation, home and Explore, cards and detail pages, auth, the Library, generation entry points, responsive layouts. Complete in this build.

Phase two, Intelligence and generation: provider adapters and a capability registry, the job state machine and worker, uploads with consent, the credit ledger, honest status, the copilot and interpreter, server-side validation. Complete in this build, on labeled demo adapters. A Replicate image adapter exists but has never run and needs a token; the owner still has to choose a provider that permits explicit output.

Phase three, Continuous creativity: projects, scenes and the continuity guide, variations and continuations, timelines, version comparison, presets, Studio, structural quality checks. Complete in this build, with the two gaps noted under System four.

Phase four, Ecosystem: creator profiles, publishing with the consent boundary, following, remix attribution, For you, owner analytics, reporting and moderation. Largely complete; the open items are the planned ones in section 5.

Across all four phases runs the launch-readiness track from the approved addendum: payments, age verification, abuse scanning and the installable web app. Their schema, environment variables, adapter interfaces and hook points are in the code; the adapters, the enforcement behind the hooks and the tests are being completed now. When complete, each runs end to end in labeled sandbox mode until the owner opens the accounts: CCBill or Segpay, an age-verification provider, and PhotoDNA approval or Cloudflare's scanner.

## 10 Creative constitution

Keep, always:

1. The gallery is the home page. Media first, one line of text.
2. Templates drive discovery. A template is a recipe with a creator's name.
3. Generation is fast and simple: a card, a tap, a confirmation.
4. The presentation is dark and immersive: ink, bone, one ember accent.
5. This is an adult product and says so at the door.
6. The community is visible: creators, follows, favorites, remix attribution.
7. Controls are compact: chips, pills, rails, sheets.
8. Navigation stays recognizable: Discover, Create, Library, Train, then Projects, Studio, Favorites.
9. Previews are clear: poster, muted preview, duration, badges.
10. Experimentation is optional and one link deeper.

Never:

- Replace the gallery with a dashboard.
- Require a chatbot or any conversation.
- Force a beginner into an advanced panel.
- Bury a feature. At risk on phones today: Projects, Studio, Train and Favorites have no tab, and the You tab is a plain link to Settings. A You sheet listing them is proposed in the UX audit, not yet in progress.
- Animate for decoration. Three keyframes, token durations, reduced motion honored.
- Interrupt browsing with monetization. Cost appears at the moment of a chargeable action and nowhere else.
- Trade privacy, consent, accessibility or reliability for engagement.
- Present a demo, a sandbox or a seeded number as real.
- Add a feature because the count looks better.

## 11 Final product vision

Hushloom is a dim, warm, private room where an adult can make the picture or the clip they were imagining in a few taps, from a template someone else was proud enough to publish, and then keep going: another take, a different angle, the next scene, a project that remembers the lighting.

Under the room is a plain, inspectable machine. A job has a state and a cost, and both are true. A credit is reserved before work starts and comes back if the work fails. A file belongs to the member who made it until they publish a copy. A face is used only with recorded consent and disappears, with everything made from it, when that consent is withdrawn. Once the launch-readiness track lands and the owner sets the geo headers and fail-closed flags, nothing is served unscanned, nothing explicit is made before age is established where the law requires it, and nothing is charged through a processor that forbids the business.

Operational today: the whole loop on real infrastructure, with labeled demo generation. Being completed now, to run in labeled sandbox mode until the owner adds account keys: payments, age verification, abuse scanning and push. The owner's remaining decisions: the AI provider, the processor, the verification vendor and the scanner. Each is a configuration change, not a rewrite, and until they are made, no member is ever told something that is not true.
