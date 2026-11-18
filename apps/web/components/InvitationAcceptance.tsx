"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "@bookworm/api-client";
import { readBrowserSession } from "../lib/browser-session";
import { apiClient } from "./api";

type SessionUser = { id: string; email: string | null };
type Accepted = { actor: string; workspaceId: string; role: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const roles = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer", "reviewer", "viewer"]);

export default function InvitationAcceptance() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const dispatched = useRef(false);

  const checkSession = useCallback(async () => {
    const ticket = ++epoch.current;
    if (dispatched.current) setUncertain(true);
    setUser(null); setSessionChecked(false);
    try {
      const next = await readBrowserSession();
      if (mounted.current && epoch.current === ticket) setUser(next);
    } catch {
      if (mounted.current && epoch.current === ticket) setUser(null);
    } finally {
      if (mounted.current && epoch.current === ticket) setSessionChecked(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    let value = fragmentToken;
    try {
      if (fragmentToken) window.sessionStorage.setItem("bookworm:invitationToken", fragmentToken);
      value ||= window.sessionStorage.getItem("bookworm:invitationToken") || "";
    } catch { setError("This browser could not retain the invitation. Keep the original invitation link available."); }
    if (fragmentToken) window.history.replaceState(null, "", "/team/accept");
    setToken(value);
    void checkSession();
    const recheck = () => void checkSession();
    const visibility = () => { if (document.visibilityState === "visible") recheck(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; epoch.current++; window.removeEventListener("focus", recheck); document.removeEventListener("visibilitychange", visibility); };
  }, [checkSession]);

  async function accept() {
    if (!token || !user || !sessionChecked || inFlight.current || uncertain) return;
    const actor = user.id; const requestToken = token; const ticket = epoch.current;
    const valid = () => mounted.current && epoch.current === ticket;
    inFlight.current = true; setBusy(true); setError(null);
    let sent = false;
    try {
      await readBrowserSession(actor);
      if (!valid()) return;
      sent = true; dispatched.current = true;
      const result = await apiClient(actor).acceptWorkspaceInvitation(requestToken);
      if (!valid()) return;
      await readBrowserSession(actor);
      if (!valid()) return;
      if (!result || !uuid.test(result.workspaceId) || !uuid.test(result.organizationId) || result.status !== "active" || !roles.has(result.role)) throw new Error("Invitation response could not be confirmed.");
      window.localStorage.setItem("bookworm:workspaceId", result.workspaceId);
      if (window.sessionStorage.getItem("bookworm:invitationToken") === requestToken) window.sessionStorage.removeItem("bookworm:invitationToken");
      setAccepted({ actor, workspaceId: result.workspaceId, role: result.role }); setToken(""); setUncertain(false);
    } catch (reason) {
      if (valid()) {
        if (!sent) {
          setUser(null); setSessionChecked(true); setError(reason instanceof Error ? reason.message : "Your account could not be verified.");
        } else if (reason instanceof ApiClientError && [401, 403, 404, 422].includes(reason.status)) {
          try {
            await readBrowserSession(actor);
            if (valid()) setError(reason.message);
          } catch {
            if (valid()) { setUser(null); setSessionChecked(true); setError("Your account changed. Recheck your account before continuing."); }
          }
        } else setUncertain(true);
      }
    } finally {
      dispatched.current = false; inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const shown = sessionChecked && user?.id === accepted?.actor ? accepted : null;
  return <main className="mx-auto flex min-h-[100dvh] max-w-xl items-center px-4 py-16 text-white">
    <section className="w-full rounded-3xl border border-white/10 bg-white/[0.035] p-7 sm:p-9">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">AI Bookworm workspace</p>
      <h1 className="mt-3 text-3xl font-medium tracking-[-0.05em]">Accept invitation</h1>
      {shown ? <div className="mt-7"><p className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">You joined the workspace as {shown.role}.</p><Link href={`/team?ws=${encodeURIComponent(shown.workspaceId)}`} className="glass-solid mt-5 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold text-black">Open the team workspace</Link></div> : <>
        <p className="mt-4 text-sm leading-6 text-white/50">Sign in with the exact email address that received this invitation. The server verifies both the account and the expiring token before granting access.</p>
        {!sessionChecked && <p role="status" className="mt-6 text-sm text-white/60">Checking your account…</p>}
        {!token && sessionChecked && <p role="alert" className="mt-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">This invitation link is missing its secure token. Ask the workspace owner to create a new link.</p>}
        {token && sessionChecked && !user && <div className="mt-6"><p className="text-sm text-white/60">Sign in or create an account before accepting. The invitation token stays in this browser tab and is not sent through the login URL.</p><Link href="/login?next=%2Fteam%2Faccept" className="glass-solid mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold text-black">Sign in to continue</Link><button type="button" onClick={() => void checkSession()} className="ml-4 underline">Recheck account</button></div>}
        {token && user && sessionChecked && !uncertain && <div className="mt-6"><p className="rounded-xl border border-white/10 p-4 text-sm text-white/60">Signed in as <span className="text-white">{user.email ?? "your account"}</span></p><button type="button" onClick={() => void accept()} disabled={busy} className="glass-solid mt-4 w-full rounded-full px-5 py-3 text-sm font-semibold text-black disabled:opacity-40">{busy ? "Joining…" : "Accept and join workspace"}</button></div>}
        {uncertain && <div role="alert" className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm text-amber-100">The invitation may have been accepted, but its result could not be confirmed. Check your workspace list before trying again. <Link href="/team" className="underline">Open workspaces</Link></div>}
        {error && <p role="alert" className="mt-5 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</p>}
      </>}
    </section>
  </main>;
}
