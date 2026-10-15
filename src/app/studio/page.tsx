import { redirect } from "next/navigation";
import { CreatePanel, type CreatePrefill } from "@/components/create-panel";
import { JobMonitor, PresetList } from "@/components/studio";
import { ButtonLink } from "@/components/ui";
import { isUuid } from "@/lib/ids";
import type { GenerationMode } from "@/server/ai/registry";
import { viewerAccess } from "@/server/age/access";
import { createContext } from "@/server/create-context";
import { listCreations } from "@/server/generation/views";
import { getPreset, listPresets } from "@/server/presets";

export const dynamic = "force-dynamic";
export const metadata = { title: "Studio" };

export default async function StudioPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { user, viewer } = await viewerAccess();
  if (!user) redirect("/auth?next=/studio");
  const sp = await searchParams;
  const kind = sp.kind === "video" ? "video" : "image";
  const [ctx, presets, recent, preset] = await Promise.all([
    createContext(user),
    listPresets(user.id),
    listCreations(user.id, { limit: 15 }, viewer),
    isUuid(sp.preset) ? getPreset(user.id, sp.preset) : null,
  ]);
  const prefill: CreatePrefill | undefined = preset
    ? { mode: preset.mode as GenerationMode, modelKey: preset.modelKey, prompt: preset.prompt, params: preset.params }
    : undefined;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="tag text-ember-400">Every control, nothing hidden</p>
          <h1 className="font-display text-4xl">Studio</h1>
          <p className="mt-1 max-w-xl text-sm text-bone-400">
            The same engine as Create, with seed, negative prompt, atmosphere and project placement in view. Settings a model does not support are refused before you pay, not ignored.
          </p>
        </div>
        <div className="flex gap-2">
          <ButtonLink href="/studio?kind=image" size="sm" variant={kind === "image" ? "bone" : "ghost"} aria-current={kind === "image" ? "page" : undefined}>
            Image
          </ButtonLink>
          <ButtonLink href="/studio?kind=video" size="sm" variant={kind === "video" ? "bone" : "ghost"} aria-current={kind === "video" ? "page" : undefined}>
            Video
          </ButtonLink>
        </div>
      </div>
      {/* minmax(0, 1fr): a long nowrap prompt in the Job monitor must truncate, not widen the page. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-[24px_8px_24px_8px] bg-ink-900/70 p-4 hairline sm:p-6">
          {preset ? <p className="mb-4 text-[13px] text-bone-300">Started from preset “{preset.name}”.</p> : null}
          <CreatePanel
            key={`${kind}-${preset?.id ?? ""}`}
            output={kind}
            models={ctx.models}
            signedIn
            balance={ctx.balance}
            characterRefs={ctx.characterRefs}
            copilot={ctx.copilot}
            projects={ctx.projects}
            prefill={prefill}
            studio
          />
        </div>
        <aside className="space-y-8">
          <section aria-label="Presets">
            <h2 className="mb-2 font-display text-xl">Presets</h2>
            <PresetList presets={presets} kind={kind} />
          </section>
          <section aria-label="Job monitor">
            <h2 className="mb-2 font-display text-xl">Job monitor</h2>
            <JobMonitor items={recent} />
          </section>
        </aside>
      </div>
    </div>
  );
}
