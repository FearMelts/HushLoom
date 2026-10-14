import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";

/**
 * Evidence capture for the e2e journeys (run plan): named screenshots, and a JSON record per test of
 * every console error, page error, failed request and 4xx/5xx response seen by the pages it watches,
 * plus notes for checks made outside a page (API calls through a request context, manifest and
 * header checks). Each test declares what it expects (the 451 of an age check, the generic 403 of a
 * rejected upload); at the end the fixture asserts that no undeclared console error, page error or 5xx
 * response happened. Failed requests and 4xx responses are recorded but not asserted: the JSON says so.
 *
 * Files go to E2E_SHOTS_DIR (default test-results/journey): "<name>.png" for screenshots and
 * "<test title slug>.json" for the log.
 */
export const SHOTS_DIR = path.resolve(process.env.E2E_SHOTS_DIR ?? "test-results/journey");
export const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;

type Kind = "console" | "pageerror" | "requestfailed" | "response";

/** Something the test expects to see. Every given field must match; `why` is written into the JSON. */
export type Allowance = {
  kind?: Kind | Kind[];
  /** Substring of, or pattern for, the request URL (for console errors: the URL the message points at). */
  url?: string | RegExp;
  status?: number | number[];
  method?: string;
  /** The request's resource type ("document", "fetch", "image", ...), for failed requests and responses. */
  resourceType?: string | string[];
  /** Pattern for the console text, page error message or request failure text. */
  text?: string | RegExp;
  why: string;
};

/** A check made outside a watched page (an API response, a header, a manifest), written into the JSON. */
type Note = { at: string; label: string; data: unknown };

type Entry = {
  kind: Kind;
  page: string;
  at: string;
  url: string | null;
  method?: string;
  status?: number;
  resourceType?: string;
  text?: string;
  expected: boolean;
  why?: string;
};

// Failed requests are not asserted (only console errors, page errors and 5xx are). These two kinds of
// cancellation are labelled as expected because they are what a navigation does to in-flight work; any
// other failed request stays undeclared in the JSON, so a reader sees it rather than a blanket "expected".
const BUILT_IN: Allowance[] = [
  {
    kind: "requestfailed",
    resourceType: "fetch",
    url: /[?&]_rsc=/,
    text: "net::ERR_ABORTED",
    why: "a Next.js link prefetch (?_rsc=) cancelled because the page navigated away",
  },
  {
    kind: "requestfailed",
    resourceType: ["image", "media", "script", "font", "stylesheet"],
    text: "net::ERR_ABORTED",
    why: "an image, media, script or font load cancelled because the page navigated away",
  },
];

const asList = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const matches = (pattern: string | RegExp | undefined, value: string | null | undefined) =>
  pattern === undefined || (value != null && (typeof pattern === "string" ? value.includes(pattern) : pattern.test(value)));

export function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

export class Evidence {
  private readonly entries: Entry[] = [];
  private readonly allowances: Allowance[] = [...BUILT_IN];
  private readonly shots: string[] = [];
  private readonly notes: Note[] = [];
  private readonly contexts: BrowserContext[] = [];
  private readonly watched = new WeakSet<Page>();
  private pageCount = 0;
  private recording = true;

  constructor(private readonly info: TestInfo) {
    mkdirSync(SHOTS_DIR, { recursive: true });
  }

  /** Declares responses, console errors or failures this test expects. */
  allow(...allowances: Allowance[]) {
    this.allowances.push(...allowances);
  }

  /**
   * Records a check made outside a watched page (an API response, headers, a manifest body) in the JSON
   * and the report, so the evidence directory shows what was verified, not only what pages saw.
   */
  note(label: string, data: unknown) {
    this.notes.push({ at: new Date().toISOString(), label, data });
  }

  /** Attaches the listeners to a page. Safe to call twice. */
  watch(page: Page, label?: string): Page {
    if (this.watched.has(page)) return page;
    this.watched.add(page);
    const name = label ?? `page-${++this.pageCount}`;
    const push = (e: Omit<Entry, "page" | "at" | "expected">) => {
      if (this.recording) this.entries.push({ ...e, page: name, at: new Date().toISOString(), expected: false });
    };
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      push({ kind: "console", url: msg.location().url || null, text: msg.text() });
    });
    page.on("pageerror", (err) => push({ kind: "pageerror", url: page.url(), text: `${err.name}: ${err.message}` }));
    page.on("requestfailed", (req) => push({ kind: "requestfailed", url: req.url(), method: req.method(), resourceType: req.resourceType(), text: req.failure()?.errorText ?? "failed" }));
    page.on("response", (res) => {
      if (res.status() < 400) return;
      push({ kind: "response", url: res.url(), method: res.request().method(), status: res.status(), resourceType: res.request().resourceType() });
    });
    return page;
  }

  /** A new context (baseURL set) whose every page is watched. Closed by the fixture. */
  async newContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const ctx = await browser.newContext({ baseURL: BASE, ...options });
    ctx.on("page", (p) => this.watch(p));
    this.contexts.push(ctx);
    return ctx;
  }

  /** A watched page in a new context. */
  async newPage(browser: Browser, options: BrowserContextOptions = {}): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await this.newContext(browser, options);
    const page = await ctx.newPage();
    return { ctx, page: this.watch(page) };
  }

  /** Saves a named screenshot ("age-01-blocked-gb.png") into the evidence directory and attaches it to the report. */
  async shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
    const file = path.join(SHOTS_DIR, name.endsWith(".png") ? name : `${name}.png`);
    await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
    this.shots.push(file);
    await this.info.attach(path.basename(file), { path: file, contentType: "image/png" });
  }

  private classify(e: Entry): { expected: boolean; why?: string } {
    // A console "Failed to load resource: ... status of 451" belongs to the response it reports on.
    const consoleStatus = e.kind === "console" ? Number(e.text?.match(/status of (\d{3})/)?.[1] ?? NaN) : NaN;
    for (const a of this.allowances) {
      const kinds = asList(a.kind);
      const statuses = asList(a.status);
      if (e.kind === "console" && Number.isFinite(consoleStatus) && (!kinds.length || kinds.includes("response") || kinds.includes("console"))) {
        if (statuses.length && !statuses.includes(consoleStatus)) continue;
        if (!matches(a.url, e.url)) continue;
        if (a.text !== undefined && !matches(a.text, e.text)) continue;
        return { expected: true, why: a.why };
      }
      if (kinds.length && !kinds.includes(e.kind)) continue;
      const types = asList(a.resourceType);
      if (types.length && !types.includes(e.resourceType ?? "")) continue;
      if (statuses.length && (e.status === undefined || !statuses.includes(e.status))) continue;
      if (a.method && a.method.toUpperCase() !== e.method?.toUpperCase()) continue;
      if (!matches(a.url, e.url)) continue;
      if (!matches(a.text, e.text)) continue;
      return { expected: true, why: a.why };
    }
    return { expected: false };
  }

  /** Classifies everything, writes the JSON and returns what must not have happened. */
  finish(status: string): { file: string; unexpected: Entry[] } {
    this.recording = false;
    for (const e of this.entries) Object.assign(e, this.classify(e));
    const unexpected = this.entries.filter((e) => !e.expected && (e.kind === "console" || e.kind === "pageerror" || (e.kind === "response" && (e.status ?? 0) >= 500)));
    const file = path.join(SHOTS_DIR, `${slug(this.info.titlePath.slice(1).join(" "))}.json`);
    const count = (kind: Kind, expected: boolean, test: (e: Entry) => boolean = () => true) => this.entries.filter((e) => e.kind === kind && e.expected === expected && test(e)).length;
    const is5xx = (e: Entry) => (e.status ?? 0) >= 500;
    writeFileSync(
      file,
      JSON.stringify(
        {
          test: this.info.titlePath.slice(1).join(" › "),
          file: path.relative(process.cwd(), this.info.file),
          status,
          finishedAt: new Date().toISOString(),
          declared: this.allowances.map((a) => ({ ...a, url: a.url?.toString(), text: a.text?.toString() })),
          summary: {
            // Asserted: any undeclared entry here fails the test.
            asserted: {
              console: { declared: count("console", true), undeclared: count("console", false) },
              pageerror: { declared: count("pageerror", true), undeclared: count("pageerror", false) },
              response5xx: { declared: count("response", true, is5xx), undeclared: count("response", false, is5xx) },
            },
            // Recorded for the reader, not asserted.
            notAsserted: {
              requestfailed: { declared: count("requestfailed", true), undeclared: count("requestfailed", false) },
              response4xx: { declared: count("response", true, (e) => !is5xx(e)), undeclared: count("response", false, (e) => !is5xx(e)) },
            },
            assertedUnexpected: unexpected.length,
          },
          screenshots: this.shots.map((s) => path.basename(s)),
          notes: this.notes,
          entries: this.entries,
        },
        null,
        2,
      ),
    );
    return { file, unexpected };
  }

  async close() {
    for (const ctx of this.contexts) await ctx.close().catch(() => undefined);
  }
}

/**
 * `evidence` fixture: one Evidence per test. After the test body it writes the JSON, closes the
 * contexts it made, and (when the test itself passed) asserts there were no unexpected console
 * errors, page errors or 5xx responses.
 */
export const test = base.extend<{ evidence: Evidence }>({
  // The fixture callback is named `provide`, not `use`, so React's hook lint rule does not mistake it for a hook.
  evidence: async ({}, provide, testInfo) => {
    const ev = new Evidence(testInfo);
    await provide(ev);
    const { file, unexpected } = ev.finish(testInfo.status ?? "unknown");
    await ev.close();
    await testInfo.attach("errors.json", { path: file, contentType: "application/json" });
    if (testInfo.status === testInfo.expectedStatus) {
      expect(unexpected, `unexpected console errors, page errors or 5xx responses (see ${path.basename(file)})`).toEqual([]);
    }
  },
});

export { expect };
