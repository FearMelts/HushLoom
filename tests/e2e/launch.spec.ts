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
// The edge's geo headers; the defaults in src/config/jurisdictions.ts require an age check in GB and
// in the US states with laws (Texas among them), and not elsewhere in the US (California).
const GB = { extraHTTPHeaders: { "x-country-code": "GB" } };
const US_TX = { extraHTTPHeaders: { "x-country-code": "US", "x-region-code": "TX" } };
const US_CA = { extraHTTPHeaders: { "x-country-code": "US", "x-region-code": "CA" } };
const WITHHELD_ANON = "Sign in and verify to see previews";

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

const AGE_HOOK = "/api/webhooks/age-verification/sandbox";
const AGE_SIGNATURE_HEADER = "x-hushloom-sandbox-signature"; // src/server/age/providers/sandbox.ts
type SignedCallback = { body: string; signature: string };

/**
 * The two pre-signed results the sandbox age page hands to the browser (its client component's props,
 * read from the page's RSC payload): what a person at that page could deliver, or keep and replay.
 */
async function sandboxAgeCallbacks(page: Page): Promise<{ verified: SignedCallback; failed: SignedCallback }> {
  const flight = await page.evaluate(() => ((self as unknown as { __next_f?: unknown[][] }).__next_f ?? []).map((c) => (typeof c[1] === "string" ? c[1] : "")).join(""));
  const pick = (kind: "verified" | "failed"): SignedCallback => {
    const m = flight.match(new RegExp(`"${kind}":\\{"body":"((?:[^"\\\\]|\\\\.)*)","signature":"([0-9a-f]{64})"\\}`));
    expect(m, `signed ${kind} callback in the page`).not.toBeNull();
    return { body: JSON.parse(`"${m![1]}"`) as string, signature: m![2]! };
  };
  return { verified: pick("verified"), failed: pick("failed") };
}

/**
 * The signature src/server/storage/index.ts puts on its own /api/media links (HMAC-SHA256 over
 * "key\nexp\ndownload", base64url), with the run's secret from playwright.config.ts.
 */
function mediaSignature(key: string, exp: number): string {
  const secret = process.env.E2E_MEDIA_SIGNING_SECRET;
  expect(secret, "E2E_MEDIA_SIGNING_SECRET is set by playwright.config.ts").toBeTruthy();
  return createHmac("sha256", secret!).update(`${key}\n${exp}\n`).digest("base64url");
}

function signedMediaUrl(key: string, exp: number): string {
  return `/api/media?${new URLSearchParams({ k: key, e: String(exp), s: mediaSignature(key, exp) }).toString()}`;
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

  test("an anonymous GB visitor sees no template media on cards, the template page or a creator page", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, { ...DESKTOP, ...GB });
    const mediaRequests = trackMediaRequests(page);
    await enterAgeGate(page);

    // Each page is checked after it settles (so later client renders are included), in the DOM and in
    // the page's HTML with its RSC payload: withheld server-side, not hidden by the browser.
    const assertWithheld = async (where: string) => {
      await settle(page);
      expect(await mediaRefsInDom(page), `${where}: media in the DOM`).toEqual([]);
      expect(await page.content(), `${where}: media in the HTML or RSC payload`).not.toContain("/api/media");
    };

    await expect(page.getByText(WITHHELD_ANON).first()).toBeVisible();
    expect(await page.getByText(WITHHELD_ANON).count()).toBeGreaterThan(3);
    await assertWithheld("home");
    await evidence.shot(page, "age-01-home-withheld-gb");

    await page.goto("/explore");
    await expect(page.getByRole("heading", { name: "Explore", level: 1 })).toBeVisible();
    await expect(page.getByText(WITHHELD_ANON).first()).toBeVisible();
    await assertWithheld("explore");

    await page.goto("/templates/velvet-hour");
    await expect(page.getByRole("heading", { name: "Velvet Hour", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Velvet Hour preview withheld until age verification")).toContainText(WITHHELD_ANON);
    await expect(page.getByAltText("Velvet Hour cover")).toHaveCount(0);
    await assertWithheld("template page");
    await evidence.shot(page, "age-02-template-withheld-gb");

    await page.goto("/creators/lunavelour");
    await expect(page.getByRole("heading", { name: "Luna Velour", level: 1 })).toBeVisible();
    await expect(page.getByText(WITHHELD_ANON).first()).toBeVisible();
    await assertWithheld("creator page");
    await evidence.shot(page, "age-02b-creator-withheld-gb");
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
    await expect(balance(page)).toHaveText("40");
    await page.getByLabel("Prompt", { exact: true }).fill("a quiet lakeside cabin at dusk, warm window light");
    const refused = page.waitForResponse((r) => r.url().endsWith("/api/generations") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Make it" }).click();
    expect((await refused).status()).toBe(451);
    await expect(page.getByRole("alert").filter({ hasText: AGE_REFUSAL })).toBeVisible();
    await expect(page.getByTestId("confirm-make")).toHaveCount(0);
    await evidence.shot(page, "age-04-make-refused-gb");

    // Upload through the create panel's image-to-image input, with the consent sheet.
    await page.reload();
    await expect(balance(page)).toHaveText("40");
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
    await expect(balance(page)).toHaveText("40");
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

    // The page holds both pre-signed results; the browser delivers one. Keep the other, and the request
    // the browser actually sends, to replay them once this check has an outcome.
    const failedRef = new URL(page.url()).searchParams.get("ref")!;
    const issued = await sandboxAgeCallbacks(page);
    expect(JSON.parse(issued.verified.body)).toMatchObject({ providerRef: failedRef, outcome: "verified" });
    const delivery = page.waitForRequest((r) => r.url().endsWith(AGE_HOOK) && r.method() === "POST");
    await page.getByRole("button", { name: "Simulate failed" }).click();
    const sent = await delivery;
    const failed = { body: sent.postData() ?? "", signature: (await sent.allHeaders())[AGE_SIGNATURE_HEADER] ?? "" };
    expect(JSON.parse(failed.body)).toMatchObject({ providerRef: failedRef, outcome: "failed" });
    expect(failed, "the browser delivers exactly the result the page was given").toEqual(issued.failed);
    await expect(page).toHaveURL(`${BASE}/settings#age-verification`);
    await expect(badges.getByText("Not passed", { exact: true })).toBeVisible();
    await expect(card).toContainText("a simulated failure (sandbox)");
    await card.scrollIntoViewIfNeeded();
    await evidence.shot(page, "age-08-not-passed");

    // Provider callbacks are signature-checked and a completed check cannot be completed again.
    const postCallback = (body: string, signature?: string) =>
      page.request.post(AGE_HOOK, { data: body, headers: { "Content-Type": "application/json", ...(signature ? { [AGE_SIGNATURE_HEADER]: signature } : {}) } });
    const flipped = failed.body.replace(`"outcome":"failed"`, `"outcome":"verified"`);
    expect(flipped).not.toBe(failed.body);
    for (const [what, body, signature, status, code] of [
      ["the browser's own failed callback, sent again", failed.body, failed.signature, 409, "callback_replayed"],
      ["the validly signed 'verified' result issued for the same, now failed, check", issued.verified.body, issued.verified.signature, 409, "callback_replayed"],
      ["the failed callback without a signature", failed.body, undefined, 400, "callback_unsigned"],
      ["the failed callback edited to 'verified', old signature", flipped, failed.signature, 400, "callback_bad_signature"],
      ["the 'verified' result with a forged signature", issued.verified.body, "0".repeat(64), 400, "callback_bad_signature"],
    ] as const) {
      const res = await postCallback(body, signature);
      const json = (await res.json()) as { error?: { code?: string } };
      evidence.note(`age callback: ${what}`, { status: res.status(), body: json });
      expect(res.status(), what).toBe(status);
      expect(json.error?.code, what).toBe(code);
      await page.reload();
      await expect(badges.getByText("Not passed", { exact: true }), `still not passed after ${what}`).toBeVisible();
    }
    // The refused callbacks did not open the gate either.
    await page.goto("/templates/velvet-hour");
    await expect(page.getByAltText("Velvet Hour cover")).toHaveCount(0);
    await page.goto("/settings#age-verification");

    await card.getByRole("button", { name: "Verify again" }).click();
    await expect(page).toHaveURL(/\/verify\/sandbox\?ref=sbx_/);
    const verifiedRef = new URL(page.url()).searchParams.get("ref")!;
    expect(verifiedRef).not.toBe(failedRef);
    await page.getByRole("button", { name: "Simulate verified" }).click();
    await expect(page).toHaveURL(`${BASE}/settings#age-verification`);
    await expect(badges.getByText("Verified", { exact: true })).toBeVisible();
    await expect(badges.getByText("Sandbox", { exact: true })).toBeVisible();
    await expect(card.getByText("You are all set.")).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await evidence.shot(page, "age-09-verified");

    // Every status change is in the audit log, once: the refused callbacks wrote nothing. The log shows
    // each entry's target (the check's id) in full but its metadata cut to 120 characters, so the check
    // is found by its reference on the "pending" row, then all its rows by that target.
    const admin = await adminPage(evidence, browser);
    await admin.goto("/admin");
    const audit = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Audit log" }) });
    const auditTrail: Record<string, string[]> = {};
    for (const [ref, actions] of [
      [failedRef, ["age_verification.pending", "age_verification.failed"]],
      [verifiedRef, ["age_verification.pending", "age_verification.verified"]],
    ] as const) {
      const opened = audit.getByRole("row").filter({ hasText: ref }).filter({ hasText: "age_verification.pending" });
      await expect(opened).toHaveCount(1);
      const target = ((await opened.getByRole("cell").nth(3).textContent()) ?? "").trim();
      expect(target).toMatch(/^age_verification:[0-9a-f]{8}$/);
      const rows = audit.getByRole("row").filter({ hasText: target });
      await expect(rows).toHaveCount(actions.length);
      for (const action of actions) await expect(rows.filter({ hasText: action })).toHaveCount(1);
      // The action is each row's third cell.
      auditTrail[ref] = (await rows.locator("td:nth-child(3)").allTextContents()).map((t) => t.trim());
    }
    evidence.note("admin audit log rows per age check", auditTrail);
    await audit.getByRole("row").filter({ hasText: verifiedRef }).first().scrollIntoViewIfNeeded();
    await evidence.shot(admin, "age-09b-audit-log");
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

    await expect(page.getByTestId("cost-line")).toHaveText(/^4 credits · you have \d+/);
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
    await expect(balance(page)).toHaveText("36");
    await settle(page);
    await evidence.shot(page, "age-11-library-demo-made");
  });

  test("a visitor with no geo header is not covered and sees previews; no install prompt on first visit", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, DESKTOP);
    await enterAgeGate(page);
    // Install is offered from Settings only (addendum §4): nothing pops up on a first visit.
    await settle(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toMatch(/install/i);
    await page.goto("/templates/velvet-hour");
    const cover = page.getByAltText("Velvet Hour cover");
    await expect(cover).toBeVisible();
    await imageLoaded(cover);
    await expect(page.getByText("Sign in and verify to see previews")).toHaveCount(0);
    await settle(page);
    await evidence.shot(page, "age-12-no-geo-not-blocked");
  });
});

test.describe("age verification in US states", () => {
  test("US states follow the same rules: an anonymous Texas visitor is withheld, a California visitor is not", async ({ browser, evidence }) => {
    const tx = (await evidence.newPage(browser, { ...DESKTOP, ...US_TX })).page;
    const txMedia = trackMediaRequests(tx);
    await enterAgeGate(tx);
    await tx.goto("/templates/velvet-hour");
    await expect(tx.getByLabel("Velvet Hour preview withheld until age verification")).toContainText(WITHHELD_ANON);
    await expect(tx.getByAltText("Velvet Hour cover")).toHaveCount(0);
    await settle(tx);
    expect(await mediaRefsInDom(tx)).toEqual([]);
    expect(await tx.content()).not.toContain("/api/media");
    expect(txMedia).toEqual([]);
    await evidence.shot(tx, "age-02c-us-tx-withheld");

    const ca = (await evidence.newPage(browser, { ...DESKTOP, ...US_CA })).page;
    await enterAgeGate(ca);
    await ca.goto("/templates/velvet-hour");
    const cover = ca.getByAltText("Velvet Hour cover");
    await expect(cover).toBeVisible();
    await imageLoaded(cover);
    await expect(ca.getByText(WITHHELD_ANON)).toHaveCount(0);
    await settle(ca);
    await evidence.shot(ca, "age-02d-us-ca-not-covered");
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
  let secondRef = "";
  // The request the browser sent to complete the first purchase, kept to send again.
  let completion: { body: string } | undefined;

  const packCard = (page: Page) => page.getByRole("heading", { name: pack.label, exact: true, level: 3 }).locator("..");
  const history = (page: Page) => page.getByTestId("payments-history");
  const packRows = (page: Page) => history(page).getByRole("row").filter({ hasText: "Credit pack" });
  const ledger = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Credit history", level: 2 }) });

  /** The pricing panel and the shell's balance pill must agree. */
  async function expectBalance(page: Page, credits: number) {
    await expect(page.getByTestId("pricing-balance")).toHaveText(String(credits));
    await expect(balance(page)).toHaveText(String(credits));
  }

  async function toSandboxCheckout(page: Page) {
    await page.goto("/pricing");
    await packCard(page).getByRole("button", { name: /^Buy/ }).click();
    await expect(page).toHaveURL(/\/pricing\/sandbox\?t=/);
    await expect(page.getByRole("heading", { name: "This is a sandbox. No money moves." })).toBeVisible();
  }

  /**
   * A full-page shot with the Payments history in it, so the rows the test asserts are in the picture.
   * Taken from the top: the shell's rail and top bar are fixed, and a full-page shot of a scrolled page
   * draws them halfway down.
   */
  async function historyShot(evidence: Evidence, page: Page, name: string) {
    await expect(history(page)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await evidence.shot(page, name, { fullPage: true });
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
    await expectBalance(page, 0);

    await toSandboxCheckout(page);
    await expect(page.getByText(`${pack.label} pack`)).toBeVisible();
    await expect(page.getByText(`${pack.credits.toLocaleString()} credits · nothing is charged`)).toBeVisible();
    userId = sandboxTokenUser(page.url());
    await evidence.shot(page, "pay-02-sandbox-checkout");

    const sent = page.waitForRequest((r) => r.url().endsWith("/api/pricing/sandbox") && r.method() === "POST");
    await page.getByTestId("sandbox-complete").click();
    completion = { body: (await sent).postData() ?? "" };
    expect(JSON.parse(completion.body)).toMatchObject({ action: "complete" });
    await expect(page).toHaveURL(`${BASE}/pricing?checkout=success`);
    await expectBalance(page, pack.credits);
    await expect(packRows(page)).toHaveCount(1);
    await expect(packRows(page)).toContainText(pack.label);
    await expect(packRows(page)).toContainText(`+${pack.credits}`);
    firstRef = ((await packRows(page).getByRole("cell").last().textContent()) ?? "").trim();
    expect(firstRef).toMatch(/^sbx_txn_/);
    await historyShot(evidence, page, "pay-03-purchase-credited");
    member = await ctx.storageState();
  });

  test("the browser cannot grant itself credits: its own completion sent again, or the success page, adds nothing", async ({ browser, evidence }) => {
    expect(completion).toBeDefined();
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    // Opening the success page without paying grants nothing: only the processor's webhook does.
    await page.goto("/pricing?checkout=success");
    await expect(page.getByRole("status").filter({ hasText: "Payment sent." })).toBeVisible();
    await expectBalance(page, pack.credits);
    await expect(packRows(page)).toHaveCount(1);

    // The exact request the browser sent to complete the purchase, sent again with the same session.
    const again = await page.request.post("/api/pricing/sandbox", { data: completion!.body, headers: { "Content-Type": "application/json", Origin: BASE } });
    const answer = (await again.json()) as unknown;
    evidence.note("POST /api/pricing/sandbox re-sent with the browser's own completion body", { status: again.status(), body: answer });
    // The checkout link already settled: the processor's event is a duplicate and grants nothing.
    expect(again.status()).toBe(200);
    expect(answer).toMatchObject({ outcome: "duplicate" });
    await page.reload();
    await expectBalance(page, pack.credits);
    await expect(packRows(page)).toHaveCount(1);
    await historyShot(evidence, page, "pay-03b-resent-completion-granted-nothing");
  });

  test("a simulated failure on a second checkout leaves the balance unchanged", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await toSandboxCheckout(page);
    await page.getByTestId("sandbox-fail").click();
    await expect(page).toHaveURL(`${BASE}/pricing?checkout=cancelled`);
    await expect(page.getByText("Checkout cancelled. Nothing was charged.")).toBeVisible();
    await expectBalance(page, pack.credits);
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
    await expectBalance(page, 0);
    const refund = history(page).getByRole("row").filter({ hasText: "Refund" });
    await expect(refund).toHaveCount(1);
    await expect(refund).toContainText(`-${pack.credits}`);
    await historyShot(evidence, page, "pay-05-refund-clawed-back");
  });

  test("a chargeback flags the account and pauses checkout until an admin clears it", async ({ browser, evidence }) => {
    evidence.allow({ url: /\/api\/checkout$/, status: 403, method: "POST", why: "checkout refused while a chargeback flag is open (account_flagged)" });
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await toSandboxCheckout(page);
    await page.getByTestId("sandbox-complete").click();
    await expect(page).toHaveURL(`${BASE}/pricing?checkout=success`);
    await expectBalance(page, pack.credits);
    await expect(packRows(page)).toHaveCount(2);
    secondRef = ((await packRows(page).first().getByRole("cell").last().textContent()) ?? "").trim();
    expect(secondRef).toMatch(/^sbx_txn_/);
    expect(secondRef).not.toBe(firstRef);

    await toSandboxCheckout(page);
    await page.getByRole("listitem").filter({ hasText: secondRef }).getByRole("button", { name: "Simulate chargeback" }).click();
    await expect(page.getByText("Sandbox chargeback sent (sandbox, processed)")).toBeVisible();

    await page.goto("/pricing");
    await expect(page.getByTestId("account-flagged")).toContainText("Buying is paused on this account after a chargeback.");
    await expectBalance(page, 0);
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
    await historyShot(evidence, page, "pay-06-chargeback-flagged");

    const admin = await adminPage(evidence, browser);
    await admin.goto("/admin");
    const flags = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Account flags" }) });
    const flag = flags.getByRole("listitem").filter({ hasText: `@${handle}` }).filter({ hasText: "chargeback" });
    await expect(flag).toHaveCount(1);
    await expect(flag).toContainText(secondRef);
    await flag.scrollIntoViewIfNeeded();
    await evidence.shot(admin, "pay-07-admin-sees-flag");

    // Dismissing the note prompt clears nothing.
    admin.once("dialog", (d) => void d.dismiss());
    await flag.getByRole("button", { name: "Clear flag" }).click();
    await expect(flag).toHaveCount(1);

    const note = `e2e ${stamp} cb drill`;
    admin.once("dialog", (d) => void d.accept(note));
    await flag.getByRole("button", { name: "Clear flag" }).click();
    await expect(admin.getByText("Flag cleared.")).toBeVisible();
    await expect(flag).toHaveCount(0);
    // The note is stored with the flag and shown in the audit log.
    type FlagRow = { kind: string; clearedAt: string | null; clearedBy: string | null; details: { transactionRef?: string; clearNote?: string } };
    const cleared = (await (await admin.request.get("/api/admin/flags?all=1")).json()) as { flags: FlagRow[] };
    const record = cleared.flags.find((f) => f.kind === "chargeback" && f.details.transactionRef === secondRef);
    evidence.note("GET /api/admin/flags?all=1: the cleared chargeback flag", record);
    expect(record?.clearedAt).toBeTruthy();
    expect(record?.clearedBy).toBe("hushloom");
    expect(record?.details.clearNote).toBe(note);
    await admin.reload();
    const audit = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Audit log" }) });
    const auditRow = audit.getByRole("row").filter({ hasText: "flag.clear" }).filter({ hasText: note });
    await expect(auditRow).toHaveCount(1);
    await expect(auditRow).toContainText("@hushloom");
    await auditRow.scrollIntoViewIfNeeded();
    await evidence.shot(admin, "pay-08-admin-cleared-flag");

    await page.goto("/pricing");
    await expect(page.getByTestId("account-flagged")).toHaveCount(0);
    await expect(packCard(page).getByRole("button", { name: /^Buy/ })).toBeEnabled();
    await toSandboxCheckout(page);
    await evidence.shot(page, "pay-09-checkout-works-again");
  });

  test("a second reversal of a payment already charged back takes nothing more", async ({ browser, evidence }) => {
    expect(secondRef).not.toBe("");
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await page.goto("/pricing");
    await expectBalance(page, 0);
    const reversalsBefore = await ledger(page).getByRole("row").filter({ hasText: /Refunded|Chargeback/ }).count();

    await toSandboxCheckout(page);
    await page.getByRole("listitem").filter({ hasText: secondRef }).getByRole("button", { name: "Simulate refund" }).click();
    await expect(page.getByText(/Sandbox refund sent \(sandbox, \w+\)/)).toBeVisible();

    await page.goto("/pricing");
    await expectBalance(page, 0);
    // No ledger movement: the credit history has the same reversals as before.
    await expect(ledger(page).getByRole("row").filter({ hasText: /Refunded|Chargeback/ })).toHaveCount(reversalsBefore);
    // The processor's notice is recorded, with no credits taken (the Credits cell is empty).
    const refund = history(page).getByRole("row").filter({ hasText: secondRef }).filter({ hasText: "Refund" });
    await expect(refund).toHaveCount(1);
    await expect(refund.getByRole("cell").nth(3)).toHaveText("");
    await expect(page.getByTestId("account-flagged")).toHaveCount(0);
    await historyShot(evidence, page, "pay-09b-second-reversal-took-nothing");
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
      const json = (await res.json()) as { error: { code: string } };
      evidence.note(`payment webhook: ${code}`, { status: res.status(), body: json });
      expect(res.status()).toBe(400);
      expect(json.error.code).toBe(code);
    }
    await page.reload();
    await expectBalance(page, before);

    // The same signed body delivered twice: processed once, then a duplicate that touches nothing.
    const signature = signSandbox(body);
    const first = await post(signature);
    const firstJson = (await first.json()) as unknown;
    const again = await post(signature);
    const againJson = (await again.json()) as unknown;
    evidence.note("payment webhook: the same signed sale delivered twice", { first: { status: first.status(), body: firstJson }, again: { status: again.status(), body: againJson } });
    expect(first.status()).toBe(200);
    expect(firstJson).toEqual({ received: true, outcome: "processed" });
    expect(again.status()).toBe(200);
    expect(againJson).toEqual({ received: true, outcome: "duplicate" });

    await page.reload();
    await expectBalance(page, before + pack.credits);
    await expect(history(page).getByRole("row").filter({ hasText: `sbx_txn_e2e_${stamp}` })).toHaveCount(1);
    await historyShot(evidence, page, "pay-10-replay-granted-once");
  });

  test("a refund after some credits were spent takes back what is left and records the debt for an admin", async ({ browser, evidence }) => {
    const { page } = await evidence.newPage(browser, { ...DESKTOP, storageState: member });
    await page.goto("/pricing");
    await expectBalance(page, pack.credits);

    // Spend 4 of the credits the webhook sale above granted.
    await page.goto("/templates/velvet-hour");
    await page.getByRole("button", { name: "Make it" }).click();
    await expect(page.getByTestId("confirm-cost")).toHaveText("4 credits");
    await page.getByTestId("confirm-make").click();
    await expect(page.getByText("Weaving a demo placeholder.")).toBeVisible();
    await page.goto("/pricing");
    await expectBalance(page, pack.credits - 4);

    await toSandboxCheckout(page);
    await page.getByRole("listitem").filter({ hasText: `sbx_txn_e2e_${stamp}` }).getByRole("button", { name: "Simulate refund" }).click();
    await expect(page.getByText("Sandbox refund sent (sandbox, processed)")).toBeVisible();

    await page.goto("/pricing");
    await expectBalance(page, 0);
    const refund = history(page).getByRole("row").filter({ hasText: "Refund" }).filter({ hasText: `sbx_txn_e2e_${stamp}` });
    await expect(refund).toHaveCount(1);
    await expect(refund).toContainText(`-${pack.credits - 4}`);
    await expect(refund).toContainText("(4 owed)");
    await historyShot(evidence, page, "pay-11-refund-shortfall");

    const admin = await adminPage(evidence, browser);
    await admin.goto("/admin");
    const flags = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Account flags" }) });
    const debt = flags.getByRole("listitem").filter({ hasText: `@${handle}` }).filter({ hasText: "credit debt" });
    await expect(debt).toHaveCount(1);
    await expect(debt).toContainText("4 credits were already spent.");
    await expect(debt).toContainText(`shortfall 4 credits · reversed ${pack.credits - 4}`);
    await debt.scrollIntoViewIfNeeded();
    await evidence.shot(admin, "pay-12-admin-credit-debt-flag");
    // A credit debt does not pause buying (only a chargeback does).
    await page.goto("/pricing");
    await expect(page.getByTestId("account-flagged")).toHaveCount(0);
  });
});

// ── 3. Scanning and takedowns (addendum §3) ──────────────────────────────────────────────────────

test.describe("abuse scanning and takedowns", () => {
  test.describe.configure({ mode: "serial" });
  // The handle must not itself contain a word the "says nothing about why" check looks for.
  const throwaway = `quiet_${stamp}`;
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
    // Nothing on screen (page, alerts, toasts) says why.
    expect(await page.locator("body").innerText()).not.toMatch(/scan|match|abuse|csam|child|hash|suspend/i);
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
    // Even knowing where it is stored, a request for it is refused: without a signature, with a forged
    // one, and with a valid one (signed with the run's media secret, as the server signs its own links).
    const stored = ((await item.getByText(/^stored at /).textContent()) ?? "").replace(/^stored at\s*/, "").trim();
    expect(stored).toMatch(/^uploads\//);

    // The control. A clean file's link as the server issued it (a template cover): signing its key and
    // expiry here reproduces the server's own signature, so this test signs exactly as the server does,
    // and the same signing on a clean file is served. (A member's upload is never shown back through a
    // signed link, its preview is the browser's local copy, so a seeded cover stands in.)
    const viewer = await admin.context().newPage();
    await viewer.goto("/templates/velvet-hour");
    const issued = new URL((await viewer.getByAltText("Velvet Hour cover").getAttribute("src")) ?? "", BASE).searchParams;
    const cleanKey = issued.get("k") ?? "";
    const issuedExp = Number(issued.get("e"));
    expect(cleanKey).not.toBe("");
    expect(mediaSignature(cleanKey, issuedExp), "the test signs /api/media links exactly as the server does").toBe(issued.get("s"));
    await viewer.close();

    const exp = Math.floor(Date.now() / 1000) + 300;
    const probes = [
      { what: "held file, no signature", url: `/api/media?k=${encodeURIComponent(stored)}`, status: 403 },
      { what: "held file, forged signature", url: `/api/media?k=${encodeURIComponent(stored)}&e=${exp}&s=forged`, status: 403 },
      { what: "held file, valid signature", url: signedMediaUrl(stored, exp), status: 404 },
      // The same signing on a clean file is served, so the 404 above is the scan guard, not the signature.
      { what: "clean file, valid signature (control)", url: signedMediaUrl(cleanKey, exp), status: 200 },
    ];
    for (const probe of probes) {
      const res = await admin.request.get(probe.url);
      const body = res.headers()["content-type"]?.includes("json") ? ((await res.json()) as unknown) : `${res.headers()["content-type"]}, ${(await res.body()).length} bytes`;
      evidence.note(`GET /api/media: ${probe.what}`, { key: new URL(probe.url, BASE).searchParams.get("k"), status: res.status(), body });
      expect(res.status(), probe.what).toBe(probe.status);
      if (probe.status === 403) expect(body).toEqual({ error: { code: "forbidden", message: "Link expired or invalid." } });
      if (probe.status === 404) expect(body).toEqual({ error: { code: "not_found", message: "Not found." } });
      if (probe.status === 200) expect(res.headers()["content-type"]).toMatch(/^image\//);
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
    const manifest = (await res.json()) as { name: string; display: string; start_url: string; icons: { src: string; sizes: string; type?: string; purpose?: string }[] };
    evidence.note("GET /manifest.webmanifest", { status: res.status(), contentType: res.headers()["content-type"], manifest });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^application\/manifest\+json/);
    expect(manifest.name).toBe("Hushloom");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((i) => i.sizes === `${size}x${size}` && (i.purpose ?? "any").split(" ").includes("any"));
      expect(icon, `${size}px icon`).toBeDefined();
      const png = await request.get(new URL(icon!.src, BASE).toString());
      const dims = pngSize(await png.body());
      evidence.note(`GET ${icon!.src}`, { status: png.status(), contentType: png.headers()["content-type"], pixels: dims });
      expect(png.status()).toBe(200);
      expect(png.headers()["content-type"]).toBe("image/png");
      expect(dims).toEqual({ width: size, height: size });
    }
  });

  test("the service worker script is served fresh and may control the whole origin", async ({ request, evidence }) => {
    const res = await request.get(`${BASE}/sw.js`);
    const headers = res.headers();
    evidence.note("GET /sw.js", { status: res.status(), cacheControl: headers["cache-control"], serviceWorkerAllowed: headers["service-worker-allowed"], contentType: headers["content-type"] });
    expect(res.status()).toBe(200);
    expect(headers["cache-control"]).toBe("no-cache");
    expect(headers["service-worker-allowed"]).toBe("/");
    expect(headers["content-type"]).toMatch(/javascript/);
  });

  test("pages link the manifest and iOS icon, and Chromium's own installability check reports no errors", async ({ browser, evidence }) => {
    const { ctx, page } = await evidence.newPage(browser, PHONE);
    await enterAgeGate(page);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon.png");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0f0a0d");
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
    const touchIcon = await ctx.request.get("/icons/apple-touch-icon.png");
    expect(touchIcon.status()).toBe(200);
    expect(pngSize(await touchIcon.body())).toEqual({ width: 180, height: 180 });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    const cdp = await ctx.newCDPSession(page);
    const manifest = (await cdp.send("Page.getAppManifest")) as { url: string; errors: { message: string; critical: number }[] };
    const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string; errorArguments: unknown[] }[] };
    evidence.note("CDP Page.getAppManifest and Page.getInstallabilityErrors on /", { manifestUrl: manifest.url, manifestErrors: manifest.errors, installabilityErrors });
    expect(manifest.url).toBe(`${BASE}/manifest.webmanifest`);
    expect(manifest.errors).toEqual([]);
    expect(installabilityErrors).toEqual([]);
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
    await settle(page);
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
    evidence.note("offline navigation to /collection in a new tab", {
      outcome: failure === null ? "the offline page" : "the browser's own network error (no response from the worker or a cache)",
      tabUrl: tab.url(),
      navigationError: failure?.split("\n")[0] ?? null,
      bodyText: (await tab.locator("body").innerText().catch(() => "")).slice(0, 200),
    });
    // Headless Chromium renders its own network-error page blank, so a picture only says something when
    // the offline page answered; otherwise the note above is the evidence.
    if (failure === null) await evidence.shot(tab, "pwa-02-offline-private-page");
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
    const keyJson = (await key.json()) as unknown;
    evidence.note("GET /api/push/public-key", { status: key.status(), body: keyJson });
    expect(keyJson).toMatchObject({ enabled: false, publicKey: null });
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
  // Each visit asserts it landed on the page it meant (its URL and its h1), so a redirect or a not-found
  // screen cannot pass as a screenshot of the right page.
  const visit = async (path: string, heading: string | RegExp, name: string) => {
    await page.goto(path);
    await expect(page).toHaveURL(`${BASE}${path}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await settle(page);
    await evidence.shot(page, name);
  };
  await visit("/", "Pick a template. Make it yours.", "smoke-01-home");
  await visit("/explore", "Explore", "smoke-02-explore");
  await visit("/templates/velvet-hour", "Velvet Hour", "smoke-03-template");
  await apiAs(ctx.request, "demo@hushloom.local");
  await visit("/collection", "Library", "smoke-04-library");
  await expect(balance(page)).toBeVisible();
  await visit("/settings", "Settings", "smoke-05-settings");
  await visit("/pricing", "Credits and passes", "smoke-06-pricing");
  await visit("/policies", "Policies", "smoke-07-policies");
  await visit("/policies/takedown", "Request a takedown", "smoke-08-takedown");

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

// ── 6. Clock skew: server-rendered relative times hydrate cleanly (regression for 11ad512) ─────────

test("with the device clock 10 minutes ahead, pages with relative times and dates hydrate without errors", async ({ browser, evidence }) => {
  // The fixture fails the test on any page error, so a returning React #418 (hydration text mismatch)
  // on any page below fails it. The server renders "just now" / "5m ago"; the skewed browser computes a
  // different string for the same timestamp, which is exactly what used to break hydration.
  const SKEW_MS = 10 * 60_000;
  const skewed = async (options: Parameters<Evidence["newPage"]>[1]) => {
    const { ctx, page } = await evidence.newPage(browser, { ...DESKTOP, serviceWorkers: "block", ...options });
    await ctx.clock.install({ time: Date.now() + SKEW_MS });
    await ctx.clock.resume();
    return { ctx, page };
  };
  const visited: string[] = [];
  const check = async (page: Page, path: string, heading: string | RegExp, ready?: () => Promise<void>) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    if (ready) await ready();
    await settle(page);
    visited.push(path);
  };

  // A GB member who verifies (Settings shows the check's dates) and buys a pack (the sandbox page lists it).
  const { page: member } = await skewed(GB);
  const skew = (await member.evaluate(() => Date.now())) - Date.now();
  expect(skew).toBeGreaterThan(SKEW_MS - 60_000);
  await enterAgeGate(member);
  await signUp(member, `skew_${stamp}`);
  await member.goto("/settings#age-verification");
  await member.locator("#age-verification").getByRole("button", { name: "Verify now" }).click();
  await member.getByRole("button", { name: "Simulate verified" }).click();
  await expect(member).toHaveURL(`${BASE}/settings#age-verification`);
  await check(member, "/settings", "Settings", () =>
    expect(member.locator("#age-verification").getByRole("heading", { name: "Your age check" }).locator("..").getByText("Verified", { exact: true })).toBeVisible(),
  );
  await member.goto("/pricing");
  await member.getByRole("heading", { name: smallestPack.label, exact: true, level: 3 }).locator("..").getByRole("button", { name: /^Buy/ }).click();
  await member.getByTestId("sandbox-complete").click();
  await expect(member).toHaveURL(`${BASE}/pricing?checkout=success`);
  await check(member, "/pricing", "Credits and passes");
  await member.getByRole("heading", { name: smallestPack.label, exact: true, level: 3 }).locator("..").getByRole("button", { name: /^Buy/ }).click();
  await expect(member).toHaveURL(/\/pricing\/sandbox\?t=/);
  await expect(member.getByRole("button", { name: "Simulate refund" })).toHaveCount(1);
  await settle(member);
  visited.push("/pricing/sandbox (with a purchase)");
  await evidence.shot(member, "skew-01-sandbox-purchases-clock-ahead");

  // A creation, so the Library and its detail page show relative times.
  await member.goto("/templates/velvet-hour");
  await member.getByRole("button", { name: "Make it" }).click();
  await member.getByTestId("confirm-make").click();
  await expect(member.getByText("Weaving a demo placeholder.")).toBeVisible();
  await check(member, "/collection", "Library", () => expect(member.locator("article").first()).toBeVisible());
  await evidence.shot(member, "skew-02-library-clock-ahead");
  const detail = await member.locator("article").first().getByRole("link").getAttribute("href");
  expect(detail).toMatch(/^\/collection\/[0-9a-f-]{36}$/);
  await member.goto(detail!);
  await settle(member);
  visited.push("/collection/<id>");

  // The admin pages (flags, takedowns and scanner matches with ages).
  const { ctx: adminCtx, page: admin } = await skewed({});
  await apiAs(adminCtx.request, "admin@hushloom.local");
  await check(admin, "/admin", "Admin");
  await check(admin, "/admin/review", "Abuse review");
  await evidence.shot(admin, "skew-03-admin-review-clock-ahead");
  evidence.note("pages loaded with the browser clock 10 minutes ahead", { skewMs: skew, visited });
});
