# GitHub Actions CI runs on the integration branch

Read on 2026-10-14 19:50 UTC through the GitHub API (workflow `.github/workflows/ci.yml`, which runs on
pushes to every branch except main). 22 runs in total; the ten newest:

| Run | Commit | Result | Notes |
| --- | --- | --- | --- |
| 16 | 574ccaf (docs merge; code as at 09a436e) | success | both jobs: "Typecheck, lint, unit and integration tests, build" and "Playwright journey (production build)", every step green |
| 15 | 3f3637a | success | |
| 14 | 27b3a33 | success | |
| 13 | 09a436e | cancelled | superseded by the next push (the workflow cancels in-progress runs per ref) |
| 12 | 446719a | success | |
| 11 | 2f3815c (code as at ce84bff) | success | |
| 10 | 342afb4 | cancelled | superseded |
| 9 | ce84bff | failure | Playwright job only: 28 passed, 1 failed, 7 did not run. tests/e2e/journey.spec.ts:90 "another member cannot see that creation or its media": `apiRequestContext.get: socket hang up` on GET /api/generations/:id (journey.spec.ts:119). The server logged no error. The same code passed at run 11 and at every later run, and locally (notes/evidence/e2e-ce84bff.log, e2e-09a436e.log). Cause not determined; a keep-alive connection closed by the server between requests is the likely explanation (inferred, not shown). |
| 8 | d6e271e | success | |
| 7 | fe21509 | success | |

Links: https://github.com/FearMelts/HushLoom/actions/runs/38604600428 (run 16),
https://github.com/FearMelts/HushLoom/actions/runs/38545674895 (run 9).

The checks job's step log does not print the vitest summary in its tail, so the count on GitHub is
not recorded here; the step's exit status is success.
