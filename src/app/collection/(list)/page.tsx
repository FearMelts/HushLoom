import { redirect } from "next/navigation";
import { LibraryView } from "@/components/library";
import { LibraryFilters, type LibraryExtraQuery } from "@/components/library-filters";
import { getCurrentUser } from "@/server/auth/session";
import { listFolders } from "@/server/folders";
import { libraryFacets, listCreations, utcDay } from "@/server/generation/views";
import { MODELS } from "@/server/ai/registry";
import { isUuid } from "@/lib/ids";

export const dynamic = "force-dynamic";
export const metadata = { title: "Library" };

export default async function CollectionPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/auth?next=/collection");
  const sp = await searchParams;
  const media: "image" | "video" | undefined = sp.media === "image" || sp.media === "video" ? sp.media : undefined;
  // The finer filters: only well-formed values reach the query; anything else is ignored.
  const extra: LibraryExtraQuery = {
    project: isUuid(sp.project) ? sp.project! : "",
    template: isUuid(sp.template) ? sp.template! : "",
    creator: isUuid(sp.creator) ? sp.creator! : "",
    quality: sp.quality === "hd" || sp.quality === "4k" ? sp.quality : "",
    from: utcDay(sp.from) ? sp.from! : "",
    to: utcDay(sp.to) ? sp.to! : "",
  };
  const filters = {
    media,
    status: ["completed", "failed", "processing", "queued", "cancelled"].includes(sp.status ?? "") ? sp.status : undefined,
    favorites: sp.favorites === "1",
    folderId: isUuid(sp.folder) ? sp.folder : undefined,
    modelKey: sp.model,
    projectId: extra.project || undefined,
    templateId: extra.template || undefined,
    templateCreatorId: extra.creator || undefined,
    quality: (extra.quality || undefined) as "hd" | "4k" | undefined,
    from: extra.from || undefined,
    to: extra.to || undefined,
    sort: sp.sort === "oldest" ? ("oldest" as const) : ("newest" as const),
  };
  const [items, folders, facets] = await Promise.all([listCreations(user.id, { ...filters, limit: 120 }), listFolders(user.id), libraryFacets(user.id)]);
  // LibraryView rebuilds the URL from this object, so the extra keys ride along and survive its own filter changes.
  const query = { media: sp.media ?? "", status: sp.status ?? "", favorites: sp.favorites ?? "", folder: sp.folder ?? "", model: sp.model ?? "", sort: sp.sort ?? "", ...extra };
  return (
    <>
      <LibraryFilters facets={facets} value={extra} />
      <LibraryView items={items} folders={folders.map((f) => ({ id: f.id, name: f.name }))} models={MODELS.map((m) => ({ key: m.key, name: m.displayName }))} query={query} />
    </>
  );
}
