"use client";

import { Flag, Pause, Play, Star, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { WithheldMedia } from "./template-card";
import { Button, Field, Sheet, inputClass, useToast } from "./ui";

export function TemplateMedia({
  posterUrl,
  previewUrl,
  title,
  isVideo,
  withheld,
  signedIn,
}: {
  posterUrl: string | null;
  previewUrl: string | null;
  title: string;
  isVideo: boolean;
  /** The server issued no media because the viewer still needs an age check. */
  withheld?: boolean;
  signedIn?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <div className="petal relative overflow-hidden bg-ink-850 hairline">
      {withheld ? (
        <div className="relative aspect-[4/5] w-full" aria-label={`${title} preview withheld until age verification`}>
          <WithheldMedia signedIn={Boolean(signedIn)} />
        </div>
      ) : isVideo && previewUrl ? (
        <video
          ref={ref}
          src={previewUrl}
          poster={posterUrl ?? undefined}
          muted
          loop
          playsInline
          preload="metadata"
          className="aspect-[4/5] w-full object-cover"
          aria-label={`${title} preview`}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      ) : posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed URL
        <img src={posterUrl} alt={`${title} cover`} className="aspect-[4/5] w-full object-cover" />
      ) : (
        <div className="skeleton aspect-[4/5]" />
      )}
      {isVideo && previewUrl && !withheld ? (
        <button
          type="button"
          onClick={() => (playing ? ref.current?.pause() : void ref.current?.play())}
          className="absolute bottom-4 left-4 inline-flex h-10 items-center gap-2 rounded-full bg-ink-950/70 px-4 text-sm backdrop-blur hover:bg-ink-950/90"
        >
          {playing ? <Pause size={16} aria-hidden /> : <Play size={16} className="fill-current" aria-hidden />}
          {playing ? "Pause preview" : "Play preview"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Phones and tablets: the Create panel sits below the media and the description, so a slim bar
 * keeps "Make it" one tap away until the panel itself scrolls into view. It is a link to #make,
 * not a second Make button; the panel's own button is the only thing that starts a creation.
 */
export function MakeBar({ cost, locked, demo }: { cost: number | null; locked: boolean; demo: boolean }) {
  const [shown, setShown] = useState(false);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = document.getElementById("make");
    if (!target) return;
    const io = new IntersectionObserver(([entry]) => setShown(!entry?.isIntersecting), { rootMargin: "0px 0px -15% 0px" });
    io.observe(target);
    return () => io.disconnect();
  }, []);

  // Toasts and the job tray read --dock-h so they stack above the bar instead of under it.
  useEffect(() => {
    const el = bar.current;
    const root = document.documentElement;
    if (!shown || !el) {
      root.style.removeProperty("--dock-h");
      return;
    }
    const ro = new ResizeObserver(() => root.style.setProperty("--dock-h", `${el.offsetHeight ? el.offsetHeight + 8 : 0}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--dock-h");
    };
  }, [shown]);

  if (!shown) return null;
  return (
    <div ref={bar} className="fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 animate-rise lg:hidden">
      <a
        href="#make"
        onClick={(e) => {
          const target = document.getElementById("make");
          if (!target) return;
          e.preventDefault();
          const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
          history.replaceState(null, "", "#make");
          // Move the focus start point like a native anchor would, without raising a phone keyboard.
          if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
        }}
        className="mx-auto flex h-12 max-w-md items-center justify-center gap-2 rounded-full bg-ember-500 px-5 text-[15px] font-semibold text-ink-950 shadow-glow"
      >
        <Wand2 size={18} aria-hidden />
        {locked ? "VIP template · see options" : cost !== null ? `Make it · ${cost} credit${cost === 1 ? "" : "s"}` : "Make your own"}
        {demo && !locked ? <span className="tag rounded-[4px] bg-ink-950/20 px-1.5 py-0.5 text-[10px]">Demo</span> : null}
      </a>
    </div>
  );
}

export function FollowButton({ creatorId, initial, signedIn }: { creatorId: string; initial: boolean; signedIn: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant={on ? "ghost" : "bone"}
      busy={busy}
      aria-pressed={on}
      onClick={async () => {
        if (!signedIn) return router.push("/auth");
        setBusy(true);
        try {
          await api("/api/follows", { method: on ? "DELETE" : "POST", body: { creatorId } });
          setOn(!on);
          router.refresh();
        } catch (e) {
          toast({ message: e instanceof ApiError ? e.message : "Couldn't update that. Try again.", tone: "error" });
        } finally {
          setBusy(false);
        }
      }}
    >
      {on ? "Following" : "Follow"}
    </Button>
  );
}

export function RateStars({ templateId, initial }: { templateId: string; initial: number | null }) {
  const [score, setScore] = useState(initial ?? 0);
  const [hover, setHover] = useState(0);
  const toast = useToast();
  const router = useRouter();
  return (
    <div className="flex items-center gap-2 text-[13px] text-bone-400">
      <span id="rate-label">{score ? "Your rating" : "Rate this template"}</span>
      <div role="radiogroup" aria-labelledby="rate-label" className="flex" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={score === n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            onMouseEnter={() => setHover(n)}
            onClick={async () => {
              const prev = score;
              setScore(n);
              try {
                await api(`/api/templates/${templateId}/rate`, { body: { score: n } });
                toast({ message: "Thanks for rating.", tone: "success" });
                router.refresh();
              } catch (e) {
                setScore(prev);
                toast({ message: e instanceof ApiError ? e.message : "Could not save rating.", tone: "error" });
              }
            }}
            className="grid size-8 place-items-center max-sm:size-10"
          >
            <Star size={18} className={cn((hover || score) >= n ? "fill-brass-400 text-brass-400" : "text-bone-500")} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}

const REASONS = [
  ["minor", "Appears to involve a minor"],
  ["non_consent", "Non-consensual or coercive"],
  ["real_person", "A real person without consent"],
  ["illegal", "Otherwise illegal"],
  ["spam", "Spam or misleading"],
  ["other", "Something else"],
] as const;

export function ReportButton({ templateId }: { templateId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("minor");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 items-center gap-1.5 px-1 text-[13px] text-bone-500 hover:text-danger-400 max-sm:h-10">
        <Flag size={14} aria-hidden /> Report
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Report this template">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api(`/api/templates/${templateId}/report`, { body: { reason, note } });
              toast({ message: "Reported. Our moderators will review it.", tone: "success" });
              setOpen(false);
            } catch (err) {
              toast({ message: err instanceof ApiError ? err.message : "Could not send report.", tone: "error" });
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-2 text-[13px] text-bone-300">What is wrong?</legend>
            {REASONS.map(([value, label]) => (
              <label key={value} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm hairline has-[:checked]:bg-ink-800">
                <input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} className="accent-[var(--color-ember-500)]" />
                {label}
              </label>
            ))}
          </fieldset>
          <Field label="Details (optional)" htmlFor="report-note">
            <textarea id="report-note" rows={3} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
          <p className="text-[12.5px] text-bone-400">
            Is it you, without your consent?{" "}
            <Link href={`/policies/takedown?target=${encodeURIComponent(`/templates/${templateId}`)}`} className="text-ember-400 underline-offset-2 hover:underline">
              Request a takedown
            </Link>
            .
          </p>
          <div className="flex justify-end">
            <Button type="submit" variant="ember" busy={busy}>
              Send report
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
