import type { APIRequestContext } from "@playwright/test";
import { BASE, expect, test } from "./evidence";

// Creation detail's side-by-side comparison says Demo on each figure that shows demo media, like every other
// place that shows it (fact-check D2b): the compared version had no badge, and the note below followed only
// the open creation. The comparison opens on a tap, so this runs in a real browser.

const post = (request: APIRequestContext, path: string, data: unknown) => request.post(path, { data, headers: { Origin: BASE } });

/** Confirms a priced draft and waits for the worker to finish it. */
async function finish(request: APIRequestContext, job: { id: string; costCredits: number }) {
  expect((await post(request, `/api/generations/${job.id}/confirm`, { expectedCost: job.costCredits })).status(), "confirm").toBe(200);
  await expect
    .poll(async () => ((await (await request.get(`/api/generations/${job.id}`)).json()) as { job: { status: string } }).job.status, { timeout: 60_000, intervals: [500] })
    .toBe("completed");
}

test("the comparison labels a demo version on both sides", async ({ browser, evidence }) => {
  const { ctx, page } = await evidence.newPage(browser, { viewport: { width: 1440, height: 900 } });
  const login = await post(ctx.request, "/api/auth/login", { email: "demo@hushloom.local", password: "e2e-password-123" });
  expect(login.status(), "member sign-in").toBe(200);

  const stamp = Date.now();
  const draft = await post(ctx.request, "/api/generations", {
    idempotencyKey: `labels-${stamp}`,
    mode: "text_to_image",
    modelKey: "demo-still",
    prompt: "a quiet lakeside cabin at dusk, warm window light",
    params: { aspectRatio: "4:5" },
  });
  expect(draft.status(), "draft").toBe(201);
  const original = ((await draft.json()) as { job: { id: string; costCredits: number } }).job;
  await finish(ctx.request, original);
  const derived = await post(ctx.request, `/api/generations/${original.id}/derive`, { relation: "variation", idempotencyKey: `labels-var-${stamp}` });
  expect(derived.status(), "variation draft").toBe(201);
  const variation = ((await derived.json()) as { job: { id: string; costCredits: number } }).job;
  await finish(ctx.request, variation);

  await page.goto(`/collection/${variation.id}`);
  await page.getByRole("button", { name: /^Compare with original/ }).click();
  const figures = page.locator('[aria-label="Comparison"] figure');
  await expect(figures).toHaveCount(2);
  for (const i of [0, 1]) await expect(figures.nth(i).getByText("Demo", { exact: true }), `figure ${i + 1}`).toBeVisible();
  await expect(page.getByText("Demo output: made locally by the development placeholder model")).toBeVisible();
});
