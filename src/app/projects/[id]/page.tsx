import { notFound, redirect } from "next/navigation";
import { ProjectWorkspace } from "@/components/projects";
import { isUuid } from "@/lib/ids";
import { viewerAccess } from "@/server/age/access";
import { listCharacters } from "@/server/characters";
import { HttpError } from "@/server/http";
import { getProjectDetail } from "@/server/projects";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, viewer } = await viewerAccess();
  if (!user) redirect(`/auth?next=/projects/${id}`);
  if (!isUuid(id)) notFound();
  const [data, characters] = await Promise.all([
    getProjectDetail(user.id, id, viewer).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }),
    listCharacters(user.id),
  ]);
  if (!data) notFound();
  return <ProjectWorkspace data={data} characters={characters.map((c) => ({ id: c.id, name: c.name }))} />;
}
