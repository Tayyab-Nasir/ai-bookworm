"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiClient } from "./api";

type SessionUser = { id: string; email: string | null; displayName: string | null };

export default function InvitationAcceptance() {
  const api = apiClient();
  const [token, setToken] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ workspaceId: string; role: string } | null>(null);

  useEffect(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    if (fragmentToken) window.sessionStorage.setItem("bookworm:invitationToken", fragmentToken);
    const value = fragmentToken || window.sessionStorage.getItem("bookworm:invitationToken") || "";
    if (fragmentToken) window.history.replaceState(null, "", "/team/accept");
    setToken(value);
    fetch("/api/auth/session").then(async (response) => {
      if (response.ok) setUser((await response.json() as { user: SessionUser }).user);
    }).catch(() => {}).finally(() => setSessionChecked(true));
  }, []);

  async function accept() {
    if (!token || !user || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.acceptWorkspaceInvitation(token);
      window.localStorage.setItem("bookworm:workspaceId", result.workspaceId);
      window.sessionStorage.removeItem("bookworm:invitationToken");
      setAccepted({ workspaceId: result.workspaceId, role: result.role });
      setToken("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invitation could not be accepted."); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-[100dvh] max-w-xl items-center px-4 py-16 text-white">
    <section className="w-full rounded-3xl border border-white/10 bg-white/[0.035] p-7 sm:p-9">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">AI Bookworm workspace</p>
      <h1 className="mt-3 text-3xl font-medium tracking-[-0.05em]">Accept invitation</h1>
      {accepted ? <div className="mt-7"><p className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">You joined the workspace as {accepted.role}.</p><Link href={`/team?ws=${encodeURIComponent(accepted.workspaceId)}`} className="glass-solid mt-5 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold text-black">Open the team workspace</Link></div> : <>
        <p className="mt-4 text-sm leading-6 text-white/50">Sign in with the exact email address that received this invitation. The server verifies both the account and the expiring token before granting access.</p>
        {!token && sessionChecked && <p role="alert" className="mt-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">This invitation link is missing its secure token. Ask the workspace owner to create a new link.</p>}
        {token && sessionChecked && !user && <div className="mt-6"><p className="text-sm text-white/60">Sign in or create an account before accepting. The invitation token stays in this browser tab and is not sent through the login URL.</p><Link href="/login?next=%2Fteam%2Faccept" className="glass-solid mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold text-black">Sign in to continue</Link></div>}
        {token && user && <div className="mt-6"><p className="rounded-xl border border-white/10 p-4 text-sm text-white/60">Signed in as <span className="text-white">{user.email ?? user.displayName ?? "your account"}</span></p><button type="button" onClick={() => void accept()} disabled={busy} className="glass-solid mt-4 w-full rounded-full px-5 py-3 text-sm font-semibold text-black disabled:opacity-40">{busy ? "Joining…" : "Accept and join workspace"}</button></div>}
        {error && <p role="alert" className="mt-5 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</p>}
      </>}
    </section>
  </main>;
}
