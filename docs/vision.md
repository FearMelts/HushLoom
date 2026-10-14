# Hushloom Product Vision

Deliverable A: Hushloom at commit `342afb4`, with every build track and review fix merged. Labels: **Built** (the code does it), **Demo** or **sandbox** (runs, labeled on screen, without the outside service), **Unverified** (written from public documentation, never run against the real service) and **Not built** (planned).

## 1 Opening product framing

Hushloom is an adults-only web app for making images and short videos from templates. A member picks a template another member published, changes as much or as little as they like, and gets the result in a private Library, ready to remix, continue or, if made only from a prompt or template, publish.

The product is one loop: discover, choose, personalize, generate, remix, continue, explore again. Any card leads to a result in two taps and a confirmation.

Three rules shape every decision. What a member makes stays private until they publish a copy. Nothing is faked: a placeholder is labeled in its pixels, its data and every in-app screen, though its push notification still reads like a real one (an open issue). Trust is enforced on the server.

Checks at `342afb4`: typecheck and lint clean; vitest passes 503 tests in 44 files; Playwright passed 36 of 36 on a fresh production build of `ce84bff`, the last code merge (`notes/evidence/e2e-ce84bff.log`).

| Area | In this build | Goes live with |
| --- | --- | --- |
| AI generation | Demo: two local models named "(not AI)"; Replicate unverified | A provider allowing explicit output |
| Payments | Sandbox, no money moves; CCBill, Segpay unverified; Stripe off by default | A CCBill or Segpay account |
| Age verification | Sandbox that proves nothing; Yoti unverified | A Yoti account, edge geo headers |
| Abuse scanning | Dev scanner, test hashes only; PhotoDNA unverified; Cloudflare adapter not a launch option | PhotoDNA approval |
| Docker, CI | Written, never run | A Docker host, GitHub |
| S3 storage | Tested against a stub, never a real bucket | A bucket |

## 2 Current identity and experience

The structural reference is Playbox's category, the template-driven adult AI playground. Hushloom keeps these patterns:

| Pattern kept | Where it lives in Hushloom |
| --- | --- |
| Media-first gallery as home page | `/`: rails, a card grid, short captions |
| Templates with a named creator | `/templates/[id]`, `/creators/[id]` |
| Browse modes | Trending, New, Top rated, Most loved; filters and search (`/explore`) |
| Indicators | VIP, 4K, New and Demo badges; play mark and clip length on video cards |
| Generate from a preview | Make on every card, Make it on every template page |
| Credits as the unit of cost | A credit pill; the cost shown before every charge |
| Personal collection and Train | `/collection`, `/favorites`, `/train` |

It borrows none of the reference's appearance: colors, type, card shape, copy, motion, the loom mark and the wordmark are Hushloom's own.

## 3 Core visual and emotional personality

Hushloom looks like a dim room with warm light. Colors, font families, shadows, durations and the petal and panel radii are tokens in `src/app/globals.css`; type sizes and a few one-off radii are inline. Exceptions: the browser theme and background colors (layout, manifest) and the offline page use hex literals, and each avatar gets a gradient computed from its name. A unit test holds every text token to 4.5:1 contrast on ink.

| Role | Token and value |
| --- | --- |
| Surfaces (red-shifted, never gray) | `ink-950` `#0f0a0d` page, `ink-900` `#160f13` panels, `ink-850` `#1c1419` card media |
| Text | `bone-50` `#f7efe7` primary, `bone-200` labels, `bone-300` secondary, `bone-400` tertiary, `bone-500` `#958480` hints |
| The one accent | `ember-500` `#ff6a4d` fill, `ember-400` focus ring and kickers, `ember-300` italic emphasis |
| Warm second color | `brass-400` `#e2b46d`: loom mark's second thread, hero glow, stars, VIP, credits, warning tint |
| Meaning only | `sage-400` new and success, `iris-400` demo badge fill, `iris-300` video badge text and notices |

Type is three self-hosted variable families. Fraunces, a display serif, carries headings, card titles and the lowercase italic wordmark; its ember italic is the signature ("Pick a template. *Make it yours.*"). Manrope is the body face. JetBrains Mono carries handles, counts and uppercase `.tag` kickers.

Shape is the petal: cards round two opposite corners at 20px and two at 5px, panels at 24px and 8px; buttons and chips are pills. `src/components/ui.tsx` keeps the primitives few: buttons, badges, chips, a switch, sheets, toasts, skeletons, empty states.

Voice is short, warm and second person: "After dark, made by you", "Everything you make stays private unless you publish it" and "A loose thread" for the 404 page.

The feeling: a private place where trying something takes a tap. A little mischievous, never corporate or clinical.

## 4 What stays versus what evolves

What stays is section 2's structure: gallery first, named templates, cost before every charge, compact controls.

What evolves:

- From "input, generate, output" to a loop: remix, retry, vary, continue or publish.
- From one-off clips to projects with scenes, takes, branches and a continuity guide.
- From a form to a companion: inline suggestions and a plain-language interpreter.
- From "generate and hope" to a state machine with reserved credits and automatic refunds.
- From a checkbox to enforced trust: a server-checked date of birth, consent records, signed private media.
- From a banned processor, a bare notice, unscanned files and app stores to adult-processor, age-check and scanning adapters (today labeled sandboxes or a development scanner) and an installable web app.

## 5 Seven major experience upgrades

### System one: AI-powered discovery

**Built.** Home shows For you, Continue exploring, Your favorites, Trending tonight, Following and New; Explore adds sorts, filters and search. For you uses only the categories and tags of templates the member saved, made or viewed, and tags they chose; nothing about the person is inferred. Settings can turn off personalization, or history (which deletes it).

**Demo.** Every seeded template runs on a demo model and shows a Demo badge.

**Not built.** Visual-style similarity; Quick Generate on the card; a media-type mark on image cards.

### System two: intelligent template remix

**Built.** A template page loads its recipe, and Make it works untouched. A collapsed Tweak section offers the model and its own aspect ratios, lengths and qualities; camera and motion intensity where the model supports them; and lighting, framing, atmosphere and, for video, pacing, added to the prompt as words. "Say it plainly" turns a sentence into settings, each with a reason and any cost change. The server validates every setting against the model's capabilities. Remix keeps its parent job and template attribution.

**Demo.** Results come from the demo models.

### System three: invisible creative copilot

**Built.** A rules engine (`src/lib/copilot.ts`) runs as the member types. It blocks prohibited prompts before any credit is spent, flags weak prompts, conflicts and unsupported settings, and suggests camera moves. Each suggestion waits for a click; Undo keeps 20 steps. A Settings switch hides suggestions, but not warnings that would stop a creation. There is no chat window.

**Demo.** None: the engine is deterministic, unit-tested and calls no AI model.

### System four: scene continuity engine

**Built.** Projects hold ordered scenes, each with a continuity guide (lighting, framing, palette, a consented character, notes). A new scene inherits the previous guide; making from a scene folds it into the prompt and settings. Takes can be compared side by side or played in sequence. A character needs a two-checkbox likeness consent and reaches a model only in Demo Still's reference mode, while consent is active and the photo is clean; for clips, continuity "relies on the guide text and settings".

**Demo.** The demo motion model ignores the source clip; the demo still model's blended reference photo is not a likeness match.

**Not built.** Alternate angles.

### System five: living collection

**Built.** The Library grid follows each output's aspect ratio, with filters. Multi-select deletes or files in bulk. A creation page shows the media, any Demo notice, every setting from mode to seed and cost except atmosphere, versions with compare, and up to twelve actions. Deleted files are purged after 30 days unless on legal hold.

**Demo.** Every result comes from a demo model and says so.

### System six: creator ecosystem

**Built.** Creator pages have Follow, the published grid, any collections and, for the owner, 30-day event counts. Editing a published prompt makes a new version. Publishing needs a completed, scan-clean creation, runs the content policy and copies the output to a new public asset, so the original stays private. Anything made from an input file (an upload, a character reference, or the member's own clip in a Continue or Extend) can never be published. Admins work report, takedown (CSAM, NCII and likeness first) and abuse-review queues and an audit log; anyone may request a takedown (`/policies/takedown`).

**Demo.** Published covers come from the demo models.

**Not built.** Creating or editing collections (one is seeded); avatar upload (avatars are initials).

### System seven: optional advanced studio

**Built.** `/studio` is the create panel in studio mode: negative prompt and seed where supported, project and scene placement, presets and a job monitor with cancel.

**Demo.** Studio runs use the demo models.

## 6 Interface and motion principles

**Content first.** The card is the media; the caption is a title, handle and favorite count.

**Motion reports state, then stops.** Six custom keyframes: `thread` (the weaving bar and skeletons, a 1.8s loop), `rise` (cards, toasts and sheets entering), `sink` (sheets leaving), `pop` (the heart, 320ms), and `veil-in` and `veil-out` (the sheet backdrop). Duration tokens are 140, 220 and 360ms on one curve, `--ease-weave`. The tray shows real states and elapsed time, never a progress percentage; the bar is an indeterminate activity loop. Reduced motion drops everything to 1ms.

**Hover is never the only way.** Focusing a card plays its preview and tabbing to Make shows it; below 1024px Make is always visible. Video cards have a Preview button with the clip length at every width. Arrow keys move between cards; the skip link is the first Tab stop.

**Honesty is visual.** Demo output carries the Demo badge, the watermark "DEMO OUTPUT · NOT AI-GENERATED" and a model name ending in "(not AI)". Sandboxes wear the same iris badge: "Sandbox · demo", "Sandbox", "Development scanner · not live".

## 7 Ideal user journey

1. **Discover.** A visitor with no session and no `hl_age_ok` cookie first sees "Adults only" with "I am 18 or older, enter" and "Leave"; it calls itself "a notice, not age verification", and until they enter the server sends no media URLs. Members never see it, and `/policies` is always open. Where the location requires an age check, cards keep titles and creators but show only "Sign in and verify to see previews".

2. **Choose.** A card opens its template page (`/templates/[id]`, linked by slug): preview, badges, creator with Follow, and the create panel with its cost, even when signed out.

3. **Personalize.** Make it as is, or open Tweak, use "Say it plainly", upload a photo after a consent sheet, or pick a consented character.

4. **Generate.** Signed out, Make it leads to `/auth` and back. Signup takes a date of birth, terms and an adult attestation; under 18 is refused on the server. Credits come from `/pricing`. Make it creates a draft after checks of age, policy, ownership, consent, scan state, model capabilities and VIP access; a missing required age check returns 451 with the path to Settings › Age verification. The confirmation sheet shows cost and balance after. Confirm refuses a changed price, runs the age gate again for the request's location and returns 429 at the active-job cap. Only then are credits reserved and a job queued.

5. **Receive the result.** The job tray shows "Weaving" and elapsed seconds, polling every 3 seconds (15 in a background tab). The output is scanned before it is attached; a toast, or push, offers to open it. A failure ends "Your credits were returned".

6. **Remix or continue.** The creation page offers Remix, Retry, Variation, Continue or Extend, Reuse settings, Preset and Publish. Every derived job confirms through a cost sheet.

7. **Return to discovery.** The creation links to its template and project; For you reflects the session.

## 8 Non-visual reliability, quality, privacy and cost improvements

**Jobs and ledger.** A job moves from `awaiting_confirmation` to `queued`, `processing`, then `completed`, `failed` or `cancelled`, each step guarded by the current status. Draft and confirm are idempotent; retryable errors get three attempts; a reconciler re-enqueues stale jobs, refunds stuck ones and closes day-old drafts every minute. Each balance change locks the account and writes a ledger row in one idempotent transaction: reserve on confirm, settle on completion, release on failure.

**Consent and privacy.** Each upload and character reference has its own consent, and withdrawing it deletes every creation made with it. Account deletion needs the password, erases the date of birth and purges after 30 days. Media links are HMAC-signed, private ones for five minutes by default. The site sends `noindex`, cannot be framed and refuses cross-origin writes.

**Payments: built, sandbox.** Stripe bans adult content, AI-generated included ([Stripe](https://stripe.com/legal/restricted-businesses)), so it is off by default; `PAYMENT_PROVIDER` picks CCBill or Segpay, both unverified, or the default sandbox, which never charges and refuses a live site. A webhook without a valid signature or shared secret is rejected, and a duplicate event grants credits once. A refund claws credits back; a chargeback blocks checkout until an admin clears it.

**Age verification: built, sandbox.** Since 25 July 2025 the UK has required "highly effective age assurance" where users generate or upload pornography ([Ofcom](https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance)); 27 US states have similar laws ([Free Speech Coalition](https://www.freespeechcoalition.com/faq)). Default rules cover the UK and 25 states, compiled from that tracker as configuration, not legal advice, and due for a re-check before launch (`src/config/jurisdictions.ts`). A check is required when the stored jurisdiction or the request's location needs one; `AGE_VERIFICATION_FAIL_CLOSED` decides only an unknown location (no code, a marker such as `XX`, or a bare "US"). A sandbox age-check result reads as unverified on a live site. Without a needed check, draft, confirm, upload, new character, publish and download return 451, and a "Verify your age" tile replaces template previews, the member's creations and character photos. ID images are never stored. The owner's edge must set geo headers and strip client copies.

**Scanning: built, development scanner.** Every upload and output is stored privately and scanned before it is used, served or published; a pending file is never signed, and a non-clean one is deleted or held. A match holds the file, suspends the owner, unpublishes their templates and opens a case in `/admin/review` for a human to report to NCMEC. With `SCAN_FAIL_CLOSED` on (the default), an outage refuses uploads and requeues outputs, and a live site will not start on the dev scanner. PhotoDNA is unverified; its success code was written from memory. `SCAN_PROVIDER=cloudflare` is unverified and not a launch option: Cloudflare scans only edge-cached images, and app media is private, so it would see nothing. The runbook, `docs/abuse-response.md`, awaits legal review.

**Installable web app: built; push needs VAPID keys.** Apple and Google ban sexually explicit apps ([App Store 1.1.4](https://developer.apple.com/app-store/review/guidelines/), [Google Play](https://support.google.com/googleplay/android-developer/answer/9878810)). The service worker caches the app shell only, never `/api`, media or signed-in pages. Push is opt-in per device, removed at sign-out, and says only that a creation is ready, failed or was cancelled. Real-device install and push are unverified.

**What the adversarial review hardened.** Seven finders returned 62 raw findings, triaged to 49: 1 critical, 12 high, 22 medium and 14 low (`notes/analysis/review/triage.json`). All 49 were fixed, each with a test that failed on the old code. Then 90 attack attempts on the fixes found 39 holes: 37 were patched and 2 await a product decision.

- **Payments.** A sale short of the price or in another currency is held for manual review. CCBill stays off without `CCBILL_WEBHOOK_TOKEN`. A refund that arrives before its sale waits and applies once; credits it cannot take back at once go on a `credit_debt` flag. Stopping rebilling leaves a pass `non_renewing` until its paid period ends; deleting an account ends its passes.
- **Media.** All media, S3 included, goes through `/api/media`, which re-checks the file on every request. Public media is served only while a published template uses it. A link lives at most 1.1 times its TTL. Uploads over 40 megapixels, and video over 60 seconds or 4096px, are refused; alpha is flattened; video is scanned across its whole length.
- **Takedowns.** Byte-identical copies are removed on every account, a hash block stops republishing (409 `taken_down`), and a CSAM takedown suspends the owner. Near-duplicates are not matched, and a taken-down file can still be regenerated privately.
- **Auth.** Per-IP limits (sign-up, sign-in, takedowns) trust only the forwarded address `TRUSTED_PROXY_HOPS` names; at the default of 0 they share one key for the whole site, so a deployment behind a proxy must set 1 or more. Limits fail closed (503) while Redis is down and cover account deletion; `?next=` lands only on same-origin paths.
- **Generation.** Concurrent confirms respect the active-job cap; deleted jobs are cancelled and refunded; a VIP template's recipe is withheld from viewers without a pass.

**Known limits and open questions.**

- Left for a product decision: ten wrong guesses lock an account's sign-in and deletion for 15 minutes, owner included (R05-H6); without email verification, sign-up reveals whether an email is registered (R05-H7).
- Reversible defaults for the owner to confirm: unknown locations are allowed (R14); byte-identical removal across accounts applies to every takedown category, copyright included, and reaches private copies (R08-A3); and the rules for VIP recipes (R35) and sandbox age-check results (R16).
- Processor questions: does CCBill keep the `X-` prefix on pass-through values (if not, sales are recorded but grant nothing), and which `transactionId` does a reversal carry? CCBill and Segpay stop replays by event id alone.

**Quality and cost.** Redacted JSON logs, an optional error webhook, health endpoints, concurrency caps that plans raise, and placeholder prices (`src/config/pricing.ts`).

## 9 Four-phase evolution plan

- **Phase one, Foundation** (design system, navigation, discovery, auth, Library): complete except Quick Generate on the card and a media-type mark on image cards; responsive layouts await the 390, 820 and 1440px visual review.
- **Phase two, Intelligence and generation** (adapters, jobs, ledger, copilot): complete, on demo models.
- **Phase three, Continuous creativity** (projects, continuity, variations, Studio): complete except alternate angles.
- **Phase four, Ecosystem** (profiles, publishing, moderation, recommendations): largely complete; collection editing, avatar upload and visual-style similarity remain.

This build completes phase two, most of phases one, three and four, and the launch-readiness addendum in sandbox mode. Still open in the tracker: that visual review, verifying these documents, the Copilot comparison and the final report. Going live needs the owner's accounts, real-service adapter runs and the section 8 decisions.

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
- Bury a feature.
- Animate for decoration.
- Interrupt browsing with monetization. Cost appears at a chargeable action only.
- Trade privacy, consent, accessibility or reliability for engagement.
- Present a demo, a sandbox or a seeded number as real.
- Add a feature because the count looks better.

## 11 Final product vision

Hushloom is a dim, warm, private room where an adult makes the picture or clip they imagined in a few taps, from a template someone published, then keeps going: another take, the next scene, a project that remembers the lighting.

Under the room is a plain machine. Credits are reserved before work starts and return if it fails. A file is its maker's until they publish a copy. A face is used only with recorded consent and disappears, with everything made from it, when consent is withdrawn. Every file passes the scanner before anyone sees it. Where the rules require an age check, nothing is made and no explicit media is shown until the member passes one.

Today generation, payments, age checks and scanning run in labeled demo, sandbox or development modes, and their real-service adapters are unverified. Every in-app screen and every demo output's pixels label the placeholders.
