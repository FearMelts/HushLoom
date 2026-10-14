export const meta = {
  name: 'hushloom-phase4-visual',
  description: 'Visual review at 390, 820 and 1440 px: capture every page and state with layout checks, review the screenshots, fix defects, then re-capture and verify (two fix rounds at most)',
  phases: [
    { title: 'Capture', detail: 'production build, every route and state at three widths, automated layout checks' },
    { title: 'Review', detail: 'two reviewers open every screenshot and list defects' },
    { title: 'Fix', detail: 'fix the defects in the visual-review worktree' },
    { title: 'Verify', detail: 're-capture, compare before and after, find regressions' },
  ],
}

const WT = '/home/claude/hushloom-visual'
const MAIN = '/home/claude/hushloom'
const EV = '/mnt/project-files/playbox-2/evidence/visual'

const COMMON = `
You are working on the visual review of Hushloom, an adults-only, AI-native image and video creation web app (Next.js 15 App Router, React 19, strict TypeScript, Tailwind 4 with tokens in src/app/globals.css and primitives in src/components/ui.tsx, Drizzle + Postgres 16, BullMQ + Redis 7 worker). Hushloom has its own look (it must look nothing like playbox.com); never restyle it toward any other product. AI generation is a labeled demo: outputs are placeholder images and clips rendered by ffmpeg and sharp and marked Demo. Payments, age verification and scanning run in labeled sandbox or development modes.
Work only in the git worktree ${WT} (branch visual-review). Never touch ${MAIN} or any other worktree, never "git push", never call mcp__hearthbot__ tools, never touch GitHub. Postgres (user playbox, localhost:5432, trust) and Redis (localhost:6379) run locally; if not, run "bash ${MAIN}/notes/workflow/start-services.sh".
The e2e harness (playwright.config.ts) builds the production app, resets and seeds the database playbox_e2e (Redis db 2, storage .storage-e2e), and starts the standalone server on http://localhost:3100 with a worker (health on 3901); the seeded accounts are in scripts/seed.ts and share the password e2e-password-123; APP_ENV=test, so the sandboxes run. Location headers x-country-code and x-region-code (for example GB, or US with TX) set the jurisdiction; GB and the covered US states require age verification. Existing specs: tests/e2e/journey.spec.ts and tests/e2e/launch.spec.ts, with the evidence helper tests/e2e/evidence.ts (study how they sign in, set headers and use the sandboxes). Only one e2e run may happen at a time on this machine: never start two.
Commit rules: commit your work in ${WT} with clear subjects; end every commit message with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BSE2farBCYZaqmEuz9DVcb
Zero fabrication: never claim a page rendered, a check passed or a defect is fixed without the screenshot or command output that shows it.`

const MANIFEST = {
  type: 'object',
  properties: {
    manifest: { type: 'string', description: 'absolute path of the manifest JSON' },
    shots: { type: 'integer' },
    notCaptured: { type: 'array', items: { type: 'string' }, description: 'route or state, and why it could not be captured' },
    automated: { type: 'string', description: 'summary of the automated checks: counts of horizontal overflow, small targets, clipped text and contrast failures by width' },
    commit: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['manifest', 'shots', 'notCaptured', 'automated', 'commit', 'notes'],
}

const DEFECTS = {
  type: 'object',
  properties: {
    reviewed: { type: 'integer', description: 'screenshots opened and looked at' },
    defects: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string', description: 'V-<group>-<n>' },
      severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      route: { type: 'string' },
      width: { type: 'integer' },
      state: { type: 'string', description: 'role and state, for example member, empty Library' },
      screenshot: { type: 'string' },
      what: { type: 'string' },
      where: { type: 'string', description: 'element or selector, and the likely source file' },
      fix: { type: 'string' },
    }, required: ['id', 'severity', 'route', 'width', 'state', 'screenshot', 'what', 'where', 'fix'] } },
    fine: { type: 'array', items: { type: 'string' }, description: 'pages checked with no defect' },
  },
  required: ['reviewed', 'defects', 'fine'],
}

const FIX = {
  type: 'object',
  properties: {
    commits: { type: 'array', items: { type: 'string' } },
    results: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'not-fixed', 'not-a-defect'] }, commit: { type: 'string' }, notes: { type: 'string' },
    }, required: ['id', 'status', 'commit', 'notes'] } },
    checks: { type: 'string', description: 'quoted typecheck, lint, full vitest and full Playwright results' },
  },
  required: ['commits', 'results', 'checks'],
}

const VERIFY = {
  type: 'object',
  properties: {
    manifest: { type: 'string' },
    results: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'not-fixed', 'regressed'] }, before: { type: 'string' }, after: { type: 'string' }, notes: { type: 'string' },
    }, required: ['id', 'status', 'before', 'after', 'notes'] } },
    newDefects: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, route: { type: 'string' }, width: { type: 'integer' }, state: { type: 'string' }, screenshot: { type: 'string' }, what: { type: 'string' }, where: { type: 'string' }, fix: { type: 'string' },
    }, required: ['id', 'severity', 'route', 'width', 'state', 'screenshot', 'what', 'where', 'fix'] } },
    automated: { type: 'string' },
  },
  required: ['manifest', 'results', 'newDefects', 'automated'],
}

const SEVERITY = `Severity: high = content unreadable, hidden, overlapping or unreachable, a control that cannot be used, horizontal page scroll, layout broken; medium = clipped or truncated text that loses meaning, a tap target under 40 px on the 390 px phone layout (the design system's rule), misalignment or spacing that looks broken, contrast below WCAG AA, a missing loading, empty or error state; low = polish.`

const captureTask = (dir, round) => `${COMMON}\n\nTask: capture round "${dir}". ${round === 0 ? `First set up: cd ${WT}; if node_modules is missing, "ln -s ${MAIN}/node_modules node_modules". Then write tests/e2e/visual.spec.ts, skipped unless VISUAL_REVIEW=1 (so the normal e2e run is unchanged), which captures full-page screenshots of every page and state at three viewports: 390x844 (phone, isMobile and hasTouch), 820x1180 (tablet) and 1440x900 (desktop). Cover every page.tsx under src/app (use seeded ids for dynamic routes: a template, a creator, a Library item, a project; a generate kind), as anonymous, as a seeded member and as the seeded admin where the page differs by role, plus: a fresh member with no creations, projects or favorites (empty states); a member in GB who is not age verified (the verification surfaces and what is withheld); the not-found page; the offline page (context.setOffline after the service worker is ready, as launch.spec.ts does); loading skeletons (delay the navigation request with page.route on a client-side navigation, for the routes that have loading.tsx); open overlays: the You sheet on the phone, the job tray, the create panel and its cost sheet, filters, the pricing sandbox checkout, the sandbox age check, the takedown form, admin review. For each screenshot record automated checks in the page: horizontal overflow (document.documentElement.scrollWidth > innerWidth, and up to five offending elements whose right edge passes the viewport), interactive elements (a, button, input, select, textarea, [role=button], [tabindex]) that are visible and smaller than 40x40 px at 390 px or smaller than 24x24 px at any width, text clipped without an ellipsis (scrollWidth > clientWidth with overflow hidden and no text-overflow: ellipsis), and color-contrast violations from axe-core (inject node_modules/axe-core/axe.min.js with page.addScriptTag and run only the color-contrast rule). If an element fails a check by design (for example an inline text link), record it with the reason; do not hide it.` : `cd ${WT}. tests/e2e/visual.spec.ts exists; run it unchanged except for the output folder (fix it only if a fixed page changed a selector it uses, and say so).`} Write screenshots and a manifest JSON (one entry per screenshot: id, route, role, state, width, file, checks) to ${EV}/${dir}/ (VISUAL_SHOTS_DIR=${EV}/${dir}, read by the spec). Run it with "VISUAL_REVIEW=1 VISUAL_SHOTS_DIR=${EV}/${dir} npx playwright test tests/e2e/visual.spec.ts". ${round === 0 ? 'Commit the spec ("Visual review capture spec, skipped unless VISUAL_REVIEW=1"). Also run the normal "npx playwright test" once to show the full e2e suite still passes with the new spec skipped; quote its summary in notes.' : ''} Return the manifest path, the counts and what could not be captured with the reason.`

const reviewTask = (manifest, group) => `${COMMON}\n\nTask: review screenshots. Do not edit or commit anything. The manifest is ${manifest}. Review the entries of group ${group.name}: ${group.rule}. Open EVERY screenshot of your group with the Read tool and look at it; read its automated checks in the manifest; open the source of the page and components when you need to name the cause. Check layout, overflow, truncation, tap targets on the phone layout, contrast, alignment and spacing, the demo and sandbox labels being visible, and the loading, empty and error states. ${SEVERITY} List only real defects (an automated flag that is fine on inspection goes in "fine" with the reason). Number your defects V-${group.key}-1, V-${group.key}-2, ...`

const fixTask = (defects, round) => `${COMMON}\n\nTask: fix visual defects, round ${round}. cd ${WT}. Defects (screenshots are on disk, open them):\n${JSON.stringify(defects, null, 1)}\n\nFix every high and medium defect, and low ones when the fix is small and safe. Keep Hushloom's own tokens and components; fix causes in shared primitives (src/components/ui.tsx, src/app/globals.css) when several pages share them, and keep the 40 px phone tap-target rule. Do not change behavior, copy meaning, routes or tests' intent; if a defect needs a product decision, leave it with status not-fixed and say which decision. One commit per defect or per shared cause ("Visual: <what changed>"). ${round === 1 ? 'Then add tests/e2e/layout.spec.ts (always on, short): at 390 and 820 px, no horizontal page overflow on the main routes (home, explore, a template, Library, projects, pricing, settings, auth) as anonymous and as a member, and every visible primary navigation control and primary action at least 40x40 px at 390 px. It must pass. ' : ''}Before you finish: npm run typecheck clean, npm run lint clean, full vitest green (TEST_DATABASE_URL=postgres://playbox@localhost:5432/playbox_test_visual TEST_REDIS_URL=redis://localhost:6379/10 STORAGE_LOCAL_DIR=.storage-test-visual npx vitest run; createdb playbox_test_visual first, ignore "already exists"), and the full "npx playwright test" passing; quote all four. No uncommitted changes at the end.`

const verifyTask = (dir, defects, fixes) => `${captureTask(dir, 1)}\n\nThen verify: for each defect below, open its before screenshot and the matching after screenshot (same route, role, state and width) and decide fixed, not-fixed or regressed. Then compare the automated checks of every after entry with the before manifest ${EV}/before/manifest.json and open every after screenshot whose checks got worse or whose page a fix commit touched (git -C ${WT} log --stat), and list any new defect (ids V-new-1, ...). ${SEVERITY}\n\nDefects and the fixer's report:\n${JSON.stringify({ defects, fixes }, null, 1)}`

phase('Capture')
const cap = await agent(captureTask('before', 0), { label: 'capture:before', phase: 'Capture', schema: MANIFEST })
if (!cap) return { error: 'capture failed' }

phase('Review')
const GROUPS = [
  { key: 'A', name: 'A (discovery and making)', rule: 'routes /, /explore, /templates/*, /creators/*, /generate/*, /studio, /train, /pricing, /pricing/sandbox, /auth, /policies, /policies/takedown, /offline, not-found, and overlays opened on those pages (create panel, cost sheet, job tray, filters)' },
  { key: 'B', name: 'B (account, library and admin)', rule: 'every other entry: /collection and /collection/*, /projects and /projects/*, /favorites, /settings, /admin, /admin/review, /verify/sandbox, the You sheet, empty states, the unverified GB member, loading skeletons' },
]
const reviews = await parallel(GROUPS.map(g => () => agent(reviewTask(cap.manifest, g), { label: `review:${g.key}`, phase: 'Review', schema: DEFECTS })))
let open = reviews.filter(Boolean).flatMap(r => r.defects)
const rounds = []

for (let round = 1; round <= 2 && open.some(d => d.severity !== 'low' || round === 1); round++) {
  phase('Fix')
  const fixes = await agent(fixTask(open, round), { label: `fix:${round}`, phase: 'Fix', schema: FIX })
  if (!fixes) { rounds.push({ round, fixes: null }); break }
  phase('Verify')
  const dir = round === 1 ? 'after' : `after-${round}`
  const ver = await agent(verifyTask(dir, open, fixes), { label: `verify:${round}`, phase: 'Verify', schema: VERIFY })
  rounds.push({ round, defects: open, fixes, verify: ver })
  if (!ver) break
  const notFixedIds = new Set(ver.results.filter(r => r.status !== 'fixed').map(r => r.id))
  const skipped = new Set(fixes.results.filter(r => r.status !== 'fixed').map(r => r.id))
  open = [...open.filter(d => notFixedIds.has(d.id) && !skipped.has(d.id)), ...ver.newDefects]
  if (!open.length) break
}

return { capture: cap, reviews, rounds, remaining: open }
