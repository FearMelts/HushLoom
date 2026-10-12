import { redirect } from "next/navigation";
import { TrainView } from "@/components/train";
import { getCurrentUser } from "@/server/auth/session";
import { LIKENESS_STATEMENT, listCharacters } from "@/server/characters";

export const dynamic = "force-dynamic";
export const metadata = { title: "Train" };

export default async function TrainPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/auth?next=/train");
  return <TrainView characters={await listCharacters(user.id)} statement={LIKENESS_STATEMENT} />;
}
