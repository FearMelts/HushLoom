"use client";

import { ChevronRight, Coins, Compass, FolderOpen, Heart, Layers, LibraryBig, LogOut, Plus, ScrollText, Search, Settings, Shield, Sparkles, Wand2, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { JobTray } from "./job-tray";
import { OfflineBanner } from "./offline";
import { Sheet, ToastProvider, buttonClass, useToast } from "./ui";

export type ShellUser = { id: string; handle: string; displayName: string; role: string; credits: number } | null;

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <path d="M3 11c7-6 19 6 26 0" fill="none" stroke="var(--color-ember-500)" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M3 21c7-6 19 6 26 0" fill="none" stroke="var(--color-brass-400)" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M11 3c-6 7 6 19 0 26" fill="none" stroke="var(--color-bone-50)" strokeOpacity=".75" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="font-display text-[22px] italic tracking-tight">hushloom</span>
    </span>
  );
}

const primary = [
  { href: "/", label: "Discover", icon: Compass, match: (p: string) => p === "/" || p.startsWith("/explore") || p.startsWith("/templates") },
  { href: "/generate/image", label: "Create", icon: Wand2, match: (p: string) => p.startsWith("/generate") },
  { href: "/collection", label: "Library", icon: LibraryBig, match: (p: string) => p.startsWith("/collection") },
  { href: "/train", label: "Train", icon: Sparkles, match: (p: string) => p.startsWith("/train") },
];
const secondary = [
  { href: "/projects", label: "Projects", icon: Layers, match: (p: string) => p.startsWith("/projects") },
  { href: "/studio", label: "Studio", icon: FolderOpen, match: (p: string) => p.startsWith("/studio") },
  { href: "/favorites", label: "Favorites", icon: Heart, match: (p: string) => p.startsWith("/favorites") },
];
/**
 * The phone's "You" sheet: everything the rail offers that the tab bar has no room for.
 * Same items as "Go deeper" plus Train and the account pages, so nothing is desktop-only.
 */
const youMenu = [
  secondary[2]!,
  secondary[0]!,
  secondary[1]!,
  primary[3]!,
  { href: "/settings", label: "Settings", icon: Settings, match: (p: string) => p.startsWith("/settings") },
  { href: "/pricing", label: "Pricing", icon: Coins, match: (p: string) => p.startsWith("/pricing") },
  { href: "/policies", label: "Content policy & privacy", icon: ScrollText, match: (p: string) => p.startsWith("/policies") },
];

/** Signs out this device only (the session cookie and this device's push subscription), then starts fresh at Discover. */
function useSignOut() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await api("/api/auth/logout", { body: {} });
      // A full load so nothing from the signed-in shell (balance, tray, cached data) stays on screen.
      window.location.assign("/");
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not sign out. Check your connection and try again.", tone: "error" });
      setBusy(false);
    }
  };
  return { signOut, busy };
}

function CreditPill({ credits }: { credits: number }) {
  return (
    <Link
      href="/pricing"
      className="inline-flex h-9 items-center gap-2 rounded-full bg-ink-850 pl-2 pr-3.5 text-sm hairline hover:bg-ink-800"
      aria-label={`${credits} credits. Get more credits`}
    >
      <span className="grid size-5 place-items-center rounded-full bg-brass-400 text-[11px] font-bold text-ink-950" aria-hidden>
        ✦
      </span>
      <span className="font-mono tabular-nums" data-testid="credit-balance">
        {credits}
      </span>
    </Link>
  );
}

function SearchBox({ className }: { className?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      role="search"
      className={cn("relative", className)}
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/explore?q=${encodeURIComponent(q)}`);
      }}
    >
      <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-bone-500" size={16} aria-hidden />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        type="search"
        placeholder="Search templates, moods, creators"
        aria-label="Search templates"
        className="h-10 w-full rounded-full bg-ink-900 pl-10 pr-4 text-sm hairline placeholder:text-bone-500 focus:outline-none focus:ring-2 focus:ring-ember-400/70"
      />
    </form>
  );
}

export function Shell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const pathname = usePathname();
  const navLink = (item: (typeof primary)[number], compact = false) => {
    const active = item.match(pathname);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14.5px] transition-colors",
          active ? "bg-ink-800 text-bone-50" : "text-bone-300 hover:bg-ink-850 hover:text-bone-50",
          compact && "py-2 text-[13.5px]",
        )}
      >
        <Icon size={compact ? 17 : 19} className={cn(active ? "text-ember-400" : "text-bone-500 group-hover:text-bone-300")} aria-hidden />
        {item.label}
      </Link>
    );
  };

  return (
    <ToastProvider>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-full focus:bg-bone-50 focus:px-4 focus:py-2 focus:text-ink-950">
        Skip to content
      </a>
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-[var(--line)] bg-ink-950/80 px-4 py-5 backdrop-blur lg:flex" aria-label="Main navigation">
        <Link href="/" className="mb-7 px-2" aria-label="Hushloom home">
          <Wordmark />
        </Link>
        <nav className="space-y-0.5">{primary.map((i) => navLink(i))}</nav>
        <p className="tag mt-7 mb-2 px-3 text-bone-500">Go deeper</p>
        <nav className="space-y-0.5">{secondary.map((i) => navLink(i, true))}</nav>
        <div className="mt-auto space-y-3">
          {user ? (
            <>
              <Link href="/generate/video" className={buttonClass("ember", "md", "w-full")}>
                <Plus size={17} aria-hidden /> New creation
              </Link>
              <div className="flex items-center justify-between gap-2">
                <CreditPill credits={user.credits} />
                <div className="flex items-center gap-1">
                  {user.role === "admin" ? (
                    <Link href="/admin" className="grid size-9 place-items-center rounded-full text-bone-400 hover:bg-ink-850 hover:text-bone-50" aria-label="Admin">
                      <Shield size={17} />
                    </Link>
                  ) : null}
                  <Link href="/settings" className="grid size-9 place-items-center rounded-full text-bone-400 hover:bg-ink-850 hover:text-bone-50" aria-label="Settings">
                    <Settings size={17} />
                  </Link>
                  <SignOutButton compact />
                </div>
              </div>
              <Link href={`/creators/${user.handle}`} className="flex items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-ink-850">
                <Avatar name={user.displayName} />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{user.displayName}</span>
                  <span className="block truncate font-mono text-[11px] text-bone-500">@{user.handle}</span>
                </span>
              </Link>
            </>
          ) : (
            <Link href="/auth" className={buttonClass("ember", "md", "w-full")}>
              Join or sign in
            </Link>
          )}
          <Link href="/pricing" className="block px-3 text-[12.5px] text-bone-500 hover:text-bone-300">
            Pricing
          </Link>
          <Link href="/policies" className="block px-3 text-[12.5px] text-bone-500 hover:text-bone-300">
            Content policy &amp; privacy
          </Link>
        </div>
      </aside>

      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-ink-950/80 pt-[env(safe-area-inset-top)] backdrop-blur lg:pl-[236px]">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="lg:hidden" aria-label="Hushloom home">
            <Wordmark />
          </Link>
          <SearchBox className="ml-auto hidden w-full max-w-md sm:block lg:ml-0" />
          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <>
                <span className="lg:hidden">
                  <CreditPill credits={user.credits} />
                </span>
                <Link href="/generate/image" className={buttonClass("bone", "sm", "hidden lg:inline-flex")}>
                  <Wand2 size={15} aria-hidden /> Create
                </Link>
              </>
            ) : (
              <Link href="/auth" className={buttonClass("bone", "sm")}>
                Sign in
              </Link>
            )}
          </div>
        </div>
        <OfflineBanner />
      </header>

      <main id="main" className="pb-28 lg:pb-12 lg:pl-[236px]">
        <div className="mx-auto max-w-[1600px] px-4 pt-5 sm:px-6">{children}</div>
      </main>

      {user ? <JobTray /> : null}

      {/* Mobile tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-ink-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Main navigation">
        <div className="mx-auto grid h-16 max-w-md grid-cols-5 items-center">
          <TabLink href="/" label="Discover" active={primary[0]!.match(pathname)} icon={<Compass size={21} />} />
          <TabLink href="/explore" label="Search" active={false} icon={<Search size={21} />} />
          <Link href="/generate/image" className="mx-auto grid size-12 place-items-center rounded-[16px_5px_16px_5px] bg-ember-500 text-ink-950 shadow-glow" aria-label="Create">
            <Plus size={24} />
          </Link>
          <TabLink href="/collection" label="Library" active={primary[2]!.match(pathname)} icon={<LibraryBig size={21} />} />
          {user ? <YouTab user={user} pathname={pathname} /> : <TabLink href="/auth" label="Sign in" active={pathname.startsWith("/auth")} icon={<UserRound size={21} />} />}
        </div>
      </nav>
    </ToastProvider>
  );
}

const tabClass = (active: boolean) => cn("flex h-full flex-col items-center justify-center gap-0.5 text-[10.5px]", active ? "text-bone-50" : "text-bone-500");

function TabLink({ href, label, icon, active }: { href: string; label: string; icon: ReactNode; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
      <span className={active ? "text-ember-400" : undefined} aria-hidden>
        {icon}
      </span>
      {label}
    </Link>
  );
}

/** The phone's "You" tab opens a sheet with the pages the tab bar has no room for, and sign-out. */
function YouTab({ user, pathname }: { user: NonNullable<ShellUser>; pathname: string }) {
  const [open, setOpen] = useState(false);
  const active = youMenu.some((i) => i.match(pathname)) || pathname.startsWith(`/creators/${user.handle}`) || pathname.startsWith("/admin");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} className={tabClass(active)}>
        <span className={active ? "text-ember-400" : undefined} aria-hidden>
          <UserRound size={21} />
        </span>
        You
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="You">
        <Link href={`/creators/${user.handle}`} onClick={() => setOpen(false)} className="-mx-2 mb-2 flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-ink-800">
          <Avatar name={user.displayName} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px]">{user.displayName}</span>
            <span className="block truncate font-mono text-[11.5px] text-bone-400">@{user.handle} · your profile</span>
          </span>
          <ChevronRight size={16} className="text-bone-500" aria-hidden />
        </Link>
        <Link href="/pricing" onClick={() => setOpen(false)} className="mb-3 flex items-center justify-between rounded-xl bg-ink-850 px-3.5 py-3 text-sm hairline hover:bg-ink-800">
          <span className="flex items-center gap-2.5">
            <span className="grid size-5 place-items-center rounded-full bg-brass-400 text-[11px] font-bold text-ink-950" aria-hidden>
              ✦
            </span>
            <span className="font-mono tabular-nums">{user.credits}</span> credits
          </span>
          <span className="text-[13px] text-ember-400">Get more</span>
        </Link>
        <nav aria-label="More pages">
          <ul className="space-y-0.5">
            {[...youMenu, ...(user.role === "admin" ? [{ href: "/admin", label: "Admin", icon: Shield, match: (p: string) => p.startsWith("/admin") }] : [])].map((item) => {
              const Icon = item.icon;
              const current = item.match(pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={current ? "page" : undefined}
                    className={cn("flex h-12 items-center gap-3 rounded-xl px-3 text-[15px]", current ? "bg-ink-800 text-bone-50" : "text-bone-200 hover:bg-ink-800")}
                  >
                    <Icon size={19} className={current ? "text-ember-400" : "text-bone-400"} aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="mt-3 border-t border-[var(--line)] pt-3">
          <SignOutButton />
        </div>
      </Sheet>
    </>
  );
}

function SignOutButton({ compact }: { compact?: boolean }) {
  const { signOut, busy } = useSignOut();
  if (compact) {
    return (
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="grid size-9 place-items-center rounded-full text-bone-400 hover:bg-ink-850 hover:text-bone-50 disabled:opacity-45"
        aria-label="Sign out"
        title="Sign out of this device"
      >
        <LogOut size={17} aria-hidden />
      </button>
    );
  }
  return (
    <button type="button" onClick={signOut} disabled={busy} aria-busy={busy || undefined} className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-[15px] text-bone-200 hover:bg-ink-800 disabled:opacity-45">
      <LogOut size={19} className="text-bone-400" aria-hidden />
      {busy ? "Signing out…" : "Sign out"}
      <span className="ml-auto text-[12px] text-bone-500">This device</span>
    </button>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[40%_12%_40%_12%] font-semibold text-ink-950"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${h} 70% 70%), hsl(${(h + 40) % 360} 65% 55%))` }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
