"use client";

import { useState } from "react";
import type { WorkspaceMember } from "@bookworm/types";

export interface MemberProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

export interface TeamTableProps {
  members: WorkspaceMember[];
  profiles: MemberProfile[];
  roles: WorkspaceMember["role"][];
  canManage: boolean;
  onInvite: (email: string, role: WorkspaceMember["role"]) => void;
  onRoleChange: (userId: string, role: WorkspaceMember["role"]) => void;
}

export default function TeamTable({ members, profiles, roles, canManage, onInvite, onRoleChange }: TeamTableProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceMember["role"]>("viewer");
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.display_name || id.slice(0, 8);

  return (
    <section>
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) {
              onInvite(email.trim(), role);
              setEmail("");
            }
          }}
          style={{ display: "flex", gap: 8, marginBottom: 12 }}
        >
          <input
            aria-label="Invite email"
            type="email"
            required
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select aria-label="Invite role" value={role} onChange={(e) => setRole(e.target.value as WorkspaceMember["role"])}>
            {roles.filter((r) => r !== "owner").map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button type="submit">Invite</button>
        </form>
      )}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">Member</th>
            <th align="left">Role</th>
            <th align="left">Status</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id} style={{ borderTop: "1px solid #eee" }}>
              <td style={{ padding: "6px 4px" }}>{nameOf(m.user_id)}</td>
              <td>
                {canManage ? (
                  <select
                    aria-label={`Role for ${nameOf(m.user_id)}`}
                    value={m.role}
                    onChange={(e) => onRoleChange(m.user_id, e.target.value as WorkspaceMember["role"])}
                  >
                    {roles.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                ) : (
                  m.role
                )}
              </td>
              <td>{m.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
