"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ApiClient, PackageListing } from "@bookworm/api-client";
import RetailerListingReview from "./RetailerListingReview";

export default function PackageListingReview({ api, actor, jobId, checksum, isCurrent }: {
  api: Pick<ApiClient, "getPackageListing">; actor: string; jobId: string; checksum: string; isCurrent: () => boolean;
}) {
  const [state, setState] = useState<"closed" | "loading" | "unavailable" | PackageListing>("closed");
  const generation = useRef(0);
  const current = useRef(isCurrent);
  useLayoutEffect(() => { current.current = isCurrent; }, [isCurrent]);
  useLayoutEffect(() => () => { generation.current++; }, []);

  async function load() {
    if (!current.current()) return;
    const sequence = ++generation.current;
    const valid = () => sequence === generation.current && current.current();
    setState("loading");
    try {
      const result = await api.getPackageListing(jobId, checksum, actor);
      if (!valid()) return;
      setState(result.packageJobId === jobId && result.packageSha256 === checksum && result.metadata
        ? result : "unavailable");
    } catch {
      if (valid()) setState("unavailable");
    }
  }

  const visibleGeneration = generation.current;
  return <details className="mt-3 border-t border-white/10" onToggle={event => {
    if (event.currentTarget.open) void load();
    else { generation.current++; setState("closed"); }
  }}>
    <summary className="min-h-11 cursor-pointer py-3 text-sm text-white/75">Copy package listing</summary>
    {state === "loading" && <p role="status" className="text-sm text-white/60">Reading the saved package listing…</p>}
    {state === "unavailable" && <div className="text-sm">
      <p role="alert" className="text-amber-100">The listing is unavailable here. Open metadata.json in the original ZIP if you have it.</p>
      <button type="button" className="min-h-11 underline" onClick={() => void load()}>Check again</button>
    </div>}
    {typeof state === "object" && <RetailerListingReview metadata={state.metadata}
      isCurrent={() => generation.current === visibleGeneration && current.current()} inline />}
  </details>;
}
