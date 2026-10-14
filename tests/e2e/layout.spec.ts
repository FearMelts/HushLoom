import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { BASE, expect, test, type Evidence } from "./evidence";

// Layout guards for the main routes, as a visitor and as a member: at phone (390) and tablet (820)
// width nothing scrolls the page sideways, and on the phone every visible primary navigation control
// and primary action is at least 40x40 px.

const ROUTES = [
  ["/", "home"],
  ["/explore", "explore"],
  ["/templates/velvet-hour", "template"],
  ["/collection", "Library"],
  ["/projects", "projects"],
  ["/pricing", "pricing"],
  ["/settings", "settings"],
  ["/auth", "auth"],
] as const;

const VIEWPORTS: Record<number, BrowserContextOptions> = {
  390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  820: { viewport: { width: 820, height: 1180 } },
};

async function open(browser: Browser, evidence: Evidence, width: number, role: "visitor" | "member"): Promise<Page> {
  const { ctx, page } = await evidence.newPage(browser, VIEWPORTS[width]);
  if (role === "visitor") {
    const gate = await ctx.request.post("/api/age-gate", { data: { confirm: true }, headers: { Origin: BASE } });
    expect(gate.ok(), "age gate").toBe(true);
  } else {
    const login = await ctx.request.post("/api/auth/login", { data: { email: "demo@hushloom.local", password: "e2e-password-123" }, headers: { Origin: BASE } });
    expect(login.status(), "member sign-in").toBe(200);
  }
  return page;
}

/**
 * Waits until the page stops moving. A signed-out visit to the Library or Settings answers 200 with a
 * streamed redirect that the client follows to /auth after hydration, so the URL must hold still too.
 */
async function settle(page: Page) {
  for (let i = 0; i < 6; i++) {
    const before = page.url();
    await page.waitForLoadState("load");
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    const ready = await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => false);
    await page.waitForTimeout(300);
    if (ready && page.url() === before) return;
  }
  throw new Error(`${page.url()} kept navigating`);
}

/**
 * Sideways overflow, measured against the configured viewport width: with isMobile, Chromium widens
 * the layout viewport (window.innerWidth) to fit overflowing content, so innerWidth alone hides it.
 */
const overflowOf = (page: Page, width: number) =>
  page.evaluate((w) => {
    const sw = document.documentElement.scrollWidth;
    if (sw <= w) return null;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > w + 1 && !el.closest("[class*='overflow-x-auto']"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")}`);
    return { scrollWidth: sw, offenders };
  }, width);

/** Visible header and tab-bar controls, and filled (ember or bone) buttons and links, under 40x40. */
const smallPrimaryTargets = (page: Page) =>
  page.evaluate(() => {
    const nav = "header a, header button, nav[aria-label='Main navigation'] a, nav[aria-label='Main navigation'] button";
    const primary = "a[class*='bg-ember-500'], button[class*='bg-ember-500'], a[class*='bg-bone-50'], button[class*='bg-bone-50']";
    const seen = new Set<Element>();
    const out: string[] = [];
    for (const el of document.querySelectorAll(`${nav}, ${primary}`)) {
      if (seen.has(el)) continue;
      seen.add(el);
      // A switch's whole row is its label, and so its target.
      if (el.getAttribute("role") === "switch" || el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (r.width >= 40 && r.height >= 40) continue;
      const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
      out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });

for (const width of [390, 820]) {
  for (const role of ["visitor", "member"] as const) {
    test(`the main routes fit ${width} px for a ${role}${width === 390 ? ", with 40 px primary targets" : ""}`, async ({ browser, evidence }) => {
      const page = await open(browser, evidence, width, role);
      for (const [route, name] of ROUTES) {
        const res = await page.goto(route);
        expect(res?.status(), `${name} answers`).toBeLessThan(400);
        await settle(page);
        expect(await overflowOf(page, width), `${name} (${route}, landed on ${new URL(page.url()).pathname}) scrolls sideways at ${width} px`).toBeNull();
        if (width === 390) expect(await smallPrimaryTargets(page), `${name}: primary controls under 40x40 at 390 px`).toEqual([]);
      }
    });
  }
}
