"use client";

import type { ActivityEvent } from "@bookworm/api-client";

export default function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) return <p style={{ color: "#777" }}>No activity yet.</p>;
  return (
    <ul aria-label="Activity" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {events.map((e) => (
        <li key={e.id} style={{ padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
          <small style={{ color: "#777" }}>{new Date(e.created_at).toLocaleString()}</small>{" "}
          <strong>{(e.actor_id ?? "system").slice(0, 8)}</strong> {e.event_type.replace(/_/g, " ")}
          {e.entity_type && (
            <span style={{ color: "#555" }}>
              {" "}· {e.entity_type} {(e.entity_id ?? "").slice(0, 8)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
