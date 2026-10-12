import { redirect } from "next/navigation";
import { SettingsView } from "@/components/settings";
import { getCurrentUser } from "@/server/auth/session";
import { settingsFor } from "@/server/me";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/auth?next=/settings");
  return <SettingsView data={await settingsFor(user.id)} email={user.email} />;
}
