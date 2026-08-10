"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { Approval } from "@bookworm/types";
import { apiClient, DEMO_WORKSPACE } from "../../components/api";

function ApprovalsPageInner() {
  const workspaceId = useSearchParams().get("ws") ?? DEMO_WORKSPACE;
  const api = apiClient();
  const [pending, setPending] = useState<Approval[]>([]);
  const [done, setDone] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const all = await api.listApprovals(workspaceId);
      setPending(all.approvals.filter((a) => a.status === "pending"));
      setDone(all.approvals.filter((a) => a.status !== "pending"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (a: Approval, action: "approve" | "reject") => {
    try {
      await api?.resolveApproval(a.id, action);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "resolve failed");
    }
  };

  return (
    <main style={{ padding: 16 }}>
      <h1>Approvals</h1>
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      <h2>Pending ({pending.length})</h2>
      {pending.length === 0 && <p style={{ color: "#777" }}>Queue is clear.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {pending.map((a) => (
          <li key={a.id} style={{ border: "1px solid #eee", borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <strong>{a.entity_type}</strong> {a.entity_id.slice(0, 8)} · requested by {a.requested_by.slice(0, 8)} ·{" "}
            {new Date(a.created_at).toLocaleString()}
            {a.comment && <p style={{ margin: "4px 0" }}>{a.comment}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => void resolve(a, "approve")}>Approve</button>
              <button onClick={() => void resolve(a, "reject")}>Reject</button>
            </div>
          </li>
        ))}
      </ul>
      <h2>Resolved</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {done.map((a) => (
          <li key={a.id} style={{ padding: "4px 0", color: "#555" }}>
            {a.entity_type} {a.entity_id.slice(0, 8)} — <strong>{a.status}</strong>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense>
      <ApprovalsPageInner />
    </Suspense>
  );
}
