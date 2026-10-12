"use client";

import { ShieldCheck, Trash2, Upload, UserRoundPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Button, ButtonLink, EmptyState, Field, Sheet, inputClass, useToast } from "./ui";

type Character = { id: string; name: string; createdAt: string; consentGrantedAt: string; imageUrl: string | null };

export function TrainView({ characters, statement }: { characters: Character[]; statement: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [adult, setAdult] = useState(false);
  const [likeness, setLikeness] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Character | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function reset() {
    setName("");
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setAdult(false);
    setLikeness(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set("file", file);
    form.set("name", name);
    form.set("consentAdult", String(adult));
    form.set("consentLikeness", String(likeness));
    try {
      const res = await api<{ warnings: string[] }>("/api/characters", { form });
      toast({
        message: res.warnings.includes("low_resolution") ? "Added. The photo is small, so likeness may drift. A sharper photo helps." : "Character added.",
        tone: "success",
      });
      setOpen(false);
      reset();
      router.refresh();
    } catch (err) {
      toast({ message: err instanceof ApiError ? err.message : "Upload failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="tag text-ember-400">Consistent characters</p>
          <h1 className="font-display text-4xl">Train</h1>
          <p className="mt-1 max-w-2xl text-sm text-bone-400">
            Add a consented reference photo and pick it when you make a still, or attach it to a project scene. Honest note: this build does not fine-tune a model.
            The photo is sent to a model that accepts a reference image at generation time, and nothing else is learned from it.
          </p>
        </div>
        <Button variant="ember" onClick={() => setOpen(true)}>
          <UserRoundPlus size={16} aria-hidden /> Add a character
        </Button>
      </div>

      {characters.length ? (
        <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {characters.map((c) => (
            <li key={c.id}>
              <div className="petal relative aspect-[4/5] overflow-hidden bg-ink-850 hairline">
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed URL
                  <img src={c.imageUrl} alt={`Reference photo for ${c.name}`} className="absolute inset-0 size-full object-cover" />
                ) : null}
              </div>
              <div className="mt-2 flex items-start justify-between gap-2 px-0.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-bone-100">{c.name}</p>
                  <p className="flex items-center gap-1 font-mono text-[11px] text-bone-500">
                    <ShieldCheck size={11} aria-hidden /> consent {relativeTime(c.consentGrantedAt)}
                  </p>
                </div>
                <button type="button" onClick={() => setRemoving(c)} className="grid size-8 place-items-center rounded-full text-bone-500 hover:bg-ink-800 hover:text-danger-400" aria-label={`Remove ${c.name}`}>
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
              <ButtonLink href={`/generate/image?character=${c.id}`} size="sm" variant="ghost" className="mt-2 w-full">
                Make a still
              </ButtonLink>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No characters yet" body="Only add yourself, or an adult who explicitly agreed to sexual content made with their likeness. You can remove a character at any time." />
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Add a character">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name" htmlFor="cn" hint="Only you see this.">
            <input id="cn" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </Field>
          <div>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              id="cf"
              data-testid="character-input"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (preview) URL.revokeObjectURL(preview);
                setPreview(f ? URL.createObjectURL(f) : null);
              }}
            />
            <label htmlFor="cf" className="petal flex cursor-pointer items-center gap-3 border border-dashed border-bone-500/40 p-3 hover:border-ember-400">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local preview
                <img src={preview} alt="" className="size-16 rounded-lg object-cover" />
              ) : (
                <span className="grid size-16 place-items-center rounded-lg bg-ink-850 text-bone-400">
                  <Upload size={18} aria-hidden />
                </span>
              )}
              <span className="text-[13px] text-bone-300">{file ? file.name : "A clear, well-lit photo of one face. JPG, PNG or WebP."}</span>
            </label>
          </div>
          <fieldset className="space-y-2.5 rounded-xl bg-ink-850 p-3.5">
            <legend className="sr-only">Consent</legend>
            <label className="flex items-start gap-2.5 text-[13px] text-bone-200">
              <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-0.5 accent-[var(--color-ember-500)]" data-testid="consent-adult" />
              The person in this photo is an adult (18+).
            </label>
            <label className="flex items-start gap-2.5 text-[13px] text-bone-200">
              <input type="checkbox" checked={likeness} onChange={(e) => setLikeness(e.target.checked)} className="mt-0.5 accent-[var(--color-ember-500)]" data-testid="consent-likeness" />
              {statement}
            </label>
          </fieldset>
          <Button type="submit" variant="ember" className="w-full" busy={busy} disabled={!file || !name.trim() || !adult || !likeness}>
            Add character
          </Button>
        </form>
      </Sheet>

      <Sheet open={Boolean(removing)} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ""}?`}>
        <p className="text-sm text-bone-300">
          This withdraws the likeness consent. The reference photo and every creation made with it are deleted from your Library and from storage right away. It cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={() => setRemoving(null)}>
            Keep
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={async () => {
              if (!removing) return;
              setBusy(true);
              try {
                await api(`/api/characters/${removing.id}`, { method: "DELETE" });
                toast({ message: "Removed, with everything made from it.", tone: "success" });
                setRemoving(null);
                router.refresh();
              } catch (err) {
                toast({ message: err instanceof ApiError ? err.message : "Could not remove.", tone: "error" });
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove and delete
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
