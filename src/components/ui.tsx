"use client";

import { X } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

type Variant = "ember" | "ghost" | "quiet" | "danger" | "bone";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  ember: "bg-ember-500 text-ink-950 hover:bg-ember-400 active:bg-ember-600 font-semibold",
  bone: "bg-bone-50 text-ink-950 hover:bg-bone-200 font-semibold",
  ghost: "hairline text-bone-50 hover:bg-ink-800",
  quiet: "text-bone-300 hover:text-bone-50 hover:bg-ink-800",
  danger: "hairline text-danger-400 hover:bg-danger-400/10",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-full",
  md: "h-10 px-4 text-sm gap-2 rounded-full",
  lg: "h-12 px-6 text-[15px] gap-2 rounded-full",
};

export const buttonClass = (variant: Variant = "ghost", size: Size = "md", extra?: string) =>
  cn(
    "inline-flex items-center justify-center whitespace-nowrap transition-colors duration-[var(--duration-quick)] disabled:opacity-45 disabled:pointer-events-none select-none",
    variants[variant],
    sizes[size],
    extra,
  );

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean }>(
  function Button({ variant = "ghost", size = "md", busy, className, children, disabled, ...rest }, ref) {
    return (
      <button ref={ref} className={buttonClass(variant, size, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
        {busy ? <span className="size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);

export function ButtonLink({ variant = "ghost", size = "md", className, ...rest }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}

export function Badge({ tone = "plain", children, className }: { tone?: "plain" | "vip" | "new" | "video" | "demo" | "warn" | "danger"; children: ReactNode; className?: string }) {
  const tones = {
    plain: "bg-ink-950/70 text-bone-200",
    vip: "bg-brass-400 text-ink-950",
    new: "bg-sage-400 text-ink-950",
    video: "bg-ink-950/70 text-iris-300",
    demo: "bg-iris-400 text-ink-950",
    warn: "bg-brass-300/15 text-brass-300",
    danger: "bg-danger-400/15 text-danger-400",
  } as const;
  return <span className={cn("tag inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 backdrop-blur", tones[tone], className)}>{children}</span>;
}

export function Chip({ active, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "h-8 shrink-0 rounded-full px-3.5 text-[13px] transition-colors duration-[var(--duration-quick)]",
        active ? "bg-bone-50 text-ink-950 font-semibold" : "hairline text-bone-300 hover:text-bone-50 hover:bg-ink-800",
        className,
      )}
      {...rest}
    />
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-bone-200">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12.5px] text-danger-400" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] text-bone-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "w-full rounded-xl bg-ink-900 hairline px-3.5 py-2.5 text-sm text-bone-50 placeholder:text-bone-500 focus:outline-none focus:ring-2 focus:ring-ember-400/70 transition-shadow";

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={cn("flex items-start justify-between gap-4 py-3", disabled && "opacity-50")}>
      <span>
        <span className="block text-sm text-bone-50">{label}</span>
        {description ? <span className="block text-[12.5px] text-bone-400 mt-0.5">{description}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors duration-[var(--duration-base)]", checked ? "bg-ember-500" : "bg-ink-700")}
      >
        <span className={cn("absolute top-0.5 size-5 rounded-full bg-bone-50 transition-transform duration-[var(--duration-base)] ease-[var(--ease-weave)]", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
    </label>
  );
}

/** Accessible modal built on <dialog>: focus trap, Escape and backdrop close come from the platform. */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
      className={cn(
        "m-auto max-h-[92dvh] w-[min(100vw-24px,var(--w))] overflow-auto rounded-[24px] bg-ink-900 p-0 text-bone-50 hairline backdrop:bg-ink-950/75 backdrop:backdrop-blur-sm",
        "max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none",
        "open:animate-rise",
      )}
      style={{ ["--w" as string]: wide ? "880px" : "480px" }}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between bg-ink-900/95 px-5 pt-4 pb-3 backdrop-blur">
        <h2 className="font-display text-xl">{title}</h2>
        <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full text-bone-300 hover:bg-ink-800 hover:text-bone-50" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="px-5 pb-5">{children}</div>
    </dialog>
  );
}

// ── Toasts ──

type Toast = { id: number; message: string; tone?: "plain" | "success" | "error"; action?: { label: string; href: string } };
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl bg-ink-800/95 px-4 py-3 text-sm shadow-2xl shadow-black/50 hairline backdrop-blur animate-rise",
              t.tone === "error" && "text-danger-400",
            )}
          >
            {t.tone === "success" ? <span className="size-2 rounded-full bg-sage-400" aria-hidden /> : null}
            <span className="flex-1">{t.message}</span>
            {t.action ? (
              <Link href={t.action.href} className="font-semibold text-ember-400 hover:text-ember-300">
                {t.action.label}
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="petal hairline mx-auto my-10 max-w-md px-6 py-10 text-center">
      <p className="font-display text-2xl">{title}</p>
      <p className="mt-2 text-sm text-bone-400">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function SectionHeading({ title, kicker, action }: { title: string; kicker?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        {kicker ? <p className="tag text-ember-400">{kicker}</p> : null}
        <h2 className="font-display text-[26px] leading-tight sm:text-3xl">{title}</h2>
      </div>
      {action}
    </div>
  );
}
