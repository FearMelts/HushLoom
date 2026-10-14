import { createHmac } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { pricing } from "../../src/config/pricing";
import { BASE, expect, test, type Evidence } from "./evidence";

/**
 * Launch-readiness journeys (addendum §1-§4) in a real browser against the production build. Runs after
 * journey.spec.ts in the same run, so every account and record here carries its own stamp and nothing
 * depends on what journey.spec.ts left behind.
 */

const SEED_PASSWORD = "e2e-password-123";
const MEMBER_PASSWORD = "e2e-member-pass";
const stamp = `l${Date.now().toString(36)}`;

const DESKTOP = { viewport: { width: 1440, height: 960 } };
const PHONE = { viewport: { width: 390, height: 844 } };
// The edge's geo headers; the defaults in src/config/jurisdictions.ts require an age check in GB.
const GB = { extraHTTPHeaders: { "x-country-code": "GB" } };

const AGE_REFUSAL = "Your region requires an age check before you can create or upload.";
const OFFLINE_LINE = "You're offline. Nothing is queued; try again when you're back.";
const MATCH_FIXTURE = path.resolve("tests/fixtures/scan-drill-match.png");

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

// ── Helpers (journey.spec.ts keeps its own copies; importing a spec would register its tests twice) ──

// The rail and the mobile header each render a balance; only one is visible at a time.
const balance = (page: Page) => page.getByTestId("credit-balance").filter({ visible: true });

async function enterAgeGate(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Adults only" })).toBeVisible();
  await page.getByRole("button", { name: "I am 18 or older, enter" }).click();
  await expect(page.getByRole("heading", { name: "Adults only" })).toBeHidden();
}

async function signUp(page: Page, handle: string) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Password").fill(MEMBER_PASSWORD);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Display name").fill(handle);
  await page.getByLabel("Date of birth").fill("1992-03-09");
  await page.getByText("I am at least 18").click();
  await page.getByText("I agree to the").click();
  await page.getByRole("button", { name: "Create account" }).last().click();
  await expect(page).toHaveURL(`${BASE}/`);
}

async function apiAs(request: APIRequestContext, email: string, password = SEED_PASSWORD) {
  const res = await request.post("/api/auth/login", { data: { email, password }, headers: { Origin: BASE } });
  expect(res.status()).toBe(200);
}

/** A watched page signed in as the seeded admin through the real login API. */
async function adminPage(evidence: Evidence, browser: Browser, options = DESKTOP): Promise<Page> {
  const { ctx, page } = await evidence.newPage(browser, options);
  await apiAs(ctx.request, "admin@hushloom.local");
  return page;
}

async function grantCredits(evidence: Evidence, browser: Browser, account: string, amount: number) {
  const ctx = await evidence.newContext(browser);
  await apiAs(ctx.request, "admin@hushloom.local");
  const res = await ctx.request.post("/api/admin/credits", { data: { account, amount, reason: "e2e launch", idempotencyKey: `launch-${account}` }, headers: { Origin: BASE } });
  expect(res.status()).toBe(200);
  await ctx.close();
}

/** Every element attribute that points at app media: images, videos, posters, sources, links, inline styles. */
async function mediaRefsInDom(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((el) =>
      ["src", "srcset", "poster", "href", "style", "data-src"].map((a) => el.getAttribute(a) ?? "").filter((v) => v.includes("/api/media")),
    ),
  );
}

/** Requests the page made for /api/media, to show withheld media is never even fetched. */
function trackMediaRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/media")) seen.push(r.url());
  });
  return seen;
}

async function imageLoaded(locator: ReturnType<Page["locator"]>) {
  await expect.poll(() => locator.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
}

/** A harmless solid-colour PNG for clean uploads. */
function cleanPng(size = 768): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: 92, g: 60, b: 120 } } }).png().toBuffer();
}

/** Waits for whatever is still loading, without failing a screenshot-only step on a long poll. */
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const smallestPack = [...pricing.packs].sort((a, b) => a.credits - b.credits)[0]!;

// ── 1. Age verification (addendum §2) ──────────────────────────────────────────────────────────

test.describe("age verification in a covered jurisdiction (GB)", () => {
  test.describe.configure({ mode: "serial" });
  const handle = `gb_${stamp}`;
  let member: StorageState | undefined;

  test("an anonymous GB visitor sees no template media on cards or the template page", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, { ...DESKTOP, ...GB });
    const mediaRequests = trackMediaRequests(page);
    await enterAgeGate(page);

    await expect(page.getByText("Sign in and verify to see previews").first()).toBeVisible();
    expect(await page.getByText("Sign in and verify to see previews").count()).toBeGreaterThan(3);
    expect(await mediaRefsInDom(page)).toEqual([]);
    await settle(page);
    await evidence.shot(page, "age-01-home-withheld-gb");

    await page.goto("/explore");
    await expect(page.getByText("Sign in and verify to see previews").first()).toBeVisible();
    expect(await mediaRefsInDom(page)).toEqual([]);

    await page.goto("/templates/velvet-hour");
    await expect(page.getByRole("heading", { name: "Velvet Hour", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Velvet Hour preview withheld until age verification")).toContainText("Sign in and verify to see previews");
    await expect(page.getByAltText("Velvet Hour cover")).toHaveCount(0);
    expect(await mediaRefsInDom(page)).toEqual([]);
    // Withheld server-side: not even the page's HTML or its RSC payload carries a media URL.
    expect(await page.content()).not.toContain("/api/media");
    await settle(page);
    await evidence.shot(page, "age-02-template-withheld-gb");
    expect(mediaRequests).toEqual([]);
  });

  test("a new GB member is still withheld and cannot make or upload; nothing is charged", async ({ browser, evidence }) => {
    evidence.allow(
      { url: /\/api\/generations$/, status: 451, method: "POST", why: "GB needs a provider age check before making anything (age_verification_required)" },
      { url: /\/api\/uploads$/, status: 451, method: "POST", why: "GB needs a provider age check before uploading (age_verification_required)" },
    );
    const { ctx, page } = await evidence.newPage(browser, { ...DESKTOP, ...GB });
    const mediaRequests = trackMediaRequests(page);
    await enterAgeGate(page);
    await signUp(page, handle);
    await expect(page.getByText("Verify your age to see previews").first()).toBeVisible();
    await expect(page.getByText("Sign in and verify to see previews")).toHaveCount(0);
    expect(await mediaRefsInDom(page)).toEqual([]);
    await settle(page);
    await evidence.shot(page, "age-03-member-withheld-gb");

    await grantCredits(evidence, browser, handle, 40);
    await page.goto("/generate/image");
    await expect(balance(page)).toContainText("40");
    await page.getByLabel("Prompt", { exact: true }).fill("a quiet lakeside cabin at dusk, warm window light");
    const refused = page.waitForResponse((r) => r.url().endsWith("/api/generations") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Make it" }).click();
    expect((await refused).status()).toBe(451);
    await expect(page.getByRole("alert").filter({ hasText: AGE_REFUSAL })).toBeVisible();
    await expect(page.getByTestId("confirm-make")).toHaveCount(0);
    await evidence.shot(page, "age-04-make-refused-gb");

    // Upload through the create panel's image-to-image input, with the consent sheet.
    await page.reload();
    await expect(balance(page)).toContainText("40");
    await page.getByRole("radio", { name: "Image to image" }).click();
    await page.getByTestId("upload-input").setInputFiles({ name: "harmless.png", mimeType: "image/png", buffer: await cleanPng() });
    const sheet = page.getByRole("dialog", { name: "Before you upload" });
    await sheet.getByTestId("consent-checkbox").check();
    const uploadRefused = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
    await sheet.getByRole("button", { name: "Upload", exact: true }).click();
    expect((await uploadRefused).status()).toBe(451);
    await expect(page.getByRole("alert").filter({ hasText: AGE_REFUSAL })).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(page.getByAltText("Your upload")).toHaveCount(0);
    await evidence.shot(page, "age-05-upload-refused-gb");

    // Nothing was charged or held: the ledger shows only the grant.
    await page.goto("/pricing");
    await expect(page.getByTestId("pricing-balance")).toHaveText("40");
    await expect(page.getByRole("cell", { name: "Held for a creation" })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Spent" })).toHaveCount(0);
    expect(mediaRequests).toEqual([]);
    member = await ctx.storageState();
  });

  test("Settings: the check is required and sandbox-labelled; a failed attempt, then verified", async ({ browser, evidence }) => {
    expect(member).toBeDefined();
    const { page } = await evidence.newPage(browser, { ...DESKTOP, ...GB, storageState: member });
    await page.goto("/settings#age-verification");
    const card = page.locator("#age-verification");
    await expect(card.getByRole("heading", { name: "Your age check" })).toBeVisible();
    // The status and sandbox badges sit next to the card's heading.
    const badges = card.getByRole("heading", { name: "Your age check" }).locator("..");
    await expect(badges.getByText("Not verified", { exact: true })).toBeVisible();
    await expect(badges.getByText("Sandbox", { exact: true })).toBeVisible();
    await expect(card).toContainText("United Kingdom");
    await expect(card).toContainText("Your region requires a provider age check before you create, upload or see previews.");
    await expect(card).toContainText("Sandbox check (proves nothing)");
    await card.scrollIntoViewIfNeeded();
    await evidence.shot(page, "age-06-settings-check-required");

    await card.getByRole("button", { name: "Verify now" }).click();
    await expect(page).toHaveURL(/\/verify\/sandbox\?ref=sbx_/);
    await expect(page.getByRole("heading", { name: "This is a sandbox age check." })).toBeVisible();
    await expect(page.getByText("It proves nothing about anyone's age.")).toBeVisible();
    await expect(page.getByText("Demo · not age verification")).toBeVisible();
    await evidence.shot(page, "age-07-sandbox-proves-nothing");

    await page.getByRole("button", { name: "Simulate failed" }).click();
    await expect(page).toHaveURL(`${BASE}/settings#age-verification`);
    await expect(badges.getByText("Not passed", { exact: true })).toBeVisible();
    await expect(card).toContainText("a simulated failure (sandbox)");
    await card.scrollIntoViewIfNeeded();
    await evidence.shot(page, "age-08-not-passed");

    await card.getByRole("button", { name: "Verify again" }).click();
    await expect(page).toHaveURL(/\/verify\/sandbox\?ref=sbx_/);
    await page.getByRole("button", { name: "Simulate verified" }).click();
    await expect(page).toHaveURL(`${BASE}/settings#age-verification`);
    await expect(badges.getByText("Verified", { exact: true })).toBeVisible();
    await expect(badges.getByText("Sandbox", { exact: true })).toBeVisible();
    await expect(card.getByText("You are all set.")).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await evidence.shot(page, "age-09-verified");
  });

  test("after verification previews load and a demo image is made, charged and in the Library", async ({ browser, evidence }) => {
    expect(member).toBeDefined();
    const { page } = await evidence.newPage(browser, { ...DESKTOP, ...GB, storageState: member });
    await page.goto("/templates/velvet-hour");
    const cover = page.getByAltText("Velvet Hour cover");
    await expect(cover).toBeVisible();
    expect(await cover.getAttribute("src")).toContain("/api/media?");
    await imageLoaded(cover);
    await expect(page.getByText("Verify your age to see previews")).toHaveCount(0);
    await settle(page);
    await evidence.shot(page, "age-10-previews-visible");

    await expect(page.getByTestId("cost-line")).toContainText("4");
    await page.getByRole("button", { name: "Make it" }).click();
    await expect(page.getByTestId("confirm-cost")).toHaveText("4 credits");
    await page.getByTestId("confirm-make").click();
    await expect(page.getByText("Weaving a demo placeholder.")).toBeVisible();

    await page.goto("/collection");
    const first = page.locator("article").first();
    await expect(async () => {
      await page.reload();
      await expect(first.getByRole("link")).toHaveAttribute("aria-label", /^Ready:/, { timeout: 1000 });
    }).toPass({ timeout: 60_000 });
    await expect(first.getByText("Demo")).toBeVisible();
    await imageLoaded(first.locator("img").first());
    // 40 granted, 4 spent.
    await expect(balance(page)).toContainText("36");
    await settle(page);
    await evidence.shot(page, "age-11-library-demo-made");
  });

  test("a visitor with no geo header is not covered and sees previews", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, DESKTOP);
    await enterAgeGate(page);
    await page.goto("/templates/velvet-hour");
    const cover = page.getByAltText("Velvet Hour cover");
    await expect(cover).toBeVisible();
    await imageLoaded(cover);
    await expect(page.getByText("Sign in and verify to see previews")).toHaveCount(0);
    await settle(page);
    await evidence.shot(page, "age-12-no-geo-not-blocked");
  });
});

// ── 2. Payments (addendum §1), labeled sandbox ───────────────────────────────────────────────────

const SANDBOX_WEBHOOK_SECRET = "hushloom-sandbox-dev-only-secret-no-money-moves"; // src/server/payments/providers/sandbox.ts
const signSandbox = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", SANDBOX_WEBHOOK_SECRET).update(`${t}.${body}`).digest("base64url")}`;

/** The user id inside a sandbox checkout link (/pricing/sandbox?t=<base64url payload>.<signature>). */
function sandboxTokenUser(url: string): string {
  const token = new URL(url).searchParams.get("t") ?? "";
  const claims = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { userId: string };
  return claims.userId;
}

test.describe("payments in the labeled sandbox", () => {
  test.describe.configure({ mode: "serial" });
  const handle = `pay_${stamp}`;
  const pack = smallestPack;
  let member: StorageState | undefined;
  let userId = "";
  let firstRef = "";

  const packCard = (page: Page) => page.getByRole("heading", { name: pack.label, exact: true, level: 3 }).locator("..");
  const history = (page: Page) => page.getByTestId("payments-history");
  const packRows = (page: Page) => history(page).getByRole("row").filter({ hasText: "Credit pack" });

  async function toSandboxCheckout(page: Page) {
    await page.goto("/pricing");
    await packCard(page).getByRole("button", { name: /^Buy/ }).click();
    await expect(page).toHaveURL(/\/pricing\/sandbox\?t=/);
    await expect(page.getByRole("heading", { name: "This is a sandbox. No money moves." })).toBeVisible();
  }

  test("pricing shows the sandbox label for the active processor", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, DESKTOP);
    await enterAgeGate(page);
    await page.goto("/pricing");
    const processor = page.getByTestId("payments-processor");
    await expect(processor).toContainText("Sandbox · no money moves");
    await expect(processor).toContainText("Nothing is charged");
    await settle(page);
    await evidence.shot(page, "pay-01-pricing-sandbox-label");
  });

  test("a new member buys the smallest pack and gets exactly its credits", async ({ browser, evidence }) => {
    const { ctx, page } = await evidence.newPage(browser, DESKTOP);
    await enterAgeGate(page);
    await signUp(page, handle);
    await page.goto("/pricing");
    await expect(page.getByTestId("pricing-balance")).toHaveText("0");

    await toSandboxCheckout(page);
    await expect(page.getByText(`${pack.label} pack`)).toBeVisible();
    await expect(page.getByText(`${pack.credits.toLocaleString()} credits · nothing is charged`)).toBeVisible();
    userId = sandboxTokenUser(page.url());
    await evidence.shot(page, "pay-02-sandbox-checkout");

    await page.getByTestId("sandbox-complete").click();
    await expect(page).toHaveURL(`${BASE}/pricing?checkout=success`);
    await expect(page.getByTestId("pricing-balance")).toHaveText(String(pack.credits));
    await expect(packRows(page)).toHaveCount(1);
    await expect(packRows(page)).toContainText(pack.label);
    await expect(packRows(page)).toContainText(`+${pack.credits}`);
    firstRef = ((await packRows(page).getByRole("cell").last().textContent()) ?? "").trim();
    expect(firstRef).toMatch(/^sbx_txn_/);
    await evidence.shot(page, "pay-03-purchase-credited");
    member = await ctx.storageState();
  });

  test("a simulated failure on a second checkout leaves the balance unchanged", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await toSandboxCheckout(page);
    await page.getByTestId("sandbox-fail").click();
    await expect(page).toHaveURL(`${BASE}/pricing?checkout=cancelled`);
    await expect(page.getByText("Checkout cancelled. Nothing was charged.")).toBeVisible();
    await expect(page.getByTestId("pricing-balance")).toHaveText(String(pack.credits));
    await expect(packRows(page)).toHaveCount(1);
    await evidence.shot(page, "pay-04-failure-no-change");
  });

  test("a simulated refund claws the credits back and the history shows it", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await toSandboxCheckout(page);
    const purchase = page.getByRole("listitem").filter({ hasText: firstRef });
    await purchase.getByRole("button", { name: "Simulate refund" }).click();
    await expect(page.getByText("Sandbox refund sent (sandbox, processed)")).toBeVisible();

    await page.goto("/pricing");
    await expect(page.getByTestId("pricing-balance")).toHaveText("0");
    const refund = history(page).getByRole("row").filter({ hasText: "Refund" });
    await expect(refund).toHaveCount(1);
    await expect(refund).toContainText(`-${pack.credits}`);
    await evidence.shot(page, "pay-05-refund-clawed-back");
  });

  test("a chargeback flags the account and pauses checkout until an admin clears it", async ({ browser, evidence }) => {
    evidence.allow({ url: /\/api\/checkout$/, status: 403, method: "POST", why: "checkout refused while a chargeback flag is open (account_flagged)" });
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await toSandboxCheckout(page);
    await page.getByTestId("sandbox-complete").click();
    await expect(page).toHaveURL(`${BASE}/pricing?checkout=success`);
    await expect(page.getByTestId("pricing-balance")).toHaveText(String(pack.credits));
    await expect(packRows(page)).toHaveCount(2);
    const secondRef = ((await packRows(page).first().getByRole("cell").last().textContent()) ?? "").trim();
    expect(secondRef).toMatch(/^sbx_txn_/);
    expect(secondRef).not.toBe(firstRef);

    await toSandboxCheckout(page);
    await page.getByRole("listitem").filter({ hasText: secondRef }).getByRole("button", { name: "Simulate chargeback" }).click();
    await expect(page.getByText("Sandbox chargeback sent (sandbox, processed)")).toBeVisible();

    await page.goto("/pricing");
    await expect(page.getByTestId("account-flagged")).toContainText("Buying is paused on this account after a chargeback.");
    await expect(page.getByTestId("pricing-balance")).toHaveText("0");
    await expect(history(page).getByRole("row").filter({ hasText: "Chargeback" })).toContainText(`-${pack.credits}`);
    const buys = page.getByRole("button", { name: /^(Buy|Get )/ });
    expect(await buys.count()).toBe(pricing.packs.length + pricing.plans.length);
    for (const b of await buys.all()) await expect(b).toBeDisabled();
    // The server refuses too, whatever the page shows.
    const direct = await page.evaluate(async (itemKey) => {
      const r = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemKey }) });
      return { status: r.status, body: (await r.json()) as { error?: { code?: string } } };
    }, pack.key);
    expect(direct.status).toBe(403);
    expect(direct.body.error?.code).toBe("account_flagged");
    await evidence.shot(page, "pay-06-chargeback-flagged");

    const admin = await adminPage(evidence, browser);
    await admin.goto("/admin");
    const flags = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Account flags" }) });
    const flag = flags.getByRole("listitem").filter({ hasText: `@${handle}` }).filter({ hasText: "chargeback" });
    await expect(flag).toHaveCount(1);
    await expect(flag).toContainText(secondRef);
    await flag.scrollIntoViewIfNeeded();
    await evidence.shot(admin, "pay-07-admin-sees-flag");
    admin.once("dialog", (d) => void d.accept(`e2e ${stamp}: sandbox chargeback drill`));
    await flag.getByRole("button", { name: "Clear flag" }).click();
    await expect(admin.getByText("Flag cleared.")).toBeVisible();
    await expect(flag).toHaveCount(0);
    await evidence.shot(admin, "pay-08-admin-cleared-flag");

    await page.goto("/pricing");
    await expect(page.getByTestId("account-flagged")).toHaveCount(0);
    await expect(packCard(page).getByRole("button", { name: /^Buy/ })).toBeEnabled();
    await toSandboxCheckout(page);
    await evidence.shot(page, "pay-09-checkout-works-again");
  });

  test("webhook replay protection: unsigned, forged or stale events are refused and a re-delivered event grants once", async ({ browser, evidence }) => {
    const { ctx, page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await page.goto("/pricing");
    const before = Number(await page.getByTestId("pricing-balance").textContent());
    const hook = "/api/webhooks/payments/sandbox";
    const body = JSON.stringify({
      kind: "sale",
      eventId: `sbx_sale_e2e_${stamp}`,
      userId,
      itemKey: pack.key,
      amountCents: pack.priceCents,
      currency: pricing.currency,
      transactionRef: `sbx_txn_e2e_${stamp}`,
    });
    const post = (signature?: string) =>
      ctx.request.post(hook, { data: body, headers: { "Content-Type": "application/json", ...(signature ? { "x-sandbox-signature": signature } : {}) } });

    // A body this test cannot sign: no signature, a forged one, and a real one from outside the 5-minute window.
    for (const [signature, code] of [
      [undefined, "unsigned"],
      [`t=${Math.floor(Date.now() / 1000)},v1=forged`, "bad_signature"],
      [signSandbox(body, Math.floor(Date.now() / 1000) - 600), "replayed"],
    ] as const) {
      const res = await post(signature);
      expect(res.status()).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    await page.reload();
    await expect(page.getByTestId("pricing-balance")).toHaveText(String(before));

    // The same signed body delivered twice: processed once, then a duplicate that touches nothing.
    const signature = signSandbox(body);
    const first = await post(signature);
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ received: true, outcome: "processed" });
    const again = await post(signature);
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ received: true, outcome: "duplicate" });

    await page.reload();
    await expect(page.getByTestId("pricing-balance")).toHaveText(String(before + pack.credits));
    await expect(history(page).getByRole("row").filter({ hasText: `sbx_txn_e2e_${stamp}` })).toHaveCount(1);
    await evidence.shot(page, "pay-10-replay-granted-once");
  });
});

// ── 3. Scanning and takedowns (addendum §3) ──────────────────────────────────────────────────────

test.describe("abuse scanning and takedowns", () => {
  test.describe.configure({ mode: "serial" });
  const throwaway = `scan_${stamp}`;
  const uploader = `clean_${stamp}`;

  async function chooseUpload(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
    await page.goto("/generate/image");
    await page.getByRole("radio", { name: "Image to image" }).click();
    await page.getByTestId("upload-input").setInputFiles(file);
    const sheet = page.getByRole("dialog", { name: "Before you upload" });
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("consent-checkbox").check();
    return sheet;
  }

  test("a scanner match gets a generic rejection and the uploader is suspended and signed out", async ({ browser, evidence }) => {
    evidence.allow(
      { url: /\/api\/uploads$/, status: 403, method: "POST", why: "generic upload_rejected for the dev scanner's drill fixture" },
      { url: /\/api\/auth\/login$/, status: 401, method: "POST", why: "a suspended account cannot sign in" },
    );
    const { page } = await evidence.newPage(browser, DESKTOP);
    await enterAgeGate(page);
    await signUp(page, throwaway);
    const sheet = await chooseUpload(page, MATCH_FIXTURE);
    await evidence.shot(page, "scan-01-consent-sheet");
    const rejected = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
    await sheet.getByRole("button", { name: "Upload", exact: true }).click();
    const res = await rejected;
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "upload_rejected", message: "This upload was rejected." } });
    const alert = page.getByRole("alert").filter({ hasText: "This upload was rejected." });
    await expect(alert).toHaveText("This upload was rejected.");
    // The sheet closes once the upload settles (its exit animation still shows the busy button).
    await expect(sheet).toBeHidden();
    await expect(page.getByAltText("Your upload")).toHaveCount(0);
    expect(await page.locator("main").textContent()).not.toMatch(/scan|match|abuse|csam|child|hash|suspend/i);
    await evidence.shot(page, "scan-02-generic-rejection");

    await page.reload();
    await expect(page.getByTestId("credit-balance")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
    await evidence.shot(page, "scan-03-signed-out-after-reload");

    await page.goto("/auth?mode=signin");
    await page.getByLabel("Email").fill(`${throwaway}@example.test`);
    await page.getByLabel("Password").fill(MEMBER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).last().click();
    await expect(page.getByRole("alert").filter({ hasText: "Email or password is incorrect." })).toBeVisible();
    await expect(page).toHaveURL(/\/auth/);
    await evidence.shot(page, "scan-04-sign-in-refused");
  });

  test("a clean upload by another member still works and its preview loads", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, DESKTOP);
    await enterAgeGate(page);
    await signUp(page, uploader);
    const sheet = await chooseUpload(page, { name: "clean.png", mimeType: "image/png", buffer: await cleanPng(768) });
    const accepted = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
    await sheet.getByRole("button", { name: "Upload", exact: true }).click();
    const res = await accepted;
    expect(res.status()).toBe(201);
    expect(((await res.json()) as { warnings: string[] }).warnings).toEqual([]);
    await expect(sheet).toBeHidden();
    const preview = page.getByAltText("Your upload");
    await expect(preview).toBeVisible();
    await imageLoaded(preview);
    await expect(page.getByText("768×768")).toBeVisible();
    await expect(page.getByText("Private. Only you can see it.")).toBeVisible();
    await expect(page.getByText("This upload was rejected.")).toHaveCount(0);
    await evidence.shot(page, "scan-05-clean-upload-preview");
    await page.reload();
    await expect(balance(page)).toBeVisible();
  });

  test("the admin sees the escalation and the matched file is never served", async ({ browser, evidence }) => {
    evidence.allow({ url: /\/api\/media\?/, status: 403, why: "fetching the held file without a valid signature is refused" });
    const admin = await adminPage(evidence, browser);
    const mediaRequests = trackMediaRequests(admin);
    await admin.goto("/admin/review");
    await expect(admin.getByText("Development scanner · not live")).toBeVisible();
    const matches = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Scanner matches" }) });
    const item = matches.getByRole("listitem").filter({ hasText: `@${throwaway}` });
    await expect(item).toHaveCount(1);
    for (const text of ["abuse match", "upload", "dev scanner drill", "legal hold", "suspended"]) await expect(item).toContainText(text);
    await item.scrollIntoViewIfNeeded();
    await evidence.shot(admin, "scan-06-admin-escalation");

    // Nothing renders the file, and the page exposes no media URL for it (or anything else).
    expect(await item.locator("img, video, picture, canvas, object, embed, iframe").count()).toBe(0);
    expect(await mediaRefsInDom(admin)).toEqual([]);
    const exposed = [...(await admin.content()).matchAll(/\/api\/media\?[^"'\s<)\\]+/g)].map((m) => m[0]);
    expect(exposed).toEqual([]);
    expect(mediaRequests).toEqual([]);
    // Even knowing where it is stored, a request for it is refused.
    const stored = ((await item.getByText(/^stored at /).textContent()) ?? "").replace(/^stored at\s*/, "").trim();
    expect(stored).toMatch(/^uploads\//);
    const exp = Math.floor(Date.now() / 1000) + 300;
    for (const url of [`/api/media?k=${encodeURIComponent(stored)}`, `/api/media?k=${encodeURIComponent(stored)}&e=${exp}&s=forged`]) {
      expect((await admin.request.get(url)).status()).toBe(403);
    }
  });

  test("the public takedown form works signed out and the admin dismisses it with a note", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, DESKTOP);
    await enterAgeGate(page);
    await page.goto("/policies/takedown");
    await expect(page.getByRole("heading", { name: "Request a takedown" })).toBeVisible();
    await page.getByRole("radio", { name: "An intimate image or video of me shared without my consent" }).check();
    await page.getByLabel("Where is it?").fill(`${BASE}/templates/velvet-hour`);
    await page.getByLabel("Your email").fill(`takedown_${stamp}@example.test`);
    await page.getByLabel("Anything that helps us find it (optional)").fill(`e2e launch check ${stamp}`);
    await page.getByLabel(/I believe in good faith/).check();
    await evidence.shot(page, "scan-07-takedown-form-signed-out");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByRole("status").filter({ hasText: "We have your request" })).toBeVisible();
    await evidence.shot(page, "scan-08-takedown-sent");

    const admin = await adminPage(evidence, browser);
    await admin.goto("/admin/review");
    const queue = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Takedown requests" }) });
    const request = queue.getByRole("listitem").filter({ hasText: `e2e launch check ${stamp}` });
    await expect(request).toHaveCount(1);
    await expect(request).toContainText("intimate image without consent");
    await expect(request).toContainText(`takedown_${stamp}@example.test`);
    await expect(request).toContainText("Velvet Hour");
    await request.scrollIntoViewIfNeeded();
    await evidence.shot(admin, "scan-09-admin-takedown-queue");

    const note = `e2e ${stamp}: not on this site, dismissed`;
    await request.getByLabel("Note", { exact: true }).fill(note);
    await request.getByRole("button", { name: "Dismiss" }).click();
    await expect(admin.getByText("Dismissed.", { exact: true })).toBeVisible();
    await expect(request).toHaveCount(0);
    const closed = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Recently closed" }) });
    const done = closed.getByRole("listitem").filter({ hasText: note });
    await expect(done).toContainText("Takedown dismissed");
    await done.scrollIntoViewIfNeeded();
    await evidence.shot(admin, "scan-10-takedown-dismissed");
  });
});

// ── 4. Installable web app (addendum §4) ─────────────────────────────────────────────────────────

const SHELL_PATHS = ["/offline", "/manifest.webmanifest"];
const isShellOrStatic = (url: string) => {
  const p = new URL(url).pathname;
  return SHELL_PATHS.includes(p) || p.startsWith("/icons/") || p.startsWith("/_next/static/");
};

async function cacheStorage(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) urls.push(req.url);
    }
    return urls;
  });
}

function pngSize(buf: Buffer) {
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test.describe("installable web app", () => {
  const offlineNoise = [
    { kind: ["console", "requestfailed"] as ("console" | "requestfailed")[], text: "net::ERR_INTERNET_DISCONNECTED", why: "the context is offline on purpose (link prefetches and fetches fail)" },
    { kind: "console" as const, text: /Failed to fetch RSC payload/, why: "Next.js link prefetch while offline on purpose" },
  ];

  test("the manifest is installable: name, standalone, start_url and real 192 and 512 icons", async ({ request, evidence }) => {
    const res = await request.get(`${BASE}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^application\/manifest\+json/);
    const manifest = (await res.json()) as { name: string; display: string; start_url: string; icons: { src: string; sizes: string; type?: string; purpose?: string }[] };
    expect(manifest.name).toBe("Hushloom");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((i) => i.sizes === `${size}x${size}` && (i.purpose ?? "any").split(" ").includes("any"));
      expect(icon, `${size}px icon`).toBeDefined();
      const png = await request.get(new URL(icon!.src, BASE).toString());
      expect(png.status()).toBe(200);
      expect(png.headers()["content-type"]).toBe("image/png");
      expect(pngSize(await png.body())).toEqual({ width: size, height: size });
    }
    // API-only: no page is watched, so the evidence JSON for this test records an empty log.
    expect(evidence).toBeDefined();
  });

  test("the service worker script is served fresh and may control the whole origin", async ({ request, evidence }) => {
    expect(evidence).toBeDefined();
    const res = await request.get(`${BASE}/sw.js`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-cache");
    expect(res.headers()["service-worker-allowed"]).toBe("/");
    expect(res.headers()["content-type"]).toMatch(/javascript/);
  });

  test("the worker activates; offline, public pages show the offline page and private pages and the API are never cached", async ({ browser, evidence }) => {
    evidence.allow(...offlineNoise);
    const { ctx, page } = await evidence.newPage(browser, DESKTOP);
    await apiAs(ctx.request, "demo@hushloom.local");
    await page.goto("/explore");
    const registration = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return { scope: r.scope, script: r.active?.scriptURL ?? null };
    });
    expect(registration).toEqual({ scope: `${BASE}/`, script: `${BASE}/sw.js` });
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe("activated");
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    // Visit private pages and signed media while online, so a careless worker would have stored them.
    for (const p of ["/collection", "/settings", "/pricing", "/templates/velvet-hour"]) {
      await page.goto(p);
      await settle(page);
    }
    await imageLoaded(page.getByAltText("Velvet Hour cover"));
    const cached = await cacheStorage(page);
    expect(cached).toContain(`${BASE}/offline`);
    expect(cached.filter((u) => new URL(u).pathname.startsWith("/api/"))).toEqual([]);
    expect(cached.filter((u) => u.includes("/api/media"))).toEqual([]);
    expect(cached.filter((u) => !isShellOrStatic(u))).toEqual([]);

    await ctx.setOffline(true);
    await page.goto("/explore");
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    // The worker's copy of /offline was fetched without cookies: no balance, no account.
    await expect(page.getByTestId("credit-balance")).toHaveCount(0);
    await expect(page.getByText("Demo Member")).toHaveCount(0);
    await evidence.shot(page, "pwa-01-offline-public-page");

    // A signed-in page is never answered from a cache: the browser's own offline error, or the offline page.
    // A second tab, so the check reads that tab right away: after a failed navigation Chromium's emulated
    // navigator.onLine flips back to true in new documents, and the offline page above then reloads itself.
    const tab = await ctx.newPage();
    const failure = await tab.goto("/collection").then(
      () => null,
      (e: Error) => e.message,
    );
    if (failure === null) await expect(tab.getByRole("heading", { name: "You're offline" })).toBeVisible();
    else expect(failure).toContain("net::ERR_INTERNET_DISCONNECTED at http://localhost:3100/collection");
    await expect(tab.getByTestId("credit-balance")).toHaveCount(0);
    await expect(tab.getByRole("heading", { name: "Library" })).toHaveCount(0);
    await evidence.shot(tab, "pwa-02-offline-private-page");
    await tab.close();

    await ctx.setOffline(false);
    await page.goto("/explore");
    await expect(balance(page)).toBeVisible();
    const after = await cacheStorage(page);
    expect(after.filter((u) => !isShellOrStatic(u))).toEqual([]);
  });

  test("Settings shows the install card and says push is not configured without VAPID keys", async ({ browser, evidence }) => {
    const { ctx, page } = await evidence.newPage(browser, DESKTOP);
    await apiAs(ctx.request, "demo@hushloom.local");
    const key = await ctx.request.get("/api/push/public-key");
    expect(await key.json()).toMatchObject({ enabled: false, publicKey: null });
    await page.goto("/settings#device");
    const device = page.locator("#device");
    await expect(device.getByRole("heading", { name: "On this device" })).toBeVisible();
    await expect(device).toContainText("Install Hushloom");
    const toggle = device.getByRole("switch", { name: "Tell me when a creation finishes" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeDisabled();
    await expect(device.getByText("Push is not configured on this server.")).toBeVisible();
    await device.scrollIntoViewIfNeeded();
    await evidence.shot(page, "pwa-03-settings-install-and-notifications");
  });

  test("at 390x844 offline: the banner shows on a loaded signed-in page and Make it is disabled", async ({ browser, evidence }) => {
    evidence.allow(...offlineNoise);
    const { ctx, page } = await evidence.newPage(browser, PHONE);
    await apiAs(ctx.request, "demo@hushloom.local");
    await page.goto("/generate/image");
    await expect(balance(page)).toBeVisible();
    await page.getByLabel("Prompt", { exact: true }).fill("a quiet lakeside cabin at dusk, warm window light");
    const make = page.getByRole("button", { name: "Make it" });
    await expect(make).toBeEnabled();

    await ctx.setOffline(true);
    const banner = page.getByRole("status").filter({ hasText: OFFLINE_LINE });
    await expect(banner).toBeVisible();
    await expect(make).toBeDisabled();
    await make.scrollIntoViewIfNeeded();
    await evidence.shot(page, "pwa-04-phone-offline-make-disabled");

    await ctx.setOffline(false);
    await expect(banner).toHaveCount(0);
    await expect(make).toBeEnabled();
  });
});

// ── 5. Core flows at phone width: screenshots and a clean console ────────────────────────────────

test("core flows at 390x844: screenshots with no unexpected errors", async ({ browser, evidence }) => {
  const { ctx, page } = await evidence.newPage(browser, PHONE);
  await enterAgeGate(page);
  const visit = async (path: string, name: string) => {
    await page.goto(path);
    await settle(page);
    await evidence.shot(page, name);
  };
  await visit("/", "smoke-01-home");
  await visit("/explore", "smoke-02-explore");
  await visit("/templates/velvet-hour", "smoke-03-template");
  await apiAs(ctx.request, "demo@hushloom.local");
  await visit("/collection", "smoke-04-library");
  await visit("/settings", "smoke-05-settings");
  await visit("/pricing", "smoke-06-pricing");
  await visit("/policies", "smoke-07-policies");
  await visit("/policies/takedown", "smoke-08-takedown");

  const admin = await adminPage(evidence, browser, PHONE);
  await admin.goto("/admin");
  await expect(admin.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible();
  await settle(admin);
  await evidence.shot(admin, "smoke-09-admin");
  await admin.goto("/admin/review");
  await expect(admin.getByRole("heading", { name: "Abuse review", level: 1 })).toBeVisible();
  await settle(admin);
  await evidence.shot(admin, "smoke-10-admin-review");
});
