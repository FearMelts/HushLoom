"use client";

import { Eye, EyeOff, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { compact } from "@/lib/format";
import { Badge, Button, Field, Sheet, inputClass, useToast } from "./ui";

type Row = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  isVip: boolean;
  mediaType: string;
  version: number;
  posterUrl: string | null;
  /** The cover was made by a demo model: a labeled placeholder, not AI output. */
  isDemo: boolean;
  favorites: number;
  generations: number;
  rating: number | null;
  ratingCount: number;
  views30: number;
  generations30: number;
  /** The current version's prompt; editing it publishes the next version. */
  prompt: string;
};

export function CreatorManage({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function patch(id: string, body: Record<string, unknown>, done: string) {
    setBusy(id);
    try {
      await api(`/api/templates/${id}`, { method: "PATCH", body });
      toast({ message: done, tone: "success" });
      setEditing(null);
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not save.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (!rows.length) return <p className="text-sm text-bone-400">Publish a creation from your Library to start a template.</p>;

  const actions = (r: Row) => (
    <div className="flex shrink-0 justify-end gap-1">
      <Button size="sm" variant="quiet" aria-label={`Edit ${r.title}`} onClick={() => setEditing(r)}>
        <Pencil size={13} aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="quiet"
        busy={busy === r.id}
        aria-label={r.status === "published" ? `Unpublish ${r.title}` : `Publish ${r.title}`}
        onClick={() =>
          patch(r.id, { status: r.status === "published" ? "unpublished" : "published" }, r.status === "published" ? "Unpublished. Only you can see it now." : "Published.")
        }
      >
        {r.status === "published" ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
      </Button>
    </div>
  );
  const poster = (r: Row) =>
    r.posterUrl ? (
      // eslint-disable-next-line @next/next/no-img-element -- signed URL
      <img src={r.posterUrl} alt="" className="size-9 shrink-0 rounded-md object-cover max-sm:size-10" />
    ) : (
      <span className="size-9 shrink-0 rounded-md bg-ink-800 max-sm:size-10" />
    );
  const status = (r: Row) => (
    <>
      <Badge tone={r.status === "published" ? "new" : "plain"}>{r.status}</Badge> {r.isVip ? <Badge tone="vip">VIP</Badge> : null}{" "}
      {/* The thumbnail is too small to carry the badge, so it sits with the status, beside the thumbnail on phones. */}
      {r.isDemo ? <Badge tone="demo">Demo</Badge> : null}
    </>
  );

  return (
    <>
      <p className="mb-3 text-[12.5px] text-bone-500">
        Views and uses in the last 30 days are counted from signed-in visitors who keep history on. Totals are lifetime.
      </p>
      {/* Phones: one stacked row per template, with its numbers on a line and both actions in view. */}
      <ul className="divide-y divide-bone-50/5 border-y border-bone-50/10 sm:hidden" aria-label="Your templates">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex items-center gap-3">
              <Link href={`/templates/${r.slug}`} className="flex min-h-10 min-w-0 flex-1 items-center gap-3 hover:text-ember-400">
                {poster(r)}
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px]">
                    {r.title} <span className="font-mono text-[11px] text-bone-500">v{r.version}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">{status(r)}</span>
                </span>
              </Link>
              {actions(r)}
            </div>
            <p className="mt-1.5 pl-[52px] font-mono text-[11.5px] leading-relaxed text-bone-400">
              {compact(r.views30)} views 30d · {compact(r.generations30)} uses 30d · {compact(r.generations)} uses · {compact(r.favorites)} saves ·{" "}
              {r.rating ? `★ ${r.rating} (${r.ratingCount})` : "no rating"}
            </p>
          </li>
        ))}
      </ul>
      <div className="edge-fade hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="text-bone-500">
            <tr className="border-b border-bone-50/10">
              <th className="py-2 font-medium">Template</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 text-right font-medium">Views 30d</th>
              <th className="py-2 text-right font-medium">Uses 30d</th>
              <th className="py-2 text-right font-medium">Uses</th>
              <th className="py-2 text-right font-medium">Saves</th>
              <th className="py-2 text-right font-medium">Rating</th>
              <th className="py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-bone-50/5">
                <td className="py-2.5">
                  <Link href={`/templates/${r.slug}`} className="flex items-center gap-2.5 hover:text-ember-400">
                    {poster(r)}
                    <span>
                      {r.title} <span className="font-mono text-[11px] text-bone-500">v{r.version}</span>
                    </span>
                  </Link>
                </td>
                <td className="py-2.5">{status(r)}</td>
                <td className="py-2.5 text-right font-mono">{compact(r.views30)}</td>
                <td className="py-2.5 text-right font-mono">{compact(r.generations30)}</td>
                <td className="py-2.5 text-right font-mono">{compact(r.generations)}</td>
                <td className="py-2.5 text-right font-mono">{compact(r.favorites)}</td>
                <td className="py-2.5 text-right font-mono">{r.rating ? `${r.rating} (${r.ratingCount})` : "–"}</td>
                <td className="py-2.5 text-right">{actions(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The sheet stays mounted so it can animate closed; the form inside starts fresh per template. */}
      <Sheet open={Boolean(editing)} onClose={() => setEditing(null)} title="Edit template">
        {editing ? (
          <EditForm
            key={editing.id}
            row={editing}
            busy={busy === editing.id}
            onSave={(body) => patch(editing.id, body, body.prompt ? `Saved as version ${editing.version + 1}.` : "Saved.")}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function EditForm({ row, onSave, busy }: { row: Row; onSave: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [title, setTitle] = useState(row.title);
  const [description, setDescription] = useState(row.description);
  const [isVip, setIsVip] = useState(row.isVip);
  const [prompt, setPrompt] = useState(row.prompt);
  const [changelog, setChangelog] = useState("");
  const promptChanged = prompt.trim() !== row.prompt.trim();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        // Only a changed prompt is sent: the server then publishes the next version with it.
        onSave(promptChanged ? { title, description, isVip, prompt, changelog: changelog.trim() } : { title, description, isVip });
      }}
    >
      <Field label="Title" htmlFor="et">
        <input id="et" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} minLength={2} maxLength={60} required />
      </Field>
      <Field label="Description" htmlFor="ed">
        <textarea id="ed" className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <label className="flex items-center gap-2.5 text-sm text-bone-200">
        <input type="checkbox" checked={isVip} onChange={(e) => setIsVip(e.target.checked)} className="accent-[var(--color-ember-500)]" />
        VIP only (pass holders can use it)
      </label>
      <Field label="Prompt" htmlFor="ep" hint={`This is version ${row.version}. Change the prompt and you publish version ${row.version + 1}; what people already made keeps the version they used.`}>
        <textarea id="ep" className={inputClass} rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} minLength={1} maxLength={2000} required />
      </Field>
      {promptChanged ? (
        <Field label="What changed" htmlFor="ec" hint="Optional. Shown in the version history on the template page.">
          <input id="ec" className={inputClass} value={changelog} onChange={(e) => setChangelog(e.target.value)} maxLength={200} placeholder="Warmer light, slower pacing" />
        </Field>
      ) : null}
      <Button type="submit" variant="ember" className="w-full" busy={busy}>
        {promptChanged ? `Publish version ${row.version + 1}` : "Save"}
      </Button>
    </form>
  );
}
