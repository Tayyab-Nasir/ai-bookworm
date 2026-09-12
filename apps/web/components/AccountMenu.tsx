"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "./api";

export function AccountMenu() {
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/session").then(async (response) => {
      if (!response.ok) return;
      const result = await response.json();
      if (active) setEmail(result.user?.email ?? null);
    }).catch(() => {});
    apiClient().adminAccess().then((result) => { if (active) setAdmin(result.admin); }).catch(() => {});
    return () => { active = false; };
  }, []);
  async function logout() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Sign-out failed. Please retry.");
      try { localStorage.removeItem("bookworm:workspaceId"); } catch { /* Storage access is optional. */ }
      window.location.assign("/login");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-out failed."); setBusy(false); }
  }
  return <div className="relative flex items-center gap-2 text-xs">
    {admin && <Link href="/admin" className="rounded-full border border-white/15 px-3 py-2 text-white/75">Admin</Link>}
    <Link href="/settings/data-rights" title={email ?? "Account settings"} className="hidden max-w-40 truncate text-[#aaa] hover:text-white lg:inline">{email ?? "Account"}</Link>
    <button onClick={() => void logout()} disabled={busy} className="rounded-full border border-white/15 px-3 py-2 text-[#ddd] disabled:opacity-50">{busy ? "Signing out…" : "Sign out"}</button>
    {error && <p role="alert" className="absolute right-0 top-12 w-60 rounded-xl bg-red-950 p-3 text-red-100">{error}</p>}
  </div>;
}
