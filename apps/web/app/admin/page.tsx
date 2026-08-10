"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../../components/api";

type Row = Record<string, unknown>;
type Tab = "users" | "jobs" | "flags" | "support" | "audit";
const TABS: Tab[] = ["users", "jobs", "flags", "support", "audit"];

// ponytail: generic table renderer, no per-tab components. Add when a tab
// needs custom cells beyond value stringification.
function Table({ rows, renderActions }: { rows: Row[]; renderActions?: (r: Row) => React.ReactNode }) {
  if (!rows.length) return <p>None.</p>;
  const cols = Object.keys(rows[0]).slice(0, 7);
  return (
    <table>
      <thead>
        <tr>{cols.map((c) => <th key={c}>{c}</th>)}{renderActions && <th>actions</th>}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={(r.id as string) ?? i}>
            {cols.map((c) => (
              <td key={c}>{typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]).slice(0, 80) : String(r[c] ?? "")}</td>
            ))}
            {renderActions && <td>{renderActions(r)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AdminPage() {
  const api = apiClient();
  const [tab, setTab] = useState<Tab>("users");
  const [rows, setRows] = useState<Row[]>([]);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (t: Tab) => {
    if (!api) return;
    setError(null);
    try {
      const data = await api.adminList(t);
      setRows(data as Row[]);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403 || status === 401) setDenied(true);
      else setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api]);

  useEffect(() => { void load(tab); }, [tab, load]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(tab); } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    }
  }, [load, tab]);

  if (denied) return <main style={{ padding: 16 }}><h1>Admin</h1><p>No access.</p></main>;

  return (
    <main style={{ padding: 16 }}>
      <h1>Admin</h1>
      {!api && <p>Demo mode — set NEXT_PUBLIC_API_URL / NEXT_PUBLIC_API_TOKEN.</p>}
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      <nav style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}>{t}</button>
        ))}
      </nav>

      {tab === "users" && (
        <Table rows={rows} renderActions={(r) => (
          <button disabled={!api} onClick={() => void act(() => api!.adminSuspendUser(r.id as string))}>Suspend</button>
        )} />
      )}
      {tab === "jobs" && (
        <Table rows={rows} renderActions={(r) =>
          (r.status === "failed" || r.status === "dead") ? (
            <button disabled={!api} onClick={() => void act(() => api!.adminRetryJob("ai", r.id as string))}>Retry</button>
          ) : null
        } />
      )}
      {tab === "flags" && (
        <Table rows={rows} renderActions={(r) => (
          <button disabled={!api} onClick={() => void act(() => api!.adminToggleFlag(r.key as string, !r.enabled))}>
            {r.enabled ? "Disable" : "Enable"}
          </button>
        )} />
      )}
      {tab === "support" && (
        <Table rows={rows} renderActions={(r) =>
          r.status !== "resolved" ? (
            <button disabled={!api} onClick={() => void act(() => api!.adminUpdateTicket(r.id as string, "resolved"))}>Resolve</button>
          ) : null
        } />
      )}
      {tab === "audit" && <Table rows={rows} />}
    </main>
  );
}
