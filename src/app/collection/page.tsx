import { redirect } from "next/navigation";
import { LibraryView } from "@/components/library";
import { getCurrentUser } from "@/server/auth/session";
import { listFolders } from "@/server/folders";
import { listCreations } from "@/server/generation/views";
import { MODELS } from "@/server/ai/registry";
import { isUuid } from "@/lib/ids";

export const dynamic = "force-dynamic";
export const metadata = { title: "Library" };

export default async function CollectionPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/auth?next=/collection");
  const sp = await searchParams;
  const media: "image" | "video" | undefined = sp.media === "image" || sp.media === "video" ? sp.media : undefined;
  const filters = {
    media,
    status: ["completed", "failed", "processing", "queued", "cancelled"].includes(sp.status ?? "") ? sp.status : undefined,
    favorites: sp.favorites === "1",
    folderId: isUuid(sp.folder) ? sp.folder : undefined,
    modelKey: sp.model,
    sort: sp.sort === "oldest" ? ("oldest" as const) : ("newest" as const),
  };
  const [items, folders] = await Promise.all([listCreations(user.id, { ...filters, limit: 120 }), listFolders(user.id)]);
  return (
    <LibraryView
      items={items}
      folders={folders.map((f) => ({ id: f.id, name: f.name }))}
      models={MODELS.map((m) => ({ key: m.key, name: m.displayName }))}
      query={{ media: sp.media ?? "", status: sp.status ?? "", favorites: sp.favorites ?? "", folder: sp.folder ?? "", model: sp.model ?? "", sort: sp.sort ?? "" }}
    />
  );
}
