import { and, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { CreationDetail } from "@/components/creation-detail";
import { getModel, MODE_LABELS } from "@/server/ai/registry";
import { getCurrentUser } from "@/server/auth/session";
import { getBalance } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import { generationJobs, projects, templates } from "@/server/db/schema";
import { listCategories } from "@/server/discovery/templates";
import { listFolders } from "@/server/folders";
import { getCreation, lineage } from "@/server/generation/views";

export const dynamic = "force-dynamic";
export const metadata = { title: "Creation" };

export default async function CreationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/auth?next=/collection/${id}`);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const item = await getCreation(user.id, id);
  if (!item) notFound();
  const [job] = await getDb().select().from(generationJobs).where(and(eq(generationJobs.id, id), eq(generationJobs.userId, user.id)));
  const [versions, folders, categories, balance, template, project] = await Promise.all([
    lineage(user.id, id),
    listFolders(user.id),
    listCategories(),
    getBalance(user.id),
    job!.templateId ? getDb().select({ slug: templates.slug, title: templates.title }).from(templates).where(and(eq(templates.id, job!.templateId), isNull(templates.deletedAt))) : [],
    // A deleted project is not linked: its page is gone.
    job!.projectId
      ? getDb()
          .select({ id: projects.id, title: projects.title })
          .from(projects)
          .where(and(eq(projects.id, job!.projectId), eq(projects.userId, user.id), isNull(projects.deletedAt)))
      : [],
  ]);
  const model = getModel(job!.modelKey);
  return (
    <CreationDetail
      item={item}
      details={{
        prompt: job!.prompt,
        negativePrompt: job!.negativePrompt,
        params: job!.params,
        modeLabel: MODE_LABELS[job!.mode],
        modelName: model?.displayName ?? job!.modelKey,
        modelOutput: model?.output ?? "image",
        usedPersonalMedia: job!.inputAssetIds.length > 0 || Boolean(job!.characterReferenceId),
        attempts: job!.attempts,
        providerJobId: job!.providerJobId,
        template: template[0] ?? null,
        project: project[0] ?? null,
        relation: job!.relation,
      }}
      versions={versions}
      folders={folders.map((f) => ({ id: f.id, name: f.name }))}
      categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
      balance={balance.available}
    />
  );
}
