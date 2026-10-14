import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// The client components render on the server here, as Next does for the first paint; they only need a router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { CreationDetail } from "@/components/creation-detail";
import { CreatorManage } from "@/components/creator-manage";
import { ProjectsIndex, ProjectWorkspace } from "@/components/projects";
import { MODELS, type ModelSpec } from "@/server/ai/registry";
import { registerAdapter } from "@/server/ai/providers";
import type { ProviderAdapter } from "@/server/ai/providers/types";
import type { SessionUser } from "@/server/auth/session";
import { creatorAnalytics } from "@/server/creators";
import { closeDb, getDb } from "@/server/db";
import { generationJobs } from "@/server/db/schema";
import { processJob } from "@/server/generation/processor";
import { confirmJob, createDraft } from "@/server/generation/service";
import type { CreationListItem } from "@/server/generation/views";
import { createProject, getProjectDetail, listProjects } from "@/server/projects";
import { closeRedis } from "@/server/redis";
import { publishTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

// Every place that shows demo media says Demo, and nothing else does (D2); media withheld for an age check
// says so instead of looking like an empty project (D3).

// A model that is not a demo, so a non-demo creation exists to compare against.
const realAdapter: ProviderAdapter = {
  key: "labels-real",
  isDemo: false,
  isConfigured: () => true,
  async execute(_req, c) {
    await c.onProviderJobId("labels-real-1");
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#446688", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).webp().toBuffer();
    return [{ mime: "image/webp", bytes, width: 256, height: 256 }];
  },
};
MODELS.push({ ...MODELS[0]!, key: "labels-real-still", providerKey: "labels-real", displayName: "Real still" } satisfies ModelSpec);
registerAdapter(realAdapter);

const ctx = { country: null };

async function finished(user: SessionUser, overrides: Record<string, unknown> = {}) {
  const draft = await createDraft(
    user,
    { idempotencyKey: key(), mode: "text_to_image", modelKey: "demo-still", prompt: "an adult couple sharing a toast by candlelight", negativePrompt: "", params: { aspectRatio: "1:1" }, inputAssetIds: [], ...overrides },
    ctx,
  );
  await confirmJob(user, draft.id, draft.costCredits);
  await processJob(draft.id);
  const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
  expect(job!.status).toBe("completed");
  return job!;
}

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

/** The element that starts at the first match of `start`, through its matching close tag. */
function element(html: string, start: string | RegExp): string {
  const at = typeof start === "string" ? html.indexOf(start) : html.search(start);
  if (at < 0) throw new Error(`not rendered: ${start}`);
  const tag = /^<([a-z0-9]+)/.exec(html.slice(at))![1]!;
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = at;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(at, m.index + m[0].length);
  }
  throw new Error(`unclosed: ${start}`);
}

/** The element carrying this aria-label (or one that starts with it). */
const labelled = (html: string, label: string) => element(html, new RegExp(`<[a-z]+[^>]*aria-label="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

const DEMO_BADGE = /bg-iris-400 text-ink-950">Demo<\/span>/g;
const demoBadges = (html: string) => html.match(DEMO_BADGE)?.length ?? 0;
const WITHHELD = "Verify your age to see this";
const CLAPPERBOARD = "lucide-clapperboard";

const at = new Date().toISOString();
function creation(id: string, isDemo: boolean, over: Partial<CreationListItem> = {}): CreationListItem {
  return {
    id,
    status: "completed",
    mode: "text_to_video",
    modelKey: isDemo ? "demo-motion" : "labels-real-motion",
    prompt: "a quiet lakeside cabin at dusk",
    isDemo,
    createdAt: at,
    queuedAt: at,
    startedAt: at,
    finishedAt: at,
    failureMessage: null,
    costCredits: 9,
    templateTitle: null,
    projectId: "00000000-0000-4000-8000-000000000001",
    relation: null,
    output: { assetId: `asset-${id}`, kind: "video", url: `/api/media?k=${id}`, posterUrl: `/api/media?k=${id}-poster`, width: 1280, height: 720, mediaWithheld: false },
    isFavorited: false,
    ...over,
  };
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("Play sequence (D2a)", () => {
  const workspace = (first: CreationListItem, second: CreationListItem): ComponentProps<typeof ProjectWorkspace>["data"] => ({
    project: { id: "00000000-0000-4000-8000-000000000001", title: "Golden hour", description: "", updatedAt: at },
    scenes: [first, second].map((c, i) => ({
      id: `00000000-0000-4000-8000-00000000001${i}`,
      position: i,
      title: `Scene ${i + 1}`,
      continuity: {},
      versions: [{ id: `v${i}`, parentVersionId: null, branchLabel: "A", isSelected: true, createdAt: at, creation: c }],
    })),
    loose: [],
  });
  // The sheet keeps its content in the page while closed, so the first clip of the sequence is in the markup.
  const player = (data: ComponentProps<typeof ProjectWorkspace>["data"]) => element(render(createElement(ProjectWorkspace, { data, characters: [] })), '<dialog aria-label="Sequence"');

  it("labels a demo clip as Demo", () => {
    const sheet = player(workspace(creation("c1", true), creation("c2", false)));
    expect(sheet).toContain('src="/api/media?k=c1"');
    expect(demoBadges(sheet)).toBe(1);
  });

  it("does not label a clip that is not a demo", () => {
    const sheet = player(workspace(creation("c2", false), creation("c1", true)));
    expect(sheet).toContain('src="/api/media?k=c2"');
    expect(demoBadges(sheet)).toBe(0);
  });
});

describe("creation detail Versions strip (D2c)", () => {
  const details = { prompt: "p", negativePrompt: "", params: { aspectRatio: "16:9" }, modeLabel: "Text to video", modelName: "Demo Motion", modelOutput: "video" as const, usedPersonalMedia: false, attempts: 1, providerJobId: null, template: null, project: null, relation: null };
  const page = (item: CreationListItem, versions: CreationListItem[]) =>
    render(createElement(CreationDetail, { item, details, versions, folders: [], categories: [], balance: 20 }));

  it("labels each demo version's thumbnail, and only those", () => {
    const item = creation("orig", false);
    const html = page(item, [item, creation("var", true, { relation: "variation" }), creation("ret", false, { relation: "retry" }), creation("fail", true, { relation: "extension", status: "failed", output: null })]);
    const demoThumb = labelled(html, "Compare with variation");
    expect(demoBadges(demoThumb)).toBe(1);
    // The button's name replaces its content for a screen reader, so the name says it too.
    expect(demoThumb).toContain('aria-label="Compare with variation, demo media"');
    expect(demoBadges(labelled(html, "Compare with retry"))).toBe(0);
    expect(labelled(html, "Compare with retry")).toContain('aria-label="Compare with retry"');
    expect(demoBadges(labelled(html, "This version"))).toBe(0);
    // A failed demo job has no media to label.
    expect(demoBadges(labelled(html, "Compare with extension"))).toBe(0);
  });

  it("labels the current version's thumbnail when it is a demo", () => {
    const item = creation("orig", true);
    const html = page(item, [item, creation("ret", false, { relation: "retry" })]);
    expect(demoBadges(labelled(html, "This version"))).toBe(1);
    expect(demoBadges(labelled(html, "Compare with retry"))).toBe(0);
  });
});

describe("creator Manage tab (D2d)", () => {
  it("sends isDemo for each template, from the model of its current version", async () => {
    const creator = await makeUser({ credits: 50 });
    const demo = await publishTemplate(creator, { jobId: (await finished(creator)).id, title: "Demo Toast", description: "", tags: [], isVip: false });
    const real = await publishTemplate(creator, { jobId: (await finished(creator, { modelKey: "labels-real-still" })).id, title: "Real Toast", description: "", tags: [], isVip: false });
    const rows = await creatorAnalytics(creator.id, true);
    expect(rows.map((r) => [r.id, r.isDemo]).sort()).toEqual([[demo.id, true], [real.id, false]].sort());
  });

  it("labels a demo template's row, and only that row, at both layouts", () => {
    const row = (id: string, title: string, isDemo: boolean) => ({
      id, slug: id, title, description: "", status: "published", isVip: false, mediaType: "image", version: 1, posterUrl: `/api/media?k=${id}`, isDemo,
      favorites: 0, generations: 0, rating: null, ratingCount: 0, views30: 0, generations30: 0, prompt: "p",
    });
    const html = render(createElement(CreatorManage, { rows: [row("demo-t", "Demo Toast", true), row("real-t", "Real Toast", false)] }));
    const phone = element(html, '<ul class="divide-y');
    const desk = element(html, "<table");
    for (const layout of [phone, desk]) {
      const demoRow = element(layout, layout === phone ? /<li[^>]*>(?=(?:(?!<\/li>).)*Demo Toast)/s : /<tr[^>]*>(?=(?:(?!<\/tr>).)*Demo Toast)/s);
      const realRow = element(layout, layout === phone ? /<li[^>]*>(?=(?:(?!<\/li>).)*Real Toast)/s : /<tr[^>]*>(?=(?:(?!<\/tr>).)*Real Toast)/s);
      expect(demoBadges(demoRow)).toBe(1);
      expect(demoBadges(realRow)).toBe(0);
    }
  });
});

describe("withheld project media (D3)", () => {
  it("shows the age-check cover, not the empty-project icon, on the index and the scene tiles", async () => {
    const user = await makeUser({ credits: 50 });
    const withMedia = await createProject(user.id, { title: "Golden hour", description: "" });
    const empty = await createProject(user.id, { title: "Not started", description: "" });
    const detail = await getProjectDetail(user.id, withMedia.id, { explicitAllowed: true });
    await finished(user, { projectId: withMedia.id, sceneId: detail.scenes[0]!.id });

    const projects = await listProjects(user.id, { explicitAllowed: false });
    expect(projects.find((p) => p.id === withMedia.id)!.cover).toMatchObject({ url: null, mediaWithheld: true });
    const index = render(createElement(ProjectsIndex, { projects }));
    const tile = element(index, `<a class="group block" href="/projects/${withMedia.id}"`);
    expect(tile).toContain(WITHHELD);
    expect(tile).not.toContain(CLAPPERBOARD);
    // A project with nothing in it yet keeps its own placeholder.
    const emptyTile = element(index, `<a class="group block" href="/projects/${empty.id}"`);
    expect(emptyTile).toContain(CLAPPERBOARD);
    expect(emptyTile).not.toContain(WITHHELD);

    const data = await getProjectDetail(user.id, withMedia.id, { explicitAllowed: false });
    const workspace = render(createElement(ProjectWorkspace, { data, characters: [] }));
    const sceneTile = labelled(workspace, "01 ");
    expect(sceneTile).toContain(WITHHELD);
    expect(sceneTile).not.toContain(CLAPPERBOARD);
    // The withheld cover carries no link: the tile is already a button.
    expect(sceneTile).not.toContain("<a ");
  });

  it("still shows the media itself to a viewer who may see it", async () => {
    const user = await makeUser({ credits: 50 });
    const project = await createProject(user.id, { title: "Golden hour", description: "" });
    const detail = await getProjectDetail(user.id, project.id, { explicitAllowed: true });
    await finished(user, { projectId: project.id, sceneId: detail.scenes[0]!.id });
    const index = render(createElement(ProjectsIndex, { projects: await listProjects(user.id, { explicitAllowed: true }) }));
    const tile = element(index, `<a class="group block" href="/projects/${project.id}"`);
    expect(tile).toContain("<img ");
    expect(tile).not.toContain(WITHHELD);
    expect(demoBadges(tile)).toBe(1);
  });
});
