"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "@bookworm/api-client";
import type { ManagedPublishingRequest } from "@bookworm/types";

type Props = {
  api: Pick<ApiClient, "getManagedPublishingRequest" | "requestManagedPublishing" | "withdrawManagedPublishing">;
  jobId: string;
  workspaceId: string;
  actor: string;
  checksum: string | null;
  isCurrent: () => boolean;
};

type State =
  | { phase: "loading" | "saving" | "withdrawing" | "ready" }
  | { phase: "saved"; receipt: ManagedPublishingRequest }
  | { phase: "unavailable"; message: string };

export default function ManagedPublishingConsent({ api, jobId, workspaceId, actor, checksum, isCurrent }: Props) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [consent, setConsent] = useState(false);
  const active = useRef(false);
  const pending = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function update(action: "read" | "record" | "withdraw") {
    if (pending.current || !isCurrent() || (action === "record" && (!consent || state.phase !== "ready" || !checksum))
      || (action === "withdraw" && (state.phase !== "saved" || state.receipt.withdrawnAt || state.receipt.confirmedAt))) return;
    const reviewedChecksum = action === "withdraw" && state.phase === "saved" ? state.receipt.packageSha256 : checksum;
    pending.current = true;
    setConsent(false);
    setState({ phase: action === "record" ? "saving" : action === "withdraw" ? "withdrawing" : "loading" });
    try {
      const receipt = action === "read" || !reviewedChecksum ? await api.getManagedPublishingRequest(jobId, workspaceId, actor)
        : action === "record" ? await api.requestManagedPublishing(jobId, workspaceId, reviewedChecksum, actor)
        : await api.withdrawManagedPublishing(jobId, workspaceId, reviewedChecksum, actor);
      if (active.current && isCurrent()) {
        if (action !== "read" && receipt?.packageSha256 !== reviewedChecksum) throw new Error("Different package");
        setState(receipt ? { phase: "saved", receipt } : { phase: "ready" });
      }
    } catch {
      if (active.current && isCurrent()) setState({ phase: "unavailable", message: action !== "read"
        ? "The request could not be confirmed. Check its saved status before trying again."
        : "The saved request could not be verified." });
    } finally { pending.current = false; }
  }

  return <details className="mt-3 border-t border-white/10" onToggle={event => {
    if (event.currentTarget.open) void update("read");
  }}>
    <summary className="min-h-11 cursor-pointer py-3 text-sm text-white/75">Managed publishing request</summary>
    {state.phase === "loading" && <p role="status">Checking the saved request…</p>}
    {state.phase === "saving" && <p role="status">Recording consent for this package…</p>}
    {state.phase === "withdrawing" && <p role="status">Withdrawing consent for this package…</p>}
    {state.phase === "unavailable" && <div className="space-y-2 text-sm">
      <p role="alert">{state.message}</p>
      <button type="button" className="min-h-11 underline" onClick={() => void update("read")}>Check saved request</button>
    </div>}
    {state.phase === "saved" && (state.receipt.withdrawnAt
      ? <p role="status" className="text-sm">Consent withdrawn on <time dateTime={state.receipt.withdrawnAt}>{new Date(state.receipt.withdrawnAt).toLocaleString()}</time>.</p>
      : state.receipt.confirmedAt && state.receipt.listingUrl
        ? <div className="space-y-2 text-sm"><p role="status" className="text-emerald-100">
          Operator confirmed publication on <time dateTime={state.receipt.confirmedAt}>{new Date(state.receipt.confirmedAt).toLocaleString()}</time>.
        </p><a href={state.receipt.listingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline">Open retailer listing</a></div>
      : <div className="space-y-2 text-sm"><p role="status" className="text-emerald-100">
        Consent recorded on <time dateTime={state.receipt.requestedAt}>{new Date(state.receipt.requestedAt).toLocaleString()}</time>. Retailer submission is a separate step.
      </p><button type="button" className="min-h-11 underline" onClick={() => void update("withdraw")}>Withdraw consent</button></div>)}
    {state.phase === "ready" && !checksum && <p className="text-sm">This package is currently unavailable for a new request.</p>}
    {state.phase === "ready" && checksum && <div className="space-y-2 text-sm">
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        I authorize Bookworm to use this exact package for managed publishing.</label>
      <button type="button" className="glass-ghost min-h-11 rounded-full px-4 disabled:opacity-40"
        onClick={() => void update("record")} disabled={!consent}>Record consent</button>
    </div>}
  </details>;
}
