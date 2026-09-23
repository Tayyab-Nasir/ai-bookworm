"use client";

import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import Link from "next/link";
import { rememberReferral } from "../lib/referrals";

interface AuthCardProps {
  badge: string;
  headline: ReactNode;
  italicWord: ReactNode;
  subtext: string;
  primaryLabel: string;
  altPrompt: string;
  altLabel: string;
  altHref: string;
  showName?: boolean;
  showForgot?: boolean;
  showRemember?: boolean;
  mode?: "login" | "signup" | "forgot-password" | "reset-password";
}

export function AuthCard({
  badge,
  headline,
  italicWord,
  subtext,
  primaryLabel,
  altPrompt,
  altLabel,
  altHref,
  showName = false,
  showForgot = false,
  showRemember = false,
  mode = "login",
}: AuthCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const passwordOnly = mode === "reset-password";
  const emailOnly = mode === "forgot-password";

  useEffect(() => {
    rememberReferral(window.location.search);
    if (new URLSearchParams(window.location.search).get("error") === "oauth") {
      setErrorAction("google");
      setError("Google sign-in didn't complete. Try again or use email sign-in. If Google is unavailable, the app owner must finish OAuth setup.");
    }
  }, []);

  async function submit(action: string, values: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setErrorAction(action);
    setMessage(null);
    try {
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      rememberReferral(window.location.search);
      const response = await fetch(`/api/auth/${action}`, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, next }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Unable to complete this request.");
      if (result.redirectTo) {
        // Full navigation avoids serving an old prefetched anonymous page after login.
        window.location.assign(result.redirectTo);
        return;
      }
      setMessage(result.message ?? "Check your email to continue.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection failed. Please try again.");
    } finally { setBusy(false); }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (passwordOnly && values.password !== values.confirmPassword) { setError("The passwords do not match."); return; }
    void submit(mode, values);
  }

  return (
    <div className="w-full max-w-[420px]">
      <div className="mb-3 flex items-center justify-center">
        <span className="inline-flex items-center gap-2.5 rounded-full border border-white/[0.13] bg-white/[0.045] px-3.5 py-2 text-[10px] font-medium uppercase tracking-[0.19em] text-[#c5c5c5]">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/50" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
          </span>
          {badge}
        </span>
      </div>

      <h1 className="text-center text-[clamp(2.25rem,8.5vw,3.5rem)] font-medium leading-[0.95] tracking-[-0.072em] sm:text-[clamp(2.75rem,6.5vw,3.75rem)]">
        {headline}
        <br />
        <span className="font-instrument instrument-italic font-normal italic tracking-[-0.045em] text-[#9a9a9a]">
          {italicWord}
        </span>
      </h1>

      <p className="mt-4 text-center text-[14px] leading-[1.6] tracking-[-0.015em] text-[#9a9a9a] sm:text-[15px]">
        {subtext}
      </p>

      <div className="mt-10 rounded-[28px] border border-white/[0.09] bg-white/[0.025] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_24px_64px_-24px_rgba(0,0,0,0.6)]">
        <div className="rounded-[calc(28px-0.375rem)] border border-white/[0.05] bg-gradient-to-b from-white/[0.025] to-transparent p-7 sm:p-9">
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-5"
          >
            {(showName || mode === "signup") && (
              <div>
                <label htmlFor="name" className="mb-2 ml-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">
                  Name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  required
                  placeholder="Your name"
                  className="h-12 w-full rounded-full border border-white/[0.1] bg-white/[0.04] px-5 text-[15px] text-white outline-none transition-[border-color,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-[#5a5a5a] hover:border-white/[0.18] focus:border-white/30 focus:bg-white/[0.06] focus-visible:ring-0"
                />
              </div>
            )}

            {!passwordOnly && <div>
              <label htmlFor="email" className="mb-2 ml-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@bookworm.ai"
                className="h-12 w-full rounded-full border border-white/[0.1] bg-white/[0.04] px-5 text-[15px] text-white outline-none transition-[border-color,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-[#5a5a5a] hover:border-white/[0.18] focus:border-white/30 focus:bg-white/[0.06] focus-visible:ring-0"
              />
            </div>}

            {!emailOnly && <div>
              <div className="mb-2 flex items-center justify-between px-1">
                <label htmlFor="password" className="block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">
                  Password
                </label>
                {(showForgot || mode === "login") && (
                  <Link href="/forgot-password" className="text-[11px] font-medium tracking-[0.05em] text-[#9a9a9a] transition-colors duration-200 hover:text-white">
                    Forgot?
                  </Link>
                )}
              </div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={8}
                maxLength={128}
                placeholder={mode === "login" ? "Your password" : "At least 8 characters"}
                className="h-12 w-full rounded-full border border-white/[0.1] bg-white/[0.04] px-5 text-[15px] text-white outline-none transition-[border-color,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-[#5a5a5a] hover:border-white/[0.18] focus:border-white/30 focus:bg-white/[0.06] focus-visible:ring-0"
              />
            </div>}

            {passwordOnly && <div>
              <label htmlFor="confirmPassword" className="mb-2 block text-sm text-[#9a9a9a]">Confirm new password</label>
              <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} className="h-12 w-full rounded-full border border-white/10 bg-white/[0.04] px-5 text-white" />
            </div>}

            {error && errorAction !== "google" && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{error}</p>}
            {message && <p role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">{message}</p>}

            {showRemember && (
              <label className="flex cursor-pointer items-center gap-2.5 pl-1">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer rounded border-white/20 bg-white/[0.04] text-white accent-white outline-none transition-colors duration-200 hover:border-white/30"
                />
                <span className="text-[13px] text-[#9a9a9a]">Keep me signed in</span>
              </label>
            )}

            <button
              type="submit"
              disabled={busy}
              aria-busy={busy}
              className="glass-solid metal-shine group mt-2 flex h-14 w-full items-center justify-between rounded-full pl-6 pr-2 text-[15px] font-semibold text-black outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-black"
            >
              <span className="relative z-10 tracking-[-0.01em]">{busy ? "Please wait…" : primaryLabel}</span>
              <span className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/[0.08] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5">
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                  <path d="M4 10h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="m11 6 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
          </form>

          {!emailOnly && !passwordOnly && <><div className="my-7 flex items-center gap-4">
            <div className="h-px flex-1 bg-white/[0.08]" />
            <span className="text-[10px] font-medium uppercase tracking-[0.19em] text-[#6f6f6f]">or continue with</span>
            <div className="h-px flex-1 bg-white/[0.08]" />
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void submit("google", {})}
            aria-label="Continue with Google"
            aria-busy={busy && errorAction === "google"}
            className="glass-ghost metal-shine group flex h-12 w-full cursor-pointer items-center justify-center gap-3 rounded-full text-[14px] font-medium text-white outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-wait disabled:opacity-60"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[18px] w-[18px]">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            <span className="relative z-10">Continue with Google</span>
          </button>
          {error && errorAction === "google" && <p role="alert" className="mt-3 rounded-xl border border-red-300/25 bg-red-300/[0.08] px-3.5 py-3 text-left text-sm leading-5 text-red-100">{error}</p>}
          </>}
        </div>
      </div>

      <p className="mt-7 text-center text-[13px] tracking-[-0.01em] text-[#8a8a8a]">
        {altPrompt}{" "}
        <Link
          href={altHref}
          className="text-white font-medium transition-colors duration-200 hover:text-[#d8d8d8]"
        >
          {altLabel}
        </Link>
      </p>
    </div>
  );
}
