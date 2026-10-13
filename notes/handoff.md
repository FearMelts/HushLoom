# Hand-off (2026-10-13 02:15 UTC)

Read this first, then `notes/progress.md` (the tracker) and `notes/plan.md` (decisions and environment).

## Where things stand

- Integration branch: `claude/playbox-2-foundation-q7fpbs`, pushed. It holds the original build, the
  launch-readiness scaffold (migration 0002), and the merged **payments** and **age verification** tracks.
- Last verified on this branch (2026-10-13 02:04): typecheck exit 0, lint 0 warnings, vitest 121/121 in
  9 files. Playwright was last run before these merges (8/8 at 22:26 on 2026-10-12) and must be re-run.
- Running when this was written: the **scanning** and **web app** tracks (workflow `hushloom-build-stage`,
  two worktrees under `.claude/worktrees/`) and a read-only Copilot reader. Neither track had written or
  committed anything yet. Worktrees are local to the container and are lost if it is reclaimed; treat
  both tracks as **not done** unless their branches exist when you resume.

## How to resume

1. Restart services after any container restart: `sh notes/workflow/start-services.sh`
   (Postgres 16 runs as the `postgres` user from `/home/claude/.pgdata`; Redis keeps its dump in
   `/home/claude/.redis-data`, never in the repo). If `.pgdata` is gone, follow "Environment" in
   `notes/plan.md` (initdb must run as `postgres`, not root), then `npm run db:migrate` and
   `SEED_PASSWORD=<choose> npm run db:seed`.
2. `git worktree list`. For each track branch that exists, check it has commits on top of the
   integration head and a clean tree, then run in its worktree:
   `npm run typecheck && npm run lint && TEST_DATABASE_URL=postgres://playbox@localhost:5432/playbox_test_<track> TEST_REDIS_URL=redis://localhost:6379/<n> npm test`.
   A track whose agent stopped mid-work but committed everything can be verified and merged by hand,
   as was done for payments; a track with no commits restarts from scratch.
3. Build the remaining tracks two at a time, in slot order, each from the current integration head:
   scanning + web app, then fix track A + fix track B, then infra. The full briefs for every track are in
   `notes/workflow/hushloom-build-stage.js` (the `TRACKS` array);
   run it with the Workflow tool and `args: { tracks: [...], base: "<integration head sha>" }`.
4. Merge each stage's tracks in slot order with `git merge --no-ff`, re-running typecheck, lint and vitest
   after every merge. Record each result in the tracker.
5. Then phases 2 to 6 of the run plan (tracker, "Phase status").

## Working material

In the repo under `notes/analysis/`, `notes/workflow/` and `docs/drafts/`, and also in
`/mnt/project-files/playbox-2/working/` (the shared project folder):

| Path | What it is |
| --- | --- |
| `spec.md`, `addendum.md` | The product spec and the approved launch-readiness addendum with its sources |
| `maps/` | Nine subsystem maps of the code at commit 9acac2e, with file:line evidence |
| `audits/` | Four spec-coverage audits; fix tracks A and B are built from their defect lists |
| `track-reports/` | The age track's full report (env vars, unverified items, docs notes) and the payments commit notes |
| `doc-drafts/` | Vision and information-architecture drafts plus their critiques (both "revise"; revision was interrupted) |
| `workflow-scripts/` | The stage script with every track brief |
| `start-services.sh` | Restarts Postgres and Redis |

## Nothing is waiting on Jayvo

No PR is open; per the earlier decision it is prepared and listed in the final report. Nothing has been
merged into or pushed to `main`, and Copilot's work is untouched.
