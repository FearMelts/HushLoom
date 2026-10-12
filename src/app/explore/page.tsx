import { ExploreFeed } from "@/components/explore-feed";
import { getCurrentUser } from "@/server/auth/session";
import { browseTemplates, listCategories, type SortKey } from "@/server/discovery/templates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Explore" };

const SORTS: SortKey[] = ["trending", "new", "top_rated", "most_favorited"];

export default async function ExplorePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const sort = SORTS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "trending";
  const media = sp.media === "image" || sp.media === "video" ? sp.media : undefined;
  const user = await getCurrentUser();
  const [categories, first] = await Promise.all([
    listCategories(),
    browseTemplates({ q: sp.q, category: sp.category, media, sort, limit: 24 }, user?.id ?? null),
  ]);
  return (
    <ExploreFeed
      key={JSON.stringify([sp.q, sp.category, media, sort])}
      initial={first}
      categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
      query={{ q: sp.q ?? "", category: sp.category ?? "", media: media ?? "", sort }}
      signedIn={Boolean(user)}
    />
  );
}
