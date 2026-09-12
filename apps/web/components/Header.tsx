"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const NAV_LINKS = [
  ["Benefits", "/#benefits"],
  ["How It Works", "/#how-it-works"],
  ["Features", "/#features"],
  ["Pricing", "/#pricing"],
] as const;

function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="5.2" y="11" width="20" height="8" rx="4" fill="white" transform="rotate(-32 5.2 11)" />
      <rect x="6.8" y="17.4" width="20" height="8" rx="4" fill="white" transform="rotate(32 6.8 17.4)" />
    </svg>
  );
}

function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      {diagonal ? (
        <>
          <path d="M6 14 14 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M8.5 6H14v5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path d="M4 10h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="m11 6 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen]);

  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  return (
    <header className="landing-header relative z-30 grid grid-cols-[1fr_auto] items-center gap-3 px-5 pt-5 sm:px-8 sm:pt-7 min-[901px]:grid-cols-[1fr_auto_1fr] min-[901px]:px-12 min-[901px]:pt-8 min-[1280px]:px-16 min-[1600px]:px-[5vw] min-[1920px]:px-[6vw]">
      <Link
        href="/"
        className="inline-flex w-fit items-center gap-3 rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-black"
        aria-label="AI Bookworm home"
      >
        <LogoMark className="h-7 w-7 sm:h-8 sm:w-8" />
        <span className="text-[15px] font-semibold tracking-[-0.03em] sm:text-base">AI Bookworm</span>
      </Link>

      <nav
        aria-label="Primary navigation"
        className="rail-shine relative isolate hidden items-center gap-1 overflow-hidden rounded-full border border-white/[0.1] bg-white/[0.03] px-1.5 py-1.5 min-[901px]:flex"
      >
        {NAV_LINKS.map(([label, href]) => (
          <a key={label} href={href} className="metal-pill metal-shine px-5 py-2 text-[13px] font-medium text-[#d8d8d8]">
            <span className="relative z-10">{label}</span>
          </a>
        ))}
      </nav>

      <div className="flex items-center justify-end gap-2.5">
        <Link
          href="/signup"
          className="glass-solid metal-shine hidden min-h-11 items-center rounded-full px-5 text-[13px] font-semibold text-black sm:inline-flex"
        >
          <span className="relative z-10">Create your account</span>
        </Link>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          className="relative z-50 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-white outline-none transition-[background-color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/[0.12] active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-white min-[901px]:hidden"
        >
          <span className={`absolute h-px w-[18px] bg-current transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${menuOpen ? "translate-y-0 rotate-45" : "-translate-y-[4px]"}`} />
          <span className={`absolute h-px w-[18px] bg-current transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${menuOpen ? "translate-y-0 -rotate-45" : "translate-y-[4px]"}`} />
        </button>
      </div>

      <div
        id="mobile-menu"
        aria-hidden={!menuOpen}
        className={`fixed inset-0 z-40 flex min-h-[100dvh] flex-col bg-black/90 px-6 pb-8 pt-28 backdrop-blur-3xl transition-[opacity,visibility] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] min-[901px]:hidden ${menuOpen ? "visible opacity-100" : "invisible opacity-0"}`}
      >
        <nav aria-label="Mobile navigation" className="flex flex-col">
          {NAV_LINKS.map(([label, href], index) => (
            <a
              key={label}
              href={href}
              onClick={() => setMenuOpen(false)}
              tabIndex={menuOpen ? 0 : -1}
              className={`border-b border-white/10 py-5 text-[clamp(2rem,10vw,3.5rem)] font-medium tracking-[-0.055em] text-white outline-none transition-[opacity,transform,color] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[#9a9a9a] focus-visible:text-[#9a9a9a] ${menuOpen ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0"}`}
              style={{ transitionDelay: menuOpen ? `${100 + index * 55}ms` : "0ms" }}
            >
              {label}
            </a>
          ))}
        </nav>
        <Link
          href="/signup"
          onClick={() => setMenuOpen(false)}
          tabIndex={menuOpen ? 0 : -1}
          className={`glass-solid metal-shine mt-auto flex min-h-14 w-full items-center justify-between rounded-full px-5 text-base font-semibold text-black transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] ${menuOpen ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}
          style={{ transitionDelay: menuOpen ? "340ms" : "0ms" }}
        >
          <span className="relative z-10">Create your account</span>
          <span className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/10">
            <ArrowIcon diagonal />
          </span>
        </Link>
      </div>
    </header>
  );
}
