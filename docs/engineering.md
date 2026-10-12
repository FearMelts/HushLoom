# Engineering Notes

## Current implementation and status

This is a no-dependency, static browser preview served by a small Node HTTP server. It demonstrates the visual direction and a real local discovery-to-template-edit interaction: catalog filtering, search, favorites, recently viewed templates, prompt editing, and saved local settings.

It is **not** the production full-stack platform in the product brief. There is no database, authentication, AI provider, job queue, worker, credit ledger, payment integration, upload service, creator API, or deployment target configured. Template artwork and catalog entries are local illustrative content. Browser storage is device-local and is not an account-backed private collection. The preview does not upload media, submit a generation, estimate costs, or charge credits.

## Information architecture

| Route / destination | Intended responsibility | Preview status |
| --- | --- | --- |
| `/` and `/explore` | Explore, discover, search, and category filters | One page at `/`; hash `#explore` |
| `/templates/[id]` | Preview, metadata, personalize, remix | Accessible template dialog; no deep route |
| `/generate/image`, `/generate/video` | Capability-aware generation flows | Not implemented; submission explains the limitation |
| `/collection` and `/favorites` | Private saved media and favorites | Saved templates at `#collection`, not a creation library |
| `/collection/[id]` | Creation detail and actions | Not implemented |
| `/projects`, `/projects/[id]` | Project and scene workspace | Not implemented |
| `/train` | Authorized training workflows | Not implemented |
| `/studio` | Optional advanced workspace | Small optional controls live in the template dialog only |
| `/creators/[id]` | Public creator profiles | Not implemented; “Playbox picks” is illustrative |
| `/pricing` | Configured plans and credits | Not implemented; no prices or plans are invented |
| `/settings` | Account, privacy, personalization controls | Not implemented |
| `/auth` | Secure sign-in and age assurance | Not implemented |
| `/admin` | Protected moderation and administration | Not implemented |

Explore should remain the main entry point. Generation belongs in a selected template; Collection holds personal work; Studio, Train, projects, and creator pages are contextual destinations rather than top-level navigation clutter.

## Design and accessibility

Design assumptions and tokens are documented in [the product vision](playbox-2-vision.md). CSS variables in `styles.css` centralize surface, text, accent, radius, spacing, and motion values. Layout breakpoints adapt the gallery and sidebar to mobile. Focus rings, a skip link, accessible names, native dialog/details controls, live result counts, and reduced-motion handling are included.

Fonts currently load from Google Fonts with system fallbacks. For a fully self-hosted production deployment, vendor appropriately licensed font files or remove the remote import.

## Suggested production architecture (not implemented)

Keep browser UI separate from API and worker processes. Use PostgreSQL as the source of truth, an object store for private media, and a Redis-backed queue only as a delivery mechanism; persist job transitions in the database. Define image/video providers behind capability-declared adapters so unsupported durations, ratios, references, or continuation modes cannot be submitted.

Suggested durable entities: users and profiles; sessions and consent records; creator profiles; templates and versions; favorites and follows; generation jobs and outputs; media assets and uploads; collections and projects; scenes and scene versions; model configurations; saved presets and user preferences; subscriptions and credit accounts; immutable credit-ledger entries; payment events; moderation events; discovery history; audit logs.

Add foreign keys, ownership indexes, unique idempotency constraints, retention metadata, and transactional updates. Keep secrets and private asset locations out of public template fields.

### Proposed API contracts

These endpoints are a design sketch, not implemented routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/templates?query=&category=&cursor=` | Public catalog discovery |
| `GET` | `/api/templates/:id` | Public template and supported version |
| `PUT` / `DELETE` | `/api/me/favorites/:templateId` | Idempotent favorite management |
| `POST` | `/api/uploads` | Validate authorized upload, return short-lived upload target |
| `POST` | `/api/generations` | Validate consent/capabilities, quote cost, accept idempotency key and confirmed submission |
| `GET` | `/api/generations/:id` | Owner-scoped job status and output metadata |
| `POST` | `/api/generations/:id/cancel` | Capability-aware cancellation request |
| `GET` | `/api/me/collection` | Owner-scoped creations, projects, and saved presets |

Generation submission should separate a server-generated estimate/confirmation from job creation. The server must derive the authenticated owner, supported settings, and final cost; it must never trust a client-supplied balance.

### Worker, credit, and error rules

The API persists a draft/confirmed job and reserves credits in one transaction before enqueueing it. Workers claim jobs idempotently, enforce concurrency/timeouts, record provider IDs and timestamps, normalize provider errors, retry only safe transient errors, and persist actual terminal states. Completion records stored outputs and settles the reservation; failure/cancellation applies an explicit, audited reimbursement policy. Webhooks are signature-verified and deduplicated. A queue is not the source of job truth; reconciliation recovers stuck work.

Never report fabricated percentage progress. Return truthful queued/processing/terminal states and actionable normalized errors. Prevent duplicate submissions and charges with server-side idempotency and ledger constraints.

## Authentication, consent, privacy, and storage

Authentication, age assurance, jurisdiction rules, authorized likeness workflows, and adult-content safety need server-side enforcement before any upload or provider call. A privacy page is not a substitute for enforcement. Support consent withdrawal and removal flows, minimize discovery-history retention, and provide user controls to disable personalization and clear history.

Keep media private in object storage. Verify type and size server-side, scan and moderate where required, use short-lived signed URLs, avoid public indexing, and check ownership on every object and job access. Public templates require explicit publication of a sanitized template version; never reuse private prompts or uploads implicitly.

## Deployment and local commands

Requirements: Node.js 18 or newer. There are no npm dependencies or secrets required for this preview.

```sh
npm test
npm start
```

Open `http://127.0.0.1:4173`. `PORT` can select another local port. There are no migrations, worker startup commands, production build, container, or deployment configuration yet; the preview server is local-only and should not be treated as a production API server. No `.env` file is needed or supplied.

## Verification report

- **Implemented:** responsive static UI; catalog search and image/video filters; favorites and recently viewed templates with a clear-history control; template detail dialog; editable prompts and optional frame/motion settings; browser-local persistence; explicit unavailable-generation messaging.
- **Tests:** `npm test` passed (5 tests); JavaScript syntax checks passed. A headless Chromium interaction check verified initial rendering (8 templates), search, video filtering, template details, unavailable-generation messaging, local prompt persistence, favorites/Collection, and clearing recent history. Direct HTTP checks confirmed app resources return 200, non-public repository files return 404, and security headers are present.
- **Integrations configured:** none.
- **Demonstrations:** the interface, sample templates/artwork, and local-only saved settings; these are not connected production services.
- **Not operational:** authentication, age verification, generation, AI assistance, uploads, provider capability checks, jobs, costs/credits, payments, private cloud media, projects, publishing, analytics, moderation, and deployment.
- **Production blockers:** all production services and server-side authorization/safety/accounting systems listed above.
