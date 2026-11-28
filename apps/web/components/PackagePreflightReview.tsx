"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ApiClient, PackagePreflight } from "@bookworm/api-client";

export default function PackagePreflightReview({ api, actor, jobId, preflightId, isCurrent }: {
  api: Pick<ApiClient, "getPackagePreflight">; actor: string; jobId: string; preflightId: string; isCurrent: () => boolean;
}) {
  const [state, setState] = useState<"closed" | "loading" | "unavailable" | PackagePreflight>("closed");
  const generation = useRef(0);
  const current = useRef(isCurrent);
  useLayoutEffect(() => { current.current = isCurrent; }, [isCurrent]);
  useLayoutEffect(() => () => { generation.current++; }, []);

  async function load() {
    if (!current.current()) return;
    const version = ++generation.current;
    const valid = () => version === generation.current && current.current();
    setState("loading");
    try {
      const report = await api.getPackagePreflight(jobId, actor);
      if (!valid()) return;
      setState(report.packageJobId === jobId && report.preflightJobId === preflightId ? report : "unavailable");
    } catch {
      if (valid()) setState("unavailable");
    }
  }

  return <details className="mt-3 border-t border-white/10" onToggle={event => {
    if (event.currentTarget.open) void load();
    else { generation.current++; setState("closed"); }
  }}>
    <summary className="min-h-11 cursor-pointer py-3 text-sm text-white/75">Review package preflight</summary>
    {state === "loading" && <p role="status" className="text-sm text-white/60">Loading the saved preflight…</p>}
    {state === "unavailable" && <div className="text-sm">
      <p role="alert" className="text-amber-100">The saved preflight is unavailable here. Check preflight.json in the original ZIP if you have it.</p>
      <button type="button" className="min-h-11 underline" onClick={() => void load()}>Check again</button>
    </div>}
    {typeof state === "object" && <div className="space-y-2 text-sm text-white/75">
      <p>Saved preflight · {state.warnings === 0 ? "No warnings recorded" : `${state.warnings} ${state.warnings === 1 ? "warning" : "warnings"}`}</p>
      <p className="text-xs text-white/55">Rules {state.ruleVersion}</p>
      {state.findings.length > 0 && <ul className="space-y-2">
        {state.findings.map((finding, index) => <li key={`${finding.code}:${index}`} className="break-words rounded-lg border border-white/10 p-3">
          <p>{finding.message}</p>
          {finding.location && <p className="mt-1 text-xs text-white/55">{finding.location}</p>}
        </li>)}
      </ul>}
    </div>}
  </details>;
}
