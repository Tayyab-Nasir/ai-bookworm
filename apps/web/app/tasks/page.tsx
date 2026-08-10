"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { Task, WorkspaceMember } from "@bookworm/types";
import { apiClient, DEMO_WORKSPACE } from "../../components/api";

const COLUMNS: Task["status"][] = ["todo", "in_progress", "blocked", "done"];

function TasksPageInner() {
  const workspaceId = useSearchParams().get("ws") ?? DEMO_WORKSPACE;
  const api = apiClient();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const [t, m] = await Promise.all([api.listTasks(workspaceId), api.listMembers(workspaceId)]);
      setTasks(t.tasks);
      setMembers(m.members.filter((x) => x.status === "active"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = async (t: Task, status: Task["status"]) => {
    await api?.updateTask(t.id, { status });
    await load();
  };

  return (
    <main style={{ padding: 16 }}>
      <h1>Tasks</h1>
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      {api && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await api.createTask({ workspaceId, title: title.trim() });
            setTitle("");
            await load();
          }}
          style={{ display: "flex", gap: 8, marginBottom: 12 }}
        >
          <input aria-label="New task" placeholder="New task…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
          <button type="submit">Add</button>
        </form>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`, gap: 8 }}>
        {COLUMNS.map((col) => (
          <section key={col} aria-label={col} style={{ background: "#fafafa", borderRadius: 6, padding: 8 }}>
            <h3 style={{ margin: "0 0 8px", textTransform: "capitalize" }}>{col.replace("_", " ")}</h3>
            {tasks.filter((t) => t.status === col).map((t) => (
              <article key={t.id} style={{ background: "#fff", border: "1px solid #eee", borderRadius: 4, padding: 8, marginBottom: 8 }}>
                <strong>{t.title}</strong>
                <div style={{ fontSize: 12, color: "#777" }}>
                  {t.priority}
                  {t.due_at && ` · due ${new Date(t.due_at).toLocaleDateString()}`}
                </div>
                <select
                  aria-label="Assignee"
                  value={t.assignee_id ?? ""}
                  onChange={async (e) => {
                    await api?.updateTask(t.id, { assigneeId: e.target.value || null });
                    await load();
                  }}
                  style={{ marginTop: 4, width: "100%" }}
                >
                  <option value="">unassigned</option>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>{m.user_id.slice(0, 8)} ({m.role})</option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                  {COLUMNS.filter((c) => c !== col).map((c) => (
                    <button key={c} onClick={() => void move(t, c)} style={{ fontSize: 11 }}>
                      → {c.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksPageInner />
    </Suspense>
  );
}
