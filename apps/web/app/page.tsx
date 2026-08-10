"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ActivityEvent } from "@bookworm/api-client";
import ActivityTimeline from "../components/ActivityTimeline";
import { apiClient } from "../components/api";

// Dashboard: activity timeline when an API + ?ws= are configured, else the
// offline shell. ponytail: usage/tasks widgets land with their pages' data.
export default function Home() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const api = apiClient();

  useEffect(() => {
    const ws = new URLSearchParams(window.location.search).get("ws");
    if (api && ws) api.listActivity(ws, 20).then((r) => setEvents(r.events)).catch(() => {});
  }, [api]);

  return (
    <main style={{ padding: 16 }}>
      <h1>AI Bookworm</h1>
      <p>AI-assisted book publishing platform.</p>
      <nav style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Link href="/assets">Assets</Link>
        <Link href="/team">Team</Link>
        <Link href="/tasks">Tasks</Link>
        <Link href="/approvals">Approvals</Link>
      </nav>
      <h2>Recent activity</h2>
      {api ? (
        <ActivityTimeline events={events} />
      ) : (
        <p style={{ color: "#777" }}>
          Offline demo — set <code>NEXT_PUBLIC_API_URL</code>/<code>NEXT_PUBLIC_API_TOKEN</code> and append{" "}
          <code>?ws=&lt;workspaceId&gt;</code> to see live activity.
        </p>
      )}
    </main>
  );
}
