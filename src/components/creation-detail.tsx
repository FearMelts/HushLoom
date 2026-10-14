"use client";

import { ArrowLeft, Bookmark, Columns2, Copy, Download, FastForward, FolderPlus, Heart, Repeat, Send, Shuffle, Trash2, Wand2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GenerationParams } from "@/server/db/schema";
import type { CreationListItem } from "@/server/generation/views";
import { api, ApiError, apiErrorAction, newIdempotencyKey } from "@/lib/api";
import { cn } from "@/lib/cn";
import { STATUS_LABEL, elapsed, relativeTime } from "@/lib/format";
import { useOnline } from "@/lib/use-online";
import { JOB_STARTED_EVENT } from "./job-tray";
import { OFFLINE_MESSAGE, OfflineGuard } from "./offline";
import { Badge, Button, ButtonLink, Field, Sheet, buttonClass, inputClass, useToast } from "./ui";

type Details = {
  prompt: string;
  negativePrompt: string;
  params: GenerationParams;
  modeLabel: string;
  modelName: string;
  modelOutput: "image" | "video";
  usedPersonalMedia: boolean;
  attempts: number;
  providerJobId: string | null;
  template: { slug: string; title: string } | null;
  project: { id: string; title: string } | null;
  relation: string | null;
};

type Pending = { id: string; costCredits: number; label: string; isDemo: boolean };

function Media({ item, className }: { item: CreationListItem; className?: string }) {
  if (!item.output?.url) {
    const running = item.status === "queued" || item.status === "processing";
    return (
      <div className={cn("petal grid aspect-[4/5] place-items-center bg-ink-850 hairline", running && "skeleton", className)}>
        <div className="p-6 text-center">
          <p className="font-display text-2xl">{STATUS_LABEL[item.status]}</p>
          {running ? <p className="mt-1 font-mono text-[12px] text-bone-400">{elapsed(item.startedAt ?? item.queuedAt ?? item.createdAt)} elapsed</p> : null}
          {item.failureMessage ? <p className="mt-2 max-w-xs text-sm text-bone-300">{item.failureMessage}</p> : null}
        </div>
      </div>
    );
  }
  return item.output.kind === "video" ? (
    <video src={item.output.url} poster={item.output.posterUrl ?? undefined} controls loop playsInline muted preload="metadata" className={cn("petal w-full bg-ink-850", className)} aria-label="Your video" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- signed URL
    <img src={item.output.url} alt="Your creation" className={cn("petal w-full bg-ink-850 object-contain", className)} />
  );
}

export function CreationDetail({
  item,
  details,
  versions,
  folders,
  categories,
  balance,
}: {
  item: CreationListItem;
  details: Details;
  versions: CreationListItem[];
  folders: { id: string; name: string }[];
  categories: { slug: string; name: string }[];
  balance: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const online = useOnline();
  const [fav, setFav] = useState(item.isFavorited);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [compareWith, setCompareWith] = useState<CreationListItem | null>(null);
  const running = item.status === "queued" || item.status === "processing";
  const done = item.status === "completed";
  const kind = details.modelOutput;

  async function derive(relation: "retry" | "variation" | "continuation" | "extension", label: string) {
    if (!online) return;
    setBusy(relation);
    try {
      const { job } = await api<{ job: { id: string; costCredits: number; isDemo: boolean } }>(`/api/generations/${item.id}/derive`, {
        body: { relation, idempotencyKey: newIdempotencyKey() },
      });
      setPending({ id: job.id, costCredits: job.costCredits, label, isDemo: job.isDemo });
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not prepare that.", tone: "error", action: apiErrorAction(e) });
    } finally {
      setBusy(null);
    }
  }

  async function confirmPending() {
    if (!pending || !online) return;
    setBusy("confirm");
    try {
      await api(`/api/generations/${pending.id}/confirm`, { body: { expectedCost: pending.costCredits } });
      window.dispatchEvent(new Event(JOB_STARTED_EVENT));
      toast({ message: `${pending.label} started.`, action: { label: "Open", href: `/collection/${pending.id}` } });
      setPending(null);
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not start.", tone: "error", action: apiErrorAction(e) });
    } finally {
      setBusy(null);
    }
  }

  async function toggleFav() {
    const next = !fav;
    setFav(next);
    try {
      await api("/api/favorites", { method: next ? "POST" : "DELETE", body: { targetType: "creation", targetId: item.id } });
    } catch (e) {
      setFav(!next);
      toast({ message: e instanceof ApiError ? e.message : "We couldn't update your favorites. Try again.", tone: "error" });
    }
  }

  async function cancel() {
    setBusy("cancel");
    try {
      await api(`/api/generations/${item.id}/cancel`, { method: "POST" });
      toast({ message: "Cancelling. Credits come back once it stops." });
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "We couldn't cancel it. Try again.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await api(`/api/generations/${item.id}`, { method: "DELETE" });
      toast({ message: "Deleted.", tone: "success" });
      router.push("/collection");
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not delete.", tone: "error" });
      setBusy(null);
    }
  }

  const settings: [string, string | number | undefined][] = [
    ["Mode", details.modeLabel],
    ["Model", details.modelName],
    ["Aspect", details.params.aspectRatio],
    ["Length", details.params.durationS ? `${details.params.durationS}s` : undefined],
    ["Quality", details.params.quality?.toUpperCase()],
    ["Camera", details.params.cameraMovement],
    ["Motion", details.params.motionIntensity],
    ["Pacing", details.params.pacing],
    ["Lighting", details.params.lighting],
    ["Framing", details.params.framing],
    ["Seed", details.params.seed],
    ["Cost", `${item.costCredits} credits`],
  ];

  return (
    <div>
      <Link href="/collection" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-bone-400 hover:text-bone-50">
        <ArrowLeft size={15} aria-hidden /> Library
      </Link>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {compareWith ? (
            <div className="grid grid-cols-2 gap-3" aria-label="Comparison">
              <figure>
                <Media item={item} />
                <figcaption className="mt-1.5 text-[12px] text-bone-400">This one</figcaption>
              </figure>
              <figure>
                <Media item={compareWith} />
                <figcaption className="mt-1.5 flex items-center justify-between text-[12px] text-bone-400">
                  {compareWith.relation ?? "original"} · {relativeTime(compareWith.createdAt)}
                  <button type="button" onClick={() => setCompareWith(null)} className="text-bone-300 hover:text-bone-50" aria-label="Close comparison">
                    <X size={14} />
                  </button>
                </figcaption>
              </figure>
            </div>
          ) : (
            <Media item={item} />
          )}
          {item.isDemo ? (
            <p className="rounded-xl bg-iris-400/10 px-3.5 py-2.5 text-[13px] text-iris-300">
              Demo output: made locally by the development placeholder model, not by an AI model.
            </p>
          ) : null}
        </div>

        <div className="min-w-0 space-y-6">
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={item.status === "failed" ? "danger" : item.status === "completed" ? "new" : "plain"}>{STATUS_LABEL[item.status]}</Badge>
              {item.isDemo ? <Badge tone="demo">Demo</Badge> : null}
              {details.relation ? <Badge>{details.relation}</Badge> : null}
              <span className="font-mono text-[11.5px] text-bone-500">{relativeTime(item.createdAt)}</span>
            </div>
            <p className="mt-3 text-[15px] leading-relaxed">{details.prompt}</p>
            {details.negativePrompt ? <p className="mt-1 text-[13px] text-bone-400">Avoid: {details.negativePrompt}</p> : null}
            <p className="mt-2 text-[13px] text-bone-400">
              {details.template ? (
                <>
                  From{" "}
                  <Link className="text-bone-200 underline" href={`/templates/${details.template.slug}`}>
                    {details.template.title}
                  </Link>
                </>
              ) : (
                "From scratch"
              )}
              {details.project ? (
                <>
                  {" "}· in{" "}
                  <Link className="text-bone-200 underline" href={`/projects/${details.project.id}`}>
                    {details.project.title}
                  </Link>
                </>
              ) : null}
            </p>
          </div>

          {running ? (
            <Button variant="danger" onClick={cancel} busy={busy === "cancel"}>
              <X size={16} aria-hidden /> Cancel
            </Button>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <ButtonLink href={`/generate/${kind}?from=${item.id}`} variant="ember">
                <Wand2 size={16} aria-hidden /> Remix
              </ButtonLink>
              <Button onClick={() => derive("retry", "Retry")} busy={busy === "retry"} disabled={!online}>
                <Repeat size={16} aria-hidden /> Retry
              </Button>
              <Button onClick={() => derive("variation", "Variation")} busy={busy === "variation"} disabled={!done || !online}>
                <Shuffle size={16} aria-hidden /> Variation
              </Button>
              {kind === "video" ? (
                <>
                  <Button onClick={() => derive("continuation", "Continue scene")} busy={busy === "continuation"} disabled={!done || !online}>
                    <FastForward size={16} aria-hidden /> Continue
                  </Button>
                  <Button onClick={() => derive("extension", "Extend clip")} busy={busy === "extension"} disabled={!done || !online}>
                    <FastForward size={16} aria-hidden /> Extend
                  </Button>
                </>
              ) : null}
              <ButtonLink href={`/generate/${kind}?from=${item.id}&reuse=exact`}>
                <Copy size={16} aria-hidden /> Reuse settings
              </ButtonLink>
              <Button onClick={toggleFav} aria-pressed={fav}>
                <Heart size={16} className={fav ? "fill-ember-500 text-ember-500" : undefined} aria-hidden /> {fav ? "Saved" : "Save"}
              </Button>
              {done ? (
                <a href={`/api/generations/${item.id}/download`} className={buttonClass("ghost")} download>
                  <Download size={16} aria-hidden /> Download
                </a>
              ) : null}
              {done ? (
                <Button onClick={() => setFolderOpen(true)}>
                  <FolderPlus size={16} aria-hidden /> Folder
                </Button>
              ) : null}
              <Button onClick={() => setPresetOpen(true)}>
                <Bookmark size={16} aria-hidden /> Preset
              </Button>
              {done ? (
                <Button onClick={() => setPublishOpen(true)}>
                  <Send size={16} aria-hidden /> Publish
                </Button>
              ) : null}
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={16} aria-hidden /> Delete
              </Button>
            </div>
          )}
          {!running && !online ? <p className="-mt-3 text-[12.5px] text-brass-300">{OFFLINE_MESSAGE}</p> : null}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-2xl bg-ink-900 p-4 text-[13px] hairline sm:grid-cols-3">
            {settings
              .filter(([, v]) => v !== undefined && v !== "")
              .map(([k, v]) => (
                <div key={k}>
                  <dt className="tag text-bone-500">{k}</dt>
                  <dd className="mt-0.5 break-words">{v}</dd>
                </div>
              ))}
          </dl>

          {versions.length > 1 ? (
            <section>
              <h2 className="mb-2 flex items-center gap-2 font-display text-xl">
                <Columns2 size={17} aria-hidden /> Versions
              </h2>
              <p className="mb-3 text-[13px] text-bone-400">Retries, variations, continuations and remixes of the same idea. Tap one to compare side by side.</p>
              <div className="scrollbar-none -mx-1 flex gap-2.5 overflow-x-auto px-1">
                {versions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => (v.id === item.id ? setCompareWith(null) : setCompareWith(v))}
                    className={cn("w-24 shrink-0 text-left", v.id === item.id && "opacity-60")}
                    aria-label={v.id === item.id ? "This version" : `Compare with ${v.relation ?? "original"}`}
                  >
                    <div className="petal aspect-[4/5] overflow-hidden bg-ink-850 hairline">
                      {v.output?.url && v.output.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element -- signed URL
                        <img src={v.output.url} alt="" className="size-full object-cover" />
                      ) : v.output?.url ? (
                        <video src={v.output.url} poster={v.output.posterUrl ?? undefined} muted preload={v.output.posterUrl ? "none" : "metadata"} className="size-full object-cover" />
                      ) : (
                        <div className="grid size-full place-items-center text-[11px] text-bone-500">{STATUS_LABEL[v.status]}</div>
                      )}
                    </div>
                    <p className="mt-1 truncate text-[11px] text-bone-400">{v.id === item.id ? "this" : (v.relation ?? "original")}</p>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <Sheet open={Boolean(pending)} onClose={() => setPending(null)} title={pending ? `${pending.label}?` : ""}>
        {pending ? (
          <div className="space-y-4 text-sm">
            <p className="text-bone-300">
              This costs <strong className="font-mono text-bone-50">{pending.costCredits}</strong> credits. You have <span className="font-mono">{balance}</span>.
            </p>
            {pending.isDemo ? <p className="rounded-xl bg-iris-400/10 px-3.5 py-2.5 text-[13px] text-iris-300">Demo model: the result is a labeled placeholder, not AI output.</p> : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="quiet" onClick={() => setPending(null)}>
                Not now
              </Button>
              <OfflineGuard note={false}>
                <Button variant="ember" onClick={confirmPending} busy={busy === "confirm"} disabled={balance < pending.costCredits}>
                  Confirm · {pending.costCredits} credits
                </Button>
              </OfflineGuard>
            </div>
            {online ? null : <p className="text-right text-[12.5px] text-brass-300">{OFFLINE_MESSAGE}</p>}
          </div>
        ) : null}
      </Sheet>

      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this creation?">
        <p className="text-sm text-bone-300">It disappears from your Library now and is erased from storage after 30 days.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
          <Button variant="danger" onClick={remove} busy={busy === "delete"}>
            Delete
          </Button>
        </div>
      </Sheet>

      <FolderSheet open={folderOpen} onClose={() => setFolderOpen(false)} folders={folders} jobId={item.id} />
      <PresetSheet open={presetOpen} onClose={() => setPresetOpen(false)} jobId={item.id} />
      <PublishSheet open={publishOpen} onClose={() => setPublishOpen(false)} jobId={item.id} categories={categories} blocked={details.usedPersonalMedia} />
    </div>
  );
}

function FolderSheet({ open, onClose, folders, jobId }: { open: boolean; onClose: () => void; folders: { id: string; name: string }[]; jobId: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  async function add(folderId: string) {
    setBusy(true);
    try {
      await api(`/api/folders/${folderId}/items`, { body: { jobIds: [jobId] } });
      toast({ message: "Added to folder.", tone: "success" });
      onClose();
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "We couldn't add it to that folder. Try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Add to folder">
      <div className="space-y-2">
        {folders.map((f) => (
          <button key={f.id} type="button" onClick={() => void add(f.id)} disabled={busy} className="w-full rounded-xl px-3.5 py-3 text-left text-sm hairline hover:bg-ink-800">
            {f.name}
          </button>
        ))}
      </div>
      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          let folderId: string;
          try {
            ({ folder: { id: folderId } } = await api<{ folder: { id: string } }>("/api/folders", { body: { name } }));
          } catch (err) {
            toast({ message: err instanceof ApiError ? err.message : "We couldn't create that folder. Try again.", tone: "error" });
            return;
          }
          setName("");
          await add(folderId);
        }}
      >
        <div className="flex-1">
          <Field label="New folder" htmlFor="nf">
            <input id="nf" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </Field>
        </div>
        <Button type="submit" variant="bone" disabled={!name.trim()} busy={busy}>
          Create & add
        </Button>
      </form>
    </Sheet>
  );
}

function PresetSheet({ open, onClose, jobId }: { open: boolean; onClose: () => void; jobId: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Sheet open={open} onClose={onClose} title="Save as preset">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/api/presets", { body: { fromJobId: jobId, name } });
            toast({ message: "Preset saved. Start from it in Create or Studio.", tone: "success", action: { label: "Studio", href: "/studio" } });
            onClose();
          } catch (err) {
            toast({ message: err instanceof ApiError ? err.message : "Could not save.", tone: "error" });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Preset name" htmlFor="pn" hint="Saves the model, mode, prompt and settings so you can start from them again.">
          <input id="pn" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="ember" busy={busy} disabled={!name.trim()}>
            Save preset
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function PublishSheet({ open, onClose, jobId, categories, blocked }: { open: boolean; onClose: () => void; jobId: string; categories: { slug: string; name: string }[]; blocked: boolean }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(categories[0]?.slug ?? "");
  const [tags, setTags] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <Sheet open={open} onClose={onClose} title="Publish as a template">
      {blocked ? (
        <p className="text-sm text-bone-300">
          This creation used your own upload or a character reference, so it stays private to protect the people in it. Publish something made from a prompt or a template instead.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const { template } = await api<{ template: { slug: string } }>("/api/templates", {
                body: { jobId, title, description, categorySlug: category, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) },
              });
              router.push(`/templates/${template.slug}`);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Could not publish.");
              setBusy(false);
            }
          }}
        >
          <p className="text-[13px] text-bone-400">A public copy of this result becomes the cover, and your prompt and settings become the recipe others start from. Your original stays private.</p>
          <Field label="Title" htmlFor="pt">
            <input id="pt" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} required />
          </Field>
          <Field label="Description" htmlFor="pd">
            <textarea id="pd" rows={3} className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" htmlFor="pc">
              <select id="pc" className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tags" htmlFor="ptags" hint="Comma separated, up to 8.">
              <input id="ptags" className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
          </div>
          <label className="flex items-start gap-3 text-[13.5px] text-bone-300">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-ember-500)]" />
            <span>I understand this will be public to every Hushloom member, and it follows the content policy.</span>
          </label>
          {error ? <p className="text-[13px] text-danger-400" role="alert">{error}</p> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="ember" busy={busy} disabled={!agree || title.trim().length < 2}>
              Publish
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
