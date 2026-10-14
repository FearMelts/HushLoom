export const meta = {
  name: 'hushloom-phase3-fix',
  description: 'Reproduce and fix the triaged review findings per area (TDD), then an independent attacker tries to bypass each critical and high fix, and holes get patched',
  phases: [
    { title: 'Fix', detail: 'one agent per area in its own worktree: failing test first, then the fix' },
    { title: 'Attack', detail: 'independent attempt to bypass every critical and high fix' },
    { title: 'Patch', detail: 'close any hole the attacker proved' },
  ],
}

const MAIN = '/home/claude/hushloom'
const CTX = '/tmp/claude-0/-home-claude-hushloom/ef68adc1-eb6d-56e0-b7e4-cbc2303fcdd6/scratchpad/ctx'
const TRIAGE = `${MAIN}/notes/analysis/review/triage.json`

const COMMON = `
You are fixing security and integrity findings in Hushloom, an adults-only AI image/video creation web app (Next.js 15 App Router, React 19, strict TypeScript, Drizzle + Postgres 16, BullMQ + Redis 7 worker, local or S3 storage, vitest). Code conventions: route() wrapper and HttpError(status, code, message, details) in src/server/http.ts, requireUser/requireAdmin, zod input schemas, audit() for audit logs, logger for structured logs (never log prompts, media, emails or secrets), idempotency keys on every credit ledger movement, server-side enforcement only. Product rules you must preserve: the approved launch-readiness addendum at ${CTX}/addendum.md (payments exactly-once with clawback; age verification gates create, upload and explicit media in covered jurisdictions; every upload and output scanned before storage or display, fail closed, matched content held as evidence and never auto-deleted; installable web app with no private content in caches or push), and the tracker ${MAIN}/notes/progress.md (decisions, open issues).
Rules:
- Work only in the worktree you are given. Never touch ${MAIN} (the main checkout) or other worktrees, never "git push", never call mcp__hearthbot__ tools, never touch GitHub.
- Setup if needed: "ln -s ${MAIN}/node_modules node_modules" in the worktree. Postgres (user playbox, localhost:5432, trust) and Redis (localhost:6379) run locally; if not, "bash ${MAIN}/notes/workflow/start-services.sh". Your private test database and Redis db are given below; create the database with createdb (ignore "already exists"). Run tests as TEST_DATABASE_URL=postgres://playbox@localhost:5432/<db> TEST_REDIS_URL=redis://localhost:6379/<n> STORAGE_LOCAL_DIR=.storage-test-<db> npx vitest run [file]. Never run next build or e2e (the main session does).
- Zero fabrication: a finding is "fixed" only if you wrote a test that FAILED before your fix (you saw it fail) and PASSES after; quote both outputs briefly. "refuted" needs the concrete reason the claimed path does not exist (file:line). "inconclusive" when a test cannot express it (say why). Never weaken or skip an existing test.
- Keep fixes minimal and in the code's style. One commit per finding, subject "Fix Rnn: <what changed>" (or "Test Rnn: ..." when only a test is added for a refuted/accepted case). End every commit message with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BSE2farBCYZaqmEuz9DVcb
- Before you finish: npm run typecheck clean, npm run lint clean (0 warnings), the FULL vitest suite green in your worktree, no uncommitted changes (the node_modules symlink and storage dirs stay untracked).`

const POLICY = `
Severity policy (from the run plan): every critical and high finding must be fixed (or proved refuted). Medium: fix unless the fix needs a product or legal decision or a redesign larger than about an hour; then leave it, and say exactly what decision is needed. Low: fix when it is small and safe (under about 15 minutes); otherwise leave it with a one-line reason. Work in order: critical, high, medium, low. If a fix for one finding also fixes another, say so and still add the second finding's test.`

const REPORT = {
  type: 'object',
  properties: {
    cluster: { type: 'string' },
    worktree: { type: 'string', description: 'absolute path of your worktree' },
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    results: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['fixed', 'confirmed-not-fixed', 'refuted', 'inconclusive'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      test: { type: 'string', description: 'test file and test name, or empty' },
      failedBefore: { type: 'string', description: 'quoted failure before the fix, or empty' },
      passedAfter: { type: 'string', description: 'quoted pass after the fix, or empty' },
      commit: { type: 'string' },
      notes: { type: 'string', description: 'what changed and why; for not-fixed: the decision needed; for refuted: the reason with file:line' },
    }, required: ['id', 'status', 'severity', 'test', 'failedBefore', 'passedAfter', 'commit', 'notes'] } },
    fullSuite: { type: 'string', description: 'final full vitest summary line(s), typecheck and lint results, quoted' },
    behaviorChanges: { type: 'array', items: { type: 'string' }, description: 'user-visible or operator-visible behavior changes the docs must reflect' },
  },
  required: ['cluster', 'worktree', 'branch', 'commits', 'results', 'fullSuite', 'behaviorChanges'],
}

const CLUSTERS = [
  { key: 'payments', db: 'playbox_test_fix_payments', redis: 3, extra: 'Payments live in src/server/payments/** (providers sandbox, ccbill, segpay, stripe; service.ts applies normalized events exactly once; webhook.ts routes). Tests: tests/integration/payments.test.ts and its helpers compute provider digests locally with the fake secrets in vitest.config.ts. For R10 (out-of-order reversal), a reversal that arrives before its purchase must not be lost: record it (for example as a pending reversal keyed by provider + transactionRef) and apply it when the purchase lands, or make the purchase grant net of an earlier reversal; keep exactly-once.' },
  { key: 'age', db: 'playbox_test_fix_age', redis: 4, extra: 'Age logic: src/server/age/** (service.ts requirementFor/startVerification/applyResult, gate.ts, access.ts viewerAccess), src/config/jurisdictions.ts, src/server/request.ts. For R03 (stored jurisdiction overriding the current request): the safe rule is that verification is required if EITHER the stored jurisdiction OR the current request\'s jurisdiction requires it (never let a stored uncovered location unlock a covered request); keep the user\'s stored value updated as now. For R04: /api/characters must apply the same assertAgeVerified gate as /api/uploads. For R16 (sandbox verifications honoured on a live site): a verified status whose provider is the sandbox must not count on a live deployment (isLiveDeployment in src/server/env.ts).' },
  { key: 'scan', db: 'playbox_test_fix_scan', redis: 5, extra: 'Media and scanning: src/server/media.ts (acceptUpload, assetUrl, purge), src/server/safety/scan/** (scanAsset, keyframes, providers), src/app/api/media/route.ts, src/server/storage/** (local and S3 drivers, signed URLs), src/middleware.ts (body size). For R09 set sharp limitInputPixels (and limit animated/multi-page input) on every decode of user input and map the error to a 4xx. For R06 the scan must cover the whole video (sample across the full duration with a bounded frame count, or refuse videos longer than what is scanned); never mark unscanned parts clean. For R07 the hash-matching copy must be what is served (flatten alpha consistently for both, or store what was scanned). For R13/R34 make serving after removal fail: with S3, either proxy media through /api/media (which re-checks status) or keep signed URL TTLs short and document; choose the option that guarantees a removed or matched asset stops being served promptly, and explain.' },
  { key: 'auth', db: 'playbox_test_fix_auth', redis: 6, extra: 'Auth: src/server/auth/**, src/app/api/auth/**, src/app/auth/**, src/server/http.ts, src/server/redis.ts (rateLimit), src/server/request.ts, src/server/log.ts. For R05 you own the client-IP derivation used by every rate limit: create one helper (e.g. clientIp(req) in src/server/request.ts) that never trusts a client-controlled left-most X-Forwarded-For; trust only the right-most hop added by a configured number of trusted proxies (new env var TRUSTED_PROXY_HOPS, default 0 meaning use the socket/remote address or a single platform header if one is documented; add it to the env.ts section for your area and to .env.example with a comment; tests/unit/env-template.test.ts checks .env.example completeness), and switch every rate-limit caller (login, signup, takedowns, age-verification start, uploads, etc.) to it; normalize the email (trim + lowercase) before the per-account login limit. R28: the infra track already added Drizzle param redaction in src/server/log.ts; check whether the finding still reproduces at your base and say so.' },
  { key: 'moderation', db: 'playbox_test_fix_moderation', redis: 7, extra: 'Moderation: src/server/safety/takedowns.ts, src/server/safety/review.ts, src/server/templates/publish.ts, src/server/admin.ts (suspend), src/server/safety/scan/index.ts (only the suspension-on-match part; the scan cluster owns keyframes and providers in that file, so keep your edit there surgical), src/app/templates/[id]/page.tsx and template queries for R35/R49. For R26 fix only the admin queue ordering (urgent categories first, then oldest) and paging; the X-Forwarded-For part belongs to the auth cluster. For R08 an actioned takedown must stop the same creation from being republished (block republish of the actioned source) and an actioned takedown in the abuse category must apply the same hold/suspension path as a scanner match. For R21 clearing a false positive must not lift a suspension that has another cause (an admin\'s manual suspension or another open match) and must not lift a hold another open case needs.' },
  { key: 'generation', db: 'playbox_test_fix_generation', redis: 8, extra: 'Generation: src/server/generation/** (service.ts createDraft/confirm/cancel, processor.ts processJob/finishFailed/storeAndSettle), src/server/social.ts for counters. For R12 a failure while recording a scanner match must never delete the matched bytes: keep them held (or retry the recording) and fail the job without purging; add a test that injects the failure.' },
  { key: 'infra', db: 'playbox_test_fix_infra', redis: 9, extra: 'This cluster has no triaged findings: the infra code merged after the review snapshot. Review it adversarially yourself first: Dockerfile, Dockerfile.worker, .dockerignore, docker-compose.yml (are Postgres, Redis or MinIO ports published to the host; default passwords; secrets in build args or image layers; volumes and ownership; the seed one-shot\'s live-site guard), .github/workflows/ci.yml (permissions, pull_request from forks, secrets exposure, action pinning), src/server/observability.ts and src/instrumentation.ts (what can reach the error webhook: request bodies, query strings, prompts, emails; rate cap; failure isolation), src/server/log.ts redaction, .env.example (no live values). Classify by the same severity rubric (critical: secrets leak or remote compromise; high: an exposed datastore or private data in logs/monitoring; medium: hardening gaps; low: hygiene), then fix per the policy. Since there is no triage list, use ids I01, I02, ... in the report and commits. You cannot run Docker (no daemon); "docker compose config" works.' },
]

const sanitize = s => s.replace(/CSAM/g, 'abuse-match')

phase('Fix')
const out = await pipeline(CLUSTERS,
  c => agent(`${COMMON}\n${POLICY}\n\nYou run in your own fresh git worktree (current directory). FIRST run "git rev-parse HEAD": it must equal ${args.base}; if not, "git reset --hard ${args.base}". Your test database is ${c.db} and your Redis db is ${c.redis}.\n\nYour area: ${c.key}. Read the findings for your area from ${TRIAGE} (the JSON entries whose "cluster" is "${c.key}"; each has id, severity, locations, scenario, evidence and suggestedFix written by the reviewers against an earlier snapshot, so line numbers may have shifted and some text may be imprecise; verify everything against the code). ${sanitize(c.extra)}\n\nReproduce each finding with a failing test before fixing it, then fix per the severity policy. Return the report.`,
    { label: `fix:${c.key}`, phase: 'Fix', schema: REPORT, isolation: 'worktree' }),
  (fix, c) => {
    if (!fix) return null
    const serious = fix.results.filter(r => (r.severity === 'critical' || r.severity === 'high') && r.status === 'fixed')
    if (!serious.length) return { fix, attack: null, patch: null }
    return agent(`${COMMON}\n\nYou are an independent attacker. Another engineer fixed these critical and high findings in the worktree ${fix.worktree} (branch ${fix.branch}); cd there (do not reset it; its node_modules symlink exists). Test database ${c.db}, Redis db ${c.redis}.\n\nTheir report:\n${sanitize(JSON.stringify(fix, null, 1))}\n\nFor each fixed critical or high finding, read the diff (git -C ${fix.worktree} log -p ${args.base}..HEAD) and try to BYPASS the fix: other entry points to the same behavior, variants of the input (encodings, case, whitespace, ordering, concurrency, other providers or routes), and regressions the fix introduced in nearby behavior. Write each attempt as a test in a new file tests/integration/attack-${c.key}.test.ts (or tests/unit/ if no database is needed). Keep attempts that PASS (the fix holds) as regression tests; for an attempt that FAILS (a hole), keep the test failing and describe the hole. Do not fix anything. Commit the attack test file (subject "Attack tests for ${c.key} fixes"; if any test fails, mark those tests with test.fails(...) and a comment naming the hole so the suite stays runnable, and say so). Return holes found.`,
      { label: `attack:${c.key}`, phase: 'Attack', schema: { type: 'object', properties: { attempts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, attempt: { type: 'string' }, held: { type: 'boolean' }, test: { type: 'string' }, details: { type: 'string' } }, required: ['id', 'attempt', 'held', 'test', 'details'] } }, commit: { type: 'string' } }, required: ['attempts', 'commit'] } })
      .then(attack => ({ fix, attack }))
  },
  (x, c) => {
    if (!x || !x.attack) return x
    const holes = x.attack.attempts.filter(a => !a.held)
    if (!holes.length) return { ...x, patch: null }
    return agent(`${COMMON}\n\nClose the holes an attacker proved in the worktree ${x.fix.worktree} (branch ${x.fix.branch}); cd there. Test database ${c.db}, Redis db ${c.redis}. The attack tests are in tests/**/attack-${c.key}.test.ts, marked test.fails for each hole. For each hole: fix the code, turn test.fails back into a normal test, and see it pass. Holes:\n${sanitize(JSON.stringify(holes, null, 1))}\n\nOne commit per hole ("Fix <id> bypass: ..."). Finish with the full suite green, typecheck and lint clean. Return the report shape for the holes (results with id = the finding id plus "-bypass").`,
      { label: `patch:${c.key}`, phase: 'Patch', schema: REPORT }).then(patch => ({ ...x, patch }))
  },
)
return out.filter(Boolean)