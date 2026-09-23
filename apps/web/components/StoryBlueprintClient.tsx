"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiClientError, type StoryBlueprint, type StoryBlueprintPlanItem, type StoryBlueprintStory } from "@bookworm/api-client";
import { apiClient } from "./api";
import StoryBlueprintProposalPanel from "./StoryBlueprintProposalPanel";

type StoryBlueprintResult = { blueprint: StoryBlueprint | null; role: string };
type StoryBlueprintDraft = Pick<StoryBlueprint, "story" | "chapterPlan">;

const EDIT_ROLES = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);
const PAID_PROPOSAL_ROLES = new Set(["owner", "admin", "editor", "writer"]);
const panel = "rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6";
const input = "mt-2 min-h-11 w-full rounded-xl border border-white/15 bg-black/35 px-3.5 py-2.5 text-sm text-white outline-none transition duration-200 placeholder:text-white/30 focus:border-white/50 focus:ring-2 focus:ring-white/15 disabled:cursor-not-allowed disabled:opacity-55";
const primary = "inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black outline-none transition duration-200 hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-45";
const secondary = "inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 outline-none transition duration-200 hover:border-white/45 hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-45";

export function emptyStoryBlueprint(): StoryBlueprintStory {
  return {
    workingTitle: "",
    premise: "",
    readerPromise: "",
    genre: "",
    tone: "",
    pointOfView: "",
    tense: "",
    targetWordCount: null,
    synopsis: "",
    theme: "",
    notes: "",
  };
}

// IDs are generated once at author intent time. Reordering and editing preserve
// them so a plan item remains the same materialization target after a retry.
export function newStoryBlueprintPlanItem(id = crypto.randomUUID(), index = 1): StoryBlueprintPlanItem {
  return { id, title: `Chapter ${index}`, purpose: "", summary: "", targetWords: null };
}

export function moveStoryBlueprintPlanItem(items: StoryBlueprintPlanItem[], id: string, direction: -1 | 1): StoryBlueprintPlanItem[] {
  const from = items.findIndex((item) => item.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= items.length) return items;
  const next = [...items];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// This identifies only a saved book and plan UUID, never the chapter content.
// It is deliberately deterministic so a reload can safely retry a lost response.
export const storyBlueprintMaterializationKey = (bookId: string, planItemId: string) => `story-blueprint:${bookId}:${planItemId}`;

function cloneDraft(blueprint: StoryBlueprint | null): StoryBlueprintDraft {
  return {
    story: { ...(blueprint?.story ?? emptyStoryBlueprint()) },
    chapterPlan: (blueprint?.chapterPlan ?? []).map((item) => ({ ...item })),
  };
}

function serializedDraft(draft: StoryBlueprintDraft) {
  return JSON.stringify(draft);
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function parseCount(value: string) {
  if (!value.trim()) return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : Number.NaN;
}

function normalizeDraft(draft: StoryBlueprintDraft): StoryBlueprintDraft {
  const story = draft.story;
  return {
    story: {
      workingTitle: story.workingTitle.trim(),
      premise: story.premise.trim(),
      readerPromise: story.readerPromise.trim(),
      genre: story.genre.trim(),
      tone: story.tone.trim(),
      pointOfView: story.pointOfView.trim(),
      tense: story.tense.trim(),
      targetWordCount: story.targetWordCount,
      synopsis: story.synopsis.trim(),
      theme: story.theme.trim(),
      notes: story.notes.trim(),
    },
    chapterPlan: draft.chapterPlan.map((item) => ({
      ...item,
      title: item.title.trim(),
      purpose: item.purpose.trim(),
      summary: item.summary.trim(),
    })),
  };
}

function validationError(draft: StoryBlueprintDraft) {
  const storyTarget = draft.story.targetWordCount;
  if (storyTarget !== null && (!Number.isInteger(storyTarget) || storyTarget < 100 || storyTarget > 2_000_000)) {
    return "Target word count must be a whole number from 100 to 2,000,000, or left blank.";
  }
  if (draft.chapterPlan.length > 200) return "A story blueprint can contain at most 200 planned chapters.";
  for (let index = 0; index < draft.chapterPlan.length; index += 1) {
    const item = draft.chapterPlan[index];
    if (!item.title) return `Chapter ${index + 1} needs a title before the blueprint can be saved.`;
    if (item.targetWords !== null && (!Number.isInteger(item.targetWords) || item.targetWords < 10 || item.targetWords > 200_000)) {
      return `Chapter ${index + 1} target words must be a whole number from 10 to 200,000, or left blank.`;
    }
  }
  return null;
}

export default function StoryBlueprintClient({ bookId }: { bookId: string }) {
  const api = apiClient();
  const [blueprint, setBlueprint] = useState<StoryBlueprint | null>(null);
  const [draft, setDraft] = useState<StoryBlueprintDraft>(() => cloneDraft(null));
  const [role, setRole] = useState("viewer");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [materializing, setMaterializing] = useState<string | null>(null);
  const [unconfirmedMaterialization, setUnconfirmedMaterialization] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const savedDraft = useMemo(() => cloneDraft(blueprint), [blueprint]);
  const dirty = serializedDraft(draft) !== serializedDraft(savedDraft);
  const editable = EDIT_ROLES.has(role);
  const paidProposalEditable = PAID_PROPOSAL_ROLES.has(role);
  const busy = loading || saving || materializing !== null;
  const materialized = useMemo(() => new Map((blueprint?.materializations ?? []).map((item) => [item.planItemId, item.chapterId])), [blueprint]);

  const applyResult = useCallback((result: StoryBlueprintResult) => {
    setRole(result.role);
    setBlueprint(result.blueprint);
    setDraft(cloneDraft(result.blueprint));
    setConflict(false);
    setUnconfirmedMaterialization(null);
  }, []);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getStoryBlueprint(bookId);
      if (sequence !== loadSequence.current) return;
      applyResult(result);
    } catch (reason) {
      if (sequence === loadSequence.current) setError(messageOf(reason, "Could not load this story blueprint. Try reloading before making changes."));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [api, applyResult, bookId]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardNavigation = (event: globalThis.MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!window.confirm("Leave Story Blueprint and discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    window.document.addEventListener("click", guardNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.document.removeEventListener("click", guardNavigation, true);
    };
  }, [dirty]);

  const reload = () => {
    if (busy) return;
    if (dirty && !window.confirm("Reloading will replace the unsaved story blueprint on this page. Continue?")) return;
    setNotice(null);
    void load();
  };

  const updateStory = <K extends keyof StoryBlueprintStory>(field: K, value: StoryBlueprintStory[K]) => {
    setDraft((current) => ({ ...current, story: { ...current.story, [field]: value } }));
    setNotice(null);
  };

  const updatePlanItem = <K extends keyof StoryBlueprintPlanItem>(id: string, field: K, value: StoryBlueprintPlanItem[K]) => {
    setDraft((current) => ({
      ...current,
      chapterPlan: current.chapterPlan.map((item) => item.id === id ? { ...item, [field]: value } : item),
    }));
    setNotice(null);
  };

  const addPlanItem = () => {
    if (!editable || busy || draft.chapterPlan.length >= 200) return;
    setDraft((current) => ({ ...current, chapterPlan: [...current.chapterPlan, newStoryBlueprintPlanItem(undefined, current.chapterPlan.length + 1)] }));
    setNotice("New chapter added to the plan. Save the blueprint before creating its manuscript chapter.");
  };

  const reorderPlanItem = (id: string, direction: -1 | 1) => {
    if (!editable || busy) return;
    setDraft((current) => ({ ...current, chapterPlan: moveStoryBlueprintPlanItem(current.chapterPlan, id, direction) }));
    setNotice(null);
  };

  const deletePlanItem = (item: StoryBlueprintPlanItem) => {
    if (!editable || busy || materialized.has(item.id)) return;
    if (!window.confirm(`Remove “${item.title || "this chapter"}” from the unsaved plan?`)) return;
    setDraft((current) => ({ ...current, chapterPlan: current.chapterPlan.filter((candidate) => candidate.id !== item.id) }));
    setNotice("Chapter removed from the local plan. Save the blueprint to confirm this change.");
  };

  const save = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!editable || busy || conflict || !dirty) return;
    const nextDraft = normalizeDraft(draft);
    const invalid = validationError(nextDraft);
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.saveStoryBlueprint(bookId, {
        expectedRevision: blueprint?.revision ?? 0,
        story: nextDraft.story,
        chapterPlan: nextDraft.chapterPlan,
      });
      applyResult(result);
      setNotice(`Story blueprint saved · revision ${result.blueprint?.revision ?? 1}.`);
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 409) {
        setConflict(true);
        setError("Someone saved a newer version of this story blueprint. Your edits are still on this page; reload the saved version before deciding what to keep.");
      } else {
        setError(messageOf(reason, "Could not save this story blueprint. Your edits are still on this page."));
      }
    } finally {
      setSaving(false);
    }
  };

  const materialize = async (item: StoryBlueprintPlanItem) => {
    if (!editable || busy || conflict || !blueprint || dirty || materialized.has(item.id)) return;
    setMaterializing(item.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.materializeStoryBlueprintChapter(bookId, item.id, {
        expectedRevision: blueprint.revision,
        idempotencyKey: storyBlueprintMaterializationKey(bookId, item.id),
      });
      setBlueprint((current) => current ? {
        ...current,
        materializations: [...current.materializations.filter((entry) => entry.planItemId !== item.id), { planItemId: item.id, chapterId: result.chapter.id }],
      } : current);
      setUnconfirmedMaterialization(null);
      setNotice(`Created an empty manuscript chapter for “${item.title}”. No AI was called and no credits were used.`);
    } catch (reason) {
      setUnconfirmedMaterialization(item.id);
      if (reason instanceof ApiClientError && reason.status === 409) {
        setConflict(true);
        setError("The blueprint changed before this chapter could be confirmed. Reload the saved plan, then retry the original materialization; it uses the same safe request identity.");
      } else {
        setError(`We could not confirm whether “${item.title}” was created. Retry the original materialization after checking this page; it uses the same request identity and will not create a second chapter. ${messageOf(reason, "")}`.trim());
      }
    } finally {
      setMaterializing(null);
    }
  };

  const status = loading ? "Loading blueprint…" : conflict ? "Reload required" : dirty ? "Unsaved changes" : blueprint ? `Saved · revision ${blueprint.revision}` : "Not yet saved";

  return <main className="mx-auto min-h-[calc(100dvh-84px)] max-w-7xl bg-black px-4 py-8 text-white sm:px-6 lg:px-8 lg:py-10">
    <div className="flex flex-wrap items-start justify-between gap-5 border-b border-white/10 pb-6">
      <div>
        <Link href={`/books/${bookId}`} className="text-sm text-white/50 transition duration-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">← Manuscript</Link>
        <h1 className="mt-3 text-3xl font-medium tracking-[-0.04em]">Story blueprint</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">Shape the reader promise, story direction, and chapter sequence before drafting. This is an author-owned planning surface, saved separately from your manuscript.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/books/${bookId}/memory`} className={secondary}>Book memory</Link>
        <button type="button" onClick={reload} disabled={busy} className={secondary}>{loading ? "Loading…" : "Reload"}</button>
        {editable && <button form="story-blueprint-form" type="submit" disabled={!dirty || busy || conflict} className={primary}>{saving ? "Saving…" : "Save blueprint"}</button>}
      </div>
    </div>

    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p role="status" aria-live="polite" className={conflict ? "text-amber-100" : dirty ? "text-amber-100" : "text-white/50"}>{status}</p>
      {!loading && !editable && <p className="text-xs text-white/45">Viewing access: this blueprint is read-only.</p>}
    </div>
    {error && <p role="alert" className="mt-5 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm leading-6 text-red-100">{error}</p>}
    {notice && <p role="status" className="mt-5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm leading-6 text-emerald-50">{notice}</p>}
    {conflict && <section className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/[0.08] p-4" aria-labelledby="blueprint-conflict-title"><h2 id="blueprint-conflict-title" className="font-medium text-amber-50">A newer saved version is available</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100">This page kept your local edits and did not overwrite another author’s work. Reload the current saved blueprint, then reapply any changes you still want.</p><button type="button" onClick={reload} disabled={busy} className={`${secondary} mt-4`}>Reload saved blueprint</button></section>}

    <form id="story-blueprint-form" onSubmit={(event) => void save(event)} className="mt-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,390px)] lg:items-start">
        <section className={panel} aria-labelledby="story-direction-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 id="story-direction-heading" className="text-xl font-medium">Story direction</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">Use this as a working brief for yourself and collaborators. Nothing here starts AI drafting or changes a manuscript chapter.</p></div>
            {dirty && <span className="rounded-full border border-amber-300/25 px-3 py-1 text-xs text-amber-100">Unsaved</span>}
          </div>
          <fieldset disabled={!editable || busy} className="mt-6 space-y-5">
            <label className="block text-sm text-white/75">Working title<input value={draft.story.workingTitle} onChange={(event) => updateStory("workingTitle", event.target.value)} maxLength={500} className={input} placeholder="The title you are writing toward" /></label>
            <div className="grid gap-5 md:grid-cols-2">
              <label className="block text-sm text-white/75">Genre<input value={draft.story.genre} onChange={(event) => updateStory("genre", event.target.value)} maxLength={240} className={input} placeholder="e.g. literary mystery" /></label>
              <label className="block text-sm text-white/75">Tone<input value={draft.story.tone} onChange={(event) => updateStory("tone", event.target.value)} maxLength={240} className={input} placeholder="e.g. intimate, wry" /></label>
              <label className="block text-sm text-white/75">Point of view<input value={draft.story.pointOfView} onChange={(event) => updateStory("pointOfView", event.target.value)} maxLength={120} className={input} placeholder="e.g. close third person" /></label>
              <label className="block text-sm text-white/75">Tense<input value={draft.story.tense} onChange={(event) => updateStory("tense", event.target.value)} maxLength={120} className={input} placeholder="e.g. past tense" /></label>
            </div>
            <label className="block text-sm text-white/75">Reader promise<textarea value={draft.story.readerPromise} onChange={(event) => updateStory("readerPromise", event.target.value)} maxLength={4000} rows={3} className={input} placeholder="What experience, emotional payoff, or question will the reader receive?" /></label>
            <label className="block text-sm text-white/75">Premise<textarea value={draft.story.premise} onChange={(event) => updateStory("premise", event.target.value)} maxLength={12_000} rows={5} className={input} placeholder="The central situation, conflict, and reason this story matters." /></label>
            <label className="block text-sm text-white/75">Synopsis<textarea value={draft.story.synopsis} onChange={(event) => updateStory("synopsis", event.target.value)} maxLength={24_000} rows={8} className={input} placeholder="Tell the full story in broad strokes, including the ending if you know it." /></label>
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_200px]">
              <label className="block text-sm text-white/75">Theme<textarea value={draft.story.theme} onChange={(event) => updateStory("theme", event.target.value)} maxLength={4000} rows={3} className={input} placeholder="The ideas or tensions you want to explore." /></label>
              <label className="block text-sm text-white/75">Target word count<input type="number" min={100} max={2_000_000} inputMode="numeric" value={draft.story.targetWordCount ?? ""} onChange={(event) => updateStory("targetWordCount", parseCount(event.target.value))} className={input} placeholder="Optional" /><span className="mt-2 block text-xs leading-5 text-white/40">Whole number, 100–2,000,000.</span></label>
            </div>
            <label className="block text-sm text-white/75">Private planning notes<textarea value={draft.story.notes} onChange={(event) => updateStory("notes", event.target.value)} maxLength={12_000} rows={5} className={input} placeholder="Research, structural questions, and reminders for your next pass." /></label>
          </fieldset>
          {editable && <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-white/10 pt-5"><button type="submit" disabled={!dirty || busy || conflict} className={primary}>{saving ? "Saving blueprint…" : "Save story blueprint"}</button><p className="text-xs leading-5 text-white/45">Save uses the revision you loaded and will not silently overwrite a newer plan.</p></div>}
        </section>

        <aside className="lg:sticky lg:top-6" aria-labelledby="chapter-plan-heading">
          <section className={panel}>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
              <div><h2 id="chapter-plan-heading" className="text-xl font-medium">Chapter plan</h2><p className="mt-2 text-sm leading-6 text-white/55">{draft.chapterPlan.length} planned {draft.chapterPlan.length === 1 ? "chapter" : "chapters"} · move items to shape the reading rhythm.</p></div>
              {editable && <button type="button" onClick={addPlanItem} disabled={busy || draft.chapterPlan.length >= 200} className={secondary}>Add chapter</button>}
            </div>
            <p className="mt-4 rounded-xl border border-sky-300/20 bg-sky-300/[0.05] p-3 text-xs leading-5 text-sky-50">Creating a manuscript chapter is an explicit, separate action. It makes one empty chapter from a saved plan item; it does not call AI, send text to a model, or use credits.</p>
            {!draft.chapterPlan.length ? <div className="py-9 text-center"><p className="text-sm text-white/55">No chapters are planned yet.</p>{editable && <button type="button" onClick={addPlanItem} disabled={busy} className={`${secondary} mt-4`}>Add the first chapter</button>}</div>
              : <ol className="mt-5 space-y-4">{draft.chapterPlan.map((item, index) => {
                const chapterId = materialized.get(item.id);
                const isCreating = materializing === item.id;
                const retrying = unconfirmedMaterialization === item.id;
                const canMaterialize = editable && Boolean(blueprint) && !dirty && !conflict && !chapterId;
                return <li key={item.id} className="rounded-xl border border-white/10 bg-black/25 p-4">
                  <div className="flex items-start justify-between gap-3"><p className="pt-1 text-xs font-medium uppercase tracking-[0.16em] text-white/40">{String(index + 1).padStart(2, "0")}</p><div className="flex shrink-0 gap-1"><button type="button" onClick={() => reorderPlanItem(item.id, -1)} disabled={busy || index === 0 || !editable} className="min-h-11 min-w-11 rounded-lg border border-white/15 px-2 text-sm text-white/75 transition duration-200 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40" aria-label={`Move ${item.title || `chapter ${index + 1}`} up`}>↑</button><button type="button" onClick={() => reorderPlanItem(item.id, 1)} disabled={busy || index === draft.chapterPlan.length - 1 || !editable} className="min-h-11 min-w-11 rounded-lg border border-white/15 px-2 text-sm text-white/75 transition duration-200 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40" aria-label={`Move ${item.title || `chapter ${index + 1}`} down`}>↓</button></div></div>
                  <fieldset disabled={!editable || busy} className="mt-3 space-y-3">
                    <label className="block text-xs text-white/65">Chapter title<input value={item.title} onChange={(event) => updatePlanItem(item.id, "title", event.target.value)} maxLength={500} className={input} /></label>
                    <label className="block text-xs text-white/65">Purpose<textarea value={item.purpose} onChange={(event) => updatePlanItem(item.id, "purpose", event.target.value)} maxLength={4000} rows={2} className={input} placeholder="What must change or become clear here?" /></label>
                    <label className="block text-xs text-white/65">Summary<textarea value={item.summary} onChange={(event) => updatePlanItem(item.id, "summary", event.target.value)} maxLength={16_000} rows={3} className={input} placeholder="Key scenes, turns, and reveals." /></label>
                    <label className="block text-xs text-white/65">Target words<input type="number" min={10} max={200_000} inputMode="numeric" value={item.targetWords ?? ""} onChange={(event) => updatePlanItem(item.id, "targetWords", parseCount(event.target.value))} className={input} placeholder="Optional" /></label>
                  </fieldset>
                  <div className="mt-4 border-t border-white/10 pt-4">
                    {chapterId ? <div><p className="text-sm text-emerald-100">Manuscript chapter created.</p><p className="mt-1 text-xs leading-5 text-white/50">This plan item stays in the blueprint so the created chapter keeps its provenance. Editing this title will not rename the manuscript chapter.</p><Link href={`/books/${bookId}?chapter=${chapterId}`} className="mt-3 inline-block text-sm text-emerald-100 underline underline-offset-4">Open manuscript chapter</Link></div>
                      : <><button type="button" onClick={() => void materialize(item)} disabled={!canMaterialize || isCreating} className={secondary}>{isCreating ? "Creating chapter…" : retrying ? "Retry original materialization" : "Create empty manuscript chapter"}</button><p className="mt-2 text-xs leading-5 text-white/45">{!blueprint ? "Save the blueprint first." : dirty ? "Save your plan changes before creating a chapter." : conflict ? "Reload the newer plan before creating a chapter." : "No AI call. No credits. The chapter starts empty."}</p></>}
                    {editable && !chapterId && <button type="button" onClick={() => deletePlanItem(item)} disabled={busy} className="mt-3 text-xs text-white/45 underline underline-offset-4 transition duration-200 hover:text-red-100 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">Remove from plan</button>}
                  </div>
                </li>;
              })}</ol>}
          </section>
        </aside>
      </div>
    </form>
    <StoryBlueprintProposalPanel
      bookId={bookId}
      blueprint={blueprint}
      editable={paidProposalEditable}
      blocked={busy || conflict || dirty}
      onApplied={load}
    />
  </main>;
}
