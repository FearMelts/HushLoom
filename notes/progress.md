# Progress (newest last)

All times 2026-10-12, UTC, from `git log` and the thread.

- 20:35 Grounded: Node 22, Postgres 16, Redis 7, ffmpeg, Playwright Chromium present. Repo cloned,
  branch `claude/playbox-2-foundation` created. Playbox reference observed from the shared screen
  recording and `playbox-source.s` (layout patterns only).
- 20:49 `8047578` Foundation: Drizzle schema (users, sessions, consents, ledger, jobs, outputs, assets,
  templates, projects, scenes, folders, reports, audit, stripe events, model configs), credit ledger,
  storage drivers, safety policy, provider adapters, generation service + processor + BullMQ queue.
- 20:59 `89b82f2` Shell (rail, tab bar, age gate), design tokens, discovery queries, payments module,
  seed script with templates and creator accounts.
- 21:00 `cb5eabb` Template card and gallery components.
- 21:16 `4f5d2a5` Library, creation detail, presets, projects and character reference APIs.
- 21:30 `58c8737` Projects, studio, train, creators, favorites, pricing, settings, admin, policies,
  webhooks. Every route smoke-tested as anonymous, member and admin; fixed a template detail crash
  (tags overlap query) and 22P02 → 404 mapping.
- 21:47 `273ec3a` Tests: unit (policy, copilot, registry, signatures), platform integration (Stripe
  dedupe and forgery, consent cascade, cross-user access, publish privacy, report removal, account
  deletion, admin credit idempotency, media range requests, projects, presets), Playwright journey on
  the production standalone build (8 specs). Fixes found by tests: underage regex, "years of
  experience" false positive, copilot "pans", storage path shared between app and worker, duplicate
  balance test id.
- 21:56 `0987b7c` Video poster frames (ffmpeg + sharp, migration 0001), discarded outputs purge
  posters, seeded users carry terms/adult consents, settings toggle knob centered. Results at this
  commit: typecheck clean, lint clean, vitest 79/79 in 27.7 s.
- 21:58 Sneak-peek screenshots taken from the dev server (member account) into
  `/mnt/project-files/playbox-2/sneak-peek/` (7 PNGs). A new demo clip in project "Night swim"
  confirmed the poster frame renders in the Library and the project workspace.
- 22:00 Handover: Jayvo asked for a sneak peek and a restart on the best model; the Coordinator starts a
  fresh session on Fable 5.1 from this branch. Playwright e2e re-run on the production standalone
  build at `0987b7c`: 8 passed in 2.4 min (`npm run test:e2e`, exit 0). The e2e run also proved
  `npm run build` at this commit. Dev server and worker were stopped for that run and left stopped.
