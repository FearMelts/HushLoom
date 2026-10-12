"use client";

import { ArrowLeft, ArrowRight, Check, Clapperboard, GitBranch, ImagePlus, Layers, Play, Plus, SplitSquareHorizontal, Trash2, Video } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ContinuityGuide } from "@/server/db/schema";
import type { CreationListItem } from "@/server/generation/views";
import type { SceneDetail } from "@/server/projects";
import { FRAMINGS, LIGHTINGS } from "@/server/ai/registry";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { cn } from "@/lib/cn";
import { STATUS_LABEL, relativeTime } from "@/lib/format";
import { JOB_STARTED_EVENT } from "./job-tray";
import { CreationThumb } from "./library";
import { Badge, Button, ButtonLink, EmptyState, Field, Sheet, inputClass, useToast } from "./ui";

type ProjectSummary = {
  id: string;
  title: string;
  description: string;
  updatedAt: string;
  scenes: number;
  clips: number;
  cover: { kind: "image" | "video"; url: string | null; posterUrl: string | null } | null;
};

function Media({ output, className }: { output: { kind: "image" | "video"; url: string | null; posterUrl?: string | null } | null; className?: string }) {
  if (!output?.url) return <div className={cn("grid place-items-center bg-ink-850 text-bone-500", className)}><Clapperboard size={22} aria-hidden /></div>;
  return output.kind === "video" ? (
    <video src={output.url} poster={output.posterUrl ?? undefined} muted playsInline preload={output.posterUrl ? "none" : "metadata"} className={cn("object-cover", className)} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- signed URL
    <img src={output.url} alt="" loading="lazy" className={cn("object-cover", className)} />
  );
}

export function ProjectsIndex({ projects }: { projects: ProjectSummary[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { project } = await api<{ project: { id: string } }>("/api/projects", { body: { title, description } });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      toast({ message: err instanceof ApiError ? err.message : "Could not create the project.", tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="tag text-ember-400">Scenes that belong together</p>
          <h1 className="font-display text-4xl">Projects</h1>
          <p className="mt-1 max-w-xl text-sm text-bone-400">
            A project keeps a sequence of scenes with one continuity guide: lighting, framing, palette and character carry from scene to scene.
          </p>
        </div>
        <Button variant="ember" onClick={() => setOpen(true)}>
          <Plus size={16} aria-hidden /> New project
        </Button>
      </div>
      {projects.length ? (
        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="group block">
                <div className="petal relative aspect-video overflow-hidden hairline">
                  <Media output={p.cover} className="absolute inset-0 size-full transition-transform duration-[var(--duration-slow)] group-hover:scale-[1.03]" />
                </div>
                <div className="mt-2.5 px-0.5">
                  <p className="font-display text-xl">{p.title}</p>
                  <p className="font-mono text-[11px] text-bone-500">
                    {p.scenes} {p.scenes === 1 ? "scene" : "scenes"} · {p.clips} finished · {relativeTime(p.updatedAt)}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No projects yet"
          body="Start one when a single image or clip is not enough: a story told across scenes that should look like they belong together."
          action={
            <Button variant="ember" onClick={() => setOpen(true)}>
              Start a project
            </Button>
          }
        />
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="New project">
        <form onSubmit={create} className="space-y-4">
          <Field label="Name" htmlFor="pt">
            <input id="pt" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required autoFocus />
          </Field>
          <Field label="What is it about?" htmlFor="pd" hint="Optional. Only you see this.">
            <textarea id="pd" className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
          <Button type="submit" variant="ember" busy={busy} className="w-full">
            Create project
          </Button>
        </form>
      </Sheet>
    </div>
  );
}

type Workspace = {
  project: { id: string; title: string; description: string; updatedAt: string };
  scenes: SceneDetail[];
  loose: CreationListItem[];
};

const takeOf = (s: SceneDetail) => s.versions.find((v) => v.isSelected) ?? [...s.versions].reverse().find((v) => v.creation.status === "completed");

export function ProjectWorkspace({ data, characters }: { data: Workspace; characters: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [activeId, setActiveId] = useState(data.scenes[0]?.id ?? "");
  const active = data.scenes.find((s) => s.id === activeId) ?? data.scenes[0];
  const [compare, setCompare] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Running jobs change state on the server; refresh while any are in flight.
  const running = data.scenes.some((s) => s.versions.some((v) => v.creation.status === "queued" || v.creation.status === "processing"));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [running, router]);

  async function act(label: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(label);
    try {
      await fn();
      if (success) toast({ message: success, tone: "success" });
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "That did not work.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const move = (index: number, dir: -1 | 1) => {
    const order = data.scenes.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j]!, order[index]!];
    void act("order", () => api(`/api/projects/${data.project.id}/scenes`, { method: "PUT", body: { order } }));
  };

  const addScene = () =>
    act("add", async () => {
      const { scene } = await api<{ scene: { id: string } }>(`/api/projects/${data.project.id}/scenes`, { body: { title: `Scene ${data.scenes.length + 1}` } });
      setActiveId(scene.id);
    });

  async function derive(jobId: string, relation: "variation" | "continuation") {
    setBusy(`${relation}:${jobId}`);
    try {
      const { job } = await api<{ job: { id: string; costCredits: number; isDemo: boolean } }>(`/api/generations/${jobId}/derive`, {
        body: { relation, idempotencyKey: newIdempotencyKey() },
      });
      if (!window.confirm(`${relation === "variation" ? "Make a variation" : "Continue this clip"} for ${job.costCredits} credits?${job.isDemo ? " (Demo model: the output is a labeled placeholder.)" : ""}`)) {
        await api(`/api/generations/${job.id}/cancel`, { body: {} });
        return;
      }
      await api(`/api/generations/${job.id}/confirm`, { body: { expectedCost: job.costCredits } });
      window.dispatchEvent(new Event(JOB_STARTED_EVENT));
      toast({ message: "Started. It will appear in this scene.", tone: "success" });
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not start.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const sequence = data.scenes.map(takeOf).filter((v) => v?.creation.output?.kind === "video" && v.creation.output.url);
  const compared = active?.versions.filter((v) => compare.includes(v.id)) ?? [];

  return (
    <div>
      <Link href="/projects" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-bone-400 hover:text-bone-50">
        <ArrowLeft size={14} aria-hidden /> Projects
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-4xl">{data.project.title}</h1>
          {data.project.description ? <p className="mt-1 max-w-2xl text-sm text-bone-400">{data.project.description}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={!sequence.length} onClick={() => setPlaying(true)}>
            <Play size={14} aria-hidden /> Play sequence
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setRenaming(true)}>
            Rename
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(true)} aria-label="Delete project">
            <Trash2 size={14} aria-hidden />
          </Button>
        </div>
      </div>

      <section aria-label="Scene timeline" className="-mx-4 mb-8 overflow-x-auto px-4 pb-2">
        <ol className="flex gap-3">
          {data.scenes.map((s, i) => {
            const take = takeOf(s);
            return (
              <li key={s.id} className="w-44 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(s.id);
                    setCompare([]);
                  }}
                  aria-current={s.id === active?.id ? "step" : undefined}
                  className={cn("petal relative block aspect-video w-full overflow-hidden hairline text-left", s.id === active?.id && "ring-2 ring-ember-500")}
                >
                  <Media output={take?.creation.output ?? null} className="absolute inset-0 size-full" />
                  <span className="absolute left-2 top-2 font-mono text-[11px] text-bone-50 drop-shadow">{String(i + 1).padStart(2, "0")}</span>
                </button>
                <div className="mt-1.5 flex items-center justify-between gap-1">
                  <p className="truncate text-[13px] text-bone-200">{s.title}</p>
                  <span className="flex shrink-0">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0 || busy === "order"} className="grid size-7 place-items-center rounded-full text-bone-400 hover:bg-ink-800 hover:text-bone-50 disabled:opacity-30" aria-label={`Move ${s.title} earlier`}>
                      <ArrowLeft size={13} aria-hidden />
                    </button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === data.scenes.length - 1 || busy === "order"} className="grid size-7 place-items-center rounded-full text-bone-400 hover:bg-ink-800 hover:text-bone-50 disabled:opacity-30" aria-label={`Move ${s.title} later`}>
                      <ArrowRight size={13} aria-hidden />
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
          <li className="w-44 shrink-0">
            <button type="button" onClick={addScene} disabled={busy === "add"} className="petal grid aspect-video w-full place-items-center border border-dashed border-bone-500/40 text-bone-400 hover:border-ember-400 hover:text-ember-400">
              <span className="flex items-center gap-1.5 text-sm">
                <Plus size={16} aria-hidden /> Add scene
              </span>
            </button>
          </li>
        </ol>
      </section>

      {active ? (
        <div className="grid gap-8 lg:grid-cols-[340px_1fr]">
          <SceneGuide key={active.id} scene={active} characters={characters} onSaved={() => router.refresh()} canDelete={data.scenes.length > 1} />
          <section aria-label="Versions">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-2xl">Takes for “{active.title}”</h2>
              <div className="flex gap-2">
                <ButtonLink size="sm" variant="ember" href={`/generate/video?scene=${active.id}`}>
                  <Video size={14} aria-hidden /> Make a clip
                </ButtonLink>
                <ButtonLink size="sm" variant="ghost" href={`/generate/image?scene=${active.id}`}>
                  <ImagePlus size={14} aria-hidden /> Make a still
                </ButtonLink>
              </div>
            </div>
            {compared.length === 2 ? (
              <div className="mb-5 rounded-[20px_6px_20px_6px] bg-ink-900 p-3 hairline">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm text-bone-300">Side by side</p>
                  <Button size="sm" variant="quiet" onClick={() => setCompare([])}>
                    Close
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {compared.map((v) => (
                    <figure key={v.id}>
                      <Media output={v.creation.output} className="aspect-video w-full rounded-xl" />
                      <figcaption className="mt-1 font-mono text-[11px] text-bone-500">
                        {v.branchLabel} · {relativeTime(v.createdAt)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            ) : null}
            {active.versions.length ? (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {[...active.versions].reverse().map((v) => {
                  const parent = active.versions.find((p) => p.id === v.parentVersionId);
                  const done = v.creation.status === "completed";
                  return (
                    <li key={v.id} className={cn("rounded-[20px_6px_20px_6px] p-2.5 hairline", v.isSelected && "bg-ember-500/5 ring-1 ring-ember-500/60")}>
                      <CreationThumb item={v.creation} />
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {v.isSelected ? <Badge tone="new">Take</Badge> : null}
                        <Badge>
                          <GitBranch size={9} aria-hidden /> {v.branchLabel}
                        </Badge>
                        {parent ? <span className="font-mono text-[11px] text-bone-500">from {relativeTime(parent.createdAt)}</span> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {done && !v.isSelected ? (
                          <Button size="sm" variant="ghost" busy={busy === `select:${v.id}`} onClick={() => act(`select:${v.id}`, () => api(`/api/scenes/${active.id}/select`, { body: { versionId: v.id } }), "Set as this scene’s take.")}>
                            <Check size={13} aria-hidden /> Use as take
                          </Button>
                        ) : null}
                        {done ? (
                          <Button size="sm" variant="quiet" busy={busy === `variation:${v.creation.id}`} onClick={() => derive(v.creation.id, "variation")}>
                            <GitBranch size={13} aria-hidden /> Branch
                          </Button>
                        ) : null}
                        {done && v.creation.output?.kind === "video" ? (
                          <Button size="sm" variant="quiet" busy={busy === `continuation:${v.creation.id}`} onClick={() => derive(v.creation.id, "continuation")}>
                            <ArrowRight size={13} aria-hidden /> Continue
                          </Button>
                        ) : null}
                        {done ? (
                          <Button
                            size="sm"
                            variant="quiet"
                            aria-pressed={compare.includes(v.id)}
                            onClick={() => setCompare((c) => (c.includes(v.id) ? c.filter((x) => x !== v.id) : [...c.slice(-1), v.id]))}
                          >
                            <SplitSquareHorizontal size={13} aria-hidden /> {compare.includes(v.id) ? "Comparing" : "Compare"}
                          </Button>
                        ) : null}
                      </div>
                      {!done ? <p className="mt-1 text-[12px] text-bone-500">{STATUS_LABEL[v.creation.status]}</p> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="No takes yet" body="Make a clip or a still for this scene. It starts from the continuity guide on the left." />
            )}
          </section>
        </div>
      ) : null}

      {data.loose.length ? (
        <section className="mt-12" aria-label="Other creations in this project">
          <h2 className="mb-3 flex items-center gap-2 font-display text-2xl">
            <Layers size={18} aria-hidden /> Also in this project
          </h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {data.loose.map((c) => (
              <li key={c.id}>
                <CreationThumb item={c} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <SequencePlayer open={playing} onClose={() => setPlaying(false)} clips={sequence.map((v) => ({ id: v!.id, url: v!.creation.output!.url! }))} />
      <RenameSheet open={renaming} onClose={() => setRenaming(false)} project={data.project} />
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this project?">
        <p className="text-sm text-bone-300">The project and its scenes go away. Every creation stays in your Library.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            busy={busy === "delete"}
            onClick={async () => {
              setBusy("delete");
              try {
                await api(`/api/projects/${data.project.id}`, { method: "DELETE" });
                router.push("/projects");
              } catch (e) {
                toast({ message: e instanceof ApiError ? e.message : "Could not delete.", tone: "error" });
                setBusy(null);
              }
            }}
          >
            Delete project
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function SceneGuide({ scene, characters, onSaved, canDelete }: { scene: SceneDetail; characters: { id: string; name: string }[]; onSaved: () => void; canDelete: boolean }) {
  const toast = useToast();
  const [title, setTitle] = useState(scene.title);
  const [c, setC] = useState<ContinuityGuide>(scene.continuity);
  const [busy, setBusy] = useState(false);
  const dirty = title !== scene.title || JSON.stringify(c) !== JSON.stringify(scene.continuity);
  const set = (k: keyof ContinuityGuide, v: string) => setC((prev) => {
    const next = { ...prev };
    if (v) next[k] = v;
    else delete next[k];
    return next;
  });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/scenes/${scene.id}`, { method: "PATCH", body: { title, continuity: c } });
      toast({ message: "Scene saved. New takes start from this guide.", tone: "success" });
      onSaved();
    } catch (err) {
      toast({ message: err instanceof ApiError ? err.message : "Could not save.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove “${scene.title}”? Its takes stay in your Library.`)) return;
    try {
      await api(`/api/scenes/${scene.id}`, { method: "DELETE" });
      onSaved();
    } catch (err) {
      toast({ message: err instanceof ApiError ? err.message : "Could not remove.", tone: "error" });
    }
  }

  return (
    <form onSubmit={save} className="h-fit space-y-4 rounded-[24px_8px_24px_8px] bg-ink-900/70 p-5 hairline lg:sticky lg:top-20" aria-label="Continuity guide">
      <div>
        <p className="tag text-ember-400">Continuity guide</p>
        <p className="mt-1 text-[12.5px] text-bone-400">Every take made from this scene starts with these settings. New scenes copy the guide of the scene before them.</p>
      </div>
      <Field label="Scene title" htmlFor="st">
        <input id="st" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required />
      </Field>
      <Field label="Lighting" htmlFor="sl">
        <select id="sl" className={inputClass} value={c.lighting ?? ""} onChange={(e) => set("lighting", e.target.value)}>
          <option value="">Not fixed</option>
          {LIGHTINGS.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </Field>
      <Field label="Framing" htmlFor="sf">
        <select id="sf" className={inputClass} value={c.framing ?? ""} onChange={(e) => set("framing", e.target.value)}>
          <option value="">Not fixed</option>
          {FRAMINGS.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </Field>
      <Field label="Palette" htmlFor="sp" hint="A few words, like “oxblood and brass”.">
        <input id="sp" className={inputClass} value={c.palette ?? ""} onChange={(e) => set("palette", e.target.value)} maxLength={80} />
      </Field>
      <Field label="Character" htmlFor="sc" hint={characters.length ? undefined : "Add a consented character in Train to keep a face consistent."}>
        <select id="sc" className={inputClass} value={c.characterReferenceId ?? ""} onChange={(e) => set("characterReferenceId", e.target.value)} disabled={!characters.length}>
          <option value="">None</option>
          {characters.map((ch) => (
            <option key={ch.id} value={ch.id}>
              {ch.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes" htmlFor="sn" hint="Wardrobe, setting, mood. Added to the prompt.">
        <textarea id="sn" className={inputClass} rows={3} value={c.notes ?? ""} onChange={(e) => set("notes", e.target.value)} maxLength={400} />
      </Field>
      <div className="flex items-center justify-between gap-2">
        {canDelete ? (
          <Button type="button" size="sm" variant="quiet" onClick={remove}>
            Remove scene
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" variant="ember" size="sm" busy={busy} disabled={!dirty}>
          Save guide
        </Button>
      </div>
    </form>
  );
}

function RenameSheet({ open, onClose, project }: { open: boolean; onClose: () => void; project: { id: string; title: string; description: string } }) {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title="Rename project">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/api/projects/${project.id}`, { method: "PATCH", body: { title, description } });
            onClose();
            router.refresh();
          } catch (err) {
            toast({ message: err instanceof ApiError ? err.message : "Could not save.", tone: "error" });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" htmlFor="rt">
          <input id="rt" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required />
        </Field>
        <Field label="Description" htmlFor="rd">
          <textarea id="rd" className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Button type="submit" variant="ember" busy={busy} className="w-full">
          Save
        </Button>
      </form>
    </Sheet>
  );
}

/** Plays each scene's chosen clip in order. */
function SequencePlayer({ open, onClose, clips }: { open: boolean; onClose: () => void; clips: { id: string; url: string }[] }) {
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);
  useEffect(() => {
    if (open) void ref.current?.play().catch(() => undefined);
  }, [index, open]);
  const clip = clips[index];
  return (
    <Sheet open={open} onClose={onClose} title="Sequence" wide>
      {clip ? (
        <div>
          <video ref={ref} key={clip.id} src={clip.url} controls playsInline className="aspect-video w-full rounded-xl bg-black" onEnded={() => setIndex((i) => (i + 1 < clips.length ? i + 1 : i))} />
          <p className="mt-2 font-mono text-[12px] text-bone-400">
            Clip {index + 1} of {clips.length}. Scenes without a finished clip are skipped.
          </p>
        </div>
      ) : (
        <p className="text-sm text-bone-400">No finished clips yet.</p>
      )}
    </Sheet>
  );
}
