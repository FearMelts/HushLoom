import { redirect } from "next/navigation";
import { ProjectsIndex } from "@/components/projects";
import { getCurrentUser } from "@/server/auth/session";
import { listProjects } from "@/server/projects";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/auth?next=/projects");
  return <ProjectsIndex projects={await listProjects(user.id)} />;
}
