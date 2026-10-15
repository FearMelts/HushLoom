export const meta = {
  name: 'hushloom-phase2-journey',
  description: 'Write and run the real-browser launch-readiness journey (age verification, payments, scanning, web app) on the production build, then critique and close gaps',
  phases: [
    { title: 'Journey', detail: 'write the e2e spec and run it green on the production build' },
    { title: 'Critique', detail: 'read-only gap check against the addendum and the run plan' },
    { title: 'Close gaps', detail: 'add what the critic found and re-run' },
  ],
}

const MAIN = '/home/claude/hushloom'
const CTX = '/tmp/claude-0/-home-claude-hushloom/ef68adc1-eb6d-56e0-b7e4-cbc2303fcdd6/scratchpad/ctx'
const SHOTS = '/mnt/project-files/playbox-2/evidence/journey'

const RULES = `
You are working on the Hushloom build (Next.js 15 App Router, React 19, strict TypeScript, Tailwind 4, Drizzle + Postgres 16, BullMQ + Redis 7, Playwright with Chromium pre-installed at /opt/pw-browsers; never run "playwright install").

Rules:
- Work only inside the worktree path you are given (or your own worktree if you were started in one). Never touch ${MAIN} (the main checkout), never "git push", never call any mcp__hearthbot__ tool, never touch GitHub.
- Setup if node_modules is missing in the worktree: "ln -s ${MAIN}/node_modules node_modules".
- Postgres runs on localhost:5432 (user playbox, trust auth) and Redis on localhost:6379. If either is down, run "bash ${MAIN}/notes/workflow/start-services.sh".
- The e2e stack is defined in playwright.config.ts: it resets the playbox_e2e database and Redis db 2, runs migrations, seed and scan-backfill, does a production "next build", copies .next/static and public/ into the standalone output, and starts the standalone server (NODE_ENV=production, APP_ENV=test, port 3100) plus the worker (health on 3901). Run it with "E2E_SHOTS_DIR=${SHOTS} npm run test:e2e" (a run takes about 3-5 minutes; give the Bash call a 15-minute timeout). Never point it at another database. For quicker iteration you may run "npx playwright test tests/e2e/launch.spec.ts" with the same env; the full suite must pass at the end.
- Read for context: ${MAIN}/notes/progress.md (tracker: what each track built, open issues), ${CTX}/addendum.md (the four additions and their required tests), tests/e2e/journey.spec.ts (existing journey and helpers: age gate, sign-up, admin API login; seed admin is admin@hushloom.local and every seed password is "e2e-password-123"), and the code of the flows you drive. Facts you can rely on: geo headers are "x-country-code" and "x-region-code" (set them with browser.newContext({ extraHTTPHeaders })); with default config GB and the US states in src/config/jurisdictions.ts require age verification; the payment provider defaults to the labeled sandbox (/pricing → Buy → /pricing/sandbox with "Complete sandbox purchase" (data-testid sandbox-complete), "Simulate failure", and per-purchase "Simulate refund" / "Simulate chargeback"; a flagged account shows data-testid "account-flagged" on /pricing and cannot start checkout); the age provider defaults to the labeled sandbox (Settings → "Your age check" card → "Verify now" → /verify/sandbox → "Simulate verified" / "Simulate failed"); the dev scanner treats tests/fixtures/scan-drill-match.png as a match (generic rejection, the uploader is suspended and signed out, an escalation appears at /admin/review for admins); the public takedown form is at /policies/takedown and works signed out; the web app ships /manifest.webmanifest, /sw.js, /offline, and Settings cards "On this device" (install) and notifications.
- Zero fabrication: report only what you ran and saw. A test is "passed" only if Playwright printed it as passed in a run whose output you read. Quote the summary line ("N passed (Xm)").
- Never weaken an assertion to make a test pass. If a test exposes a real application defect, first make sure it is not your test's fault (re-read the code, reproduce by hand with a small Playwright script if needed). Then fix it only if the fix is small, local and clearly correct, in its own commit whose subject starts with "Fix:", and list it under appBugs with the evidence; otherwise leave the test asserting the correct behavior, mark it test.fixme with a comment naming the defect, and list it under appBugs as unfixed. Never mark a test fixme for a test-side problem.
- Commit on the worktree branch when done (and after each coherent step; use "WIP:" in the subject while red). End every commit message with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BSE2farBCYZaqmEuz9DVcb
- Before finishing: "npm run typecheck" clean and "npm run lint" clean (0 warnings) in the worktree, and leave no uncommitted changes except the untracked node_modules symlink, .next, test-results and storage dirs (which are git-ignored or must stay untracked).`

const SPEC = `
Write tests/e2e/launch.spec.ts: a real-browser journey for the launch-readiness additions on the production build. It runs after journey.spec.ts in the same Playwright run (workers 1), so use unique handles (a stamp) and do not depend on journey.spec.ts state.

Evidence capture (required by the run plan): a small helper in tests/e2e/evidence.ts that (a) saves named screenshots into process.env.E2E_SHOTS_DIR ?? "test-results/journey" (create the dir) with descriptive filenames like "age-01-blocked-gb.png", and (b) attaches listeners to every page it is given: console messages of type error, pageerror events, requestfailed events, and responses with status >= 400; it writes one JSON per test (test title slug) into the same dir listing each entry with url, status/method and whether the test expected it (the test declares expected statuses/urls, e.g. the 451 or the generic 403). At the end of each test, assert there are no UNEXPECTED console errors, page errors or 5xx responses. Use it in launch.spec.ts (and optionally wrap the existing journey's pages if trivial; do not change what journey.spec.ts asserts).

Cover, each as its own test with screenshots at the key steps (desktop 1440x960 unless stated):
1. Age verification (addendum §2), in a context with header x-country-code: GB.
   a. Anonymous GB visitor: template cards and a template page withhold media ("Sign in and verify to see previews"), and no <img>/<video> on the page points at /api/media for template media (check the DOM, not just text).
   b. A new member signs up (through the UI, as in journey.spec.ts) in GB: still withheld ("Verify your age to see previews"); trying to make something (e.g. the create page for an image with a harmless prompt, after an admin grants credits through /api/admin/credits) is refused with the age-verification message and nothing is charged (balance unchanged); an upload attempt is refused as well (through the create panel's image-to-image upload or, if the UI path is impractical, page.request against /api/uploads with the browser's cookies; say which).
   c. Settings shows the age check card as required, sandbox-labeled; "Verify now" opens /verify/sandbox (screenshot the sandbox page with its "proves nothing" label); "Simulate failed" returns with "Not passed"; then "Verify again" → "Simulate verified" returns with "Verified".
   d. After verification: previews are visible (an <img> with /api/media or the template media URL loads with naturalWidth > 0), and making a demo image works end to end (charged, appears in the Library with the Demo label).
   e. A visitor without any geo header (not covered) is not blocked (one quick check).
2. Payments (addendum §1), sandbox:
   a. /pricing shows the sandbox label for the active processor.
   b. A new member buys the smallest pack: Buy → /pricing/sandbox (screenshot: "This is a sandbox. No money moves.") → Complete sandbox purchase → back on /pricing the balance increased by exactly the pack's credits (read src/config/pricing.ts) and the Payments history lists it.
   c. "Simulate failure" on a second checkout leaves the balance unchanged.
   d. Simulate refund on the purchase: credits are clawed back (balance back to before), the history shows the refund.
   e. Buy again, then simulate a chargeback: the account shows the flagged notice (account-flagged) and the Buy buttons are disabled / checkout is refused (assert POST /api/checkout from the page returns 403 account_flagged); an admin sees the flag in the admin flags section and clears it; checkout works again.
   f. Replay protection seen from the outside: re-POSTing the exact same signed sandbox webhook body (capture it with page.route or by reading how the sandbox page posts; if the signed body is not observable from the browser, call the webhook route with a body you cannot sign and assert 400) does not grant credits twice. State in your report which variant you used.
3. Scanning (addendum §3):
   a. A throwaway member (no geo header) uploads tests/fixtures/scan-drill-match.png through the create panel's upload (image-to-image) with the consent sheet: the UI shows a generic rejection (no mention of why), and the member is signed out/suspended (a reload lands signed out; signing in again is refused). Screenshot the rejection.
   b. A clean upload by another member still works (any small generated PNG, e.g. made with sharp in the test or an existing seed-safe image), and its preview loads.
   c. The admin sees the escalation at /admin/review (screenshot) and the matched file is never served: try GET on any /api/media URL the admin page exposes for it (there should be none) and confirm nothing renders the image.
   d. The public takedown form at /policies/takedown works signed out (submit a request with category NCII and a template URL; success message); the admin sees it in the takedown queue and can dismiss it with a note.
4. Installable web app (addendum §4):
   a. GET /manifest.webmanifest: 200, application/manifest+json, name Hushloom, display standalone, start_url "/", icons 192 and 512 exist (fetch each: 200 image/png).
   b. GET /sw.js: 200, Cache-Control no-cache, Service-Worker-Allowed "/".
   c. In the browser: the service worker registers and becomes active (navigator.serviceWorker.ready) on a public page; after it is active, context.setOffline(true) and navigating to a public page shows the offline page ("You're offline", screenshot); a signed-in page such as /collection is NOT served from cache (it fails or shows the offline page, never stale private content); the Cache Storage contains no /api/ entries and no /api/media entries (inspect with page.evaluate over caches.keys()/cache.keys()). Set offline back to false.
   d. Settings shows the install card and the notifications card; with no VAPID keys configured the notifications toggle says push is not configured.
   e. At 390x844: the offline banner appears when offline on a signed-in page that was loaded before going offline, and the "Make it" button is disabled while offline (create page); screenshot.
5. Core flows smoke at 390x844 with screenshots (they are already asserted in journey.spec.ts; here only screenshots plus the no-unexpected-errors assertion): /, /explore, a template page, /collection (signed in), /settings, /pricing, /policies, /policies/takedown, /admin (as admin), /admin/review (as admin).

Use stable selectors (roles, labels, data-testid). Where a selector you need does not exist, prefer role/label queries over adding test ids; add a data-testid only when nothing else is stable (that is an allowed small app edit).
Make the whole suite (journey.spec.ts + launch.spec.ts) pass with "E2E_SHOTS_DIR=${SHOTS} npm run test:e2e". Then commit.`

const REPORT = {
  type: 'object',
  properties: {
    worktree: { type: 'string', description: 'absolute path of the worktree you worked in' },
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    finalRun: { type: 'string', description: 'the exact command and the Playwright summary lines of the last full run, quoted' },
    tests: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'fixme', 'skipped'] }, notes: { type: 'string' } }, required: ['title', 'status', 'notes'] } },
    screenshots: { type: 'array', items: { type: 'string' } },
    errorsLogged: { type: 'string', description: 'summary of the console/network evidence files: expected and unexpected entries per test' },
    appBugs: { type: 'array', items: { type: 'object', properties: { summary: { type: 'string' }, evidence: { type: 'string' }, fixed: { type: 'boolean' }, commit: { type: 'string' } }, required: ['summary', 'evidence', 'fixed', 'commit'] } },
    variantsChosen: { type: 'array', items: { type: 'string' }, description: 'where the brief allowed a choice (upload path, replay check), which one and why' },
    notCovered: { type: 'array', items: { type: 'string' } },
  },
  required: ['worktree', 'branch', 'commits', 'finalRun', 'tests', 'screenshots', 'errorsLogged', 'appBugs', 'variantsChosen', 'notCovered'],
}

phase('Journey')
const first = await agent(`${RULES}\n\nYou were started in your own git worktree (your current directory). FIRST run "git rev-parse HEAD": it must equal ${args.base}; if not, run "git reset --hard ${args.base}". Then do the task.\n\nTASK:${SPEC}`,
  { label: 'journey:write', phase: 'Journey', schema: REPORT, isolation: 'worktree' })
if (!first) return { error: 'journey agent returned nothing' }

phase('Critique')
const GAPS = {
  type: 'object',
  properties: {
    gaps: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, why: { type: 'string' }, severity: { type: 'string', enum: ['must', 'should'] } }, required: ['item', 'why', 'severity'] } },
    weakAssertions: { type: 'array', items: { type: 'string' } },
    evidenceProblems: { type: 'array', items: { type: 'string' } },
  },
  required: ['gaps', 'weakAssertions', 'evidenceProblems'],
}
const critic = await agent(`${RULES}\n\nRead-only task: do not edit any file and do not commit. The journey was written in the worktree ${first.worktree} (branch ${first.branch}). Its author reported:\n${JSON.stringify(first, null, 2)}\n\nCritique it against (1) the run plan's phase 2 requirement: "a real-browser journey covering age verification, payment, scanning, and core flows, with screenshots and console/network errors recorded", (2) every "Tests:" line and "DONE MEANS" bullet of ${CTX}/addendum.md that a browser can observe, and (3) the brief the author was given:\n${SPEC}\n\nRead tests/e2e/launch.spec.ts, tests/e2e/evidence.ts and any app edits in that worktree (git -C ${first.worktree} diff ${args.base}..HEAD). Look at the screenshots in ${SHOTS} (open a few with the Read tool) and the evidence JSON files there. Report: brief items not covered or covered only nominally (severity must if the brief asked for it), assertions that would pass even if the feature were broken (e.g. text checks where the brief asked for DOM/media checks, missing balance checks), and evidence problems (missing screenshots, JSON that does not record console/network data, unexpected errors that were ignored). Be specific: file:line and what to change.`,
  { label: 'journey:critic', phase: 'Critique', schema: GAPS })

const mustFix = critic ? critic.gaps.length + critic.weakAssertions.length + critic.evidenceProblems.length : 0
if (!critic || mustFix === 0) {
  log(critic ? 'critic found nothing to add' : 'critic returned nothing; skipping gap closing')
  return { first, critic, final: first }
}

phase('Close gaps')
const final = await agent(`${RULES}\n\nContinue the journey work in the existing worktree ${first.worktree} (cd there; it is on branch ${first.branch}; its node_modules symlink exists). The author's report:\n${JSON.stringify(first, null, 2)}\n\nA read-only critic reviewed it and found:\n${JSON.stringify(critic, null, 2)}\n\nAddress every "must" gap, every weak assertion and every evidence problem; address "should" gaps when they take under 20 minutes each, and list the rest under notCovered with the reason. Re-run the full suite with "E2E_SHOTS_DIR=${SHOTS} npm run test:e2e" until it passes, then commit. Return the same report shape for the final state (all commits on the branch since ${args.base}, all tests, the final run).`,
  { label: 'journey:close-gaps', phase: 'Close gaps', schema: REPORT })

return { first, critic, final: final ?? first }