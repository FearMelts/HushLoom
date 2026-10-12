import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { CreatePanel, type CreatePrefill } from "@/components/create-panel";
import { getCurrentUser } from "@/server/auth/session";
import { createContext } from "@/server/create-context";
import { getDb } from "@/server/db";
import { generationJobs, projectScenes, projects } from "@/server/db/schema";
import type { GenerationMode } from "@/server/ai/registry";
import { ButtonLink } from "@/components/ui";
import { isUuid } from "@/lib/ids";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ kind: string }> }) {
  return { title: (await params).kind === "video" ? "Make a video" : "Make an image" };
}

/** Builds a prefill from ?from=<jobId> (remix / reuse settings) or ?scene=<sceneId> (project continuity). */
async function prefillFor(userId: string | undefined, sp: Record<string, string | undefined>): Promise<CreatePrefill | undefined> {
  if (!userId) return undefined;
  const db = getDb();
  if (isUuid(sp.from)) {
    const [job] = await db
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.id, sp.from), eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt)));
    if (job) {
      const withoutSeed = Object.fromEntries(Object.entries(job.params).filter(([k]) => k !== "seed"));
      return {
        mode: job.inputAssetIds.length ? undefined : (job.mode as GenerationMode),
        modelKey: job.modelKey,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        params: sp.reuse === "exact" ? job.params : withoutSeed,
        projectId: job.projectId ?? undefined,
        sceneId: job.sceneId ?? undefined,
      };
    }
  }
  if (isUuid(sp.scene)) {
    const [row] = await db
      .select({ scene: projectScenes, project: projects })
      .from(projectScenes)
      .innerJoin(projects, eq(projects.id, projectScenes.projectId))
      .where(and(eq(projectScenes.id, sp.scene), eq(projects.userId, userId)));
    if (row) {
      const c = row.scene.continuity;
      const note = [c.lighting && `${c.lighting} lighting`, c.framing && `${c.framing} framing`, c.palette && `${c.palette} palette`, c.notes].filter(Boolean).join(", ");
      return {
        prompt: note ? `${row.scene.title}. ${note}` : row.scene.title,
        params: { ...(c.lighting ? { lighting: c.lighting } : {}), ...(c.framing ? { framing: c.framing } : {}) },
        projectId: row.project.id,
        sceneId: row.scene.id,
        continuityNote: note || undefined,
      };
    }
  }
  return undefined;
}

export default async function GeneratePage({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { kind } = await params;
  if (kind !== "image" && kind !== "video") notFound();
  const sp = await searchParams;
  const user = await getCurrentUser();
  const [ctx, prefill] = await Promise.all([createContext(user), prefillFor(user?.id, sp)]);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="tag text-ember-400">{prefill?.sceneId ? "Project scene" : sp.from ? "Remix" : "From scratch"}</p>
          <h1 className="font-display text-4xl">{kind === "video" ? "Make a video" : "Make an image"}</h1>
        </div>
        <div className="flex gap-2">
          <ButtonLink href={kind === "video" ? "/generate/image" : "/generate/video"} size="sm" variant="ghost">
            {kind === "video" ? "Image instead" : "Video instead"}
          </ButtonLink>
          <ButtonLink href="/explore" size="sm" variant="quiet">
            Start from a template
          </ButtonLink>
        </div>
      </div>
      <div className="rounded-[24px_8px_24px_8px] bg-ink-900/70 p-4 hairline sm:p-6">
        <CreatePanel
          key={`${kind}-${sp.from ?? ""}-${sp.scene ?? ""}`}
          output={kind}
          models={ctx.models}
          signedIn={Boolean(user)}
          balance={ctx.balance}
          characterRefs={ctx.characterRefs}
          projects={ctx.projects}
          prefill={prefill}
          studio={Boolean(prefill?.sceneId)}
        />
      </div>
    </div>
  );
}
