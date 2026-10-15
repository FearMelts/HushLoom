export const meta = {
  name: 'hushloom-phase2-journey-resume',
  description: 'Finish closing the journey critic gaps in the existing worktree after the session limit, fix the not-found 200 status, and run the full e2e suite green',
  phases: [{ title: 'Close gaps', detail: 'continue the interrupted gap-closing work in its worktree' }],
}

const MAIN = '/home/claude/hushloom'
const WT = '/home/claude/hushloom/.claude/worktrees/wf_5d342506-e09-1'
const SP = '/tmp/claude-0/-home-claude-hushloom/ef68adc1-eb6d-56e0-b7e4-cbc2303fcdd6/scratchpad'
const SHOTS = '/mnt/project-files/playbox-2/evidence/journey'

const RULES = `
You are working on the Hushloom build (Next.js 15 App Router, React 19, strict TypeScript, Tailwind 4, Drizzle + Postgres 16, BullMQ + Redis 7, Playwright with Chromium pre-installed at /opt/pw-browsers; never run "playwright install").
Rules:
- Work only in the worktree ${WT} (cd there first; it is on branch worktree-wf_5d342506-e09-1; its node_modules symlink exists). Never touch ${MAIN} (the main checkout) or other worktrees, never "git push", never call any mcp__hearthbot__ tool, never touch GitHub.
- Postgres (user playbox, localhost:5432) and Redis (localhost:6379) run locally; if not, run "bash ${MAIN}/notes/workflow/start-services.sh".
- The e2e stack is defined in playwright.config.ts (it resets the playbox_e2e database and Redis db 2, migrates, seeds, builds the production app and starts it on port 3100 plus the worker on 3901). Run the full suite with "E2E_SHOTS_DIR=${SHOTS} npm run test:e2e" (3-6 minutes; give the Bash call a 15-minute timeout). Nobody else runs e2e right now.
- Zero fabrication: report only what you ran and saw; quote Playwright's summary lines. Never weaken an assertion to make a test pass. A real app defect gets a small, local fix in its own "Fix:" commit, or stays asserted with test.fixme scoped to the smallest possible test and listed under appBugs.
- Commit after each coherent step ("WIP:" while red). End every commit message with exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BSE2farBCYZaqmEuz9DVcb
- Before finishing: npm run typecheck clean, npm run lint clean (0 warnings), the full e2e suite run green, no uncommitted changes (node_modules symlink, .next, test-results and storage dirs stay untracked).`

const REPORT = {
  type: 'object',
  properties: {
    worktree: { type: 'string' }, branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    finalRun: { type: 'string', description: 'exact command and Playwright summary lines of the last full run, quoted' },
    tests: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'fixme', 'skipped'] }, notes: { type: 'string' } }, required: ['title', 'status', 'notes'] } },
    screenshots: { type: 'array', items: { type: 'string' } },
    errorsLogged: { type: 'string' },
    appBugs: { type: 'array', items: { type: 'object', properties: { summary: { type: 'string' }, evidence: { type: 'string' }, fixed: { type: 'boolean' }, commit: { type: 'string' } }, required: ['summary', 'evidence', 'fixed', 'commit'] } },
    gapsClosed: { type: 'array', items: { type: 'string' } },
    notCovered: { type: 'array', items: { type: 'string' } },
  },
  required: ['worktree', 'branch', 'commits', 'finalRun', 'tests', 'screenshots', 'errorsLogged', 'appBugs', 'gapsClosed', 'notCovered'],
}

phase('Close gaps')
const r = await agent(`${RULES}

You CONTINUE interrupted work. Earlier, an author wrote tests/e2e/launch.spec.ts and tests/e2e/evidence.ts (report: ${SP}/journey-first.json) and a read-only critic listed gaps, weak assertions and evidence problems (${SP}/journey-critic.json). A first gap-closing pass was interrupted by a session limit; its unfinished edits are the last commit on the branch, subject "WIP: journey gap closing ...". Read "git log --oneline 542af7a..HEAD" and that WIP diff first, then finish the job:
1. Address every "must" gap, every weak assertion and every evidence problem in the critic file, and the "should" gaps that take under 20 minutes each; list the rest under notCovered with the reason.
2. Fix the app defect the author found: not-found pages answer HTTP 200 instead of 404 because the route-level loading.tsx files on dynamic [id] routes (collection/[id], templates/[id], creators/[id], projects/[id] and any other dynamic route with a loading.tsx) start streaming before the page calls notFound(). Remove loading.tsx from those dynamic routes (keep it on list routes such as /, /explore, /collection, /projects, /favorites), or otherwise make the existence and permission check run before any streaming; then the journey's "another member cannot see that creation" test must run un-fixme'd and pass (status 404). Put this in its own "Fix:" commit and say which loading files you removed.
3. Keep the earlier "Fix:" commit for hydration (11ad512) and add the regression test the critic asked for if it is missing.
4. Run the full suite green, then commit (fold the WIP commit into proper commits if you like; never rewrite the earlier non-WIP commits).
Return the report for the final state: all commits since 542af7a, every test with its status, the final run, screenshots, error evidence, app bugs, gaps closed and what is not covered.`, { label: 'journey:close-gaps', phase: 'Close gaps', schema: REPORT })
return r