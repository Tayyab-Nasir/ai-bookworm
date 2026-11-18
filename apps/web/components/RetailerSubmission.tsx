"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient } from "@bookworm/api-client";
import { RETAILER_SUBMISSION_STATUSES, type RetailerSubmission as Submission, type RetailerSubmissionStatus } from "@bookworm/types";

const STATUS_LABELS: Record<RetailerSubmissionStatus, string> = {
  not_submitted: "Not submitted",
  submitted: "Submitted",
  in_review: "In review",
  changes_requested: "Changes requested",
  published: "Published",
  withdrawn: "Withdrawn",
};

type Props = {
  api: Pick<ApiClient, "getRetailerSubmission" | "saveRetailerSubmission">;
  actor: string;
  jobId: string;
  canEdit: boolean;
  isCurrent: () => boolean;
};

type State =
  | { phase: "loading" }
  | { phase: "unavailable"; message: string }
  | { phase: "unconfirmed"; message: string }
  | {
      phase: "ready" | "saving";
      saved: Submission | null;
      choice: RetailerSubmissionStatus | "";
      savedNow?: boolean;
    };

function SubmissionForm({ api, actor, jobId, canEdit, isCurrent }: Props) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const generation = useRef(0);
  const saving = useRef(false);
  const current = useRef(isCurrent);
  useLayoutEffect(() => { current.current = isCurrent; }, [isCurrent]);

  const load = useCallback(async () => {
    if (saving.current || !current.current()) return;
    const version = ++generation.current;
    setState({ phase: "loading" });
    try {
      const saved = await api.getRetailerSubmission(jobId, actor);
      if (version === generation.current && current.current()) {
        setState({ phase: "ready", saved, choice: saved?.status ?? "" });
      }
    } catch {
      if (version === generation.current && current.current()) {
        setState({ phase: "unavailable", message: "Submission status could not be loaded." });
      }
    }
  }, [api, actor, jobId]);
  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  async function save() {
    if (!canEdit || !current.current() || saving.current || state.phase !== "ready"
      || !state.choice || state.choice === state.saved?.status) return;
    const version = ++generation.current;
    saving.current = true;
    setState({ ...state, phase: "saving", savedNow: false });
    try {
      const saved = await api.saveRetailerSubmission(jobId, {
        status: state.choice,
        expectedRevision: state.saved?.revision ?? null,
      }, actor);
      if (version === generation.current && current.current()) {
        setState({ phase: "ready", saved, choice: saved.status, savedNow: true });
      }
    } catch (error) {
      if (version === generation.current && current.current()) {
        const message = error instanceof ApiClientError && error.status === 409
          ? "Someone changed the status. Check the saved status before editing again."
          : "The save could not be confirmed. Check the saved status before trying again.";
        setState({ phase: "unconfirmed", message });
      }
    } finally {
      saving.current = false;
    }
  }

  if (state.phase === "loading") return <p role="status" className="text-sm text-white/60">Checking submission status…</p>;
  if (state.phase === "unavailable" || state.phase === "unconfirmed") {
    return <div className="space-y-2 text-sm">
      <p role="alert" className="text-amber-100">{state.message}</p>
      <button type="button" onClick={() => void load()} className="min-h-11 underline underline-offset-4">Check saved status</button>
    </div>;
  }
  return <div className="space-y-3 text-sm">
    <p className="text-white/70">Author-reported status · {state.saved ? STATUS_LABELS[state.saved.status] : "No status recorded"}</p>
    {state.saved && <p className="text-xs text-white/50">Last updated <time dateTime={state.saved.updatedAt}>{new Date(state.saved.updatedAt).toLocaleString()}</time></p>}
    {canEdit && <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 text-white/70">Update status
        <select
          value={state.choice}
          disabled={state.phase === "saving"}
          onChange={event => {
            const choice = RETAILER_SUBMISSION_STATUSES.find(status => status === event.target.value);
            if (state.phase === "ready") setState({ ...state, choice: choice ?? "", savedNow: false });
          }}
          className="mt-1 block min-h-11 max-w-full rounded-lg border border-white/20 bg-black px-3 text-white"
        >
          <option value="">Choose a status</option>
          {RETAILER_SUBMISSION_STATUSES.map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => void save()}
        disabled={state.phase === "saving" || !state.choice || state.choice === state.saved?.status}
        className="glass-ghost min-h-11 rounded-full px-4 disabled:opacity-40">
        {state.phase === "saving" ? "Saving…" : "Save status"}
      </button>
    </div>}
    {state.savedNow && <p role="status" className="text-emerald-100">Submission status saved.</p>}
  </div>;
}

export default function RetailerSubmission(props: Props) {
  const [open, setOpen] = useState(false);
  return <details className="mt-3 border-t border-white/10"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="min-h-11 cursor-pointer py-3 text-sm text-white/75">Retailer submission status</summary>
    {open && <SubmissionForm {...props} />}
  </details>;
}
