"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { WorkspaceMember } from "@bookworm/types";
import TeamTable, { type MemberProfile } from "../../components/TeamTable";
import { apiClient, DEMO_WORKSPACE } from "../../components/api";

const ROLES: WorkspaceMember["role"][] = ["owner", "admin", "editor", "writer", "illustrator", "designer", "reviewer", "viewer"];

function TeamPageInner() {
  const workspaceId = useSearchParams().get("ws") ?? DEMO_WORKSPACE;
  const api = apiClient();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [profiles, setProfiles] = useState<MemberProfile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const r = await api.listMembers(workspaceId);
      setMembers(r.members);
      setProfiles(r.profiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ padding: 16 }}>
      <h1>Team</h1>
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      <TeamTable
        members={members}
        profiles={profiles}
        roles={ROLES}
        canManage={!!api}
        onInvite={async (email, role) => {
          await api?.inviteMember(workspaceId, { email, role });
          await load();
        }}
        onRoleChange={async (userId, role) => {
          await api?.updateMemberRole(workspaceId, userId, role);
          await load();
        }}
      />
    </main>
  );
}

export default function TeamPage() {
  return (
    <Suspense>
      <TeamPageInner />
    </Suspense>
  );
}
