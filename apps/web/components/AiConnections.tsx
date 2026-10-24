"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AI_PROVIDERS, type AiConnectionPending, type AiConnections as ConnectionList, type AiProvider } from "@bookworm/api-client/ai-connections";
import { AuthorHeader, AuthorPage } from "./AuthorShell";
import { apiClient } from "./api";
import { readBrowserSession } from "../lib/browser-session";
import { clearPendingConnection, readPendingConnection, savePendingConnection } from "../lib/ai-connection-recovery";

const providers: Record<AiProvider, { name: string; initials: string; description: string }> = {
  openai: { name: "OpenAI", initials: "O", description: "OpenAI API billing is separate from ChatGPT subscriptions." },
  anthropic: { name: "Anthropic", initials: "A", description: "Use a Claude API key. A Claude chat subscription is separate." },
  google: { name: "Google Gemini", initials: "G", description: "Use a Gemini API key. Google sign-in does not grant model access." },
  openrouter: { name: "OpenRouter", initials: "OR", description: "Requests use your OpenRouter API credits." },
  xai: { name: "xAI Grok", initials: "x", description: "Use an xAI API key. Grok subscription billing is separate." },
};
const button = "inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 px-5 text-sm text-white/85 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40";
const primary = `${button} bg-white !text-black hover:!bg-white/90`;

export default function AiConnections() {
  const [data, setData] = useState<ConnectionList | null>(null);
  const [pending, setPending] = useState<AiConnectionPending | null>(null);
  const [editing, setEditing] = useState<AiProvider | null>(null);
  const [removing, setRemoving] = useState<AiProvider | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null), actor = useRef<string | null>(null);
  const epoch = useRef<object>({}), flight = useRef(false), mounted = useRef(false);
  const clearInput = useCallback(() => { if (input.current) input.current.value = ""; setEditing(null); setRemoving(null); }, []);

  const load = useCallback(async (message = "") => {
    if (!mounted.current) return;
    const token = {}; epoch.current = token; actor.current = null;
    clearInput(); setData(null); setPending(null); setLoading(true); setError(""); setNotice(message);
    const current = () => mounted.current && epoch.current === token;
    try {
      const identity = await readBrowserSession();
      if (!current()) return;
      const unresolved = readPendingConnection(identity.id);
      const result = await apiClient().listAiConnections(identity.id, AbortSignal.timeout(15_000));
      if (!current()) return;
      let receipt: Awaited<ReturnType<ReturnType<typeof apiClient>["recoverAiConnection"]>> | null = null;
      if (unresolved) receipt = await apiClient().recoverAiConnection(unresolved, identity.id, false, AbortSignal.timeout(15_000));
      if (!current()) return;
      await readBrowserSession(identity.id);
      if (!current()) return;
      actor.current = identity.id;
      // The metadata read can precede a just-completed write. Keep the receipt
      // pending until a later list observes that revision (or a newer one).
      const row = unresolved && result.connections.find(item => item.provider === unresolved.provider);
      const observed = receipt && (receipt.receipt.status === "closed" || (receipt.receipt.revision !== null && row && row.id === unresolved?.connectionId && row.revision >= receipt.receipt.revision));
      if (unresolved && observed && receipt) {
        clearPendingConnection(identity.id, unresolved.operationId);
        setNotice(receipt.receipt.status === "closed" ? "The unresolved change was closed. It cannot save a key later."
          : "Your earlier change is confirmed. The list shows the latest saved status.");
      } else setPending(unresolved);
      setData(result);
    } catch {
      if (current()) setError("AI connection details could not be loaded. Recheck your account and reload; any earlier change may still need confirmation.");
    } finally { if (current()) setLoading(false); }
  }, [clearInput]);

  useEffect(() => {
    mounted.current = true; void load();
    const focus = () => { void load(); };
    const visibility = () => { if (document.visibilityState === "visible") void load(); else { clearInput(); epoch.current = {}; actor.current = null; setData(null); setPending(null); } };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; epoch.current = {}; actor.current = null; if (input.current) input.current.value = ""; window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility); };
  }, [load, clearInput]);

  async function change(provider: AiProvider, action: "save" | "revoke") {
    const owner = actor.current, before = epoch.current;
    if (!owner || !data || loading || flight.current || pending || (action === "save" && !data.canSave)) return;
    const row = data.connections.find(item => item.provider === provider);
    let secret = action === "save" ? input.current?.value ?? "" : "";
    if (action === "save" && !/^[A-Za-z0-9_\-./+=]{16,4096}$/u.test(secret)) { setError("Enter a provider API key, without spaces or control characters."); return; }
    if (action === "revoke" && (!row || row.status !== "saved")) return;
    const request: AiConnectionPending = { provider, action, connectionId: row?.id ?? crypto.randomUUID(), operationId: crypto.randomUUID(), expectedRevision: row?.revision ?? null };
    flight.current = true; setBusy(true); setError(""); setNotice(""); clearInput();
    const current = () => mounted.current && epoch.current === before && actor.current === owner;
    try {
      await readBrowserSession(owner);
      if (!current()) return;
      savePendingConnection(owner, request); setPending(request);
      const { provider: _provider, action: _action, ...body } = request;
      const task = action === "save" ? apiClient().saveAiConnection(provider, { ...body, apiKey: secret }, owner, AbortSignal.timeout(15_000))
        : apiClient().revokeAiConnection(provider, body, owner, AbortSignal.timeout(15_000));
      secret = "";
      await task;
      // Even a successful HTTP reply is confirmed through an account-bound
      // read. Never copy an old response into a newly signed-in account.
    } catch {
      if (current()) setError("The change is not confirmed. Check saved status before trying another change.");
    } finally {
      secret = "";
      if (mounted.current && (actor.current === owner || actor.current === null)) await load();
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function closePending() {
    const owner = actor.current, request = pending;
    if (!owner || !request || flight.current || loading) return;
    flight.current = true; setBusy(true); setError(""); const before = epoch.current;
    try {
      await readBrowserSession(owner);
      if (!mounted.current || epoch.current !== before || actor.current !== owner) return;
      await apiClient().recoverAiConnection(request, owner, true, AbortSignal.timeout(15_000));
    } catch { if (mounted.current && epoch.current === before) setError("Closing the change is unconfirmed. Check saved status again."); }
    finally {
      if (mounted.current && (actor.current === owner || actor.current === null)) await load();
      flight.current = false; if (mounted.current) setBusy(false);
    }
  }

  const disabled = loading || busy || !!pending || !data;
  return <AuthorPage><AuthorHeader /><main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
    <nav aria-label="Account sections" className="mb-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/60">
      <Link href="/settings/data-rights" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-white">Account & support</Link>
      <Link href="/settings/ai" aria-current="page" className="inline-flex min-h-11 items-center border-b border-white text-white">AI connections</Link>
    </nav>
    <div className="grid gap-8 border-b border-white/15 pb-10 sm:grid-cols-[1.5fr_1fr] sm:items-end">
      <div><p className="text-xs uppercase tracking-[0.2em] text-white/50">Your account / your AI</p>
        <h1 className="mt-4 text-4xl font-medium tracking-[-0.055em] sm:text-6xl">AI connections</h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-white/65">Keep your provider API keys in your private account. Keys are encrypted when saved and never shared with your workspace.</p></div>
      <p className="max-w-sm text-sm leading-6 text-white/55">Provider usage is billed to your provider account. Bookworm’s feature access is separate. Saving a key does not send a model request.</p>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-4 py-7"><h2 className="text-lg font-medium">Provider API keys</h2>
      <button className={button} onClick={() => void load()} disabled={loading || busy}>{loading ? "Checking account…" : "Reload saved status"}</button></div>
    {error && <p role="alert" className="mb-5 rounded-xl border border-red-300/30 bg-red-950/30 p-4 text-sm leading-6 text-red-100">{error} <Link className="underline" href="/login">Sign in</Link></p>}
    {notice && <p role="status" className="mb-5 rounded-xl border border-white/15 p-4 text-sm leading-6 text-white/80">{notice}</p>}
    {loading && <p role="status" className="py-10 text-white/60">Checking your account and saved connections…</p>}
    {data && !data.canSave && <p role="status" className="mb-5 border-l-2 border-amber-200/60 pl-4 text-sm leading-6 text-amber-100">Saving keys is not available yet. You can still review and remove existing saved keys.</p>}
    {data && !data.generationAvailable && <p className="mb-7 text-sm leading-6 text-white/60">Using your own key for book generation is not available yet. Saved keys have not been checked for validity, available funds, or model access.</p>}
    {pending && <section aria-label="Unconfirmed connection change" className="mb-6 rounded-2xl border border-amber-200/25 bg-amber-950/20 p-5">
      <h3 className="font-medium text-amber-100">A {providers[pending.provider].name} change needs confirmation</h3>
      <p className="mt-2 text-sm leading-6 text-white/70">Your API key has been cleared from the form. Checking status will not re-send it. Close this change to prevent a request that has not saved yet from arriving later; an already completed change stays saved.</p>
      <div className="mt-4 flex flex-wrap gap-3"><button className={button} disabled={loading || busy} onClick={() => void load()}>Check saved status</button>
        <button className={button} disabled={loading || busy} onClick={() => void closePending()}>Close unresolved change</button></div>
    </section>}
    <div className="border-t border-white/15" aria-busy={loading || busy}>
      {AI_PROVIDERS.map(provider => { const info = providers[provider], connection = data?.connections.find(item => item.provider === provider);
        return <section key={provider} aria-label={`${info.name} connection`} className="border-b border-white/15 py-6 sm:py-7">
          <div className="flex flex-wrap items-start gap-4 sm:gap-5">
            <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 text-base font-medium">{info.initials}</span>
            <div className="min-w-0 flex-1"><h3 className="font-medium">{info.name}</h3><p className="mt-1 max-w-lg text-sm leading-6 text-white/55">{info.description}</p>
              {data && <p className="mt-2 text-xs text-white/65">{connection?.status === "saved" ? `Saved · ending ${connection.keySuffix} · not verified` : connection?.status === "revoked" ? "Removed from Bookworm" : "No key saved"}</p>}</div>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <button className={button} disabled={disabled || !data?.canSave} onClick={() => { clearInput(); setEditing(provider); setError(""); }}>{connection?.status === "saved" ? "Replace key" : "Add key"}</button>
              {connection?.status === "saved" && <button className={button} disabled={disabled} onClick={() => { clearInput(); setRemoving(provider); }}>Remove key</button>}
            </div>
          </div>
          {editing === provider && <form className="mt-6 max-w-xl sm:ml-16" onSubmit={event => { event.preventDefault(); void change(provider, "save"); }}>
            <label htmlFor={`key-${provider}`} className="block text-sm">{info.name} API key</label>
            <input ref={input} id={`key-${provider}`} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096} minLength={16} required disabled={disabled}
              className="mt-2 min-h-12 w-full min-w-0 rounded-xl border border-white/25 bg-white/5 px-4 text-base outline-none focus-visible:ring-2 focus-visible:ring-white" aria-describedby={`help-${provider}`} />
            <p id={`help-${provider}`} className="mt-2 text-xs leading-5 text-white/60">Paste an API key from your provider’s developer account. Do not enter a password or a chat session token. Only its last four characters will be shown after saving.</p>
            <div className="mt-4 flex flex-wrap gap-3"><button className={primary} disabled={disabled} type="submit">Save key</button><button type="button" className={button} onClick={clearInput}>Cancel</button></div>
          </form>}
          {removing === provider && <div className="mt-5 sm:ml-16"><p className="max-w-xl text-sm leading-6 text-white/70">Remove this key from Bookworm? This does not revoke the key at {info.name} or cancel requests already accepted by a provider.</p>
            <div className="mt-4 flex flex-wrap gap-3"><button className={primary} disabled={disabled} onClick={() => void change(provider, "revoke")}>Confirm removal</button><button className={button} onClick={clearInput}>Cancel</button></div></div>}
        </section>;
      })}
    </div>
    <section className="mt-12 grid gap-5 sm:grid-cols-[1fr_1.5fr]" aria-label="Existing subscriptions"><h2 className="text-xl font-medium tracking-tight">Already paying for an AI plan?</h2>
      <div className="space-y-3 text-sm leading-7 text-white/60"><p>Chat subscriptions and API credits usually have separate billing. Subscription connections will be offered only where the provider supports access through Bookworm.</p>
        <p>Subscription sign-in and OpenRouter’s one-click API connection are not available here yet. You do not need to share your chat password, browser cookies, or an installed agent’s credentials.</p></div>
    </section>
  </main></AuthorPage>;
}
