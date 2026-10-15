import { redirect } from "next/navigation";
import { ProjectsIndex } from "@/components/projects";
import { viewerAccess } from "@/server/age/access";
import { listProjects } from "@/server/projects";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const { user, viewer } = await viewerAccess();
  if (!user) redirect("/auth?next=/projects");
  return <ProjectsIndex projects={await listProjects(user.id, viewer)} />;
}
