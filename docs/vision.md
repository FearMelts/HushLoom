# Hushloom Product Vision

Deliverable A, describing Hushloom at commit `c52f843` (14 October 2026) with all seven build tracks merged. Labels used throughout: **Built** (the code does it today), **Demo** or **sandbox** (runs and is labeled on screen, without the outside service), **Unverified** (written from public documentation, never run against the real service) and **Not built** (planned).

## 1 Opening product framing

Hushloom is an adults-only web app for making images and short videos from templates. A member picks a template from a gallery other members published, changes as much or as little as they like, and gets the result in a private Library, ready to remix, vary, continue, file in a project or publish.

The product is one loop: discover, choose, personalize, generate, remix, continue, explore again. Any card leads to a result in two taps and a confirmation. Depth (projects, scene continuity, presets, seeds, a Studio) waits for those who want it.

Three rules shape every decision. What a member makes stays private until they publish a copy. Nothing is faked: a placeholder is labeled in its pixels, its data and every screen. Trust is enforced on the server.

It is a Next.js, PostgreSQL and Redis application with a separate worker. At the merged head, typecheck and lint are clean and 258 unit and integration tests pass. The 8-spec browser journey last passed on the production build at `0686f87`, before the fix and infrastructure tracks merged; the fix tracks' screen changes are not yet seen in a browser.

| Area | In this build | Goes live with |
| --- | --- | --- |
| AI generation | Demo: two local models named "(not AI)"; Replicate adapter unverified | A provider that permits explicit output |
| Payments | Sandbox, no money moves; CCBill and Segpay unverified; Stripe off | A CCBill or Segpay account |
| Age verification | Sandbox that proves nothing; Yoti unverified | A Yoti account and edge geo headers |
| Abuse scanning | Development scanner, test hashes only; PhotoDNA unverified | PhotoDNA approval |
| Push | Off until VAPID keys are set, and says so | VAPID keys |
| Docker, CI, S3 | Written, never run | A Docker host, GitHub, a bucket |

## 2 Current identity and experience

The structural reference is Playbox's category, the template-driven adult AI playground. Hushloom keeps its structure and interaction patterns:

| Pattern kept | Where it lives in Hushloom |
| --- | --- |
| Media-first gallery as the home page | `/`: rails and a card grid, a short caption under each card |
| Templates as the unit of discovery, creator named | `/templates/[slug]`, `/creators/[handle]` |
| Browse modes | Trending, New, Top rated, Most loved; categories, media, VIP, search (`/explore`) |
| Indicators | VIP, 4K, New and Demo badges; media type and length on the template page |
| Generate straight from a preview | Make on every card, Make it on every template page |
| Credits as the unit of cost | A credit pill; the cost shown before every charge |
| Personal collection and Train | `/collection`, `/favorites`, `/train` |

It must never become a dashboard, a chatbot or a settings wall. It borrows none of the reference's appearance: colors, type, card shape, wordmark, icons, copy and motion are Hushloom's own.

## 3 Core visual and emotional personality

Hushloom looks like a dim room with warm light. Every value is a token in `src/app/globals.css`; components never hardcode hex values.

| Role | Token and value |
| --- | --- |
| Surfaces (red-shifted, never gray) | `ink-950` `#0f0a0d` page, `ink-900` `#160f13` panels, `ink-850` `#1c1419` card media |
| Text | `bone-50` `#f7efe7` primary, `bone-200` labels, `bone-300` secondary, `bone-400` tertiary, `bone-500` `#958480` hints |
| The one accent | `ember-500` `#ff6a4d` fill, `ember-400` focus ring and kickers, `ember-300` italic emphasis |
| Meaning only | `brass-400` VIP and credits, `sage-400` new and success, `iris-400` demo badge fill, `iris-300` video badge text and notices |

A unit test holds every text token to 4.5:1 contrast on the ink surfaces.

Type is three self-hosted variable families. Fraunces, a display serif, carries headings, card titles and the lowercase italic wordmark; its ember italic is the signature ("Pick a template. *Make it yours.*"). Manrope is the body face. JetBrains Mono carries handles, counts and uppercase `.tag` kickers.

Shape is the petal: cards round two opposite corners at 20px and two at 5px; panels do the same at 24px and 8px; buttons and chips are pills. The primitives in `src/components/ui.tsx` are few: buttons in five variants, badges, chips, a switch, sheets, toasts, skeletons and empty states.

Voice is short, warm and second person: "After dark, made by you", "Everything you make stays private unless you publish it", "Ready to make this?", "Weaving" for a running job, "A loose thread" for the 404 page, and "This is a sandbox. No money moves."

The emotional target: a private, well-made place where trying something takes a tap. A little mischievous, never corporate or clinical.

## 4 What stays versus what evolves

What stays is the structure in section 2: the gallery as home page, templates with a creator's name, the sorts and badges, generation from any card with the cost first, and compact controls.

What evolves:

- From "input, generate, output" to a loop: every creation can be remixed, retried, varied, continued or published.
- From one-off clips to projects with scenes, takes, branches and a continuity guide.
- From a form to a companion: inline suggestions and a plain-language interpreter.
- From "generate and hope" to a state machine with reserved credits and automatic refunds.
- From a checkbox to enforced trust: a server-checked date of birth, consent records, signed private media.
- From a banned processor, a bare notice, unscanned files and app stores to adult processors, provider age checks, scanning and an installable web app.

## 5 Seven major experience upgrades

### System one: AI-powered discovery

**Built.** Home shows For you, Continue exploring, Your favorites, Trending tonight, Following and New. Explore adds the sorts, category, media and VIP filters, search and infinite scroll. Template pages add "You might also like" and "More in #tag" rails. For you uses only the categories and tags of templates the member saved, made, viewed or chose as interests; nothing about the person is inferred (`src/server/discovery/templates.ts`). With no signal or personalization off, it shows trending templates as "Popular to start". Settings can turn off personalization, or history (which deletes it).

**Demo.** Every seeded template runs on a demo model and shows a Demo badge.

**Not built.** Visual-style similarity; Quick Generate on the card itself (Make opens the template's panel); a media-type and length badge on cards.

### System two: intelligent template remix

**Built.** A template page loads its recipe, and Make it works untouched. A collapsed Tweak section offers model, aspect ratio, length, quality, camera, motion, pacing, lighting, framing and atmosphere, each only where the model supports it. "Say it plainly" turns a sentence into settings, lists each with a reason and any cost change, and applies nothing until Apply. The server validates every setting against the model's declared capabilities (`src/server/ai/registry.ts`). Remix and Reuse settings record their parent job and keep template attribution. Presets save and load on `/generate` and in Studio.

**Demo.** Results come from the demo models.

### System three: invisible creative copilot

**Built.** A rules engine (`src/lib/copilot.ts`) runs as the member types. It blocks prohibited prompts before any credit is spent, flags weak prompts, conflicts, unsupported settings, low-resolution uploads and artifact risk, suggests camera moves, and notes where a model cannot promise continuity. Each suggestion shows its change and waits for a click; Undo keeps 20 steps, and Restore original is one tap. The Creative assistant switch in Settings hides these suggestions, except warnings that would stop a creation. There is no chat window.

**Not AI, and not a demo.** The engine is deterministic and unit-tested, and the interface never calls it AI. **Not built:** template recommendations from the prompt; a model-backed assistant.

### System four: scene continuity engine

**Built.** Projects hold ordered scenes, each with a continuity guide (lighting, framing, palette, a consented character, notes) that copies into the next scene and folds into each take. Branch and Continue confirm through the cost sheet; Compare shows two takes side by side; Play sequence plays the selected takes. Character references live in Train behind a two-checkbox likeness consent, and reach the provider only while that consent is active and the photo scanned clean. No model claims more than "best effort" continuity.

**Demo.** The demo motion model renders a fresh labeled clip and ignores the source. The demo still model blends a reference photo under its watermark, which is not a likeness match.

**Not built.** A one-tap alternate-angle action.

### System five: living collection

**Built.** The Library grid follows each output's real aspect ratio. Filters cover media, favorites, status, model, folder, project, template, template creator, quality and dates. Multi-select deletes or files in bulk; Retry opens a cost sheet first. A creation page shows the media, any Demo notice, every setting down to seed and cost, versions with side-by-side compare, and up to twelve actions. Deleted files are purged after 30 days unless on legal hold.

**Not built.** Folder rename and remove-from-folder; the balance in the Retry sheet.

### System six: creator ecosystem

**Built.** A creator page has Follow, the published grid, collections and, for the owner, a 30-day analytics table that counts events only. Changing a published prompt publishes the next version. Publishing starts from a completed, scan-clean creation, needs an explicit checkbox that it becomes public, runs the content policy and copies the output to a new public asset, so the original stays private. Creations from uploads or character references can never be published. Members rate and report; admins work a severity-sorted queue, suspend accounts and read an audit log. Anyone may request a takedown (`/policies/takedown`).

**Not built.** Creating or editing collections (only the seed makes them); avatar upload.

### System seven: optional advanced studio

**Built.** `/studio` is the same create panel in studio mode: negative prompt and seed where supported, atmosphere, project and scene placement, presets and a job monitor with cancel. It is never required; "More controls in Studio" is a link, not a gate.

**Not built.** Version comparison inside Studio; it lives on the creation page.

## 6 Interface and motion principles

**Content first.** The card is the media; the caption is a title, handle and favorite count.

**One accent, one meaning.** Ember is action, focus and favorites; brass, sage and iris carry meaning only.

**Motion reports state, then stops.** Four keyframes: `thread` (the weaving bar and skeleton shimmer), `rise` (cards, toasts and sheets entering), `sink` (sheets leaving) and `pop` (the heart). Durations are 140, 220 and 360ms on one curve, `--ease-weave`. No progress percentages: no provider reports one. Under `prefers-reduced-motion`, animations and transitions drop to 1ms.

**Hover is never the only way.** Keyboard focus plays a preview, and Make shows when focused; below 1024px Make is always visible and video cards have a Preview button. Arrow keys move between cards; sorts are radio groups. Small controls grow to 40px on phones. Previews are muted, load nothing until asked, and autoplay is off by default.

**Platform dialogs.** Sheets are native `<dialog>` elements, bottom sheets on phones. Toasts are a polite live region that clears the tab bar and job tray. The skip link is the first Tab stop. The browser journey checks accessible names on Explore, keyboard reach and widths of 390, 820 and 1440px.

**Honesty is visual.** Demo output carries the Demo badge, the watermark "DEMO OUTPUT · NOT AI-GENERATED" and a model name ending in "(not AI)". Sandboxes share the iris tone: "Sandbox · demo" on `/pricing/sandbox`, "Sandbox" on `/verify/sandbox`, "Development scanner · not live" in admin review.

## 7 Ideal user journey

1. **Discover.** A visitor with no session and no `hl_age_ok` cookie first sees "Adults only" with "I am 18 or older, enter" and "Leave"; it calls itself "a notice, not age verification". Signed-in members never see it, and `/policies` is always open. Where the visitor's region requires an age check, cards keep titles and creators but carry no media URL, only "Sign in and verify to see previews" (`src/server/age/access.ts`).

2. **Choose.** A card opens `/templates/[slug]`: preview, badges, creator with Follow and the create panel, with the cost visible even when signed out.

3. **Personalize.** Make it with the defaults, or open Tweak, use "Say it plainly", upload a photo (a consent sheet comes first) or pick a consented character.

4. **Generate.** Signed out, Make it leads to `/auth` and back. Signup takes a date of birth, terms and an adult attestation; under 18 is refused on the server. Credits come from `/pricing` (the sandbox here). Make it creates a draft (`POST /api/generations`); the server checks the session, age rule, content policy, input ownership, consent and scan state, model capabilities and VIP access, then returns the cost. Where the member's jurisdiction requires an age check they have not passed, it returns 451, "Your region requires an age check before you can create or upload", pointing to Settings › Age verification. The check runs there (Yoti, unverified, or the sandbox) and a signed callback records the result. Then the confirmation sheet shows cost, balance after and model. Confirm sends the expected cost; a changed price is refused. Credits are reserved and a real job is queued.

5. **Receive the result.** The job tray shows "Weaving" and elapsed seconds, polling every 3 seconds (15 in a background tab). The output is scanned before it is attached. A toast offers to open it, and push can too. A failure ends "Your credits were returned", and the release happens in the same transaction that fails the job.

6. **Remix or continue.** The creation page offers the next move: Remix, Retry, Variation, Continue or Extend for clips, Reuse settings, Preset, Publish. Every derived job confirms through a cost sheet.

7. **Return to discovery.** The creation links to its template and project; For you and Continue exploring reflect the session. A related rail on the creation page is not built.

## 8 Non-visual reliability, quality, privacy and cost improvements

**State machine.** A job moves from `awaiting_confirmation` to `queued`, `processing`, then `completed`, `failed` or `cancelled`. Each transition is an update guarded by the current status, most under a row lock (`src/server/generation/`). Draft and confirm are idempotent. Retryable errors requeue with the reservation held, up to three attempts; `PROVIDER_TIMEOUT_S` aborts slow providers. A reconciler runs every minute: it re-enqueues stale jobs, fails and refunds stuck ones, and closes day-old drafts.

**Ledger.** Every balance change locks the account row, checks an idempotency key and writes a ledger row in one transaction (`src/server/credits/ledger.ts`). Reserve on confirm, settle on completion, release on failure, cancellation or timeout: a job is charged once or refunded once, never both.

**Consent and privacy.** Signup records terms and an adult attestation; each upload and character reference has its own consent. Withdrawing one deletes every creation made with it and purges the files. Account deletion needs the password, erases the date of birth and purges after 30 days. Private media is served only through HMAC-signed links issued after an ownership check, five minutes by default; forged links get 403, deleted or uncleared assets 404. The site sends `noindex`, cannot be framed and refuses cross-origin writes.

**Payments: built, sandbox.** Stripe bans adult content, AI-generated included ([Stripe](https://stripe.com/legal/restricted-businesses)), so payments sit behind an adapter chosen by `PAYMENT_PROVIDER`. CCBill and Segpay are unverified; Stripe stays off, its policy cited in `src/server/env.ts`. Unsigned, forged and stale events are rejected; a duplicate grants credits once; a refund claws credits back through the ledger; a chargeback flags the account and blocks checkout until an admin clears it. The default sandbox never charges and refuses a live site.

**Age verification: built, sandbox.** The UK has required "highly effective age assurance" where users generate or upload pornographic content since 25 July 2025 ([Ofcom](https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance)), and 27 US states have similar laws ([Free Speech Coalition](https://www.freespeechcoalition.com/faq)). Default rules cover the UK and 25 states (`src/config/jurisdictions.ts`), as configuration to re-check before launch, not legal advice. Members there who have not passed cannot generate, upload or see template media. Status, dates and the provider's reference are stored, never ID images or biometrics. Location comes from edge geo headers; with none, `AGE_VERIFICATION_FAIL_CLOSED` decides, and its default (false) allows creation. The owner's edge must set the headers and strip client copies.

**Scanning: built, development scanner.** Every upload, video keyframe and output is scanned before storage or display; only clean assets are served, used or published. A match puts the file on legal hold, suspends and flags the owner, and opens a case in `/admin/review` for a human to report to NCMEC or another authority. With `SCAN_FAIL_CLOSED` on (the default), an outage refuses uploads with a retry message and requeues outputs with credits held. A live site's configuration check refuses the dev scanner while it is on; with it off, the dev scanner returns "unavailable" there and nothing is served. PhotoDNA is unverified. [Cloudflare's tool](https://blog.cloudflare.com/the-csam-scanning-tool/) scans only cached images and Hushloom's media is private, so it would see nothing. `docs/abuse-response.md` is the runbook; its legal statements await counsel.

**Installable web app: built, push needs keys.** Apple and Google ban sexually explicit apps ([App Store 1.1.4](https://developer.apple.com/app-store/review/guidelines/), [Google Play](https://support.google.com/googleplay/android-developer/answer/9878810)). Hushloom has a manifest, icons and a service worker that caches the app shell only, never `/api`, media or signed-in pages. Install is offered in Settings only; offline, nothing is queued. Push is opt-in per account and device, removed at sign-out, and says only "Your creation is ready" or that one did not finish or was cancelled. Without VAPID keys the switch is disabled: "Push is not configured on this server." Install and delivery on real devices are unverified.

**Quality and cost.** Redacted JSON logs, an optional error webhook, health endpoints, rate limits, concurrency caps that plans raise, and placeholder prices (`src/config/pricing.ts`).

## 9 Four-phase evolution plan

- **Phase one, Foundation** (design system, navigation, discovery, auth, Library): complete.
- **Phase two, Intelligence and generation** (adapters, jobs, worker, ledger, copilot): complete, on demo models.
- **Phase three, Continuous creativity** (projects, continuity, variations, version compare, presets, Studio): complete except alternate angles.
- **Phase four, Ecosystem** (profiles, publishing, following, analytics, moderation): largely complete; editable collections and avatars remain.

The launch-readiness addendum (payments, age verification, scanning, the web app) is built, merged and tested in sandbox mode. Still open: a browser journey on the merged build, an adversarial review and a visual review.

## 10 Creative constitution

Keep, always:

1. The gallery is the home page. Media first, a short caption.
2. Templates drive discovery. A template is a recipe with a creator's name.
3. Generation is fast and simple: a card, a tap, a confirmation.
4. The presentation is dark and immersive: ink, bone, one ember accent.
5. This is an adult product, and it says so at the door.
6. The community is visible: creators, follows, favorites, attribution.
7. Controls are compact: chips, pills, rails, sheets.
8. Navigation stays recognizable: Discover, Create, Library, Train, then Projects, Studio, Favorites.
9. Previews are clear: poster, muted preview, badges.
10. Experimentation is optional and one link deeper.

Never:

- Replace the gallery with a dashboard.
- Require a chatbot or any conversation.
- Force a beginner into an advanced panel.
- Bury a feature. On phones, the You sheet lists every page the tab bar lacks.
- Animate for decoration.
- Interrupt browsing with monetization. Cost appears at a chargeable action only.
- Trade privacy, consent, accessibility or reliability for engagement.
- Present a demo, a sandbox or a seeded number as real.
- Add a feature because the count looks better.

## 11 Final product vision

Hushloom is a dim, warm, private room where an adult makes the picture or clip they imagined in a few taps, from a template someone published, then keeps going: another take, the next scene, a project that remembers the lighting.

Under the room is a plain machine. A job's state and cost are true. Credits are reserved before work starts and return if it fails. A file is its maker's until they publish a copy. A face is used only with recorded consent and disappears, with everything made from it, when consent is withdrawn. Every file passes the scanner before anyone sees it. With a real provider and an edge that sets location headers, nothing is made or shown without an age check where the law requires one.

Today the whole loop runs on real infrastructure with labeled demo generation; payments, age checks and scanning run as labeled sandboxes, and push waits for keys. The remaining choices (AI provider, processor, age vendor, scanner) are configuration, not rewrites. Until then, no member is told anything untrue.
