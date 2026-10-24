"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiClient } from "./api";
import { ApiClientError } from "@bookworm/api-client";
import { readBrowserSession } from "../lib/browser-session";

export function AccountMenu() {
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const currentLoad = useRef<object | null>(null);
  const actor = useRef<string | null>(null);
  const logoutFlight = useRef<object | null>(null);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    if (!mounted.current) return;
    const request = {};
    currentLoad.current = request;
    actor.current = null;
    setEmail(null); setAdmin(false); setError(""); setChecking(true);
    const current = () => currentLoad.current === request;
    try {
      const account = await readBrowserSession();
      if (!current()) return;
      let allowed = false;
      let warning = "";
      try {
        const result = await apiClient().adminAccess(account.id, AbortSignal.timeout(12_000));
        if (result.viewerId !== account.id) throw new Error("Account response mismatch.");
        allowed = result.admin === true;
      } catch (reason) {
        // Non-admins are expected to receive 403. Any other failure closes the
        // link instead of retaining a previous account's administrative role.
        if (!(reason instanceof ApiClientError && reason.status === 403)) warning = "Administrative access could not be verified.";
      }
      if (!current()) return;
      await readBrowserSession(account.id);
      if (!current()) return;
      actor.current = account.id;
      setEmail(account.email); setAdmin(allowed); setError(warning);
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : "Your session could not be verified.");
    } finally { if (current()) setChecking(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const focus = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false; currentLoad.current = null; actor.current = null; logoutFlight.current = null;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  async function logout() {
    const expectedActor = actor.current;
    if (!expectedActor || logoutFlight.current) return;
    const request = currentLoad.current, flight = {};
    logoutFlight.current = flight;
    const current = () => mounted.current && currentLoad.current === request && logoutFlight.current === flight;
    setBusy(true); setError("");
    try {
      await readBrowserSession(expectedActor);
      if (!current()) return;
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json", "x-bookworm-actor": expectedActor }, body: "{}", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!current()) return;
      if (!response.ok) throw new Error("Sign-out failed. Please retry.");
      // A different tab can sign in while this operation is in flight. Never
      // navigate away from a now-active account on an older logout's reply.
      const verification = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!current()) return;
      if (verification.status !== 401) { await load(); return; }
      try { localStorage.removeItem("bookworm:workspaceId"); } catch { /* Storage access is optional. */ }
      window.location.assign("/login");
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "Sign-out failed."); }
    finally {
      if (logoutFlight.current === flight) { logoutFlight.current = null; if (mounted.current) setBusy(false); }
    }
  }
  return <div className="relative flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs">
    {admin && <Link href="/admin" className="inline-flex min-h-11 items-center rounded-full border border-white/15 px-3 py-2 text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Admin</Link>}
    <Link href="/settings/data-rights" aria-label="Account settings and support" title={email ?? "Account settings"} className="inline-flex min-h-11 items-center rounded-full border border-white/15 px-3 py-2 text-[#aaa] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><span className="lg:hidden">Account</span><span className="hidden max-w-40 truncate lg:inline">{email ?? "Account"}</span></Link>
    <button onClick={() => void logout()} disabled={busy || checking || !actor.current} className="min-h-11 rounded-full border border-white/15 px-3 py-2 text-[#ddd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50">{busy ? "Signing out…" : checking ? "Checking account…" : "Sign out"}</button>
    {error && <div role="alert" className="absolute right-0 top-12 z-50 w-60 rounded-xl border border-red-300/20 bg-red-950 p-3 text-red-100"><p>{error}</p><button type="button" onClick={() => void load()} disabled={checking || busy} className="mt-2 min-h-11 rounded-full border border-red-200/30 px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50">Recheck account</button>{!actor.current && <Link href="/login" className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4">Sign in</Link>}</div>}
  </div>;
}
