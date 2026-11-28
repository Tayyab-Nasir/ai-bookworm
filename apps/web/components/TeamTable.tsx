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

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return "badge-success";
      case "invited": return "badge-warning";
      case "suspended": return "badge-error";
      default: return "badge-info";
    }
  };

  return (
    <div>
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) {
              onInvite(email.trim(), role);
              setEmail("");
            }
          }}
          className="flex flex-col sm:flex-row gap-3 mb-6"
        >
          <input
            aria-label="Invite email"
            type="email"
            required
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input flex-1"
          />
          <select
            aria-label="Invite role"
            value={role}
            onChange={(e) => setRole(e.target.value as WorkspaceMember["role"])}
            className="input w-auto"
          >
            {roles.filter((r) => r !== "owner").map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button type="submit" className="btn-primary">Invite</button>
        </form>
      )}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center text-sm font-medium text-gold-400">
                      {nameOf(m.user_id).charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium text-white">{nameOf(m.user_id)}</span>
                  </div>
                </td>
                <td>
                  {canManage ? (
                    <select
                      aria-label={`Role for ${nameOf(m.user_id)}`}
                      value={m.role}
                      onChange={(e) => onRoleChange(m.user_id, e.target.value as WorkspaceMember["role"])}
                      className="bg-navy-800 border border-navy-700 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-gold-500"
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="capitalize text-slate-300">{m.role}</span>
                  )}
                </td>
                <td>
                  <span className={`badge ${getStatusColor(m.status)}`}>
                    {m.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
