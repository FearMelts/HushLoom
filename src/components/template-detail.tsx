"use client";

import { Flag, Pause, Play, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, Field, Sheet, inputClass, useToast } from "./ui";

export function TemplateMedia({ posterUrl, previewUrl, title, isVideo }: { posterUrl: string | null; previewUrl: string | null; title: string; isVideo: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <div className="petal relative overflow-hidden bg-ink-850 hairline">
      {isVideo && previewUrl ? (
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
      {isVideo && previewUrl ? (
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

export function FollowButton({ creatorId, initial, signedIn }: { creatorId: string; initial: boolean; signedIn: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
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
            className="p-0.5"
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
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-[13px] text-bone-500 hover:text-danger-400">
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
