import { BackLink } from "@/components/ui";
import { TakedownForm } from "@/components/takedown-form";
import { getCurrentUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Request a takedown" };

export default async function TakedownPage({ searchParams }: { searchParams: Promise<{ target?: string }> }) {
  const user = await getCurrentUser();
  const target = (await searchParams).target?.slice(0, 500) ?? "";
  return (
    <article className="mx-auto max-w-2xl">
      <BackLink href="/policies">Policies</BackLink>
      <p className="tag mt-3 text-ember-400">Report and remove</p>
      <h1 className="font-display text-4xl">Request a takedown</h1>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-bone-200">
        <p>
          If something here shows you without your consent, uses your likeness, or shows anyone who is or looks under 18, tell us. You do not need an account. A person reviews every
          request, intimate images and anything involving minors first, and what we remove stops being viewable right away.
        </p>
        <p className="text-sm text-bone-400">
          If a child is in danger, contact your local police first. In the US you can also report to the NCMEC CyberTipline; in the UK, to the Internet Watch Foundation.
        </p>
      </div>
      <div className="mt-8">
        <TakedownForm signedIn={Boolean(user)} initialTarget={target} />
      </div>
    </article>
  );
}
