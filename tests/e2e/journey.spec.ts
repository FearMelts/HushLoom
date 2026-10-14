import type { APIRequestContext, Page } from "@playwright/test";
import { BASE, expect, test } from "./evidence";

// Every test here records its console errors, page errors and failed requests through the evidence
// fixture (tests/e2e/evidence.ts), and fails on an undeclared console error, page error or 5xx.

const SEED_PASSWORD = "e2e-password-123";
const stamp = Date.now().toString(36);

// The rail and the mobile header each render a balance; only one is visible at a time.
const balance = (page: Page) => page.getByTestId("credit-balance").filter({ visible: true });

async function enterAgeGate(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Adults only" })).toBeVisible();
  await page.getByRole("button", { name: "I am 18 or older, enter" }).click();
  await expect(page.getByRole("heading", { name: "Adults only" })).toBeHidden();
}

async function signUp(page: Page, handle: string, dob = "1994-06-15") {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Password").fill("e2e-member-pass");
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Display name").fill(handle);
  await page.getByLabel("Date of birth").fill(dob);
  await page.getByText("I am at least 18").click();
  await page.getByText("I agree to the").click();
  await page.getByRole("button", { name: "Create account" }).last().click();
}

async function apiAs(request: APIRequestContext, email: string, password: string) {
  const res = await request.post("/api/auth/login", { data: { email, password }, headers: { Origin: BASE } });
  expect(res.status()).toBe(200);
}

test.describe.configure({ mode: "serial" });

let creationId = "";
let mediaUrl = "";

test("an adult signs up, makes a demo image from a template, and finds it in the Library", async ({ page, browser, evidence }) => {
  evidence.watch(page);
  await enterAgeGate(page);
  const handle = `e2e_${stamp}`;
  await signUp(page, handle);
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(balance(page)).toHaveText("0");

  // An admin grants credits through the real admin API.
  const admin = await evidence.newContext(browser);
  await apiAs(admin.request, "admin@hushloom.local", SEED_PASSWORD);
  const grant = await admin.request.post("/api/admin/credits", { data: { account: handle, amount: 40, reason: "e2e", idempotencyKey: `e2e-${stamp}` }, headers: { Origin: BASE } });
  expect(grant.status()).toBe(200);
  evidence.note("admin grant through POST /api/admin/credits", { status: grant.status(), account: handle, amount: 40 });
  await admin.close();

  await page.goto("/explore?q=velvet");
  await page.getByRole("link", { name: /Velvet Hour/ }).first().click();
  await expect(page.getByRole("heading", { name: "Velvet Hour" })).toBeVisible();
  await expect(page.getByTestId("cost-line")).toHaveText(/^4 credits · you have \d+/);
  await page.getByRole("button", { name: "Make it" }).click();
  await expect(page.getByTestId("confirm-cost")).toHaveText("4 credits");
  await expect(page.getByText("You will get a labeled placeholder")).toBeVisible();
  await page.getByTestId("confirm-make").click();
  await expect(page.getByText("Weaving a demo placeholder.")).toBeVisible();

  // The worker finishes it; the Library shows the real state, not a timer.
  await page.goto("/collection");
  const thumb = page.locator("article").first();
  await expect(async () => {
    await page.reload();
    await expect(page.locator("article").first().getByRole("link")).toHaveAttribute("aria-label", /^Ready:/, { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await expect(thumb.getByText("Demo")).toBeVisible();
  await thumb.getByRole("link").click();
  await expect(page).toHaveURL(/\/collection\/[0-9a-f-]{36}$/);
  creationId = page.url().split("/").pop()!;
  const img = page.getByAltText("Your creation");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  mediaUrl = (await img.getAttribute("src"))!;
  expect(mediaUrl).toContain("/api/media?");

  // 40 granted, 4 spent.
  await expect(balance(page)).toHaveText("36");
  await evidence.shot(page, "journey-01-creation-detail");
});

test("another member cannot see that creation or its media", async ({ browser, evidence }) => {
  expect(creationId).not.toBe("");
  evidence.allow({ url: `/collection/${creationId}`, status: 404, why: "another member's creation page is a 404" });
  const { ctx, page } = await evidence.newPage(browser);
  const mediaRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/media")) mediaRequests.push(r.url());
  });
  await enterAgeGate(page);
  await signUp(page, `peek_${stamp}`);
  await expect(page).toHaveURL(`${BASE}/`);

  // The page answers 404 with the not-found screen and nothing of the creation.
  const detail = await page.goto(`/collection/${creationId}`);
  expect(detail?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "A loose thread", level: 1 })).toBeVisible();
  await expect(page.getByText("This page does not exist, or it is private to someone else.")).toBeVisible();
  await expect(page.getByAltText("Your creation")).toHaveCount(0);
  const mediaKey = new URL(mediaUrl, BASE).searchParams.get("k")!;
  expect(mediaKey).toMatch(/^outputs\//);
  const html = await page.content();
  expect(html).not.toContain(mediaKey);
  expect(html).not.toContain(encodeURIComponent(mediaKey));
  const imgSources = await page.locator("img").evaluateAll((els) => els.map((el) => (el as HTMLImageElement).currentSrc || el.getAttribute("src") || ""));
  expect(imgSources.filter((src) => src.includes(mediaKey) || src.includes(encodeURIComponent(mediaKey)))).toEqual([]);
  expect(mediaRequests.filter((u) => u.includes(encodeURIComponent(mediaKey)))).toEqual([]);
  await evidence.shot(page, "journey-02-other-member-not-found");

  const api = {
    get: (await ctx.request.get(`/api/generations/${creationId}`)).status(),
    derive: (await ctx.request.post(`/api/generations/${creationId}/derive`, { data: { relation: "variation", idempotencyKey: `peek-${stamp}` }, headers: { Origin: BASE } })).status(),
    delete: (await ctx.request.delete(`/api/generations/${creationId}`, { headers: { Origin: BASE } })).status(),
  };
  evidence.note("another member's API calls on the creation", api);
  expect(api).toEqual({ get: 404, derive: 404, delete: 404 });

  const tampered = new URL(mediaUrl, BASE);
  tampered.searchParams.set("s", "forged");
  const forged = (await ctx.request.get(tampered.toString())).status();
  // A request from another site is refused before it reaches the handler.
  const crossSite = (await ctx.request.post("/api/folders", { data: { name: "x" }, headers: { Origin: "https://evil.example" } })).status();
  evidence.note("forged media signature and cross-site POST", { forgedMedia: forged, crossSitePost: crossSite });
  expect(forged).toBe(403);
  expect(crossSite).toBe(403);

  // The owner's creation is untouched by those attempts.
  const owner = await evidence.newContext(browser);
  await apiAs(owner.request, `e2e_${stamp}@example.test`, "e2e-member-pass");
  expect((await owner.request.get(`/api/generations/${creationId}`)).status()).toBe(200);
  await ctx.close();
});

// Regression for the not-found status fix: no loading boundary may sit above a page that can 404 or
// redirect, or the page streams a 200 shell before it calls notFound() or redirect().
test("missing and private pages answer 404, signed-out private pages redirect, and list pages still answer 200", async ({ browser, evidence }) => {
  const missing = [
    "/collection/00000000-0000-4000-8000-000000000000",
    "/collection/not-a-uuid",
    "/templates/no-such-template",
    "/creators/no-such-creator",
    "/projects/00000000-0000-4000-8000-000000000000",
    "/generate/no-such-kind",
    // Operator pages are a 404 to members.
    "/admin",
    "/admin/review",
  ];
  evidence.allow(...missing.map((path) => ({ url: `${BASE}${path}`, status: 404, why: "a missing, private or operator-only page is a 404" })));
  const { ctx, page } = await evidence.newPage(browser);
  await enterAgeGate(page);

  // Signed out (past the age gate): a private detail page redirects to sign-in with a real 307.
  const redirects: Record<string, { status: number; location: string | undefined }> = {};
  for (const path of ["/collection/00000000-0000-4000-8000-000000000000", "/projects/00000000-0000-4000-8000-000000000000"]) {
    const res = await ctx.request.get(path, { maxRedirects: 0 });
    redirects[path] = { status: res.status(), location: res.headers()["location"] };
  }
  // A public detail page that does not exist is a 404 for anyone.
  const anonymous = {
    template: (await ctx.request.get("/templates/no-such-template", { maxRedirects: 0 })).status(),
    creator: (await ctx.request.get("/creators/no-such-creator", { maxRedirects: 0 })).status(),
  };
  evidence.note("signed-out requests", { redirects, anonymous });
  expect(redirects).toEqual({
    "/collection/00000000-0000-4000-8000-000000000000": { status: 307, location: "/auth?next=/collection/00000000-0000-4000-8000-000000000000" },
    "/projects/00000000-0000-4000-8000-000000000000": { status: 307, location: "/auth?next=/projects/00000000-0000-4000-8000-000000000000" },
  });
  expect(anonymous).toEqual({ template: 404, creator: 404 });

  await signUp(page, `miss_${stamp}`);
  await expect(page).toHaveURL(`${BASE}/`);
  const statuses: Record<string, number | undefined> = {};
  for (const path of missing) {
    const res = await page.goto(path);
    statuses[path] = res?.status();
    await expect(page.getByRole("heading", { name: "A loose thread", level: 1 }), path).toBeVisible();
  }
  await evidence.shot(page, "journey-02b-missing-page-404");
  // The list pages keep their loading skeletons and still answer 200.
  for (const path of ["/", "/explore", "/collection", "/projects", "/favorites"]) {
    const res = await page.goto(path);
    statuses[path] = res?.status();
    await expect(page.getByRole("heading", { name: "A loose thread" }), path).toHaveCount(0);
  }
  evidence.note("signed-in navigation statuses", statuses);
  expect(statuses).toEqual({ ...Object.fromEntries(missing.map((path) => [path, 404])), "/": 200, "/explore": 200, "/collection": 200, "/projects": 200, "/favorites": 200 });
});

test("an under-18 date of birth is refused", async ({ page, evidence }) => {
  evidence.allow({ url: /\/api\/auth\/signup$/, status: 403, method: "POST", why: "sign-up refuses an under-18 date of birth (underage)" });
  evidence.watch(page);
  await enterAgeGate(page);
  const dob = new Date();
  dob.setUTCFullYear(dob.getUTCFullYear() - 16);
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/auth/signup") && r.request().method() === "POST");
  await signUp(page, `kid_${stamp}`, dob.toISOString().slice(0, 10));
  const res = await refused;
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("underage");
  await expect(page.getByRole("alert").filter({ hasText: "adults only" })).toHaveText("Hushloom is for adults only.");
  await expect(page).toHaveURL(/\/auth/);
  await evidence.shot(page, "journey-03-under-18-refused");
});

test("the assistant blocks a prohibited prompt before anything is charged", async ({ page, evidence }) => {
  evidence.watch(page);
  await enterAgeGate(page);
  await page.goto("/auth?mode=signin");
  await page.getByLabel("Email").fill("demo@hushloom.local");
  await page.getByLabel("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page).toHaveURL(`${BASE}/`);
  await page.goto("/generate/image");
  await page.getByLabel("Prompt", { exact: true }).fill("a teen at the beach");
  await expect(page.getByText("This can't be created")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make it" })).toBeDisabled();
  await evidence.shot(page, "journey-04-prohibited-prompt-blocked");
});

for (const [name, width, height] of [
  ["mobile", 390, 844],
  ["tablet", 820, 1180],
  ["desktop", 1440, 960],
] as const) {
  test(`layout holds on ${name}`, async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, { viewport: { width, height } });
    await enterAgeGate(page);
    for (const [path, slugName] of [
      ["/", "home"],
      ["/explore", "explore"],
      ["/templates/velvet-hour", "template"],
      ["/pricing", "pricing"],
    ] as const) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} scrolls sideways on ${name}`).toBeLessThanOrEqual(0);
      await evidence.shot(page, `journey-layout-${name}-${slugName}`);
    }
  });
}

test("keyboard users can skip to content and reach navigation", async ({ page, evidence }) => {
  evidence.watch(page);
  await enterAgeGate(page);
  await page.goto("/explore");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  // Every interactive element in the rail is reachable and labelled.
  const unlabeled = await page.evaluate(() =>
    [...document.querySelectorAll("a, button")].filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
      return visible && !name;
    }).length,
  );
  expect(unlabeled).toBe(0);
});
