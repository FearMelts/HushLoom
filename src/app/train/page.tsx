import { redirect } from "next/navigation";
import { TrainView } from "@/components/train";
import { viewerAccess } from "@/server/age/access";
import { LIKENESS_STATEMENT, listCharacters } from "@/server/characters";

export const dynamic = "force-dynamic";
export const metadata = { title: "Train" };

export default async function TrainPage() {
  const { user, viewer } = await viewerAccess();
  if (!user) redirect("/auth?next=/train");
  return <TrainView characters={await listCharacters(user.id, viewer)} statement={LIKENESS_STATEMENT} />;
}
