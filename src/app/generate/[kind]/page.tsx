import { notFound } from "next/navigation";
import { CreatePanel } from "@/components/create-panel";
import { getCurrentUser } from "@/server/auth/session";
import { createContext, generatePrefill } from "@/server/create-context";
import { ButtonLink } from "@/components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ kind: string }> }) {
  return { title: (await params).kind === "video" ? "Make a video" : "Make an image" };
}

export default async function GeneratePage({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { kind } = await params;
  if (kind !== "image" && kind !== "video") notFound();
  const sp = await searchParams;
  const user = await getCurrentUser();
  // ?from= (remix, reuse settings), ?scene= (project continuity) or ?character= (Train): see generatePrefill.
  const [ctx, prefill] = await Promise.all([createContext(user), generatePrefill(user?.id, kind, sp)]);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="tag text-ember-400">{prefill?.sceneId ? "Project scene" : prefill?.parentJobId ? (sp.reuse === "exact" ? "Same settings" : "Remix") : "From scratch"}</p>
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
          key={`${kind}-${sp.from ?? ""}-${sp.scene ?? ""}-${sp.character ?? ""}`}
          output={kind}
          models={ctx.models}
          signedIn={Boolean(user)}
          balance={ctx.balance}
          characterRefs={ctx.characterRefs}
          copilot={ctx.copilot}
          projects={ctx.projects}
          prefill={prefill}
          studio={Boolean(prefill?.sceneId)}
        />
      </div>
    </div>
  );
}
