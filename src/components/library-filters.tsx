"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button, Field, Sheet, inputClass } from "./ui";

export type LibraryExtraQuery = { project: string; template: string; creator: string; quality: string; from: string; to: string };
export type LibraryFacets = {
  projects: { id: string; title: string }[];
  templates: { id: string; title: string }[];
  creators: { id: string; handle: string; displayName: string }[];
};

const KEYS = ["project", "template", "creator", "quality", "from", "to"] as const;
const EMPTY: LibraryExtraQuery = { project: "", template: "", creator: "", quality: "", from: "", to: "" };

/**
 * The Library's finer filters: project, template, the template's creator, quality and a date
 * range. One compact row (a "More filters" button plus a removable pill per active filter); the
 * controls live in a sheet so the main filter bar stays one line on a phone. Every value is in the
 * URL next to the Library's own filters, which it leaves untouched.
 */
export function LibraryFilters({ facets, value }: { facets: LibraryFacets; value: LibraryExtraQuery }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  const go = (next: LibraryExtraQuery) => {
    const sp = new URLSearchParams(params.toString());
    for (const k of KEYS) {
      if (next[k]) sp.set(k, next[k]);
      else sp.delete(k);
    }
    router.push(`${pathname}${sp.size ? `?${sp}` : ""}`);
  };

  const pills: { key: (typeof KEYS)[number]; label: string }[] = [];
  const project = facets.projects.find((p) => p.id === value.project);
  if (value.project) pills.push({ key: "project", label: `Project: ${project?.title ?? "unknown"}` });
  const template = facets.templates.find((t) => t.id === value.template);
  if (value.template) pills.push({ key: "template", label: `Template: ${template?.title ?? "unknown"}` });
  const creator = facets.creators.find((c) => c.id === value.creator);
  if (value.creator) pills.push({ key: "creator", label: `By @${creator?.handle ?? "unknown"}` });
  if (value.quality) pills.push({ key: "quality", label: value.quality === "4k" ? "4K" : "HD" });
  if (value.from) pills.push({ key: "from", label: `From ${value.from}` });
  if (value.to) pills.push({ key: "to", label: `To ${value.to}` });

  return (
    <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        variant="ghost"
        aria-haspopup="dialog"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        <SlidersHorizontal size={14} aria-hidden /> More filters{pills.length ? ` · ${pills.length}` : ""}
      </Button>
      {pills.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => go({ ...value, [p.key]: "" })}
          className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-ink-800 px-3 text-[12.5px] text-bone-200 hover:bg-ink-700 max-sm:h-10"
          aria-label={`Remove filter ${p.label}`}
        >
          <span className="truncate">{p.label}</span>
          <X size={13} className="shrink-0" aria-hidden />
        </button>
      ))}

      <Sheet open={open} onClose={() => setOpen(false)} title="More filters">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setOpen(false);
            go(draft);
          }}
        >
          <Field label="Project" htmlFor="lf-project">
            <select id="lf-project" className={inputClass} value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })}>
              <option value="">Any project</option>
              {facets.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Template" htmlFor="lf-template">
            <select id="lf-template" className={inputClass} value={draft.template} onChange={(e) => setDraft({ ...draft, template: e.target.value })}>
              <option value="">Any template</option>
              {facets.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Template creator" htmlFor="lf-creator">
            <select id="lf-creator" className={inputClass} value={draft.creator} onChange={(e) => setDraft({ ...draft, creator: e.target.value })}>
              <option value="">Anyone</option>
              {facets.creators.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} (@{c.handle})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quality" htmlFor="lf-quality">
            <select id="lf-quality" className={inputClass} value={draft.quality} onChange={(e) => setDraft({ ...draft, quality: e.target.value })}>
              <option value="">Any quality</option>
              <option value="hd">HD</option>
              <option value="4k">4K</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="lf-from">
              <input id="lf-from" type="date" className={inputClass} value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </Field>
            <Field label="To" htmlFor="lf-to">
              <input id="lf-to" type="date" className={inputClass} value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </Field>
          </div>
          <p className="text-[12.5px] text-bone-500">Dates are whole days in UTC.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="quiet" onClick={() => setDraft(EMPTY)}>
              Reset
            </Button>
            <Button type="submit" variant="ember">
              Show creations
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
