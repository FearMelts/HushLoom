import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CreationThumb } from "@/components/library";
import { TemplateGrid } from "@/components/template-card";
import { ButtonLink, EmptyState } from "@/components/ui";
import { cn } from "@/lib/cn";
import { viewerAccess } from "@/server/age/access";
import { getDb } from "@/server/db";
import { favorites } from "@/server/db/schema";
import { cardsByIds } from "@/server/discovery/templates";
import { listCreations } from "@/server/generation/views";

export const dynamic = "force-dynamic";
export const metadata = { title: "Favorites" };

export default async function FavoritesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { user, viewer } = await viewerAccess();
  if (!user) redirect("/auth?next=/favorites");
  const tab = (await searchParams).tab === "creations" ? "creations" : "templates";
  const tabs = [
    { key: "templates", label: "Templates" },
    { key: "creations", label: "Your creations" },
  ];
  let body: React.ReactNode;
  if (tab === "templates") {
    const ids = await getDb()
      .select({ id: favorites.targetId })
      .from(favorites)
      .where(and(eq(favorites.userId, user.id), eq(favorites.targetType, "template")))
      .orderBy(desc(favorites.createdAt))
      .limit(120);
    const cards = await cardsByIds(ids.map((r) => r.id), viewer);
    body = cards.length ? (
      <TemplateGrid cards={cards} signedIn />
    ) : (
      <EmptyState title="No saved templates" body="Tap the heart on any template to keep it here." action={<ButtonLink href="/explore" variant="ember">Explore templates</ButtonLink>} />
    );
  } else {
    const items = await listCreations(user.id, { favorites: true, limit: 120 }, viewer);
    body = items.length ? (
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((i) => (
          <li key={i.id}>
            <CreationThumb item={i} />
          </li>
        ))}
      </ul>
    ) : (
      <EmptyState title="No saved creations" body="Save the ones you love from your Library and they collect here." action={<ButtonLink href="/collection" variant="ember">Open Library</ButtonLink>} />
    );
  }
  return (
    <div>
      <div className="mb-5">
        <p className="tag text-ember-400">Kept close</p>
        <h1 className="font-display text-4xl">Favorites</h1>
      </div>
      <nav className="mb-6 flex gap-2" aria-label="Favorites type">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.key === "templates" ? "/favorites" : "/favorites?tab=creations"}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn("h-8 rounded-full px-3.5 text-[13px] leading-8 max-sm:h-10 max-sm:leading-10", tab === t.key ? "bg-bone-50 font-semibold text-ink-950" : "hairline text-bone-300 hover:bg-ink-800")}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
