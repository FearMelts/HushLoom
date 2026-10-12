import { redirect } from "next/navigation";
import { AuthForms } from "@/components/auth-forms";
import { Wordmark } from "@/components/shell";
import { getCurrentUser } from "@/server/auth/session";

export const metadata = { title: "Join or sign in" };

export default async function AuthPage({ searchParams }: { searchParams: Promise<{ next?: string; mode?: string }> }) {
  const sp = await searchParams;
  const next = sp.next?.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/";
  if (await getCurrentUser()) redirect(next);
  return (
    <div className="mx-auto grid max-w-5xl items-center gap-10 py-6 lg:grid-cols-2">
      <div className="hidden lg:block">
        <Wordmark />
        <h1 className="mt-6 font-display text-5xl leading-[1.05]">
          Your private corner <em className="text-ember-300">of the loom.</em>
        </h1>
        <ul className="mt-6 space-y-3 text-[15px] text-bone-300">
          <li>Everything you make is private unless you choose to publish it.</li>
          <li>Every creation shows its credit cost before it runs. Failed runs refund automatically.</li>
          <li>Adults only, and only content of consenting adults. We enforce it on the server, not just in the fine print.</li>
        </ul>
      </div>
      <AuthForms next={next} initialMode={sp.mode === "signin" ? "signin" : "signup"} />
    </div>
  );
}
