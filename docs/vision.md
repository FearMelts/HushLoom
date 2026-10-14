# Hushloom Product Vision

Deliverable A, describing Hushloom at commit `342afb4` (14 October 2026), with every build track, the launch journey and every review fix merged. Labels: **Built** (the code does it), **Demo** or **sandbox** (runs, labeled on screen, without the outside service), **Unverified** (written from public documentation, never run against the real service) and **Not built** (planned).

## 1 Opening product framing

Hushloom is an adults-only web app for making images and short videos from templates. A member picks a template another member published, changes as much or as little as they like, and gets the result in a private Library, ready to remix, continue or publish.

The product is one loop: discover, choose, personalize, generate, remix, continue, explore again. Any card leads to a result in two taps and a confirmation; depth waits for those who want it.

Three rules shape every decision. What a member makes stays private until they publish a copy. Nothing is faked: a placeholder is labeled in its pixels, its data and every screen. Trust is enforced on the server.

At `342afb4`, typecheck and lint are clean and vitest passes 503 tests in 44 files. All 36 Playwright tests passed on a fresh production build of the last code merge, `ce84bff` (`notes/evidence/e2e-ce84bff.log`).

| Area | In this build | Goes live with |
| --- | --- | --- |
| AI generation | Demo: two local models named "(not AI)"; Replicate unverified | A provider allowing explicit output |
| Payments | Sandbox, no money moves; CCBill, Segpay unverified; Stripe off | A CCBill or Segpay account |
| Age verification | Sandbox that proves nothing; Yoti unverified | A Yoti account, edge geo headers |
| Abuse scanning | Dev scanner, test hashes only; PhotoDNA unverified | PhotoDNA approval |
| Push | Off, and says so | VAPID keys |
| Docker, CI, S3 | Written, never run | A Docker host, GitHub, a bucket |

## 2 Current identity and experience

The structural reference is Playbox's category, the template-driven adult AI playground. Hushloom keeps these patterns:

| Pattern kept | Where it lives in Hushloom |
| --- | --- |
| Media-first gallery as home page | `/`: rails, a card grid, short captions |
| Templates with a named creator | `/templates/[id]` (id or slug), `/creators/[id]` (by handle) |
| Browse modes | Trending, New, Top rated, Most loved; filters and search (`/explore`) |
| Indicators | VIP, 4K, New and Demo badges; play mark and clip length on video cards |
| Generate from a preview | Make on every card, Make it on every template page |
| Credits as the unit of cost | A credit pill; the cost shown before every charge |
| Personal collection and Train | `/collection`, `/favorites`, `/train` |

It borrows none of the reference's appearance: colors, type, card shape, wordmark, icons, copy and motion are Hushloom's own.

## 3 Core visual and emotional personality

Hushloom looks like a dim room with warm light. Every value is a token in `src/app/globals.css`; components never hardcode hex.

| Role | Token and value |
| --- | --- |
| Surfaces (red-shifted, never gray) | `ink-950` `#0f0a0d` page, `ink-900` `#160f13` panels, `ink-850` `#1c1419` card media |
| Text | `bone-50` `#f7efe7` primary, `bone-200` labels, `bone-300` secondary, `bone-400` tertiary, `bone-500` `#958480` hints |
| The one accent | `ember-500` `#ff6a4d` fill, `ember-400` focus ring and kickers, `ember-300` italic emphasis |
| Meaning only | `brass-400` VIP and credits, `sage-400` new and success, `iris-400` demo badge fill, `iris-300` video badge text and notices |

A unit test holds every text token to 4.5:1 contrast on ink.

Type is three self-hosted variable families. Fraunces, a display serif, carries headings, card titles and the lowercase italic wordmark; its ember italic is the signature ("Pick a template. *Make it yours.*"). Manrope is the body face. JetBrains Mono carries handles, counts and uppercase `.tag` kickers.

Shape is the petal: cards round two opposite corners at 20px and two at 5px, panels at 24px and 8px; buttons and chips are pills. `src/components/ui.tsx` keeps the primitives few: buttons, badges, chips, a switch, sheets, toasts, skeletons, empty states.

Voice is short, warm and second person: "After dark, made by you", "Everything you make stays private unless you publish it", "Weaving" for a running job, "A loose thread" for the 404 page, and "This is a sandbox. No money moves."

The feeling: a private, well-made place where trying something takes a tap. A little mischievous, never corporate or clinical.

## 4 What stays versus what evolves

What stays is section 2's structure: gallery first, named templates, cost before every charge, compact controls.

What evolves:

- From "input, generate, output" to a loop: any creation can be remixed, retried, varied, continued or published.
- From one-off clips to projects with scenes, takes, branches and a continuity guide.
- From a form to a companion: inline suggestions and a plain-language interpreter.
- From "generate and hope" to a state machine with reserved credits and automatic refunds.
- From a checkbox to enforced trust: a server-checked date of birth, consent records, signed private media.
- From a banned processor, a bare notice, unscanned files and app stores to adapters for adult processors, age checks and scanning (labeled sandboxes or a development scanner until verified, section 8), plus an installable web app.

## 5 Seven major experience upgrades

### System one: AI-powered discovery

**Built.** Home shows For you, Continue exploring, Your favorites, Trending tonight, Following and New; Explore adds sorts, filters and search. For you uses only the categories and tags of templates the member saved, made or viewed, and tags they chose; nothing about the person is inferred (`src/server/discovery/templates.ts`). Settings can turn off personalization, or history (which deletes it).

**Demo.** Every seeded template runs on a demo model and shows a Demo badge.

**Not built.** Visual-style similarity; Quick Generate on the card; a media-type mark on image cards.

### System two: intelligent template remix

**Built.** A template page loads its recipe, and Make it works untouched. A collapsed Tweak section offers the model and its own aspect ratios, lengths and qualities; camera and motion intensity where the model supports them; and lighting, framing, atmosphere and, for video, pacing, added to the prompt as words (`src/components/create-panel.tsx`). "Say it plainly" turns a sentence into settings, each with a reason and any cost change. The server validates every setting against the model's capabilities (`src/server/ai/registry.ts`). Remix keeps its parent job and template attribution.

**Demo.** Results come from the demo models.

### System three: invisible creative copilot

**Built.** A rules engine (`src/lib/copilot.ts`) runs as the member types. It blocks prohibited prompts before any credit is spent, flags weak prompts, conflicts and unsupported settings, and suggests camera moves. Each suggestion waits for a click; Undo keeps 20 steps. A Settings switch hides suggestions, but not warnings that would stop a creation. There is no chat window.

**Demo.** None: the engine is deterministic, unit-tested and calls no AI model.

### System four: scene continuity engine

**Built.** Projects hold ordered scenes, each with a continuity guide (lighting, framing, palette, a consented character, notes). A new scene inherits the previous guide; making from a scene folds it into the prompt and settings. Only stills use the character: for clips the panel says continuity "relies on the guide text and settings". Takes can be compared side by side or played in sequence. A character reference needs a two-checkbox likeness consent and reaches the provider only in Demo Still's reference mode, while consent is active and the photo is clean. No model claims continuity; for continue and extend the copilot says "Continuity is a goal, not a guarantee".

**Demo.** The demo motion model ignores the source clip; the demo still model's blended reference photo is not a likeness match.

**Not built.** Alternate angles.

### System five: living collection

**Built.** The Library grid follows each output's aspect ratio, with filters from media and status to template creator and dates. Multi-select deletes or files in bulk; Retry opens a cost sheet first. A creation page shows the media, any Demo notice, every setting down to seed and cost, versions with compare, and up to twelve actions. Deleted files are purged after 30 days unless on legal hold.

**Demo.** Every result comes from a demo model and says so.

### System six: creator ecosystem

**Built.** Creator pages have Follow, the published grid, any collections and, for the owner, 30-day event counts. Editing a published prompt makes a new version. Publishing needs a completed, scan-clean creation, runs the content policy and copies the output to a new public asset, so the original stays private; the publish sheet also asks for a checkbox. Creations from uploads or character references can never be published. Admins work a reports queue (newest first), a takedown queue (CSAM, NCII and likeness first), an abuse-review queue (oldest first) and an audit log; anyone may request a takedown (`/policies/takedown`).

**Demo.** Published covers come from the demo models.

**Not built.** Creating or editing collections (the one collection is seeded); avatar upload (avatars are initials).

### System seven: optional advanced studio

**Built.** `/studio` is the create panel in studio mode: negative prompt and seed where supported, project and scene placement, presets and a job monitor with cancel. It is a link, never a gate.

**Demo.** Studio runs use the demo models.

## 6 Interface and motion principles

**Content first.** The card is the media; the caption is a title, handle and favorite count.

**Motion reports state, then stops.** Six custom keyframes: `thread` (weaving bar and skeleton shimmer, a 1.8s loop), `rise` (cards, toasts and sheets entering), `sink` (sheets leaving), `pop` (the heart, 320ms), and `veil-in` and `veil-out` (sheet backdrop); Tailwind's spin and pulse mark a busy button and a running job. Duration tokens are 140, 220 and 360ms on one curve, `--ease-weave`. No progress percentages: no provider reports one. Reduced motion drops everything to 1ms.

**Hover is never the only way.** Keyboard focus plays a preview and shows Make; below 1024px Make is always visible. Video cards have a Preview button with the clip length at every width. Arrow keys move between cards; the skip link is the first Tab stop. Browser tests check labeled controls, keyboard reach and no sideways scroll at 390, 820 and 1440px.

**Honesty is visual.** Demo output carries the Demo badge, the watermark "DEMO OUTPUT · NOT AI-GENERATED" and a model name ending in "(not AI)". Sandboxes share the iris tone: "Sandbox · demo" on `/pricing/sandbox`, "Sandbox" on `/verify/sandbox`, "Development scanner · not live" in admin review.

## 7 Ideal user journey

1. **Discover.** A visitor with no session and no `hl_age_ok` cookie first sees "Adults only" with "I am 18 or older, enter" and "Leave"; it calls itself "a notice, not age verification", and until they enter the server sends no media URLs. Members never see it, and `/policies` is always open. Where the location requires an age check, cards keep titles and creators but show only "Sign in and verify to see previews" (`src/server/age/access.ts`).

2. **Choose.** A card opens its template page (`/templates/[id]`, linked by slug): preview, badges, creator with Follow, and the create panel with its cost, even when signed out.

3. **Personalize.** Make it as is, or open Tweak, use "Say it plainly", upload a photo after a consent sheet, or pick a consented character.

4. **Generate.** Signed out, Make it leads to `/auth` and back. Signup takes a date of birth, terms and an adult attestation; under 18 is refused on the server. Credits come from `/pricing`. Make it creates a draft (`POST /api/generations`) once the server has checked age, policy, ownership, consent, scan state, model capabilities and VIP access. If a required age check is missing, it returns 451 and the path to Settings › Age verification. The confirmation sheet shows cost and balance after. Confirm refuses a changed price, runs the age gate again for the request's location and returns 429 at the active-job cap. Only then are credits reserved and a job queued.

5. **Receive the result.** The job tray shows "Weaving" and elapsed seconds, polling every 3 seconds (15 in a background tab). The output is scanned before it is attached; a toast, or push, offers to open it. A failure ends "Your credits were returned".

6. **Remix or continue.** The creation page offers Remix, Retry, Variation, Continue or Extend, Reuse settings, Preset and Publish. Every derived job confirms through a cost sheet.

7. **Return to discovery.** The creation links to its template and project; For you reflects the session.

## 8 Non-visual reliability, quality, privacy and cost improvements

**Jobs and ledger.** A job moves from `awaiting_confirmation` to `queued`, `processing`, then `completed`, `failed` or `cancelled`, each step guarded by the current status (`src/server/generation/`). Draft and confirm are idempotent; retryable errors get three attempts; a reconciler re-enqueues stale jobs, refunds stuck ones and closes day-old drafts every minute. Each balance change locks the account and writes a ledger row in one idempotent transaction (`src/server/credits/ledger.ts`): reserve on confirm, settle on completion, release on failure, so a job is charged once or refunded once.

**Consent and privacy.** Each upload and character reference has its own consent, and withdrawing it deletes every creation made with it. Account deletion needs the password, erases the date of birth and purges after 30 days. Media links are HMAC-signed, private ones for five minutes by default. The site sends `noindex`, cannot be framed and refuses cross-origin writes.

**Payments: built, sandbox.** Stripe bans adult content, AI-generated included ([Stripe](https://stripe.com/legal/restricted-businesses)), so Stripe stays off and `PAYMENT_PROVIDER` picks CCBill or Segpay, both unverified, or the default sandbox, which never charges and refuses a live site. Unsigned and forged events are rejected; CCBill and Segpay have no freshness check yet. A duplicate event grants credits once, a refund claws credits back, and a chargeback blocks checkout until an admin clears it.

**Age verification: built, sandbox.** The UK has required "highly effective age assurance" where users generate or upload pornographic content since 25 July 2025 ([Ofcom](https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance)), and 27 US states have similar laws ([Free Speech Coalition](https://www.freespeechcoalition.com/faq)). Default rules cover the UK and 25 states (`src/config/jurisdictions.ts`): configuration, not legal advice. A check is required when the stored jurisdiction or the request's location needs one. `AGE_VERIFICATION_FAIL_CLOSED` decides only an unknown location: no code, a reserved marker such as `XX`, or a bare "US" (`src/server/age/rules.ts`). Without a needed check, a member gets 451 on draft, confirm, upload, new character, publish and download, and sees a "Verify your age" tile in place of template previews, their own creations and character photos. Hushloom stores status, dates and the provider's reference, never ID images. The owner's edge must set geo headers and strip client copies.

**Scanning: built, development scanner.** Every upload, sampled video frame and output lands in private storage and is scanned before it is used, served or published; a pending file is never signed, and a non-clean one is deleted or held. A match holds the file, suspends the owner, unpublishes their templates and opens a case in `/admin/review` for a human to report to NCMEC. With `SCAN_FAIL_CLOSED` on (the default), an outage refuses uploads and requeues outputs, and a live site will not start on the dev scanner. PhotoDNA is unverified; its success code was written from memory. [Cloudflare's tool](https://blog.cloudflare.com/the-csam-scanning-tool/) scans only cached images, so with private media it would see nothing. `docs/abuse-response.md` is the runbook; its legal statements await counsel.

**Installable web app: built, push needs keys.** Apple and Google ban sexually explicit apps ([App Store 1.1.4](https://developer.apple.com/app-store/review/guidelines/), [Google Play](https://support.google.com/googleplay/android-developer/answer/9878810)). Hushloom's service worker caches the app shell only, never `/api`, media or signed-in pages. Push is opt-in per device, removed at sign-out, and says only that a creation is ready, failed or was cancelled. Real-device install and push are unverified.

**What the adversarial review hardened.** Seven finders returned 62 raw findings, triaged to 49: 1 critical, 12 high, 22 medium and 14 low (`notes/analysis/review/triage.json`). All 49 were fixed, each with a test that failed on the old code. Then 90 attack attempts on the fixes found 39 holes: 37 were patched and 2 were left for a product decision (`notes/progress.md`). By area:

- **Payments.** Sales short of the price or in another currency are held for review. A refund that beats its sale waits and applies once. Credits a refund cannot reclaim go on a `credit_debt` flag.
- **Media.** All media, S3 included, goes through `/api/media`, re-checked on every request. Public media is served only while a published template uses it. Uploads over 40 megapixels, and video over 60 seconds or 4096px, are refused; video is scanned across its whole length.
- **Takedowns.** Byte-identical copies are removed on every account (to confirm, below), a hash block stops republishing (409 `taken_down`), and a CSAM takedown suspends the owner.
- **Auth.** `TRUSTED_PROXY_HOPS` sets which forwarded address rate limits trust; rate limits fail closed (503) without Redis; `?next=` lands only on same-origin paths.
- **Generation.** Concurrent confirms respect the active-job cap; deleted jobs are cancelled and refunded; a VIP recipe is withheld from viewers without a pass.

**Known limits and open questions.**

- Left for a product decision: ten wrong guesses from anywhere lock an account's sign-in and deletion for 15 minutes, owner included (R05-H6); sign-up reveals whether an email is registered until email verification exists (R05-H7).
- Reversible calls for Jayvo to confirm: `AGE_VERIFICATION_FAIL_CLOSED` defaults to false, so unknown locations are allowed (R14); takedowns remove copies in every category, copyright included (R08-A3); the VIP recipe rule (R35); a sandbox pass reads as unverified on a live site (R16).
- Takedown gaps: a taken-down file can still be regenerated privately, and near-duplicates are not matched.
- Processor go-live questions: does CCBill keep the `X-` prefix on pass-through values (if not, sales are held)? Is a reversal's `transactionId` the sale's or new?

**Quality and cost.** Redacted JSON logs, an optional error webhook, health endpoints, concurrency caps that plans raise, and placeholder prices (`src/config/pricing.ts`).

## 9 Four-phase evolution plan

- **Phase one, Foundation** (design system, navigation, discovery, cards, auth, Library, generation entry points): complete except Quick Generate on the card and a media-type mark on image cards.
- **Phase two, Intelligence and generation** (adapters, jobs, worker, ledger, copilot): complete, on demo models.
- **Phase three, Continuous creativity** (projects, continuity, variations, version compare, presets, Studio): complete except alternate angles.
- **Phase four, Ecosystem** (profiles, publishing, following, analytics, moderation, recommendations): largely complete; collection editing, avatar upload and visual-style similarity remain.

This build completes phase two and most of phases one, three and four, with the gaps above. The launch-readiness addendum is built and tested in sandbox mode. The browser journey and the adversarial review are done; of the planned checks, only the visual review at 390, 820 and 1440px remains. Going live needs the owner's accounts, real-service adapter runs and the section 8 decisions.

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

Under the room is a plain machine. Credits are reserved before work starts and return if it fails. A file is its maker's until they publish a copy. A face is used only with recorded consent and disappears, with everything made from it, when consent is withdrawn. Every file passes the scanner before anyone sees it. With a real provider and edge location headers, nothing is made or shown without an age check where the rules require one.

Generation, payments, age checks and scanning run today in labeled demo, sandbox or development modes. Adapters exist for Replicate, CCBill, Segpay, Yoti and PhotoDNA; each is unverified and may need changes against the real service. Meanwhile, no member is told anything untrue.
