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
  favorites: number;
  generations: number;
  rating: number | null;
  ratingCount: number;
  views30: number;
  generations30: number;
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
  return (
    <>
      <p className="mb-3 text-[12.5px] text-bone-500">
        Views and uses in the last 30 days are counted from signed-in visitors who keep history on. Totals are lifetime.
      </p>
      <div className="overflow-x-auto">
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
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-bone-50/5">
                <td className="py-2.5">
                  <Link href={`/templates/${r.slug}`} className="flex items-center gap-2.5 hover:text-ember-400">
                    {r.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed URL
                      <img src={r.posterUrl} alt="" className="size-9 rounded-md object-cover" />
                    ) : (
                      <span className="size-9 rounded-md bg-ink-800" />
                    )}
                    <span>
                      {r.title} <span className="font-mono text-[11px] text-bone-500">v{r.version}</span>
                    </span>
                  </Link>
                </td>
                <td className="py-2.5">
                  <Badge tone={r.status === "published" ? "new" : "plain"}>{r.status}</Badge> {r.isVip ? <Badge tone="vip">VIP</Badge> : null}
                </td>
                <td className="py-2.5 text-right font-mono">{compact(r.views30)}</td>
                <td className="py-2.5 text-right font-mono">{compact(r.generations30)}</td>
                <td className="py-2.5 text-right font-mono">{compact(r.generations)}</td>
                <td className="py-2.5 text-right font-mono">{compact(r.favorites)}</td>
                <td className="py-2.5 text-right font-mono">{r.rating ? `${r.rating} (${r.ratingCount})` : "–"}</td>
                <td className="py-2.5 text-right">
                  <div className="flex justify-end gap-1">
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? <EditSheet row={editing} onClose={() => setEditing(null)} onSave={(body) => patch(editing.id, body, "Saved.")} busy={busy === editing.id} /> : null}
    </>
  );
}

function EditSheet({ row, onClose, onSave, busy }: { row: Row; onClose: () => void; onSave: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [title, setTitle] = useState(row.title);
  const [description, setDescription] = useState(row.description);
  const [isVip, setIsVip] = useState(row.isVip);
  return (
    <Sheet open onClose={onClose} title="Edit template">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ title, description, isVip });
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
        <p className="text-[12.5px] text-bone-500">To change the prompt, publish a new version from a creation. Existing remixes keep the version they used.</p>
        <Button type="submit" variant="ember" className="w-full" busy={busy}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}
