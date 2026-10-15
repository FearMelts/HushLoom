# Jayvo's specification (verbatim essentials; message of 2026-10-12 20:30)

Overrides from Jayvo's later messages: the product is named **Hushloom**, the repo is FearMelts/HushLoom, and the site must look NOTHING like playbox.com. Playbox informs structure and interaction patterns only, never appearance. Where the spec says "preserve the existing aesthetic", read "preserve the information architecture and interaction patterns; use Hushloom's own look".

PLAYBOX 2.0 — THE ULTIMATE AI-NATIVE CREATIVE PLAYGROUND
Mission: conceptualize, architect, design, implement, test, and deliver a sophisticated, adult-oriented, AI-native image and video creation playground. Not a theoretical design exercise: real navigation, persistent data, working interface interactions, extensible AI infrastructure, generation management.
Foundational directive: Preserve the soul. Expand the possibilities.

PART I — PRODUCT IDENTITY
Playbox is an NSFW-friendly, adult-oriented, template-driven AI creative playground built around rapid visual discovery, image generation, short AI-video creation, and experimentation. Established experience: media-first Explore gallery; searchable creator templates; Trending, New, Top Rated, Most Favorited browsing; VIP and 4K indicators; image and video generation entry points; personal Collection; Train section; creator attribution; reusable templates; credit-based generation; short video previews and outputs; immediate Generate actions; browsing that encourages spontaneous experimentation.
Strongest qualities: Media-first. Instant gratification. Discovery-driven. Community-powered.
Visual personality (structure-level, since Hushloom has its own look): dark, high-contrast; media-dominant cards; dense but readable discovery; compact controls; clear immediate CTAs; immersive browsing; minimal interruption between discovery and generation; bold, provocative, playful, adult-oriented energy.
Must not feel like: corporate SaaS, admin dashboard, generic chatbot, complicated video editor, sterile image lab, social media clone, settings-burdened website.
Personality: a visually sophisticated, mischievous creative companion that constantly reveals new possibilities while making powerful technology feel effortless.

PART II — CENTRAL VISION
Conventional: Input → Generate → Output. Ours: Discover → Choose → Personalize → Generate → Remix → Continue → Explore Again.
Three layers: A The Playground (effortless template → generate). B The Creative Companion (contextual AI suggestions, never takes control). C The Advanced Studio (progressive disclosure: settings, scene continuity, presets, variations, consistency, project timelines; never mandatory).
Rule: More power, less friction, same personality.

PART III — SEVEN CORE SYSTEMS
1 AI-Powered Discovery: keep browsing categories; optional layers For You, Similar Creations, Continue Exploring, Recommended Templates, Recently Viewed, Saved Inspirations, Following, Related Visual Styles. Each template: poster/media preview, title, creator, media type, duration, quality/VIP indicators, favorite, Quick Generate, details, related, remix. Signals: favorites, viewed categories, explicit preferences, saved interests. Users control personalization and can clear history. Never infer sensitive attributes. Fast browsing, skeletons, lazy media, keyboard nav, responsive gallery.
2 Intelligent Template Remix: select template → generate with defaults immediately. Optional personalization: image upload, prompt editing, camera movement, motion intensity, scene pacing, atmosphere, lighting, framing, aspect ratio, duration, quality, presets. AI translates natural language into settings; show interpreted settings before submission when they change result or cost; validate incompatible combos; preserve template defaults unless overridden. Actions: Generate, Remix, Reuse Settings, Save Preset, Create Variation, Continue Scene. No multi-step wizard for ordinary generation.
3 Invisible Creative Copilot: embedded, distributed; improves prompts, recommends templates, detects unsupported aspect ratios, flags low-res uploads, explains artifacts, recommends motion/camera, detects conflicts, suggests coherent settings, explains controls, helps reproduce results, assists scene extensions. Small contextual suggestions; never auto-overwrite prompts; show changes before applying; Undo and Restore Original; no unsolicited conversation; user-controlled preferences.
4 Scene Continuity Engine: extend videos, continue scene, alternate angles, reuse character references, preserve attributes, lighting/framing guidance, branches, compare variations, shot sequences. Scene workspace: lightweight timeline (clips, sequence, history, settings, references, branches, continuation actions). Distinguish desired vs guaranteed consistency; provider-specific feature validation; identity workflows only for authorized adult subjects.
5 Living Collection: creations, saved templates, favorites, history, folders, projects, prompt history, version comparison, metadata, presets, timelines, downloads, deletion. Filters: images, videos, favorites, projects, date, status, template, creator, quality, model. Version branching. Open a creation → Remix, Retry, Create Variation, Continue, Save, Download, Delete. Media-dominant.
6 Creator Ecosystem: profiles (display name, avatar, bio, published templates, collections, followers, favorites, approved analytics). Publishing, editing metadata, unpublishing, versioning, remix attribution, following, public collections, search/filter, moderation and reporting. Privacy: private generations never auto-public; publishing explicit; uploads, prompts, histories private by default; analytics never expose others' private content.
7 Optional Advanced Studio: prompt editor, negative prompt where supported, model selection, aspect ratio, duration, quality, motion intensity, camera direction, seed where supported, reference image management, presets, scene sequencing, version comparison, history, credit estimates, job status. Optional; same components and visual language; "a deeper room inside the playground".

PART IV — VISUAL DESIGN AND INTERACTION
Design system with centralized tokens: background/surface, text, border, accent, radius, spacing, typography, elevation, motion durations, curves, breakpoints. Document assumed values.
Alive interface: hover/touch previews, card transitions, skeletons, button states, favorite animations, toasts, drawer transitions, generation progress feedback, gallery-to-detail transitions, subtle confirmations. Animations communicate state. Honor reduced motion. No autoplay audio. Accessible alternatives for hover-only. Content gets more attention than controls.

PART V — CORE JOURNEY
Discover → Choose (preview, metadata, creator, Generate visible) → Personalize (defaults or options; AI available) → Generate (checks authorization, input compatibility, entitlements, credits, estimated cost; user confirms chargeable ops; real job submitted) → Receive Result (clear status, playback; failures actionable with correct credit handling) → Remix or Continue (save, download, retry, variation, extend, new) → Return to Discovery (related templates/projects).

PART VI — ARCHITECTURE
Stack: Next.js App Router, React, strict TypeScript, Tailwind, accessible primitives, Lucide, motion library; server API routes, PostgreSQL, Prisma or Drizzle, Redis queues, background workers, S3-compatible storage, secure auth/sessions; Stripe with server-verified webhooks and ledger credits; provider-adapter AI (image, video, prompt assistance, optional image quality analysis, capability registry); containerized services, env config, deployment scripts, structured logs, error monitoring, automated tests. Not hardwired to one provider.
Routes: / (home+explore), /explore, /templates/[id], /generate/image, /generate/video, /collection, /collection/[id], /projects, /projects/[id], /train, /studio, /creators/[id], /favorites, /pricing, /settings, /auth, /admin. Don't crowd main nav; advanced features reachable contextually.
Data model entities: Users, User Profiles, Sessions, Creator Profiles, Templates, Template Versions, Template Categories, Favorites, Followers, Generation Jobs, Generation Outputs, Media Assets, Uploads, Collections, Projects, Project Scenes, Scene Versions, Character References, Model Configurations, Saved Presets, Subscriptions, Credit Accounts, Credit Ledger Entries, Payment Events, Moderation Events, Consent Records, User Preferences, Discovery History, Audit Logs. Referential integrity, indexes, ownership checks, FKs, retention, soft deletion where justified, transactional credits, version metadata. No secrets in public fields.

PART VII — GENERATION INFRASTRUCTURE
Modes via capability-aware abstraction: text-to-image, image-to-image, text-to-video, image-to-video, video-to-video*, video extension*, scene continuation*, reference-guided* (*where available).
Pipeline: Input → Validation → Consent and Safety → Model Selection → Credit Reservation → Queue → Provider Execution → Status Updates → Output Storage → Quality Checks → Credit Settlement → Collection.
States: Draft, Awaiting Confirmation, Queued, Processing, Completed, Failed, Cancelled. DB-backed transitions. No false progress percentages. Track provider ids, retries, timestamps, failure reasons, output locations.
Reliability: idempotent job creation, safe retries, concurrency limits, timeouts, failure recovery, provider error normalization, webhook signature verification, secure uploads, signed media URLs, reservation/settlement, no duplicate charging, accurate cancellation, provider availability checks. Never represent a placeholder as a completed AI generation.
Providers interchangeable; capabilities, durations, pricing, quality, params declared explicitly. If credentials missing: implement interface, DB, adapters, clearly labeled dev demonstrations; never falsely report external generation as operational.

PART VIII — ADULT TRUST, CONSENT, PRIVACY
Enforceable adult-only eligibility; age assurance for supported jurisdictions; authorization for images, videos, likenesses, character references. Prohibit: sexual content involving minors; nonconsensual intimate imagery; unauthorized sexualized depictions of identifiable people; exploitative material; consent-bypass attempts.
Privacy: private-by-default generations; clear sharing controls; explicit consent records; secure storage; easy account/content deletion; transparent retention; strict access control; short-lived signed URLs; no public indexing of private content; clear training-data policies; consent withdrawal and removal workflows. Server-side enforcement, not just UI text.

PART IX — MONETIZATION
Credit balance, packages, subscriptions, VIP entitlements, cost estimates, quality/duration pricing, concurrency limits, purchase history, ledger, failed-generation reimbursement rules. Server-side payment verification; never trust client balances; transactional ledger; visible cost before execution; exactly-once webhooks; configurable prices and limits (not invented Playbox policy).

PART X — MOBILE AND PERFORMANCE
Mobile primary: responsive columns, touch cards, swipeable previews, responsive nav, compact controls, persistent status access, mobile uploads, accessible dialogs/sheets, efficient streaming, adaptive images, clear downloads. Optimize initial render, images, video previews, route transitions, latency, bundle, polling, fetching, caching. Avoid autoplay and heavy background work.

PART XI — QUALITY, TESTING, SECURITY
Every important action has a defined outcome; no dead buttons. Test: auth, browsing, search, filters, favorites, template opening, generation forms, validation, uploads, job creation, queue, completion/failure, credits, webhooks, collection, download, deletion, publishing, private access, responsive layouts, keyboard a11y, consent. Unit + integration + e2e; failure cases; cross-user URL manipulation blocked; retries never double-charge; cancelled/failed reach consistent terminal states; mobile/tablet/desktop checks. Resolve critical defects before calling it complete.

PART XII — PHASES
1 Foundation: design system, nav, explore, search/filters, cards, details, auth, collection, generation entry points, responsive. 2 Intelligence and generation: adapters, jobs, workers, uploads, credits, status, prompt assistance, validation, preferences, persistence. 3 Continuous creativity: projects, scene continuity, variations, timelines, version comparison, presets, studio, quality assistance. 4 Ecosystem: creator profiles, publishing, following, remix attribution, recommendations, analytics, moderation, advanced discovery.

PART XIII — CREATIVE CONSTITUTION (non-negotiable)
Keep: 1 media-first gallery, 2 template-driven discovery, 3 fast simple generation, 4 dark immersive presentation, 5 adult entertainment identity, 6 community exploration, 7 compact interaction patterns, 8 core navigation concepts, 9 clear template previews, 10 optional experimentation. Never: replace gallery with dashboard; mandatory chatbot; force beginners into advanced panels; bury features; excessive animation; monetization interrupting browsing; sacrifice privacy, consent, accessibility, reliability for engagement. Feature quantity ≠ improvement.

PART XIV — DELIVERABLES
A Product Vision Document: 1 opening framing, 2 current identity and experience, 3 core visual and emotional personality, 4 what stays vs what evolves, 5 seven experience upgrades, 6 interface and motion principles, 7 ideal journey, 8 non-visual reliability/quality/privacy/cost improvements, 9 four-phase plan, 10 creative constitution, 11 final vision. Clear, concrete, no inflated marketing language.
B Design System: visual principles, tokens, typography hierarchy, spacing and grid, component states, responsive behavior, motion principles, accessibility.
C Information Architecture: implementation-ready sitemap and route structure; relationship between Explore, Generate, Collection, Train, Studio, Projects, creator profiles.
D Functional Application: the actual app (connected frontend and backend, navigation, auth, persistence, generation infra, credits, projects).
E Engineering Documentation: system architecture, database schema, API contracts, worker architecture, AI provider adapters, auth/authz model, credit ledger rules, file storage, privacy and consent architecture, error handling, security.
F Deployment and Configuration: env var template, setup, migrations, local dev commands, worker startup, testing commands, production build, deployment config, external dependencies. No credentials.
G Verification Report: what was implemented, tested, passed, failed; which providers configured; which need credentials; which features are demonstrations vs operational; known limitations; remaining production blockers. Distinguish implemented from intended.

PART XV — METHOD
Inspect → Understand → Architect → Design → Implement → Integrate → Test → Refine → Deliver. Decide autonomously; document assumptions; vertical slices; real functionality where possible; isolate unavailable services behind adapters and disclose; no fabricated results.
Definition of Done: installable and startable; main routes render; navigation and primary interactions work; auth and ownership enforced; persistence works; real job orchestration; consistent credits; private media protected; adult eligibility and consent implemented; responsive layouts usable; relevant tests run; setup and deployment documented; incomplete integrations identified.

PART XVI — ACCEPTANCE FROM THREE PERSPECTIVES
Returning user: recognizable structure, browse and generate without learning. New user: understands the platform in seconds; previews without friction; auth, costs, policies understandable. Advanced creator: settings, variations, continuations, project histories, reusable workflows; returns to a project without losing context.
