import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { devices, expect, test, type APIRequestContext, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Route } from "@playwright/test";
import { pricing } from "../../src/config/pricing";

/**
 * Visual review capture (phase 4). Full-page screenshots of every page and state at three viewports, each
 * with automated checks recorded next to it in a manifest:
 *
 *   - horizontal overflow: document.documentElement.scrollWidth > the configured viewport width (not innerWidth:
 *     with isMobile, Chromium widens the layout viewport to fit wide content, so innerWidth grows with the
 *     overflow), with up to five offending elements (the outermost ones whose right edge passes the viewport
 *     and that no fitting scroller clips);
 *   - small targets: visible a, button, input, select, textarea, [role=button] and [tabindex] elements under
 *     40x40 px at 390 px wide, or under 24x24 px at any width. Elements that fail by design (an inline text
 *     link, a checkbox whose label is the target) are listed with the reason, not dropped;
 *   - clipped text: an element with overflow hidden or clip whose text is wider than its box and that has no
 *     text-overflow: ellipsis;
 *   - color contrast: axe-core's color-contrast rule only (node_modules/axe-core/axe.min.js, injected).
 *
 * With a sheet open, the target, clipped-text and contrast checks look inside the open dialog (everything
 * behind it is inert); the overflow check is always page-wide. Sheets and the job tray are captured at viewport
 * size, where the person sees them; pages are captured full-page from the top.
 *
 * Skipped unless VISUAL_REVIEW=1, so the normal e2e run is unchanged. Files go to VISUAL_SHOTS_DIR (default
 * test-results/visual): "<id>.png" per capture and manifest.json. A step that fails is recorded in the manifest
 * (failures) and the test fails at its end, after every other capture in it has run.
 *
 *   VISUAL_REVIEW=1 VISUAL_SHOTS_DIR=/path/to/dir npx playwright test tests/e2e/visual.spec.ts
 */

test.skip(process.env.VISUAL_REVIEW !== "1", "visual review capture runs only with VISUAL_REVIEW=1");

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const SEED_PASSWORD = "e2e-password-123";
const MEMBER_PASSWORD = "e2e-member-pass";
const SHOTS_DIR = path.resolve(process.env.VISUAL_SHOTS_DIR ?? "test-results/visual");
const MANIFEST = path.join(SHOTS_DIR, "manifest.json");
const AXE_PATH = path.resolve("node_modules/axe-core/axe.min.js");
const MATCH_FIXTURE = path.resolve("tests/fixtures/scan-drill-match.png");
// One key per Playwright run: playwright.config.ts draws the media secret once in the main process and every
// worker inherits it. A worker restarted after a failed test finds this run's manifest and setup by it.
const RUN_KEY = createHash("sha256")
  .update(process.env.E2E_MEDIA_SIGNING_SECRET ?? "no-secret")
  .digest("hex")
  .slice(0, 16);
const SETUP_FILE = path.resolve("test-results", `visual-setup-${RUN_KEY}.json`);
const GB = { "x-country-code": "GB" };
const PROMPT = "a quiet lakeside cabin at dusk, warm window light";
const OFFLINE_LINE = "You're offline. Nothing is queued; try again when you're back.";
const smallestPack = [...pricing.packs].sort((a, b) => a.credits - b.credits)[0]!;

type Viewport = { name: "phone" | "tablet" | "desktop"; width: number; height: number; options: BrowserContextOptions };
const VIEWPORTS: Viewport[] = [
  {
    name: "phone",
    width: 390,
    height: 844,
    options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: devices["Pixel 5"].userAgent },
  },
  { name: "tablet", width: 820, height: 1180, options: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 } },
  { name: "desktop", width: 1440, height: 900, options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
];

// ── Manifest ─────────────────────────────────────────────────────────────────────────────────────

type TargetItem = { el: string; text: string; w: number; h: number; under24: boolean; byDesign: string | null };
type PageChecks = {
  h1: string | null;
  overflow: {
    scrollWidth: number;
    innerWidth: number;
    viewportWidth: number;
    overflows: boolean;
    offenders: { el: string; text: string; left: number; right: number; width: number }[];
    offenderCount: number;
  };
  smallTargets: {
    rule: string;
    minSize: number;
    scope: string;
    checked: number;
    failing: number;
    flagged: number;
    byDesign: number;
    under24: number;
    /** Every failing element, grouped by element, size and reason (no cap). */
    groups: { el: string; size: string; count: number; byDesign: string | null; example: string }[];
    items: TargetItem[];
    truncated: number;
  };
  clippedText: { scope: string; count: number; items: { el: string; text: string; scrollWidth: number; clientWidth: number }[]; truncated: number };
};
type ContrastNode = { target: string; text: string; html: string; fgColor?: unknown; bgColor?: unknown; contrastRatio?: unknown; expectedContrastRatio?: unknown; fontSize?: unknown; fontWeight?: unknown };
type Contrast = { rule: "color-contrast"; axe: string; scope: string; violations: number; nodes: ContrastNode[]; truncated: number; incomplete: number; incompleteReasons: Record<string, number>; error?: string };
type Entry = {
  id: string;
  route: string;
  url: string;
  role: string;
  state: string;
  viewport: Viewport["name"];
  width: number;
  height: number;
  file: string;
  fullPage: boolean;
  status: number | null;
  capturedAt: string;
  note?: string;
  console: string[];
  checks: PageChecks & { contrast: Contrast };
};
type Failure = { test: string; step: string; viewport: string; role: string; error: string; screenshot: string | null; at: string };
type NotCaptured = { what: string; viewport: string; role: string; reason: string };
type Manifest = {
  spec: string;
  runKey: string;
  startedAt: string;
  updatedAt: string;
  baseUrl: string;
  git: { head: string | null; specDirty: boolean | null };
  viewports: { name: string; width: number; height: number; isMobile: boolean; hasTouch: boolean; deviceScaleFactor: number }[];
  checks: Record<string, string>;
  notes: { label: string; data: unknown }[];
  entries: Entry[];
  notCaptured: NotCaptured[];
  failures: Failure[];
};

function git(cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function freshManifest(): Manifest {
  return {
    spec: "tests/e2e/visual.spec.ts",
    runKey: RUN_KEY,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseUrl: BASE,
    git: { head: git("rev-parse HEAD"), specDirty: git("status --porcelain -- tests/e2e/visual.spec.ts") === null ? null : git("status --porcelain -- tests/e2e/visual.spec.ts") !== "" },
    viewports: VIEWPORTS.map((v) => ({
      name: v.name,
      width: v.width,
      height: v.height,
      isMobile: Boolean(v.options.isMobile),
      hasTouch: Boolean(v.options.hasTouch),
      deviceScaleFactor: v.options.deviceScaleFactor ?? 1,
    })),
    checks: {
      overflow: "document.documentElement.scrollWidth > the configured viewport width (viewportWidth; innerWidth is recorded too, and a phone context widens it to fit wide content). offenders: up to five outermost elements whose right edge passes the viewport and that no fitting scroll or clip container hides (offenderCount is the full count).",
      smallTargets:
        "Visible a, button, input, select, textarea, [role=button], [tabindex] (visually hidden .sr-only elements and hidden inputs skipped). At 390 px: smaller than 40x40 (under24 also marks those below 24x24); at other widths: smaller than 24x24. byDesign gives the reason when an element fails on purpose; flagged = failing - byDesign. items lists up to 80.",
      clippedText: "Elements with overflow-x hidden or clip, scrollWidth > clientWidth + 1, text-overflow not ellipsis, and text of their own (a text node, or only inline children with text). Inputs and visually hidden elements skipped. items lists up to 40.",
      contrast: "axe-core color-contrast rule only, run on the document (or the open dialog). nodes lists up to 60 violating elements with axe's colours and ratio; incomplete counts elements axe could not decide (for example text over an image or a gradient).",
      scope: "With a modal sheet open, smallTargets, clippedText and contrast look only inside dialog[open]; overflow is page-wide.",
      capture:
        "Pages: full-page, scrolled through once so lazy images load, then from the top, with animations disabled. Sheets, the job tray and other overlays: viewport-size, where the person sees them. In a full-page capture Chromium draws fixed elements (the top bar, the phone and tablet tab bar, the desktop rail, the job tray) where they sit in the first viewport: on a page taller than the viewport the tab bar shows at y = viewport height over the content and the rail stops there. That is the capture, not the layout.",
      smallTargetsByDesign:
        "Reasons used: an <a> with display inline that shares a line with text (WCAG 2.5.8 inline exception); an input whose <label> is at least the minimum size (the label is the tap target); a tabindex=-1 element that is not a control (a programmatic focus target). Everything else that fails is flagged.",
    },
    notes: [],
    entries: [],
    notCaptured: [],
    failures: [],
  };
}

function loadManifest(): Manifest {
  if (existsSync(MANIFEST)) {
    try {
      const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
      if (m.runKey === RUN_KEY) return m;
    } catch {
      // A broken file belongs to no run: start over.
    }
  }
  // A new run: the directory holds only this spec's output, so the previous run's files go.
  mkdirSync(SHOTS_DIR, { recursive: true });
  for (const f of readdirSync(SHOTS_DIR)) if (f.endsWith(".png") || f === "manifest.json") rmSync(path.join(SHOTS_DIR, f));
  const m = freshManifest();
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  return m;
}

/** Read, change and write the manifest (one worker at a time, so no locking is needed). */
function record(change: (m: Manifest) => void) {
  const m = loadManifest();
  change(m);
  m.updatedAt = new Date().toISOString();
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── In-page checks ───────────────────────────────────────────────────────────────────────────────

/** Runs in the page. Self-contained: Playwright serializes it. */
function pageChecks(arg: { minTarget: number; scope: string | null; rule: string; viewportWidth: number }): PageChecks {
  // The configured width, not innerWidth: with isMobile, Chromium widens the layout viewport to fit content that
  // overflows, so innerWidth would grow with the very overflow this measures.
  const W = arg.viewportWidth;
  const docEl = document.documentElement;
  const scopeEl = arg.scope ? document.querySelector(arg.scope) : null;
  const root: Element = scopeEl ?? docEl;
  const clean = (s: string | null | undefined, n = 80) =>
    (s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string"
        ? el.className
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 4)
            .map((c) => `.${c}`)
            .join("")
        : "";
    const role = el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : "";
    const testid = el.getAttribute("data-testid") ? `[data-testid=${el.getAttribute("data-testid")}]` : "";
    return `${tag}${id}${role}${testid}${cls}`.slice(0, 160);
  };
  const name = (el: Element) =>
    clean(
      el.getAttribute("aria-label") ||
        (el as HTMLElement).innerText ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        (el instanceof HTMLInputElement ? `${el.type} input` : ""),
      60,
    );
  const isVisible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const check = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
    if (check && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (el.closest(".sr-only")) return false;
    return getComputedStyle(el).clipPath !== "inset(50%)";
  };

  // Horizontal overflow.
  const scrollWidth = docEl.scrollWidth;
  const overflows = scrollWidth > W;
  const offenders: PageChecks["overflow"]["offenders"] = [];
  let offenderCount = 0;
  if (overflows) {
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= W + 0.5) continue;
      const parent = el.parentElement;
      // Report the outermost element that passes the edge.
      if (parent && parent !== document.body && parent.getBoundingClientRect().right > W + 0.5) continue;
      // Hidden by a scroll or clip container that itself fits.
      let clipped = false;
      for (let a = el.parentElement; a && a !== document.body && a !== docEl; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== "visible") {
          clipped = a.getBoundingClientRect().right <= W + 0.5;
          break;
        }
      }
      if (clipped || !isVisible(el)) continue;
      offenderCount++;
      if (offenders.length < 5) offenders.push({ el: describe(el), text: clean((el as HTMLElement).innerText, 60), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    }
  }

  // Small targets.
  const SEL = "a, button, input, select, textarea, [role=button], [tabindex]";
  const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=radio], [role=checkbox], [role=switch], [role=tab], [role=option], [role=menuitem], [role=slider]";
  const items: TargetItem[] = [];
  const groups = new Map<string, PageChecks["smallTargets"]["groups"][number]>();
  let checked = 0;
  let failing = 0;
  let byDesignCount = 0;
  let under24Count = 0;
  for (const el of Array.from(root.querySelectorAll(SEL))) {
    if (el instanceof HTMLInputElement && el.type === "hidden") continue;
    if (!isVisible(el)) continue;
    checked++;
    const r = el.getBoundingClientRect();
    if (r.width >= arg.minTarget && r.height >= arg.minTarget) continue;
    failing++;
    const under24 = r.width < 24 || r.height < 24;
    if (under24) under24Count++;
    let byDesign: string | null = null;
    if (el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement) {
      // In a line of text: a sibling text node, or an inline sibling element, with text of its own.
      const inLine = Array.from(el.parentElement.childNodes).some(
        (n) =>
          n !== el &&
          (n.nodeType === Node.TEXT_NODE ? clean(n.textContent) !== "" : n instanceof Element && getComputedStyle(n).display === "inline" && clean(n.textContent) !== ""),
      );
      if (inLine) byDesign = "inline link in a line of text (WCAG 2.5.8 inline exception)";
    }
    if (!byDesign && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && el.labels) {
      for (const label of Array.from(el.labels)) {
        const lr = label.getBoundingClientRect();
        if (lr.width >= arg.minTarget && lr.height >= arg.minTarget) {
          byDesign = `its <label> (${Math.round(lr.width)}x${Math.round(lr.height)}) is the tap target`;
          break;
        }
      }
    }
    if (!byDesign && el.getAttribute("tabindex") === "-1" && !el.matches(INTERACTIVE)) byDesign = "tabindex=-1 focus target, not a tap target";
    if (byDesign) byDesignCount++;
    const item = { el: describe(el), text: name(el), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, under24, byDesign };
    if (items.length < 80) items.push(item);
    const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    const key = `${item.el}|${size}|${byDesign ?? ""}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { el: item.el, size, count: 1, byDesign, example: item.text });
  }

  // Clipped text.
  const clipped: PageChecks["clippedText"]["items"] = [];
  let clippedCount = 0;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!(el instanceof HTMLElement)) continue;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) continue;
    if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
    if (cs.textOverflow === "ellipsis") continue;
    if (!isVisible(el)) continue;
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
    const inlineKids = el.children.length > 0 && Array.from(el.children).every((c) => getComputedStyle(c).display.startsWith("inline")) && clean(el.textContent) !== "";
    if (!ownText && !inlineKids) continue;
    clippedCount++;
    if (clipped.length < 40) clipped.push({ el: describe(el), text: clean(el.textContent), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }

  const scopeName = scopeEl ? `${arg.scope} (${clean(scopeEl.getAttribute("aria-label"), 60)})` : "document";
  return {
    h1: clean(document.querySelector("h1")?.textContent, 120) || null,
    overflow: { scrollWidth, innerWidth: window.innerWidth, viewportWidth: W, overflows, offenders, offenderCount },
    smallTargets: { rule: arg.rule, minSize: arg.minTarget, scope: scopeName, checked, failing, flagged: failing - byDesignCount, byDesign: byDesignCount, under24: under24Count, groups: Array.from(groups.values()).sort((a, b) => b.count - a.count), items, truncated: Math.max(0, failing - items.length) },
    clippedText: { scope: scopeName, count: clippedCount, items: clipped, truncated: Math.max(0, clippedCount - clipped.length) },
  };
}

async function contrastCheck(page: Page, scope: string | null): Promise<Contrast> {
  const empty: Contrast = { rule: "color-contrast", axe: "", scope: scope ?? "document", violations: 0, nodes: [], truncated: 0, incomplete: 0, incompleteReasons: {} };
  try {
    const loaded = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== "undefined");
    if (!loaded) await page.addScriptTag({ path: AXE_PATH });
    return await page.evaluate(async (scopeSel) => {
      type AxeCheck = { data?: Record<string, unknown> | null };
      type AxeNode = { target: unknown[]; html: string; any: AxeCheck[] };
      type AxeRule = { nodes: AxeNode[] };
      type Axe = { version: string; run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeRule[]; incomplete: AxeRule[] }> };
      const axe = (window as unknown as { axe: Axe }).axe;
      const ctx = (scopeSel ? document.querySelector(scopeSel) : null) ?? document;
      const res = await axe.run(ctx, { runOnly: { type: "rule", values: ["color-contrast"] }, resultTypes: ["violations", "incomplete"] });
      const textOf = (target: unknown[]) => {
        if (target.length !== 1 || typeof target[0] !== "string") return "";
        try {
          return (document.querySelector(target[0])?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        } catch {
          return "";
        }
      };
      const violating = res.violations.flatMap((v) => v.nodes);
      const incomplete = res.incomplete.flatMap((v) => v.nodes);
      const reasons: Record<string, number> = {};
      for (const n of incomplete) {
        const key = String(n.any[0]?.data?.messageKey ?? "unspecified");
        reasons[key] = (reasons[key] ?? 0) + 1;
      }
      return {
        rule: "color-contrast" as const,
        axe: axe.version,
        scope: scopeSel ?? "document",
        violations: violating.length,
        nodes: violating.slice(0, 60).map((n) => {
          const d = n.any[0]?.data ?? {};
          return {
            target: n.target.map(String).join(" "),
            text: textOf(n.target),
            html: n.html.slice(0, 200),
            fgColor: d.fgColor,
            bgColor: d.bgColor,
            contrastRatio: d.contrastRatio,
            expectedContrastRatio: d.expectedContrastRatio,
            fontSize: d.fontSize,
            fontWeight: d.fontWeight,
          };
        }),
        truncated: Math.max(0, violating.length - 60),
        incomplete: incomplete.length,
        incompleteReasons: reasons,
      };
    }, scope);
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

// ── Page helpers ─────────────────────────────────────────────────────────────────────────────────

async function settle(page: Page) {
  await page.waitForLoadState("load").catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
}

/** Scrolls through the page once so lazy images load, waits for them, and returns to the top. */
async function primeLazy(page: Page) {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 40; y += step, i++) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), undefined, { timeout: 8_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function post(request: APIRequestContext, url: string, data: unknown, headers: Record<string, string> = {}) {
  return request.post(url, { data, headers: { Origin: BASE, ...headers } });
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type Account = "admin" | "member" | "creator" | "fresh" | "gb" | "gbCheck" | "tray";
type Setup = {
  runKey: string;
  stamp: string;
  states: Record<Account, StorageState>;
  handles: Record<Account, string>;
  creationId: string;
  projectId: string;
  escalation: boolean;
};

function loadSetup(): Setup {
  if (!existsSync(SETUP_FILE)) throw new Error(`no setup for this run (${SETUP_FILE}); the setup test must pass first`);
  const s = JSON.parse(readFileSync(SETUP_FILE, "utf8")) as Setup;
  if (s.runKey !== RUN_KEY) throw new Error("the setup file belongs to another run");
  return s;
}

/**
 * One capture session per test: contexts at the test's viewport, captures written to the manifest, and failures
 * recorded (the test fails at the end, after every other capture has run).
 */
class Shooter {
  readonly failures: Failure[] = [];
  private readonly errors = new WeakMap<Page, string[]>();
  private readonly contexts: BrowserContext[] = [];

  constructor(
    private readonly browser: Browser,
    readonly vp: Viewport,
    private readonly testTitle: string,
  ) {}

  async context(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const ctx = await this.browser.newContext({ baseURL: BASE, ...this.vp.options, ...options });
    this.contexts.push(ctx);
    return ctx;
  }

  async page(ctx: BrowserContext): Promise<Page> {
    const page = await ctx.newPage();
    const errs: string[] = [];
    this.errors.set(page, errs);
    page.on("console", (m) => {
      if (m.type() === "error") errs.push(`console: ${m.text().slice(0, 300)}`);
    });
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.name}: ${e.message.slice(0, 300)}`));
    return page;
  }

  /** An anonymous page past the age gate (the gate's own API sets its cookie). */
  async anonymous(headers: Record<string, string> = {}): Promise<Page> {
    const ctx = await this.context({ extraHTTPHeaders: headers });
    const res = await post(ctx.request, "/api/age-gate", { confirm: true });
    expect(res.status(), "age gate cookie").toBe(200);
    return this.page(ctx);
  }

  async signedIn(state: StorageState, options: BrowserContextOptions = {}): Promise<Page> {
    return this.page(await this.context({ storageState: state, ...options }));
  }

  /** Runs one step; a failure is recorded (with a screenshot when a page is given) and does not stop the test. */
  async attempt(step: string, role: string, fn: () => Promise<void>, page?: Page) {
    try {
      await test.step(step, fn);
    } catch (e) {
      let screenshot: string | null = null;
      if (page && !page.isClosed()) {
        screenshot = `fail-${this.vp.name}-${slug(role)}-${slug(step)}.png`;
        await page.screenshot({ path: path.join(SHOTS_DIR, screenshot) }).catch(() => (screenshot = null));
      }
      const failure: Failure = {
        test: this.testTitle,
        step,
        viewport: `${this.vp.width}x${this.vp.height}`,
        role,
        error: (e instanceof Error ? e.message : String(e)).split("\n").slice(0, 6).join("\n"),
        screenshot,
        at: new Date().toISOString(),
      };
      this.failures.push(failure);
      record((m) => {
        m.failures.push(failure);
        // A page that landed somewhere unexpected was still captured; its entry carries the note.
        if (!failure.error.includes("(captured anyway)")) {
          m.notCaptured.push({ what: step, viewport: `${this.vp.width}x${this.vp.height}`, role, reason: `the capture step failed: ${failure.error.split("\n")[0]}` });
        }
      });
    }
  }

  /** Visits a route, checks where it landed, and captures it. */
  async visit(page: Page, route: string, role: string, state: string, opts: { expectPath?: string | null; expectStatus?: number | null } = {}) {
    const res = await page.goto(route);
    await settle(page);
    const want = opts.expectPath === undefined ? new URL(route, BASE).pathname : opts.expectPath;
    const got = new URL(page.url()).pathname;
    const status = res?.status() ?? null;
    const wantStatus = opts.expectStatus === undefined ? 200 : opts.expectStatus;
    const problems: string[] = [];
    if (want !== null && got !== want) problems.push(`expected ${want}, landed on ${got}`);
    if (wantStatus !== null && status !== wantStatus) problems.push(`expected HTTP ${wantStatus}, got ${status}`);
    await this.shot(page, { route, role, state, status, note: problems.join("; ") || undefined });
    if (problems.length) throw new Error(`${route}: ${problems.join("; ")} (captured anyway)`);
  }

  /** Screenshot plus checks, written to the manifest. */
  async shot(page: Page, o: { route: string; role: string; state: string; status?: number | null; fullPage?: boolean; note?: string }) {
    const fullPage = o.fullPage ?? true;
    const dialogOpen = await page.evaluate(() => Boolean(document.querySelector("dialog[open]")));
    const scope = dialogOpen ? "dialog[open]" : null;
    if (fullPage) {
      await primeLazy(page);
    }
    const base = `${this.vp.name}-${slug(o.role)}-${slug(o.state)}`;
    let id = base;
    const taken = new Set(loadManifest().entries.map((e) => e.id));
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    const file = `${id}.png`;
    await page.screenshot({ path: path.join(SHOTS_DIR, file), fullPage, animations: "disabled", caret: "hide", timeout: 60_000 });
    const narrow = this.vp.width <= 390;
    const checks = await page.evaluate(pageChecks, { minTarget: narrow ? 40 : 24, scope, rule: narrow ? "40x40 at 390 px wide" : "24x24 at any width", viewportWidth: this.vp.width });
    const contrast = await contrastCheck(page, scope);
    if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
    const errs = this.errors.get(page);
    const entry: Entry = {
      id,
      route: o.route,
      url: page.url().replace(BASE, ""),
      role: o.role,
      state: o.state,
      viewport: this.vp.name,
      width: this.vp.width,
      height: this.vp.height,
      file,
      fullPage,
      status: o.status ?? null,
      capturedAt: new Date().toISOString(),
      ...(o.note ? { note: o.note } : {}),
      console: errs ? errs.splice(0) : [],
      checks: { ...checks, contrast },
    };
    record((m) => m.entries.push(entry));
    await test.info().attach(file, { path: path.join(SHOTS_DIR, file), contentType: "image/png" });
  }

  notCaptured(what: string, role: string, reason: string) {
    record((m) => m.notCaptured.push({ what, viewport: `${this.vp.width}x${this.vp.height}`, role, reason }));
  }

  async finish() {
    for (const ctx of this.contexts) await ctx.close().catch(() => undefined);
    expect(this.failures, `capture failures (see ${MANIFEST})`).toEqual([]);
  }
}

/** Opens the phone and tablet "You" sheet. */
async function openYouSheet(page: Page) {
  await page.getByRole("button", { name: "You", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "You" })).toBeVisible();
}

const tabBarShows = (vp: Viewport) => vp.width < 1024;

async function cleanPng(size = 768): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: 92, g: 60, b: 120 } } })
    .png()
    .toBuffer();
}

// ── Setup: accounts and records every capture uses ──────────────────────────────────────────────

test("setup: accounts, a creation, a project, a takedown, a report and a scanner escalation", async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  loadManifest();
  if (existsSync(SETUP_FILE)) {
    loadSetup();
    return;
  }
  const stamp = Date.now().toString(36).slice(-7);
  const contexts: BrowserContext[] = [];
  const ctxFor = async (options: BrowserContextOptions = {}) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, serviceWorkers: "block", ...options });
    contexts.push(ctx);
    return ctx;
  };
  const login = async (email: string, password = SEED_PASSWORD) => {
    const ctx = await ctxFor();
    const res = await post(ctx.request, "/api/auth/login", { email, password });
    expect(res.status(), `sign in ${email}`).toBe(200);
    return ctx;
  };
  const signup = async (handle: string, displayName: string, headers: Record<string, string> = {}) => {
    const ctx = await ctxFor({ extraHTTPHeaders: headers });
    const res = await post(ctx.request, "/api/auth/signup", {
      email: `${handle}@example.test`,
      password: MEMBER_PASSWORD,
      handle,
      displayName,
      dateOfBirth: "1991-04-12",
      acceptTerms: true,
      confirmAdult: true,
    });
    expect(res.status(), `sign up ${handle}: ${await res.text()}`).toBe(201);
    return ctx;
  };

  const handles: Record<Account, string> = {
    admin: "hushloom",
    member: "demo_member",
    creator: "lunavelour",
    fresh: `vfresh_${stamp}`,
    gb: `vgb_${stamp}`,
    gbCheck: `vgbchk_${stamp}`,
    tray: `vtray_${stamp}`,
  };
  const admin = await login("admin@hushloom.local");
  const member = await login("demo@hushloom.local");
  const creator = await login("lunavelour@hushloom.local");
  const fresh = await signup(handles.fresh, "Rowan Ashby");
  const gb = await signup(handles.gb, "Imogen Hart", GB);
  const gbCheck = await signup(handles.gbCheck, "Tobias Reed", GB);
  const tray = await signup(handles.tray, "Mara Quinn");

  // Credits for the member who starts a creation at each viewport (the job tray captures).
  const grant = await post(admin.request, "/api/admin/credits", { account: handles.tray, amount: 40, reason: "visual review captures", idempotencyKey: `visual-${stamp}-tray` });
  expect(grant.status(), "credit grant").toBe(200);

  // The seeded member: a creation from a template, a project whose first scene has a creation, a favorite.
  const page = await member.newPage();
  const confirmJob = async () => {
    const confirmed = page.waitForResponse((r) => /\/api\/generations\/[0-9a-f-]{36}\/confirm$/.test(r.url()) && r.request().method() === "POST");
    await page.getByTestId("confirm-make").click();
    const res = await confirmed;
    expect(res.status(), "confirm").toBe(200);
    return new URL(res.url()).pathname.split("/").at(-2)!;
  };
  await page.goto("/templates/velvet-hour");
  await page.getByRole("button", { name: "Make it" }).click();
  await expect(page.getByTestId("confirm-cost")).toBeVisible();
  const creationId = await confirmJob();

  const created = await post(member.request, "/api/projects", { title: "Golden hour series", description: "Three stills that share one warm window light." });
  expect(created.status(), "create project").toBe(201);
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  const second = await post(member.request, `/api/projects/${projectId}/scenes`, { title: "The turn" });
  expect(second.status(), "add scene").toBe(201);
  const detail = (await (await member.request.get(`/api/projects/${projectId}`)).json()) as { scenes: { id: string }[] };
  await page.goto(`/generate/image?scene=${detail.scenes[0]!.id}`);
  await page.getByLabel("Prompt", { exact: true }).fill(PROMPT);
  await page.getByRole("button", { name: "Make it" }).click();
  await expect(page.getByTestId("confirm-cost")).toBeVisible();
  const sceneJob = await confirmJob();

  await expect
    .poll(async () => ((await (await member.request.get("/api/generations?active=1")).json()) as { items: unknown[] }).items.length, { timeout: 120_000, intervals: [1000] })
    .toBe(0);
  for (const id of [creationId, sceneJob]) {
    const job = ((await (await member.request.get(`/api/generations/${id}`)).json()) as { job: { status: string } }).job;
    expect(job.status, `creation ${id}`).toBe("completed");
  }
  expect((await post(member.request, "/api/favorites", { targetType: "creation", targetId: creationId })).status(), "favorite").toBe(200);
  expect((await post(member.request, "/api/templates/mirror-glow/report", { reason: "other", note: "Visual review: a sample report so the admin queue has a row." })).status(), "report").toBe(201);

  // A public takedown request, so the review queue has one.
  const anon = await ctxFor();
  const takedown = await post(anon.request, "/api/takedowns", {
    category: "likeness",
    target: `${BASE}/templates/velvet-hour`,
    email: "visual-review@example.test",
    name: "",
    details: "Visual review: a sample request so the takedown queue has a row.",
    goodFaith: true,
  });
  expect(takedown.status(), "takedown").toBe(201);

  // A scanner escalation (the dev scanner's drill fixture), so the review page has a match to act on. The
  // throwaway account is suspended by it, as designed.
  let escalation = false;
  const scanner = await signup(`vscan_${stamp}`, "Scan Drill");
  const scanPage = await scanner.newPage();
  await scanPage.goto("/generate/image");
  await scanPage.getByRole("radio", { name: "Image to image" }).click();
  await scanPage.getByTestId("upload-input").setInputFiles(MATCH_FIXTURE);
  const sheet = scanPage.getByRole("dialog", { name: "Before you upload" });
  await sheet.getByTestId("consent-checkbox").check();
  const rejected = scanPage.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
  await sheet.getByRole("button", { name: "Upload", exact: true }).click();
  escalation = (await rejected).status() === 403;
  expect(escalation, "the drill fixture is rejected and escalated").toBe(true);

  const states = {} as Record<Account, StorageState>;
  for (const [key, ctx] of Object.entries({ admin, member, creator, fresh, gb, gbCheck, tray }) as [Account, BrowserContext][]) states[key] = await ctx.storageState();
  mkdirSync(path.dirname(SETUP_FILE), { recursive: true });
  writeFileSync(SETUP_FILE, JSON.stringify({ runKey: RUN_KEY, stamp, states, handles, creationId, projectId, escalation } satisfies Setup));
  record((m) =>
    m.notes.push({
      label: "setup",
      data: {
        accounts: handles,
        creationId,
        projectId,
        records: [
          "the seeded member made one demo image from Velvet Hour and one in the project's first scene, and favorited the first",
          "the project 'Golden hour series' has two scenes",
          "one template report (Mirror Glow) and one public takedown request",
          "one scanner escalation from a throwaway account (the dev scanner's drill fixture); that account is suspended",
          "the tray member has 40 granted credits",
        ],
      },
    }),
  );
  for (const ctx of contexts) await ctx.close();
});

// ── Captures, grouped by role so records one group creates do not change an earlier group's pages ─────

type Group = { title: string; run: (s: Shooter, setup: Setup) => Promise<void> };

const GROUPS: Group[] = [
  {
    title: "admin",
    run: async (s, setup) => {
      const role = "admin";
      const page = await s.signedIn(setup.states.admin);
      await s.attempt("/admin", role, () => s.visit(page, "/admin", role, "admin"), page);
      await s.attempt("/admin/review", role, () => s.visit(page, "/admin/review", role, "abuse review"), page);
      await s.attempt("/admin/review with the confirm-report form open", role, async () => {
        await page.goto("/admin/review");
        await settle(page);
        const confirm = page.getByRole("button", { name: "Confirm and record report" }).first();
        await expect(confirm, "an open scanner match to act on").toBeVisible();
        await confirm.click();
        await expect(page.getByLabel("Report reference").first()).toBeVisible();
        await s.shot(page, { route: "/admin/review", role, state: "abuse review, confirm-report form open" });
        await page.getByRole("button", { name: "Back" }).first().click();
      }, page);
      if (tabBarShows(s.vp)) {
        await s.attempt("You sheet (admin)", role, async () => {
          await page.goto("/admin");
          await settle(page);
          await openYouSheet(page);
          await s.shot(page, { route: "/admin", role, state: "You sheet open", fullPage: false });
        }, page);
      } else s.notCaptured("You sheet (admin)", role, "not applicable: at 1024 px and wider the tab bar is hidden and the rail shows every link, so there is no You sheet");
    },
  },
  {
    title: "creator (owner of a profile)",
    run: async (s, setup) => {
      const role = "creator";
      const page = await s.signedIn(setup.states.creator);
      await s.attempt("/creators/lunavelour as its owner", role, () => s.visit(page, "/creators/lunavelour", role, "own creator page (manage and analytics)"), page);
    },
  },
  {
    title: "member",
    run: async (s, setup) => {
      const role = "member";
      const page = await s.signedIn(setup.states.member);
      const pages: [string, string, { expectPath?: string | null; expectStatus?: number | null }?][] = [
        ["/", "home"],
        ["/explore", "explore"],
        ["/templates/velvet-hour", "template"],
        ["/creators/lunavelour", "creator page (following)"],
        [`/creators/${setup.handles.member}`, "own profile (a member, not a creator)", { expectStatus: null }],
        ["/generate/image", "create image"],
        ["/generate/video", "create video"],
        ["/collection", "library"],
        [`/collection/${setup.creationId}`, "creation detail"],
        ["/favorites", "favorites, templates"],
        ["/favorites?tab=creations", "favorites, creations"],
        ["/projects", "projects"],
        [`/projects/${setup.projectId}`, "project"],
        ["/studio", "studio"],
        ["/train", "train"],
        ["/settings", "settings"],
        ["/pricing", "pricing"],
        ["/policies", "policies"],
        ["/policies/takedown", "takedown form (signed in)"],
        ["/no-such-page", "not found", { expectPath: null, expectStatus: 404 }],
      ];
      for (const [route, state, opts] of pages) await s.attempt(route, role, () => s.visit(page, route, role, state, opts), page);

      if (tabBarShows(s.vp)) {
        await s.attempt("You sheet (member)", role, async () => {
          await page.goto("/");
          await settle(page);
          await openYouSheet(page);
          await s.shot(page, { route: "/", role, state: "You sheet open", fullPage: false });
        }, page);
      } else s.notCaptured("You sheet (member)", role, "not applicable: at 1024 px and wider the tab bar is hidden and the rail shows every link, so there is no You sheet");

      await s.attempt("Library: More filters sheet", role, async () => {
        await page.goto("/collection");
        await settle(page);
        await page.getByRole("button", { name: /More filters/ }).click();
        await expect(page.getByRole("dialog", { name: "More filters" })).toBeVisible();
        await s.shot(page, { route: "/collection", role, state: "library, More filters sheet open", fullPage: false });
      }, page);
    },
  },
  {
    title: "fresh member (empty states)",
    run: async (s, setup) => {
      const role = "fresh-member";
      const page = await s.signedIn(setup.states.fresh);
      const pages: [string, string][] = [
        ["/", "home, nothing made or saved yet"],
        ["/collection", "library, empty"],
        ["/favorites", "favorites, templates, empty"],
        ["/favorites?tab=creations", "favorites, creations, empty"],
        ["/projects", "projects, empty"],
        ["/studio", "studio, no presets or jobs"],
        ["/train", "train, no characters"],
        ["/pricing", "pricing, no credits or history"],
        ["/settings", "settings"],
      ];
      for (const [route, state] of pages) await s.attempt(route, role, () => s.visit(page, route, role, state), page);
    },
  },
  {
    title: "anonymous in GB",
    run: async (s) => {
      const role = "anonymous-gb";
      const page = await s.anonymous(GB);
      const pages: [string, string][] = [
        ["/", "home, previews withheld"],
        ["/explore", "explore, previews withheld"],
        ["/templates/velvet-hour", "template, preview withheld"],
        ["/creators/lunavelour", "creator page, previews withheld"],
      ];
      for (const [route, state] of pages) await s.attempt(route, role, () => s.visit(page, route, role, state), page);
    },
  },
  {
    title: "GB member, not age verified",
    run: async (s, setup) => {
      const role = "gb-member-unverified";
      const page = await s.signedIn(setup.states.gb, { extraHTTPHeaders: GB });
      const pages: [string, string][] = [
        ["/", "home, previews withheld until verified"],
        ["/templates/velvet-hour", "template, preview withheld until verified"],
        ["/creators/lunavelour", "creator page, previews withheld until verified"],
        ["/settings", "settings, age check required"],
      ];
      for (const [route, state] of pages) await s.attempt(route, role, () => s.visit(page, route, role, state), page);
      await s.attempt("/generate/image: Make it refused until verified", role, async () => {
        await page.goto("/generate/image");
        await settle(page);
        await page.getByLabel("Prompt", { exact: true }).fill(PROMPT);
        const refused = page.waitForResponse((r) => r.url().endsWith("/api/generations") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Make it" }).click();
        expect((await refused).status(), "make is refused with 451").toBe(451);
        await expect(page.getByRole("alert").filter({ hasText: "age check" }).first()).toBeVisible();
        await s.shot(page, { route: "/generate/image", role, state: "create, Make it refused (age check required)" });
      }, page);

      // A second unverified GB member starts the sandbox check, so the first one's Settings stay "Not verified".
      const checker = await s.signedIn(setup.states.gbCheck, { extraHTTPHeaders: GB });
      await s.attempt("/verify/sandbox: the sandbox age check", role, async () => {
        await checker.goto("/settings#age-verification");
        await settle(checker);
        await checker
          .locator("#age-verification")
          .getByRole("button", { name: /Verify now|Continue the check|Verify again/ })
          .click();
        await expect(checker).toHaveURL(/\/verify\/sandbox\?ref=sbx_/);
        await expect(checker.getByRole("heading", { name: "This is a sandbox age check." })).toBeVisible();
        await settle(checker);
        await s.shot(checker, { route: "/verify/sandbox", role, state: "sandbox age check (labeled, proves nothing)" });
      }, checker);
    },
  },
  {
    title: "anonymous",
    run: async (s) => {
      const role = "anonymous";
      await s.attempt("age gate", role, async () => {
        const gate = await s.page(await s.context());
        const res = await gate.goto("/");
        await expect(gate.getByRole("heading", { name: "Adults only" })).toBeVisible();
        await settle(gate);
        await s.shot(gate, { route: "/", role: "anonymous-first-visit", state: "age gate", status: res?.status() ?? null });
      });
      const page = await s.anonymous();
      const pages: [string, string, { expectPath?: string | null; expectStatus?: number | null }?][] = [
        ["/", "home"],
        ["/explore", "explore"],
        ["/templates/velvet-hour", "template"],
        ["/creators/lunavelour", "creator page"],
        ["/generate/image", "create image (signed out)"],
        ["/generate/video", "create video (signed out)"],
        ["/auth", "join"],
        ["/auth?mode=signin", "sign in"],
        ["/pricing", "pricing"],
        ["/policies", "policies"],
        ["/policies/takedown", "takedown form"],
        ["/offline", "offline page (visited directly)"],
        ["/no-such-page", "not found", { expectPath: null, expectStatus: 404 }],
      ];
      for (const [route, state, opts] of pages) await s.attempt(route, role, () => s.visit(page, route, role, state, opts), page);

      await s.attempt("/policies/takedown: filled in, then sent", role, async () => {
        await page.goto("/policies/takedown");
        await settle(page);
        await page.getByRole("radio", { name: "An intimate image or video of me shared without my consent" }).check();
        await page.getByLabel("Where is it?").fill(`${BASE}/templates/velvet-hour`);
        await page.getByLabel("Your email").fill(`visual-${s.vp.name}@example.test`);
        await page.getByLabel("Anything that helps us find it (optional)").fill("Visual review capture: a sample request.");
        await page.getByLabel(/I believe in good faith/).check();
        await s.shot(page, { route: "/policies/takedown", role, state: "takedown form, filled in" });
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("status").filter({ hasText: "We have your request" })).toBeVisible();
        await s.shot(page, { route: "/policies/takedown", role, state: "takedown form, sent" });
      }, page);

      // Signed out, private pages redirect to sign-in and operator pages are the not-found page: recorded, and
      // captured once as /auth and as the not-found page above.
      if (s.vp.name === "phone") {
        const redirects: Record<string, { status: number; location: string | null }> = {};
        for (const route of ["/collection", `/collection/00000000-0000-4000-8000-000000000000`, "/favorites", "/projects", "/studio", "/train", "/settings", "/pricing/sandbox", "/verify/sandbox?ref=x", "/admin", "/admin/review"]) {
          const res = await page.request.get(route, { maxRedirects: 0 });
          redirects[route] = { status: res.status(), location: res.headers()["location"] ?? null };
        }
        record((m) => m.notes.push({ label: "signed-out requests for private and operator pages (not captured separately: they are the sign-in page or the not-found page)", data: redirects }));
      }
    },
  },
  {
    title: "create flow: create panel, cost sheet, job tray, upload consent, sandbox checkout",
    run: async (s, setup) => {
      const role = "member-creating";
      // The tray is the page's one poller. Its active list is frozen at the first non-empty real answer, so the
      // tray stays on screen for the capture however fast the demo worker finishes.
      const page = await s.signedIn(setup.states.tray, { serviceWorkers: "block" });
      let frozen: string | null = null;
      await page.route(
        (url) => url.pathname === "/api/generations" && url.searchParams.get("active") === "1",
        async (route: Route) => {
          if (frozen) return route.fulfill({ status: 200, contentType: "application/json", body: frozen });
          const res = await route.fetch();
          const body = await res.text();
          try {
            if (((JSON.parse(body) as { items?: unknown[] }).items ?? []).length) frozen = body;
          } catch {
            // Not JSON: pass it through.
          }
          return route.fulfill({ response: res, body });
        },
      );
      await s.attempt("create panel with a prompt", role, async () => {
        await page.goto("/generate/image");
        await settle(page);
        await page.getByLabel("Prompt", { exact: true }).fill(PROMPT);
        await settle(page);
        await s.shot(page, { route: "/generate/image", role, state: "create panel, prompt filled in" });
      }, page);
      await s.attempt("cost sheet", role, async () => {
        await page.getByRole("button", { name: "Make it" }).click();
        await expect(page.getByRole("dialog", { name: "Ready to make this?" })).toBeVisible();
        await expect(page.getByTestId("confirm-cost")).toBeVisible();
        await s.shot(page, { route: "/generate/image", role, state: "cost sheet open", fullPage: false });
      }, page);
      await s.attempt("job tray", role, async () => {
        await page.getByTestId("confirm-make").click();
        const tray = page.getByRole("region", { name: "Creations in progress" });
        await expect(tray).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("dialog", { name: "Ready to make this?" })).toBeHidden();
        await s.shot(page, { route: "/generate/image", role, state: "job tray open", fullPage: false, note: "the tray's poll is frozen at its first non-empty real answer (a real queued job) so it stays on screen" });
        await tray.getByRole("button").first().click();
        await expect(tray.getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
        await s.shot(page, { route: "/generate/image", role, state: "job tray collapsed", fullPage: false, note: "the tray's poll is frozen at its first non-empty real answer (a real queued job) so it stays on screen" });
      }, page);
      await s.attempt("upload consent sheet", role, async () => {
        await page.goto("/generate/image");
        await settle(page);
        await page.getByRole("radio", { name: "Image to image" }).click();
        await page.getByTestId("upload-input").setInputFiles({ name: "harmless.png", mimeType: "image/png", buffer: await cleanPng() });
        const sheet = page.getByRole("dialog", { name: "Before you upload" });
        await expect(sheet).toBeVisible();
        await s.shot(page, { route: "/generate/image", role, state: "upload consent sheet open", fullPage: false });
        await sheet.getByRole("button", { name: "Close" }).click();
        await expect(sheet).toBeHidden();
      }, page);
      await s.attempt("pricing sandbox checkout", role, async () => {
        await page.goto("/pricing");
        await settle(page);
        await page.getByRole("heading", { name: smallestPack.label, exact: true, level: 3 }).locator("..").getByRole("button", { name: /^Buy/ }).click();
        await expect(page).toHaveURL(/\/pricing\/sandbox\?t=/);
        await expect(page.getByRole("heading", { name: "This is a sandbox. No money moves." })).toBeVisible();
        await settle(page);
        await s.shot(page, { route: "/pricing/sandbox", role, state: `sandbox checkout (${smallestPack.label} pack)` });
      }, page);
    },
  },
  {
    title: "loading skeletons",
    run: async (s, setup) => {
      const role = "member";
      // No service worker, so page.route sees the client-side navigation's RSC request.
      const page = await s.signedIn(setup.states.member, { serviceWorkers: "block" });
      // RouteLoading (src/components/route-loading.tsx): role=status with a visually hidden "Loading…".
      const routeLoading = page.locator("main [role=status]").filter({ hasText: "Loading" });
      const names: Record<string, string> = { "/": "home", "/explore": "explore", "/collection": "library", "/projects": "projects", "/favorites": "favorites" };
      for (const target of Object.keys(names)) {
        await s.attempt(`loading skeleton for ${target}`, role, async () => {
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          let prefetched = false;
          let held = 0;
          const matches = (url: URL) => url.pathname === target && url.searchParams.has("_rsc");
          const handler = async (route: Route) => {
            const headers = await route.request().allHeaders();
            if (headers["next-router-prefetch"]) {
              const res = await route.fetch();
              prefetched = true;
              await route.fulfill({ response: res });
              return;
            }
            held++;
            await gate;
            await route.continue().catch(() => undefined);
          };
          await page.route(matches, handler);
          try {
            // Start somewhere with a link to the target (the rail, the tab bar, the You sheet or the home page).
            let link = null as ReturnType<Page["locator"]> | null;
            for (const start of ["/policies", "/"]) {
              if (start === target) continue;
              await page.goto(start);
              await settle(page);
              link = await visibleLinkTo(page, target);
              if (!link && tabBarShows(s.vp) && (target === "/projects" || target === "/favorites")) {
                await openYouSheet(page);
                link = await visibleLinkTo(page, target);
              }
              if (link) break;
            }
            if (!link) throw new Error(`no visible link to ${target} on /policies or /`);
            // The loading state comes from the link's prefetch (dynamic pages prefetch down to loading.tsx).
            if (!prefetched) await link.hover().catch(() => undefined);
            await expect.poll(() => prefetched, { timeout: 10_000, message: `prefetch of ${target}` }).toBe(true);
            await link.click();
            await expect(page.locator("dialog[open]")).toHaveCount(0);
            await expect(routeLoading).toHaveCount(1, { timeout: 10_000 });
            await expect(routeLoading.locator(".skeleton").first()).toBeVisible();
            expect(held, "the navigation request is held").toBeGreaterThan(0);
            await page.evaluate(() => window.scrollTo(0, 0));
            await s.shot(page, { route: target, role, state: `${names[target]} loading skeleton`, note: "client-side navigation with its RSC request held by page.route until the capture is done" });
          } finally {
            release();
            await page.unroute(matches, handler);
          }
          await expect(routeLoading).toHaveCount(0, { timeout: 20_000 });
          expect(new URL(page.url()).pathname).toBe(target);
        }, page);
      }
    },
  },
  {
    title: "offline",
    run: async (s, setup) => {
      const role = "member";
      const ctx = await s.context({ storageState: setup.states.member });
      const page = await s.page(ctx);
      await s.attempt("offline banner and the offline page", role, async () => {
        await page.goto("/explore");
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready;
        });
        await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true);
        await page.goto("/generate/image");
        await settle(page);
        await ctx.setOffline(true);
        await expect(page.getByRole("status").filter({ hasText: OFFLINE_LINE }).first()).toBeVisible();
        await s.shot(page, { route: "/generate/image", role, state: "offline banner on a loaded page" });
        await page.goto("/explore");
        await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
        await s.shot(page, { route: "/explore", role, state: "offline page (service worker fallback)", note: "context.setOffline(true) after the service worker took control" });
      }, page);
      await ctx.setOffline(false);
    },
  },
];

/** The first visible link on the page whose path is the target, if any. */
async function visibleLinkTo(page: Page, target: string) {
  const index = await page.evaluate((t) => {
    const links = Array.from(document.querySelectorAll("a[href]"));
    return links.findIndex((a) => {
      const r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(a).visibility === "hidden") return false;
      try {
        return new URL((a as HTMLAnchorElement).href).pathname === t;
      } catch {
        return false;
      }
    });
  }, target);
  return index < 0 ? null : page.locator("a[href]").nth(index);
}

for (const group of GROUPS) {
  for (const vp of VIEWPORTS) {
    test(`${group.title} at ${vp.width}x${vp.height}`, async ({ browser }) => {
      test.setTimeout(15 * 60_000);
      const setup = loadSetup();
      const shooter = new Shooter(browser, vp, `${group.title} at ${vp.width}x${vp.height}`);
      try {
        await group.run(shooter, setup);
      } finally {
        await shooter.finish();
      }
    });
  }
}

test("not captured: states with no way to reach them", async () => {
  record((m) => {
    const add = (what: string, reason: string) => {
      if (!m.notCaptured.some((n) => n.what === what)) m.notCaptured.push({ what, viewport: "all", role: "all", reason });
    };
    add("src/app/error.tsx (the route error boundary)", "no page throws on demand in the production build, and making one throw would mean changing app code for the capture");
  });
});
