"use client";

import { AlertTriangle, CheckSquare, FolderPlus, Heart, Info, Play, RotateCw, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { CreationListItem } from "@/server/generation/views";
import { api, ApiError, apiErrorAction, newIdempotencyKey } from "@/lib/api";
import { cn } from "@/lib/cn";
import { STATUS_LABEL, elapsed, relativeTime } from "@/lib/format";
import { useOnline } from "@/lib/use-online";
import { JOB_STARTED_EVENT } from "./job-tray";
import { OFFLINE_MESSAGE, OfflineGuard } from "./offline";
import { Badge, Button, ButtonLink, Chip, EmptyState, Field, Sheet, inputClass, useToast } from "./ui";

type Query = { media: string; status: string; favorites: string; folder: string; model: string; sort: string };
/** A retry draft waiting for the person to confirm its cost. */
type PendingRetry = { id: string; costCredits: number; isDemo: boolean };

export function CreationThumb({ item, selectable, selected, onSelect }: { item: CreationListItem; selectable?: boolean; selected?: boolean; onSelect?: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const online = useOnline();
  const [retrying, setRetrying] = useState(false);
  const [pending, setPending] = useState<PendingRetry | null>(null);
  const [confirming, setConfirming] = useState(false);
  const running = item.status === "queued" || item.status === "processing";
  const ratio = item.output?.width && item.output.height ? `${item.output.width} / ${item.output.height}` : "4 / 5";

  // Retry makes a draft first and charges only after the person confirms the cost, like every other run.
  async function retry() {
    if (!online) return;
    setRetrying(true);
    try {
      const { job } = await api<{ job: PendingRetry }>(`/api/generations/${item.id}/derive`, { body: { relation: "retry", idempotencyKey: newIdempotencyKey() } });
      setPending({ id: job.id, costCredits: job.costCredits, isDemo: job.isDemo });
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "We couldn't set up the retry. Try again.", tone: "error", action: apiErrorAction(e) });
    } finally {
      setRetrying(false);
    }
  }

  async function confirmRetry() {
    if (!pending || !online) return;
    setConfirming(true);
    try {
      await api(`/api/generations/${pending.id}/confirm`, { body: { expectedCost: pending.costCredits } });
      window.dispatchEvent(new Event(JOB_STARTED_EVENT));
      toast({ message: pending.isDemo ? "Retrying with a demo placeholder." : "Retrying now.", action: { label: "Open", href: `/collection/${pending.id}` } });
      setPending(null);
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Retry failed.", tone: "error", action: apiErrorAction(e) });
      setPending(null);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <article className="group relative animate-rise">
      <Link
        href={`/collection/${item.id}`}
        onClick={(e) => {
          if (selectable) {
            e.preventDefault();
            onSelect?.();
          }
        }}
        className={cn("petal relative block overflow-hidden bg-ink-850 hairline", selected && "ring-2 ring-ember-500")}
        style={{ aspectRatio: ratio }}
        aria-label={`${STATUS_LABEL[item.status]}: ${item.prompt}`}
      >
        {item.output?.url ? (
          item.output.kind === "video" ? (
            <video
              src={item.output.url}
              poster={item.output.posterUrl ?? undefined}
              muted
              loop
              playsInline
              preload={item.output.posterUrl ? "none" : "metadata"}
              className="absolute inset-0 size-full object-cover"
              onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
              onMouseLeave={(e) => e.currentTarget.pause()}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- signed URL
            <img src={item.output.url} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
          )
        ) : running ? (
          <div className="skeleton absolute inset-0 grid place-items-center">
            <div className="text-center">
              <div className="relative mx-auto h-1 w-16 overflow-hidden rounded-full bg-ink-700">
                <span className="absolute inset-y-0 w-1/2 rounded-full bg-ember-500 animate-thread" />
              </div>
              <p className="mt-3 text-[13px] text-bone-200">{STATUS_LABEL[item.status]}…</p>
              <p className="font-mono text-[11px] text-bone-500">{elapsed(item.startedAt ?? item.queuedAt ?? item.createdAt)}</p>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-ink-900 p-4 text-center">
            <div>
              <AlertTriangle size={20} className={cn("mx-auto", item.status === "failed" ? "text-danger-400" : "text-bone-500")} aria-hidden />
              <p className="mt-2 text-[13px] text-bone-200">{STATUS_LABEL[item.status]}</p>
              {item.failureMessage ? <p className="mt-1 line-clamp-3 text-[12px] text-bone-400">{item.failureMessage}</p> : null}
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1">
          {item.isDemo ? <Badge tone="demo">Demo</Badge> : null}
          {item.output?.kind === "video" ? (
            <Badge tone="video">
              <Play size={9} className="fill-current" aria-hidden /> Video
            </Badge>
          ) : null}
        </div>
        {item.isFavorited ? <Heart size={16} className="absolute right-2.5 top-2.5 fill-ember-500 text-ember-500" aria-label="Favorite" /> : null}
        {selectable ? (
          <span className="absolute bottom-2 right-2 grid size-7 place-items-center rounded-full bg-ink-950/70">
            {selected ? <CheckSquare size={16} className="text-ember-400" aria-hidden /> : <Square size={16} aria-hidden />}
          </span>
        ) : null}
      </Link>
      <div className="mt-2 flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <p className="truncate text-[13px] text-bone-200">{item.templateTitle ?? item.prompt}</p>
          <p className="font-mono text-[11px] text-bone-500">{relativeTime(item.createdAt)}</p>
        </div>
        {item.status === "failed" ? (
          <OfflineGuard note={false} className="shrink-0">
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-ember-400 hover:text-ember-300 disabled:text-bone-500"
              title={online ? undefined : OFFLINE_MESSAGE}
            >
              <RotateCw size={12} className={retrying ? "animate-spin" : undefined} aria-hidden /> Retry
            </button>
          </OfflineGuard>
        ) : null}
      </div>

      <Sheet open={Boolean(pending)} onClose={() => setPending(null)} title="Try it again?">
        {pending ? (
          <div className="space-y-4 text-[14px]">
            <dl className="rounded-2xl bg-ink-850 hairline">
              <div className="flex justify-between px-4 py-3">
                <dt className="text-bone-300">Cost</dt>
                <dd className="font-mono">{pending.costCredits} credits</dd>
              </div>
            </dl>
            {pending.isDemo ? (
              <p className="flex gap-2 rounded-2xl bg-iris-400/10 p-3.5 text-[13px] text-iris-300">
                <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
                This server runs the demo model. You will get a labeled placeholder made locally, not an AI-generated result.
              </p>
            ) : null}
            <p className="text-[12.5px] text-bone-400">Same prompt and settings. If it fails, your credits come back automatically.</p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="quiet" onClick={() => setPending(null)}>
                Not now
              </Button>
              <OfflineGuard note={false}>
                <Button variant="ember" onClick={confirmRetry} busy={confirming}>
                  Confirm · {pending.costCredits} credits
                </Button>
              </OfflineGuard>
            </div>
            {online ? null : <p className="text-right text-[12.5px] text-brass-300">{OFFLINE_MESSAGE}</p>}
          </div>
        ) : null}
      </Sheet>
    </article>
  );
}

export function LibraryView({
  items,
  folders,
  models,
  query,
}: {
  items: CreationListItem[];
  folders: { id: string; name: string }[];
  models: { key: string; name: string }[];
  query: Query;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [busy, setBusy] = useState(false);

  const go = (patch: Partial<Query>) => {
    const next = { ...query, ...patch };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) sp.set(k, v);
    router.push(`${pathname}${sp.size ? `?${sp}` : ""}`);
  };
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function deleteSelected() {
    setBusy(true);
    let failed = 0;
    for (const id of selected) {
      try {
        await api(`/api/generations/${id}`, { method: "DELETE" });
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setConfirmDelete(false);
    setSelected([]);
    setSelecting(false);
    toast({ message: failed ? `${selected.length - failed} deleted, ${failed} still running (cancel them first).` : `${selected.length} deleted.`, tone: failed ? "error" : "success" });
    router.refresh();
  }

  async function addToFolder(folderId: string) {
    setBusy(true);
    try {
      const { added } = await api<{ added: number }>(`/api/folders/${folderId}/items`, { body: { jobIds: selected } });
      toast({ message: `${added} added to folder.`, tone: "success" });
      setFolderOpen(false);
      setSelecting(false);
      setSelected([]);
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not add.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const filtered = Object.values(query).some(Boolean);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="tag text-ember-400">Private to you</p>
          <h1 className="font-display text-4xl">Library</h1>
        </div>
        <div className="flex gap-2">
          {selecting ? (
            <>
              <Button size="sm" variant="ghost" disabled={!selected.length} onClick={() => setFolderOpen(true)}>
                <FolderPlus size={15} aria-hidden /> Add to folder
              </Button>
              <Button size="sm" variant="danger" disabled={!selected.length} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} aria-hidden /> Delete {selected.length || ""}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => { setSelecting(false); setSelected([]); }}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setSelecting(true)} disabled={!items.length}>
                <CheckSquare size={15} aria-hidden /> Select
              </Button>
              <ButtonLink href="/projects" size="sm" variant="ghost">
                Projects
              </ButtonLink>
            </>
          )}
        </div>
      </div>

      <div className="mb-3 scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1" aria-label="Filters">
        <Chip active={!query.media && !query.favorites} onClick={() => go({ media: "", favorites: "" })}>
          All
        </Chip>
        <Chip active={query.media === "image"} onClick={() => go({ media: "image" })}>
          Images
        </Chip>
        <Chip active={query.media === "video"} onClick={() => go({ media: "video" })}>
          Videos
        </Chip>
        <Chip active={query.favorites === "1"} onClick={() => go({ favorites: query.favorites ? "" : "1" })}>
          ♥ Favorites
        </Chip>
        <span className="mx-1 w-px shrink-0 bg-[var(--line)]" aria-hidden />
        <select aria-label="Status" value={query.status} onChange={(e) => go({ status: e.target.value })} className="h-8 shrink-0 rounded-full bg-ink-900 px-3 text-[13px] text-bone-300 hairline">
          <option value="">Any status</option>
          <option value="completed">Ready</option>
          <option value="processing">Weaving</option>
          <option value="queued">Queued</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select aria-label="Model" value={query.model} onChange={(e) => go({ model: e.target.value })} className="h-8 shrink-0 rounded-full bg-ink-900 px-3 text-[13px] text-bone-300 hairline">
          <option value="">Any model</option>
          {models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name}
            </option>
          ))}
        </select>
        <select aria-label="Folder" value={query.folder} onChange={(e) => go({ folder: e.target.value })} className="h-8 shrink-0 rounded-full bg-ink-900 px-3 text-[13px] text-bone-300 hairline">
          <option value="">All folders</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select aria-label="Sort" value={query.sort} onChange={(e) => go({ sort: e.target.value })} className="h-8 shrink-0 rounded-full bg-ink-900 px-3 text-[13px] text-bone-300 hairline">
          <option value="">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      {items.length === 0 ? (
        filtered ? (
          <EmptyState title="Nothing here" body="No creations match these filters." action={<Button onClick={() => router.push(pathname)}>Clear filters</Button>} />
        ) : (
          <EmptyState title="Your Library is empty" body="Everything you make lands here, private to you." action={<ButtonLink href="/" variant="ember">Find a template</ButtonLink>} />
        )
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {items.map((it) => (
            <CreationThumb key={it.id} item={it} selectable={selecting} selected={selected.includes(it.id)} onSelect={() => toggle(it.id)} />
          ))}
        </div>
      )}

      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${selected.length} creation${selected.length === 1 ? "" : "s"}?`}>
        <p className="text-sm text-bone-300">They disappear from your Library now and are permanently erased from storage after 30 days. Credits are not refunded for finished creations.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
          <Button variant="danger" busy={busy} onClick={deleteSelected}>
            Delete
          </Button>
        </div>
      </Sheet>

      <Sheet open={folderOpen} onClose={() => setFolderOpen(false)} title="Add to folder">
        <div className="space-y-2">
          {folders.map((f) => (
            <button key={f.id} type="button" onClick={() => void addToFolder(f.id)} disabled={busy} className="flex w-full items-center justify-between rounded-xl px-3.5 py-3 text-left text-sm hairline hover:bg-ink-800">
              {f.name}
            </button>
          ))}
        </div>
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newFolder.trim()) return;
            let folderId: string;
            try {
              ({ folder: { id: folderId } } = await api<{ folder: { id: string } }>("/api/folders", { body: { name: newFolder.trim() } }));
            } catch (err) {
              toast({ message: err instanceof ApiError ? err.message : "We couldn't create that folder. Try again.", tone: "error" });
              return;
            }
            setNewFolder("");
            await addToFolder(folderId);
          }}
        >
          <div className="flex-1">
            <Field label="New folder" htmlFor="newfolder">
              <input id="newfolder" className={inputClass} value={newFolder} onChange={(e) => setNewFolder(e.target.value)} maxLength={40} />
            </Field>
          </div>
          <Button type="submit" variant="bone" disabled={!newFolder.trim()} busy={busy}>
            Create & add
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
