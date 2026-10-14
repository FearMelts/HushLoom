"use client";

import { AlertTriangle, BookmarkPlus, ImagePlus, Info, Lightbulb, Lock, RotateCcw, Sparkles, Undo2, Upload, Wand2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GenerationParams } from "@/server/db/schema";
import type { ModelAvailability } from "@/server/ai/providers";
import { CAMERA_MOVEMENTS, FRAMINGS, LIGHTINGS, MODE_INPUTS, MODE_LABELS, PACINGS, estimateCost, type GenerationMode } from "@/server/ai/registry";
import { analyze, interpret, type Interpretation, type Suggestion } from "@/lib/copilot";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { cn } from "@/lib/cn";
import { draftKeyFor, type DraftKey } from "@/lib/draft-key";
import { useOnline } from "@/lib/use-online";
import { JOB_STARTED_EVENT } from "./job-tray";
import { OFFLINE_MESSAGE, OfflineGuard } from "./offline";
import { Badge, Button, Chip, Field, Sheet, buttonClass, inputClass, useToast } from "./ui";

export type CreateTemplate = {
  id: string;
  slug: string;
  title: string;
  mode: GenerationMode;
  prompt: string;
  negativePrompt: string;
  modelKey: string;
  defaults: GenerationParams;
  locked: boolean;
};

export type CreatePrefill = {
  mode?: GenerationMode;
  modelKey?: string;
  prompt?: string;
  negativePrompt?: string;
  params?: GenerationParams;
  projectId?: string;
  sceneId?: string;
  characterReferenceId?: string;
  continuityNote?: string;
  /** Remix and Reuse settings: the creation this one comes from, so it shows in that creation's versions. */
  parentJobId?: string;
  relation?: "remix";
  /** The source's template, only while the viewer can still make from it (see generatePrefill). */
  templateId?: string;
};

type Upload = { assetId: string; previewUrl: string; width: number | null; height: number | null; kind: "image" | "video"; warnings: string[] };
type Snapshot = { prompt: string; params: GenerationParams; modelKey?: string; mode?: GenerationMode };
/** The draft as the server made it; the confirm sheet describes this, not whatever the panel shows now. */
type Draft = { id: string; costCredits: number; isDemo: boolean; status: string; modelKey: string; characterReferenceId: string | null };
type Preset = { id: string; name: string; mode: GenerationMode; modelKey: string; prompt: string; params: GenerationParams };

/** The modes a model offers for this kind of output. */
function outputModes(m: ModelAvailability, output: "image" | "video"): GenerationMode[] {
  return m.modes.filter((x) => (output === "video" ? x.includes("video") || x === "scene_continuation" : !x.includes("video")));
}

/** Settings `m` can take: anything it cannot use is dropped (or moved to its first offer) rather than sent. */
function fitParams(p: GenerationParams, m: ModelAvailability): GenerationParams {
  const next = { ...p };
  if (next.aspectRatio && !m.aspectRatios.includes(next.aspectRatio)) next.aspectRatio = m.aspectRatios[0];
  if (!m.supports.cameraMovement) delete next.cameraMovement;
  if (!m.supports.motionIntensity) delete next.motionIntensity;
  if (!m.supports.seed) delete next.seed;
  if (next.quality && !m.qualities.includes(next.quality)) delete next.quality;
  if (m.output === "video" && next.durationS && !m.durationsS?.includes(next.durationS)) next.durationS = m.durationsS?.[0];
  return next;
}

/** A preset keeps the look, not the exact run: the seed stays out (the server drops it too). */
function withoutSeed(p: GenerationParams): GenerationParams {
  return Object.fromEntries(Object.entries(p).filter(([k]) => k !== "seed")) as GenerationParams;
}

export function CreatePanel({
  output,
  models,
  template,
  prefill,
  signedIn,
  balance,
  characterRefs = [],
  projects = [],
  studio = false,
  copilot = true,
}: {
  output: "image" | "video";
  models: ModelAvailability[];
  template?: CreateTemplate;
  prefill?: CreatePrefill;
  signedIn: boolean;
  balance: number;
  characterRefs?: { id: string; name: string }[];
  projects?: { id: string; title: string; scenes: { id: string; title: string }[] }[];
  studio?: boolean;
  /** When the viewer turns the assistant off, only blocking problems are shown. */
  copilot?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const online = useOnline();
  const usable = models.filter((m) => m.output === output);
  const initialModel = usable.find((m) => m.key === (prefill?.modelKey ?? template?.modelKey) && m.available) ?? usable.find((m) => m.available) ?? usable[0];
  const original: Snapshot = {
    prompt: prefill?.prompt ?? template?.prompt ?? "",
    params: { ...(template?.defaults ?? {}), ...(prefill?.params ?? {}) },
  };

  const [modelKey, setModelKey] = useState(initialModel?.key ?? "");
  const model = usable.find((m) => m.key === modelKey);
  const [mode, setMode] = useState<GenerationMode>(prefill?.mode ?? template?.mode ?? (output === "video" ? "text_to_video" : "text_to_image"));
  const [prompt, setPrompt] = useState(original.prompt);
  const [negativePrompt, setNegativePrompt] = useState(prefill?.negativePrompt ?? template?.negativePrompt ?? "");
  const [params, setParams] = useState<GenerationParams>(original.params);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [uploading, setUploading] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // A character carried over from a remix or a scene is kept only while it is still on file; another is never swapped in.
  const carriedRef = prefill?.characterReferenceId;
  const carriedRefGone = Boolean(carriedRef && !characterRefs.some((c) => c.id === carriedRef));
  const [characterRefId, setCharacterRefId] = useState(carriedRef ? (carriedRefGone ? "" : carriedRef) : (characterRefs[0]?.id ?? ""));
  const [projectId, setProjectId] = useState(prefill?.projectId ?? "");
  const [sceneId, setSceneId] = useState(prefill?.sceneId ?? "");
  const [showTweaks, setShowTweaks] = useState(studio);
  const [wish, setWish] = useState("");
  const [interpretation, setInterpretation] = useState<Interpretation | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const draftKey = useRef<DraftKey | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A template page makes that template, and a remix keeps its source, so presets start only fresh work.
  const offerPresets = signedIn && !template && !prefill?.parentJobId;
  useEffect(() => {
    if (!offerPresets) return;
    let live = true;
    api<{ presets: Preset[] }>("/api/presets")
      .then((r) => {
        if (live) setPresets(r.presets);
      })
      .catch(() => {
        // A shortcut only: without the list the panel works as before, so nothing is shown.
      });
    return () => {
      live = false;
    };
  }, [offerPresets]);

  const modes = model ? outputModes(model, output) : [];
  const needs = MODE_INPUTS[mode];
  const startable = presets.filter((p) => {
    const m = usable.find((x) => x.key === p.modelKey && x.available);
    return m && outputModes(m, output).includes(p.mode);
  });
  const cost = model ? estimateCost(model, params, model.priceMultiplierPct) : 0;
  const short = cost > balance;
  const changed = prompt !== original.prompt || JSON.stringify(params) !== JSON.stringify(original.params);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!model) return [];
    const notes = analyze({ prompt, negativePrompt, params, mode, model, input: upload ? { kind: upload.kind, width: upload.width, height: upload.height } : null });
    // What the server noticed about the upload, said the same way as the assistant's own notes.
    if (upload?.warnings.includes("low_resolution") && !notes.some((s) => s.id === "low-res")) {
      notes.push({ id: "upload-low-res", severity: "warn", title: "Low-resolution upload", detail: "Your image is under 512px on its short side, so expect soft detail. A larger photo works better." });
    }
    if (upload?.warnings.includes("scan_pending")) {
      notes.push({
        id: "upload-scan-pending",
        severity: "block",
        title: "This upload isn't checked yet",
        detail: "We couldn't run our safety check on it, so it can't be used yet. Remove it and upload again in a few minutes.",
      });
    }
    return notes.filter((s) => !dismissed.includes(s.id) && (copilot || s.severity === "block"));
  }, [prompt, negativePrompt, params, mode, model, upload, dismissed, copilot]);
  const blocked = suggestions.some((s) => s.severity === "block");

  /**
   * Every edit forgets the key, so the next "Make it" is a new request. draftKeyFor also compares the
   * whole request, so a key is only ever reused for the same request (src/lib/draft-key.ts).
   */
  function forgetDraftKey() {
    draftKey.current = null;
  }
  function remember() {
    setHistory((h) => [...h.slice(-19), { prompt, params, modelKey, mode }]);
  }
  function applyPatch(patch: Suggestion["patch"]) {
    if (!patch) return;
    remember();
    if (patch.prompt !== undefined) setPrompt(patch.prompt);
    if (patch.params) setParams((p) => ({ ...p, ...patch.params }));
    forgetDraftKey();
  }
  function undo() {
    const prev = history.at(-1);
    if (!prev) return;
    setPrompt(prev.prompt);
    setParams(prev.params);
    if (prev.modelKey) setModelKey(prev.modelKey);
    if (prev.mode) setMode(prev.mode);
    setHistory((h) => h.slice(0, -1));
    forgetDraftKey();
  }
  function restore() {
    remember();
    setPrompt(original.prompt);
    setParams(original.params);
    forgetDraftKey();
  }
  function setParam<K extends keyof GenerationParams>(k: K, v: GenerationParams[K] | undefined) {
    setParams((p) => {
      const next = { ...p };
      if (v === undefined || v === "") delete next[k];
      else next[k] = v;
      return next;
    });
    forgetDraftKey();
  }
  function switchModel(key: string) {
    setModelKey(key);
    const m = usable.find((x) => x.key === key);
    if (m && !m.modes.includes(mode)) setMode(outputModes(m, output)[0] ?? m.modes[0]!);
    // Drop settings the new model cannot use rather than sending them.
    if (m) setParams((p) => fitParams(p, m));
    forgetDraftKey();
  }
  function applyPreset(id: string) {
    const p = startable.find((x) => x.id === id);
    const m = p && usable.find((x) => x.key === p.modelKey);
    if (!p || !m) return;
    remember();
    setModelKey(m.key);
    setMode(p.mode);
    if (p.prompt.trim()) setPrompt(p.prompt);
    setParams(fitParams(p.params, m));
    forgetDraftKey();
  }

  async function savePreset() {
    if (!model) return;
    setPresetBusy(true);
    setPresetError(null);
    try {
      const { preset } = await api<{ preset: Preset }>("/api/presets", { body: { name: presetName.trim(), mode, modelKey: model.key, prompt, params: withoutSeed(params) } });
      setPresets((ps) => [preset, ...ps]);
      setPresetOpen(false);
      setPresetName("");
      toast({ message: `Saved "${preset.name}" as a preset.`, tone: "success" });
    } catch (e) {
      setPresetError(e instanceof ApiError ? e.message : "We couldn't save that preset. Try again.");
    } finally {
      setPresetBusy(false);
    }
  }

  async function doUpload(file: File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("consent", "true");
    form.set("purpose", "source");
    try {
      const res = await api<{ assetId: string; width: number | null; height: number | null; kind: "image" | "video"; warnings: string[] }>("/api/uploads", { form });
      setUpload({ ...res, previewUrl: URL.createObjectURL(file) });
      forgetDraftKey();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
      setPendingFile(null);
      setConsentOpen(false);
      setConsentChecked(false);
    }
  }

  async function startDraft() {
    if (!signedIn) {
      router.push(`/auth?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (!model || !online) return;
    setBusy(true);
    setError(null);
    const request = {
      mode,
      modelKey: model.key,
      prompt,
      negativePrompt: model.supports.negativePrompt ? negativePrompt : "",
      params,
      inputAssetIds: upload ? [upload.assetId] : [],
      templateId: template?.id ?? prefill?.templateId,
      characterReferenceId: needs.characterRef ? characterRefId || undefined : undefined,
      projectId: projectId || undefined,
      sceneId: sceneId || undefined,
      parentJobId: prefill?.parentJobId,
      relation: prefill?.parentJobId ? prefill.relation : undefined,
    };
    // The same request keeps its key, so a retry after a lost reply finds the draft already made.
    const key = (draftKey.current = draftKeyFor(draftKey.current, request, newIdempotencyKey));
    try {
      let { job } = await api<{ job: Draft }>("/api/generations", { body: { ...request, idempotencyKey: key.key } });
      if (job.status !== "awaiting_confirmation") {
        // That key's draft already started or expired, so this is a new request with a new key.
        draftKey.current = { key: newIdempotencyKey(), signature: key.signature };
        ({ job } = await api<{ job: Draft }>("/api/generations", { body: { ...request, idempotencyKey: draftKey.current.key } }));
      }
      setDraft(job);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!draft || !online) return;
    setBusy(true);
    try {
      await api(`/api/generations/${draft.id}/confirm`, { body: { expectedCost: draft.costCredits } });
      setDraft(null);
      forgetDraftKey();
      window.dispatchEvent(new Event(JOB_STARTED_EVENT));
      toast({ message: draft.isDemo ? "Weaving a demo placeholder." : "Weaving your creation.", action: { label: "Library", href: "/collection" } });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start.");
      setDraft(null);
      forgetDraftKey();
    } finally {
      setBusy(false);
    }
  }

  if (!model) {
    return <p className="text-sm text-bone-400">No {output} models are configured on this server.</p>;
  }

  const project = projects.find((p) => p.id === projectId);
  const draftModel = draft ? models.find((m) => m.key === draft.modelKey) : undefined;
  const draftCharacter = draft?.characterReferenceId ? (characterRefs.find((c) => c.id === draft.characterReferenceId)?.name ?? "Your character") : null;

  return (
    <div className="space-y-5" id="make">
      {template?.locked ? (
        <div className="flex items-start gap-3 rounded-2xl bg-brass-400/10 p-4 text-sm text-brass-300">
          <Lock size={18} className="mt-0.5 shrink-0" aria-hidden />
          <p>
            This is a VIP template. <Link href="/pricing" className="font-semibold underline">A pass unlocks it</Link>, along with every other VIP template.
          </p>
        </div>
      ) : null}

      {signedIn && !template?.locked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {offerPresets && startable.length ? (
            <div className="min-w-0 flex-1 sm:max-w-64">
              <label htmlFor="preset" className="sr-only">
                Start from preset
              </label>
              <select id="preset" className={inputClass} value="" onChange={(e) => applyPreset(e.target.value)}>
                <option value="">Start from preset</option>
                {startable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span />
          )}
          <button
            type="button"
            className={buttonClass("quiet", "sm")}
            onClick={() => {
              setPresetError(null);
              setPresetOpen(true);
            }}
          >
            <BookmarkPlus size={14} aria-hidden /> Save as preset
          </button>
        </div>
      ) : null}

      {modes.length > 1 ? (
        <div role="radiogroup" aria-label="What to make" className="flex flex-wrap gap-2">
          {modes.map((m) => (
            <Chip
              key={m}
              active={mode === m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                forgetDraftKey();
              }}
            >
              {MODE_LABELS[m]}
            </Chip>
          ))}
        </div>
      ) : null}

      {needs.image > 0 || needs.video > 0 ? (
        <div>
          <p className="mb-2 text-[13px] font-medium text-bone-200">{needs.video ? "Clip to continue" : "Start from your image"}</p>
          {upload ? (
            <div className="flex items-center gap-3 rounded-2xl bg-ink-850 p-2.5 hairline">
              {upload.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                <img src={upload.previewUrl} alt="Your upload" className="size-16 rounded-xl object-cover" />
              ) : (
                <video src={upload.previewUrl} className="size-16 rounded-xl object-cover" muted />
              )}
              <div className="min-w-0 flex-1 text-[13px]">
                <p>
                  {upload.width}×{upload.height}
                </p>
                <p className="text-bone-400">Private. Only you can see it.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setUpload(null);
                  forgetDraftKey();
                }}
                className="grid size-9 place-items-center rounded-full text-bone-400 hover:bg-ink-800" aria-label="Remove upload">
                <X size={16} />
              </button>
            </div>
          ) : needs.video ? (
            <p className="rounded-2xl bg-ink-850 p-4 text-[13px] text-bone-300 hairline">
              Open a finished video in your <Link href="/collection" className="text-ember-300 underline">Library</Link> and choose Continue or Extend.
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-[var(--line-strong)] bg-ink-900 px-4 py-6 text-sm text-bone-300 hover:bg-ink-850"
              >
                {uploading ? <span className="size-5 rounded-full border-2 border-current border-r-transparent animate-spin" /> : <ImagePlus size={22} aria-hidden />}
                {uploading ? "Uploading…" : "Choose a photo (JPG, PNG or WebP)"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                data-testid="upload-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) {
                    setPendingFile(f);
                    setConsentOpen(true);
                  }
                }}
              />
            </>
          )}
        </div>
      ) : null}

      {needs.characterRef ? (
        <Field
          label="Character"
          hint={carriedRefGone && !characterRefId ? "The character from before isn't on file anymore. Pick another, or add one in Train." : "From Train, with consent on file. It's sent with this request to the model."}
          htmlFor="charref"
        >
          {characterRefs.length ? (
            <select
              id="charref"
              className={inputClass}
              value={characterRefId}
              onChange={(e) => {
                setCharacterRefId(e.target.value);
                forgetDraftKey();
              }}
            >
              {characterRefId ? null : (
                <option value="" disabled>
                  Pick a character
                </option>
              )}
              {characterRefs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-bone-400">
              No characters yet. <Link href="/train" className="text-ember-300 underline">Add one in Train</Link>.
            </p>
          )}
        </Field>
      ) : null}

      {carriedRef && !needs.characterRef ? (
        <p className="flex gap-2 rounded-2xl bg-ink-850 p-3.5 text-[13px] text-bone-300 hairline">
          <Info size={16} className="mt-0.5 shrink-0 text-iris-300" aria-hidden />
          {output === "video"
            ? "Clips can't use a character reference in this build, so continuity relies on the guide text and settings."
            : modes.includes("reference_guided")
              ? `${MODE_LABELS[mode]} doesn't send your character. Pick ${MODE_LABELS.reference_guided} to use it.`
              : `${model.displayName} can't take a character reference, so yours isn't used here.`}
        </p>
      ) : null}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor="prompt" className="text-[13px] font-medium text-bone-200">
            Prompt
          </label>
          <div className="flex items-center gap-1">
            {history.length ? (
              <button type="button" onClick={undo} className={buttonClass("quiet", "sm")}>
                <Undo2 size={14} aria-hidden /> Undo
              </button>
            ) : null}
            {changed && (template || prefill?.prompt) ? (
              <button type="button" onClick={restore} className={buttonClass("quiet", "sm")}>
                <RotateCcw size={14} aria-hidden /> Restore original
              </button>
            ) : null}
          </div>
        </div>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            forgetDraftKey();
          }}
          rows={studio ? 5 : 3}
          maxLength={2000}
          placeholder={output === "video" ? "Who, where, and what moves. e.g. an adult couple slow dancing in a dim room, warm lamp light" : "Who, where, and the mood. e.g. adult model in ivory lace by a tall window, airy light"}
          className={cn(inputClass, "resize-y leading-relaxed")}
        />
        {prefill?.continuityNote ? <p className="mt-1.5 text-[12.5px] text-iris-300">Scene continuity notes are included in the prompt above. Edit them freely.</p> : null}
      </div>

      {suggestions.length ? (
        <ul className="space-y-2" aria-label="Assistant suggestions">
          {suggestions.map((s) => (
            <li
              key={s.id}
              className={cn(
                "flex items-start gap-3 rounded-2xl px-3.5 py-3 text-[13px]",
                s.severity === "block" ? "bg-danger-400/10 text-danger-400" : s.severity === "warn" ? "bg-brass-400/10" : "bg-ink-850 hairline",
              )}
            >
              {s.severity === "block" || s.severity === "warn" ? (
                <AlertTriangle size={16} className={cn("mt-0.5 shrink-0", s.severity === "warn" && "text-brass-300")} aria-hidden />
              ) : (
                <Lightbulb size={16} className="mt-0.5 shrink-0 text-ember-400" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-bone-50">{s.title}</p>
                <p className={cn("mt-0.5", s.severity === "block" ? "" : "text-bone-300")}>{s.detail}</p>
                {s.patch?.prompt ? <p className="mt-1.5 rounded-lg bg-ink-950/60 px-2.5 py-1.5 text-bone-200">{s.patch.prompt}</p> : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {s.patch ? (
                  <button type="button" className="font-semibold text-ember-400 hover:text-ember-300" onClick={() => applyPatch(s.patch)}>
                    {s.patchLabel ?? "Apply"}
                  </button>
                ) : null}
                {s.severity !== "block" ? (
                  <button type="button" className="text-bone-500 hover:text-bone-300" onClick={() => setDismissed((d) => [...d, s.id])} aria-label={`Dismiss: ${s.title}`}>
                    Dismiss
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (wish.trim()) setInterpretation(interpret(wish, model));
          }}
        >
          <label htmlFor="wish" className="sr-only">
            Describe changes in plain words
          </label>
          <div className="relative flex-1">
            <Sparkles size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ember-400" aria-hidden />
            <input
              id="wish"
              value={wish}
              onChange={(e) => setWish(e.target.value)}
              placeholder={output === "video" ? "Say it plainly: vertical, slow push in, golden hour, 8 seconds" : "Say it plainly: square, moody, close-up, 4k"}
              className={cn(inputClass, "pl-9")}
            />
          </div>
          <Button type="submit" variant="ghost" disabled={!wish.trim()}>
            Interpret
          </Button>
        </form>
        {interpretation ? (
          <div className="mt-2.5 rounded-2xl bg-ink-850 p-3.5 text-[13px] hairline" role="region" aria-label="Interpreted settings">
            {interpretation.changes.length ? (
              <>
                <p className="font-semibold">This would set:</p>
                <ul className="mt-1.5 space-y-1">
                  {interpretation.changes.map((c) => (
                    <li key={c.field} className="flex justify-between gap-3">
                      <span>
                        <span className="text-bone-300">{c.field.replace(/([A-Z])/g, " $1").toLowerCase()}</span> → <strong>{String(c.value)}</strong>
                      </span>
                      <span className="text-right text-bone-500">{c.because}</span>
                    </li>
                  ))}
                </ul>
                {(() => {
                  const next = { ...params, ...interpretation.params };
                  const newCost = estimateCost(model, next, model.priceMultiplierPct);
                  return newCost !== cost ? (
                    <p className="mt-2 text-brass-300">
                      Cost changes from {cost} to {newCost} credits.
                    </p>
                  ) : null;
                })()}
              </>
            ) : (
              <p className="text-bone-300">Nothing here maps to a setting. Try words like vertical, close-up, golden hour, pan left, or 5 seconds.</p>
            )}
            {interpretation.unsupported.length ? <p className="mt-2 text-bone-400">Not available on {model.displayName}: {interpretation.unsupported.join(", ")}.</p> : null}
            <div className="mt-3 flex gap-2">
              {interpretation.changes.length ? (
                <Button
                  size="sm"
                  variant="bone"
                  onClick={() => {
                    applyPatch({ params: interpretation.params });
                    setInterpretation(null);
                    setWish("");
                    setShowTweaks(true);
                  }}
                >
                  Apply
                </Button>
              ) : null}
              <Button size="sm" variant="quiet" onClick={() => setInterpretation(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl bg-ink-900 hairline">
        <button
          type="button"
          onClick={() => setShowTweaks((s) => !s)}
          aria-expanded={showTweaks}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-[14px]"
        >
          <span>
            Tweak <span className="text-bone-500">· {params.aspectRatio ?? model.aspectRatios[0]}{model.output === "video" ? ` · ${params.durationS ?? model.durationsS?.[0]}s` : ""}{params.quality === "4k" ? " · 4K" : ""}</span>
          </span>
          <span className="text-bone-500" aria-hidden>
            {showTweaks ? "−" : "+"}
          </span>
        </button>
        {showTweaks ? (
          <div className="space-y-4 border-t border-[var(--line)] px-4 py-4">
            <Field label="Model" htmlFor="model">
              <select id="model" className={inputClass} value={modelKey} onChange={(e) => switchModel(e.target.value)}>
                {usable.map((m) => (
                  <option key={m.key} value={m.key} disabled={!m.available}>
                    {m.displayName}
                    {m.available ? "" : ` (${m.reason})`}
                  </option>
                ))}
              </select>
            </Field>
            <p className="-mt-2 text-[12px] text-bone-500">{model.notes}</p>

            <div>
              <p className="mb-2 text-[13px] font-medium text-bone-200">Aspect ratio</p>
              <div className="flex flex-wrap gap-2">
                {model.aspectRatios.map((a) => (
                  <Chip key={a} active={(params.aspectRatio ?? model.aspectRatios[0]) === a} onClick={() => setParam("aspectRatio", a)}>
                    {a}
                  </Chip>
                ))}
              </div>
            </div>
            {model.output === "video" && model.durationsS ? (
              <div>
                <p className="mb-2 text-[13px] font-medium text-bone-200">Length</p>
                <div className="flex flex-wrap gap-2">
                  {model.durationsS.map((d) => (
                    <Chip key={d} active={(params.durationS ?? model.durationsS![0]) === d} onClick={() => setParam("durationS", d)}>
                      {d}s
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}
            {model.qualities.length > 1 ? (
              <div>
                <p className="mb-2 text-[13px] font-medium text-bone-200">Quality</p>
                <div className="flex gap-2">
                  {model.qualities.map((q) => (
                    <Chip key={q} active={(params.quality ?? "hd") === q} onClick={() => setParam("quality", q)}>
                      {q === "4k" ? "4K (2× credits)" : "HD"}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}
            {model.supports.cameraMovement ? (
              <Field label="Camera" htmlFor="camera" hint="How the shot moves. Static keeps the frame still.">
                <select id="camera" className={inputClass} value={params.cameraMovement ?? ""} onChange={(e) => setParam("cameraMovement", e.target.value || undefined)}>
                  <option value="">Let the model choose</option>
                  {CAMERA_MOVEMENTS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            {model.supports.motionIntensity ? (
              <Field label={`Motion intensity · ${params.motionIntensity ?? 5}`} htmlFor="motion" hint="Higher is livelier, and more likely to warp.">
                <input id="motion" type="range" min={1} max={10} value={params.motionIntensity ?? 5} onChange={(e) => setParam("motionIntensity", Number(e.target.value))} className="w-full accent-[var(--color-ember-500)]" />
              </Field>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-3">
              {model.output === "video" ? (
                <Field label="Pacing" htmlFor="pacing" hint="How quickly the action unfolds. Added to your prompt.">
                  <select id="pacing" className={inputClass} value={params.pacing ?? ""} onChange={(e) => setParam("pacing", e.target.value || undefined)}>
                    <option value="">Natural</option>
                    {PACINGS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field label="Lighting" htmlFor="lighting" hint="Added to your prompt. From prompt leaves it to your words.">
                <select id="lighting" className={inputClass} value={params.lighting ?? ""} onChange={(e) => setParam("lighting", e.target.value || undefined)}>
                  <option value="">From prompt</option>
                  {LIGHTINGS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="Framing" htmlFor="framing" hint="How close the camera is. Added to your prompt.">
                <select id="framing" className={inputClass} value={params.framing ?? ""} onChange={(e) => setParam("framing", e.target.value || undefined)}>
                  <option value="">From prompt</option>
                  {FRAMINGS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Atmosphere" htmlFor="atmosphere" hint="A few words of mood, added to your prompt.">
              <input id="atmosphere" className={inputClass} value={params.atmosphere ?? ""} maxLength={80} onChange={(e) => setParam("atmosphere", e.target.value || undefined)} placeholder="e.g. hazy, intimate, playful" />
            </Field>
            {studio ? (
              <>
                {model.supports.negativePrompt ? (
                  <Field label="Avoid (negative prompt)" htmlFor="neg">
                    <input
                      id="neg"
                      className={inputClass}
                      value={negativePrompt}
                      onChange={(e) => {
                        setNegativePrompt(e.target.value);
                        forgetDraftKey();
                      }}
                      placeholder="e.g. text, watermark, extra fingers"
                    />
                  </Field>
                ) : null}
                {model.supports.seed ? (
                  <Field label="Seed" htmlFor="seed" hint="Same seed + same settings = closest repeat. Leave empty for random.">
                    <input id="seed" type="number" min={0} className={inputClass} value={params.seed ?? ""} onChange={(e) => setParam("seed", e.target.value === "" ? undefined : Number(e.target.value))} />
                  </Field>
                ) : null}
                {projects.length ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Project" htmlFor="project">
                      <select
                        id="project"
                        className={inputClass}
                        value={projectId}
                        onChange={(e) => {
                          setProjectId(e.target.value);
                          setSceneId("");
                          forgetDraftKey();
                        }}
                      >
                        <option value="">None</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.title}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Scene" htmlFor="scene">
                      <select
                        id="scene"
                        className={inputClass}
                        value={sceneId}
                        disabled={!project}
                        onChange={(e) => {
                          setSceneId(e.target.value);
                          forgetDraftKey();
                        }}
                      >
                        <option value="">None</option>
                        {project?.scenes.map((s) => (
                          <option key={s.id} value={s.id}>{s.title}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                ) : null}
              </>
            ) : (
              <Link href="/studio" className="inline-flex items-center gap-1.5 text-[13px] text-bone-400 hover:text-bone-50">
                More controls in Studio →
              </Link>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-xl bg-danger-400/10 px-3.5 py-2.5 text-[13px] text-danger-400" role="alert">
          {error}
        </p>
      ) : null}

      <OfflineGuard>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ember"
            size="lg"
            onClick={startDraft}
            busy={busy && !draft}
            disabled={!prompt.trim() || blocked || template?.locked || (needs.image > 0 && !upload) || (needs.video > 0 && !upload) || (needs.characterRef && !characterRefId)}
            className="min-w-40"
          >
            <Wand2 size={18} aria-hidden /> Make it
          </Button>
          <p className="text-[13px] text-bone-300" data-testid="cost-line">
            <span className="font-mono text-bone-50">{cost}</span> credits
            {signedIn ? (
              <>
                {" "}
                · you have <span className={cn("font-mono", short ? "text-danger-400" : "text-bone-50")}>{balance}</span>
                {short ? (
                  <>
                    {" "}
                    · <Link href="/pricing" className="text-ember-300 underline">Get credits</Link>
                  </>
                ) : null}
              </>
            ) : null}
          </p>
          {model.isDemo ? (
            <Badge tone="demo">
              <Info size={11} aria-hidden /> Demo model
            </Badge>
          ) : null}
        </div>
      </OfflineGuard>

      <Sheet open={consentOpen} onClose={() => { setConsentOpen(false); setPendingFile(null); setConsentChecked(false); }} title="Before you upload">
        <div className="space-y-4 text-[14px] text-bone-300">
          <p>Uploads stay private. To protect the people in them, confirm this applies to everyone shown:</p>
          <label className="flex items-start gap-3 rounded-2xl bg-ink-850 p-3.5 hairline">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--color-ember-500)]" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} data-testid="consent-checkbox" />
            <span className="text-bone-50">
              Everyone in this photo is an adult (18+), and either it is me or they have agreed to me using their image here, including for sexual content.
            </span>
          </label>
          <p className="text-[12.5px]">We keep a record of this confirmation. You can withdraw it in Settings, which deletes the upload and everything made from it.</p>
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setConsentOpen(false)}>
              Cancel
            </Button>
            <Button variant="ember" disabled={!consentChecked || !pendingFile} busy={uploading} onClick={() => pendingFile && void doUpload(pendingFile)}>
              <Upload size={16} aria-hidden /> Upload
            </Button>
          </div>
        </div>
      </Sheet>

      <Sheet
        open={Boolean(draft)}
        onClose={() => {
          setDraft(null);
          forgetDraftKey();
        }}
        title="Ready to make this?"
      >
        {draft ? (
          <div className="space-y-4 text-[14px]">
            <dl className="divide-y divide-[var(--line)] rounded-2xl bg-ink-850 hairline">
              <div className="flex justify-between px-4 py-3">
                <dt className="text-bone-300">Cost</dt>
                <dd className="font-mono" data-testid="confirm-cost">{draft.costCredits} credits</dd>
              </div>
              <div className="flex justify-between px-4 py-3">
                <dt className="text-bone-300">Balance after</dt>
                <dd className={cn("font-mono", balance - draft.costCredits < 0 && "text-danger-400")}>{balance - draft.costCredits}</dd>
              </div>
              <div className="flex justify-between px-4 py-3">
                <dt className="text-bone-300">Model</dt>
                <dd>{draftModel?.displayName ?? draft.modelKey}</dd>
              </div>
              {draftCharacter ? (
                <div className="flex justify-between px-4 py-3">
                  <dt className="text-bone-300">Character</dt>
                  <dd>{draftCharacter}</dd>
                </div>
              ) : null}
            </dl>
            {draft.isDemo ? (
              <p className="flex gap-2 rounded-2xl bg-iris-400/10 p-3.5 text-[13px] text-iris-300">
                <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  This server runs the demo model. You will get a labeled placeholder made locally, not an AI-generated result.
                  {draftCharacter ? " Your character's photo is blended under the watermark; it isn't a likeness match." : ""}
                </span>
              </p>
            ) : null}
            <p className="text-[12.5px] text-bone-400">If it fails, your credits come back automatically. It stays private in your Library.</p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="quiet" onClick={() => setDraft(null)}>
                Not now
              </Button>
              <OfflineGuard note={false}>
                <Button variant="ember" onClick={confirm} busy={busy} disabled={balance < draft.costCredits} data-testid="confirm-make">
                  Confirm · {draft.costCredits} credits
                </Button>
              </OfflineGuard>
            </div>
            {online ? null : <p className="text-right text-[12.5px] text-brass-300">{OFFLINE_MESSAGE}</p>}
          </div>
        ) : null}
      </Sheet>

      <Sheet open={presetOpen} onClose={() => setPresetOpen(false)} title="Save as preset">
        <form
          className="space-y-4 text-[14px]"
          onSubmit={(e) => {
            e.preventDefault();
            void savePreset();
          }}
        >
          <p className="text-bone-300">Keeps this model, mode, prompt and settings so you can start from them again. The seed isn&apos;t kept, so each run is fresh.</p>
          <Field label="Name" htmlFor="preset-name" error={presetError ?? undefined}>
            <input id="preset-name" className={inputClass} value={presetName} maxLength={40} onChange={(e) => setPresetName(e.target.value)} placeholder="e.g. Soft window portraits" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="quiet" onClick={() => setPresetOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="ember" busy={presetBusy} disabled={!presetName.trim()}>
              Save preset
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
