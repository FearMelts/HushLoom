# GitHub Actions CI runs on the integration branch

Read through the GitHub API on 2026-10-15 00:20 UTC. The repository lists 24 workflow runs: 18 are this
repository's CI workflow (`.github/workflows/ci.yml`, which runs on pushes to every branch except
main, with two jobs: "Typecheck, lint, unit and integration tests, build" and "Playwright journey
(production build)"), and 6 are Copilot's own agent and review runs on Copilot's branches (not CI,
not part of this build). All 18 CI runs are on `claude/playbox-2-foundation-q7fpbs`.

| Run | Commit | Result | Notes |
| --- | --- | --- | --- |
| 18 | 97cc5c8 | in progress when read | tracker commit after the demo-label merge |
| 17 | b879e35 | success | docs sync merge |
| 16 | 574ccaf | success | both jobs, every step green |
| 15 | 3f3637a | success | |
| 14 | 27b3a33 | success | |
| 13 | 09a436e | cancelled | superseded by the next push (the workflow cancels in-progress runs per ref) |
| 12 | 446719a | success | |
| 11 | 2f3815c | success | same app code as ce84bff (run 9) |
| 10 | 342afb4 | cancelled | superseded |
| 9 | ce84bff | failure | Playwright job only: 28 passed, 1 failed, 7 did not run. journey.spec.ts:90 "another member cannot see that creation or its media": `apiRequestContext.get: socket hang up` on GET /api/generations/:id (journey.spec.ts:119). The server logged no error. The same code passed at run 11, and locally (notes/evidence/e2e-ce84bff.log). Cause not determined; a keep-alive connection closed by the server between requests is the likely explanation (inferred, not shown). |
| 8 | d6e271e | success | |
| 7 | fe21509 | success | first CI run after the launch browser journey merged (f80a555) |
| 6 | 73dcdee | failure | Playwright job; same app code as run 1 (no change under src, tests, scripts, package.json, playwright.config.ts or .github); log not read |
| 5 | 5c6bc8d | cancelled | superseded |
| 4 | 0c666db | failure | Playwright job; same app code as run 1; log not read |
| 3 | f11f799 | cancelled | superseded |
| 2 | 3412ad0 | failure | Playwright job; same app code as run 1; log not read |
| 1 | c52f843 | failure | Playwright job: 1 passed, 1 failed, 6 did not run. journey.spec.ts:84 "another member cannot see that creation or its media": `/collection/:id` answered 200 where 404 was expected. That was a real defect (not-found pages under a loading boundary answered 200), fixed by the launch browser journey track (merged at f80a555); every completed run since fe21509 except run 9 passed. The checks job passed. |

Summary: of 18 CI runs, 8 succeeded, 4 were cancelled by a newer push, 1 is in progress, and 5 failed,
all in the Playwright job: four before the not-found fix (runs 1, 2, 4 and 6; run 1's log shows the cause, and runs 2, 4 and 6
ran the same code) and one
intermittent failure after it (run 9). The checks job (typecheck, lint, vitest, production build)
has not failed in any run whose jobs were read (runs 1, 9, 16). The checks job's step log does not
print the vitest summary in its tail, so the test count on GitHub is not recorded here.

Links: run 16 https://github.com/FearMelts/HushLoom/actions/runs/38604600428 ; run 9
https://github.com/FearMelts/HushLoom/actions/runs/38545674895 ; run 1
https://github.com/FearMelts/HushLoom/actions/runs/38497148877
