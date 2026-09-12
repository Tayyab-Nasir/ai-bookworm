"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const navigation = [
  ["Benefits", "#benefits"],
  ["How It Works", "#how-it-works"],
  ["Features", "#features"],
  ["Pricing", "#pricing"],
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

function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  return (
    <header className="landing-header reveal reveal-logo relative z-30 grid grid-cols-[1fr_auto] items-center gap-3 px-5 pt-5 sm:px-8 sm:pt-7 min-[901px]:grid-cols-[1fr_auto_1fr] min-[901px]:px-12 min-[901px]:pt-8 min-[1280px]:px-16 min-[1600px]:px-[5vw] min-[1920px]:px-[6vw]">
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
        className="rail-shine relative isolate hidden items-center gap-1 overflow-hidden rounded-full border border-white/[0.1] bg-white/[0.03] px-1.5 py-1.5 min-[901px]:flex reveal reveal-nav"
      >
        {navigation.map(([label, href]) => (
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
          <span className="relative z-10">Start for Free</span>
        </Link>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          className="relative z-50 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-white outline-none transition-[background-color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/[0.12] active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-white min-[901px]:hidden"
        >
          <span
            className={`absolute h-px w-[18px] bg-current transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${menuOpen ? "translate-y-0 rotate-45" : "-translate-y-[4px]"}`}
          />
          <span
            className={`absolute h-px w-[18px] bg-current transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${menuOpen ? "translate-y-0 -rotate-45" : "translate-y-[4px]"}`}
          />
        </button>
      </div>

      <div
        id="mobile-menu"
        aria-hidden={!menuOpen}
        className={`fixed inset-0 z-40 flex min-h-[100dvh] flex-col bg-black/90 px-6 pb-8 pt-28 backdrop-blur-3xl transition-[opacity,visibility] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] min-[901px]:hidden ${menuOpen ? "visible opacity-100" : "invisible opacity-0"}`}
      >
        <nav aria-label="Mobile navigation" className="flex flex-col">
          {navigation.map(([label, href], index) => (
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
          <span className="relative z-10">Start for Free</span>
          <span className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/10">
            <ArrowIcon diagonal />
          </span>
        </Link>
      </div>
    </header>
  );
}

const stats = [
  ["1.", "End-to-end publishing workflow"],
  ["2.", "Manuscript to live book in days"],
  ["3.", "Built for indie authors & publishers"],
] as const;

export default function LandingPage() {
  return (
    <main className="landing-page min-h-[100dvh] overflow-x-clip bg-black text-white">
      <div className="relative isolate min-h-[100dvh] overflow-hidden">
      {/* Hero glow orbs — continuous ambient drift */}
      <div
        aria-hidden="true"
        className="aurora pointer-events-none absolute -left-[18%] top-[2%] h-[68vh] w-[60vw] rounded-full blur-[140px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(255,255,255,0.16), rgba(255,255,255,0.04) 45%, rgba(255,255,255,0) 75%)",
        }}
      />
      <div
        aria-hidden="true"
        className="aurora-alt pointer-events-none absolute -right-[22%] bottom-[2%] h-[72vh] w-[64vw] rounded-full blur-[160px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(255,255,255,0.13), rgba(255,255,255,0.035) 45%, rgba(255,255,255,0) 75%)",
        }}
      />
      {/* Center soft halo behind the headline */}
      <div
        aria-hidden="true"
        className="aurora pointer-events-none absolute left-1/2 top-[35%] h-[60vh] w-[60vw] -translate-x-1/2 rounded-full blur-[120px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(255,255,255,0.1), rgba(255,255,255,0.02) 50%, rgba(255,255,255,0) 75%)",
        }}
      />
      {/* Subtle vertical hairline beam */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-white/[0.12] to-transparent"
      />
      {/* Agent-Wave-style luminous cloth ribbon — turbulence-displaced, glowing, with mesh contour overlay */}
      <svg
        aria-hidden="true"
        className="agent-wave pointer-events-none absolute inset-x-0 top-[6%] z-0 h-[42vh] w-full min-[901px]:top-[4%] min-[901px]:h-[44vh]"
        viewBox="0 0 1440 520" opacity="0.55"
        preserveAspectRatio="none"
        fill="none"
      >
        <defs>
          <filter id="ribbonNoise" x="-5%" y="-25%" width="110%" height="150%">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.022" numOctaves="3" seed="11" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="48" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="ribbonGrain" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9 0.45" numOctaves="2" seed="7" result="grain" />
            <feColorMatrix in="grain" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.45 0" />
          </filter>
          <filter id="ribbonSoftGlow" x="-20%" y="-50%" width="140%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="22" />
          </filter>
          <linearGradient id="ribbonFill" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.18)" />
            <stop offset="45%" stopColor="rgba(255,255,255,0.32)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <linearGradient id="ribbonCore" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.65)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <linearGradient id="ribbonEdge" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="18%" stopColor="rgba(255,255,255,0.55)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.85)" />
            <stop offset="82%" stopColor="rgba(255,255,255,0.55)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <linearGradient id="meshStroke" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.45)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <mask id="ribbonMask">
            <path
              d="M0,260 C200,80 440,420 720,260 C1000,100 1240,440 1440,260 L1440,520 L0,520 Z"
              fill="white"
            />
          </mask>
        </defs>

        {/* Volumetric halo behind ribbon */}
        <ellipse cx="720" cy="260" rx="780" ry="110" fill="url(#ribbonCore)" filter="url(#ribbonSoftGlow)" opacity="0.7" />

        {/* Main cloth silhouette, turbulence-displaced */}
        <g filter="url(#ribbonNoise)" mask="url(#ribbonMask)">
          <path
            d="M0,260 C200,80 440,420 720,260 C1000,100 1240,440 1440,260 L1440,520 L0,520 Z"
            fill="url(#ribbonFill)"
            className="agent-wave-fill"
          />
          {/* Bright top edge of cloth */}
          <path
            d="M0,260 C200,80 440,420 720,260 C1000,100 1240,440 1440,260"
            stroke="url(#ribbonEdge)"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="agent-wave-edge"
          />
          {/* Soft secondary highlight a few px below the edge */}
          <path
            d="M0,272 C200,92 440,432 720,272 C1000,112 1240,452 1440,272"
            stroke="url(#ribbonEdge)"
            strokeWidth="1.25"
            strokeLinecap="round"
            opacity="0.55"
            className="agent-wave-edge-2"
          />
        </g>

        {/* Mesh contour wireframe overlay (the lattice look) */}
        <g opacity="0.35" stroke="url(#meshStroke)" strokeWidth="0.4" fill="none">
          <path d="M0,220 C200,40 440,380 720,220 C1000,60 1240,400 1440,220" />
          <path d="M0,300 C200,120 440,460 720,300 C1000,140 1240,480 1440,300" />
          <path d="M0,340 C200,160 440,500 720,340 C1000,180 1240,520 1440,340" />
          <path d="M120,260 L120,440" /><path d="M360,260 L360,420" /><path d="M600,260 L600,440" />
          <path d="M840,260 L840,420" /><path d="M1080,260 L1080,440" /><path d="M1320,260 L1320,420" />
        </g>

        {/* Particle grain overlay for the silver-dust feel */}
        <rect x="0" y="0" width="1440" height="520" filter="url(#ribbonGrain)" opacity="0.55" />
      </svg>

      {/* Micro-stars sprinkled across the void — fixed, GPU-cheap opacity flicker */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        {[
          { top: "8%", left: "12%", size: 1.5, d: 5.2 },
          { top: "14%", left: "32%", size: 1, d: 6.8 },
          { top: "6%", left: "55%", size: 1.2, d: 4.4 },
          { top: "20%", left: "72%", size: 1.8, d: 7.6 },
          { top: "11%", left: "88%", size: 1, d: 5.9 },
          { top: "32%", left: "8%", size: 1.4, d: 6.2 },
          { top: "44%", left: "22%", size: 1, d: 4.9 },
          { top: "62%", left: "30%", size: 1.2, d: 7.3 },
          { top: "70%", left: "78%", size: 1.5, d: 5.6 },
          { top: "78%", left: "92%", size: 1, d: 6.5 },
          { top: "84%", left: "14%", size: 1.3, d: 5.1 },
          { top: "90%", left: "60%", size: 1, d: 6.9 },
        ].map((s, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white"
            style={{
              top: s.top,
              left: s.left,
              width: `${s.size}px`,
              height: `${s.size}px`,
              opacity: 0.7,
              boxShadow: `0 0 ${s.size * 4}px rgba(255,255,255,0.6)`,
              animation: `star-twinkle ${s.d}s ease-in-out infinite`,
              animationDelay: `${i * 0.27}s`,
            }}
          />
        ))}
      </div>

      {/* Bottom glow anchor */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] bg-[radial-gradient(ellipse_at_50%_125%,rgba(255,255,255,0.08),transparent_62%)]" />

      {/* Content-area dimmer so the cloth ribbon reads as a backdrop, not foreground */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[20%] z-10 h-[80%] bg-[linear-gradient(to_bottom,rgba(0,0,0,0.45)_0%,rgba(0,0,0,0.85)_45%,#000_100%)]"
      />

      <div className="relative z-30 grid min-h-[100dvh] grid-rows-[auto_1fr_auto] min-[901px]:h-[100dvh]">
        <Header />

        <section className="flex items-end px-5 pb-14 pt-24 sm:px-8 sm:pb-16 min-[901px]:px-12 min-[901px]:pb-[clamp(3rem,7vh,5.75rem)] min-[901px]:pt-8 min-[1280px]:px-16 min-[1600px]:px-[5vw] min-[1920px]:px-[6vw]">
          <div className="w-full max-w-[1330px]">
            <div className="reveal reveal-badge mb-7 inline-flex items-center gap-2.5 rounded-full border border-white/[0.13] bg-white/[0.045] px-3.5 py-2 text-[10px] font-medium uppercase tracking-[0.19em] text-[#c5c5c5] sm:mb-8">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/50" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              AI-Native Book Publishing OS
            </div>

            <h1 className="max-w-[14ch] text-[clamp(3.25rem,14.5vw,5.75rem)] font-medium leading-[0.88] tracking-[-0.072em] sm:max-w-[13ch] sm:text-[clamp(5rem,11vw,7.5rem)] min-[901px]:max-w-[15ch] min-[901px]:text-[clamp(4.75rem,7.15vw,7.2rem)] min-[1280px]:text-[clamp(5.6rem,7.1vw,7.4rem)] min-[1600px]:text-[clamp(7rem,7.2vw,8.2rem)] min-[1920px]:text-[8.9rem]">
              <span className="reveal reveal-line-one block">Publish books with</span>
              <span className="reveal reveal-line-two block whitespace-nowrap">
                <span className="font-instrument instrument-italic font-normal italic tracking-[-0.045em]">AI agents</span> in days.
              </span>
            </h1>

            <p className="reveal reveal-lede mt-7 max-w-[730px] text-[16px] leading-[1.6] tracking-[-0.015em] text-[#9a9a9a] sm:mt-8 sm:text-lg min-[1280px]:max-w-[780px] min-[1600px]:mt-9 min-[1600px]:max-w-[850px] min-[1600px]:text-xl min-[1920px]:max-w-[920px] min-[1920px]:text-[22px]">
              From manuscript to multi-platform publishing: writing, editing, illustrations, covers, and distribution in one operating system built for authors and publishers.
            </p>

            <div className="reveal reveal-actions mt-8 flex flex-col gap-3 sm:flex-row sm:items-center min-[1600px]:mt-10">
              <Link
                href="/signup"
                className="glass-solid metal-shine group flex min-h-14 w-full items-center justify-between rounded-full pl-6 pr-2.5 text-[15px] font-semibold text-black outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-black sm:w-auto sm:min-w-[190px]"
              >
                <span className="relative z-10">Start for Free</span>
                <span className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.08] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5">
                  <ArrowIcon diagonal />
                </span>
              </Link>
              <a
                href="#how-it-works"
                className="glass-ghost metal-shine group flex min-h-14 w-full items-center justify-between rounded-full pl-6 pr-2.5 text-[15px] font-medium text-white outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-black sm:w-auto sm:min-w-[205px]"
              >
                <span className="relative z-10">See how it works</span>
                <span className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-1">
                  <ArrowIcon />
                </span>
              </a>
            </div>
          </div>
        </section>

        <footer className="reveal reveal-stats mx-5 grid border-t border-white/[0.13] pb-8 pt-2 sm:mx-8 min-[901px]:mx-12 min-[901px]:grid-cols-3 min-[901px]:pb-7 min-[901px]:pt-0 min-[1280px]:mx-16 min-[1600px]:mx-[5vw] min-[1920px]:mx-[6vw]">
          {stats.map(([number, label], index) => (
            <div
              key={number}
              className={`flex items-start gap-4 border-b border-white/[0.09] py-5 last:border-b-0 min-[901px]:border-b-0 min-[901px]:py-5 ${index > 0 ? "min-[901px]:border-l min-[901px]:border-white/[0.13] min-[901px]:pl-7 min-[1280px]:pl-10" : ""}`}
            >
              <span className="pt-0.5 text-xs font-medium text-[#6f6f6f]">{number}</span>
              <p className="max-w-[270px] text-[13px] leading-5 text-[#d8d8d8] min-[1280px]:text-sm min-[1600px]:max-w-[320px] min-[1600px]:text-[15px]">
                {label}
              </p>
            </div>
          ))}
        </footer>
      </div>
      </div>

      <section id="benefits" className="border-t border-white/[0.1] px-5 py-24 sm:px-8 min-[901px]:px-12 min-[1280px]:px-16 min-[1600px]:px-[5vw]">
        <div className="mx-auto grid max-w-[1500px] gap-14 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#777]">The publishing room</p>
            <h2 className="mt-5 max-w-[10ch] text-[clamp(2.8rem,6vw,5.8rem)] font-medium leading-[0.92] tracking-[-0.06em]">
              One book.<br /><span className="font-instrument font-normal italic text-[#999]">One source of truth.</span>
            </h2>
          </div>
          <div className="grid gap-px overflow-hidden rounded-[1.75rem] border border-white/[0.1] bg-white/[0.1] sm:grid-cols-3">
            {[
              ["01", "Keep the work together", "Manuscript, book bible, artwork, editions, and approvals stay connected to the same project."],
              ["02", "Move with confidence", "Every publishing step has a clear state, review point, and next action before files leave your workspace."],
              ["03", "Create without losing control", "Use AI for focused drafts and visuals while keeping authors and editors in the approval loop."],
            ].map(([number, title, copy]) => (
              <article key={number} className="min-h-72 bg-[#080808] p-7 sm:p-8">
                <p className="font-mono text-xs text-[#666]">{number}</p>
                <h3 className="mt-16 text-xl font-medium tracking-[-0.035em]">{title}</h3>
                <p className="mt-4 text-sm leading-6 text-[#929292]">{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="border-t border-white/[0.1] bg-[#050505] px-5 py-24 sm:px-8 min-[901px]:px-12 min-[1280px]:px-16 min-[1600px]:px-[5vw]">
        <div className="mx-auto max-w-[1500px]">
          <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#777]">How it works</p>
              <h2 className="mt-5 max-w-[12ch] text-[clamp(2.8rem,5vw,5.4rem)] font-medium leading-[0.95] tracking-[-0.06em]">From first page to finished package.</h2>
            </div>
            <p className="max-w-lg text-base leading-7 text-[#969696]">Start with a manuscript or a new idea. AI Bookworm keeps the creative and production work in one visible sequence.</p>
          </div>

          <ol className="mt-16 grid border-y border-white/[0.12] lg:grid-cols-5">
            {[
              ["01", "Write or import", "Begin from a blank project or bring your existing manuscript."],
              ["02", "Shape the story", "Draft, edit, proof, and maintain characters and world details."],
              ["03", "Create the visuals", "Generate or upload illustrations and cover concepts for review."],
              ["04", "Build the edition", "Choose trim, typography, spacing, and channel requirements."],
              ["05", "Package and track", "Run preflight, create retailer-ready files, and follow each release."],
            ].map(([number, title, copy], index) => (
              <li key={number} className={`relative min-h-64 py-7 lg:px-7 ${index > 0 ? "border-t border-white/[0.1] lg:border-l lg:border-t-0" : ""}`}>
                <span className="text-xs text-[#666]">{number}</span>
                <h3 className="mt-14 text-lg font-medium tracking-[-0.03em]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#858585]">{copy}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="features" className="border-t border-white/[0.1] px-5 py-24 sm:px-8 min-[901px]:px-12 min-[1280px]:px-16 min-[1600px]:px-[5vw]">
        <div className="mx-auto grid max-w-[1500px] gap-14 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#777]">Inside the system</p>
            <h2 className="mt-5 max-w-[9ch] text-[clamp(2.8rem,5vw,5.4rem)] font-medium leading-[0.94] tracking-[-0.06em]">A studio for the whole book.</h2>
            <p className="mt-7 max-w-md text-base leading-7 text-[#929292]">The tools share book context, permissions, assets, and production history, so each specialist starts from the latest approved work.</p>
          </div>
          <div className="border-t border-white/[0.12]">
            {[
              ["Manuscript studio", "Structured chapters, revision-aware editing, AI suggestions, and a persistent book bible."],
              ["Visual direction", "Private asset library for uploaded and generated illustrations, references, and cover artwork."],
              ["Edition designer", "Print and ebook settings for trim, typography, spacing, cover assignment, and channel rules."],
              ["Production control", "Preflight findings, approvals, version history, export jobs, and retailer package status."],
              ["Business workspace", "Team roles, usage and credits, support, referrals, and release activity in one dashboard."],
            ].map(([title, copy], index) => (
              <article key={title} className="grid gap-5 border-b border-white/[0.12] py-8 sm:grid-cols-[3rem_1fr_1.25fr] sm:items-start">
                <span className="font-mono text-xs text-[#5f5f5f]">0{index + 1}</span>
                <h3 className="text-xl font-medium tracking-[-0.035em]">{title}</h3>
                <p className="text-sm leading-6 text-[#909090]">{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="border-t border-white/[0.1] bg-[#050505] px-5 py-24 sm:px-8 min-[901px]:px-12 min-[1280px]:px-16 min-[1600px]:px-[5vw]">
        <div className="mx-auto max-w-[1500px] overflow-hidden rounded-[2rem] border border-white/[0.12] bg-[radial-gradient(circle_at_80%_20%,rgba(255,255,255,0.1),transparent_32%),#090909] p-7 sm:p-12 lg:p-16">
          <div className="grid gap-12 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#777]">Start your studio</p>
              <h2 className="mt-5 max-w-[12ch] text-[clamp(2.8rem,5vw,5.8rem)] font-medium leading-[0.94] tracking-[-0.06em]">Bring the book. We will help organize the rest.</h2>
              <p className="mt-7 max-w-xl text-base leading-7 text-[#999]">Create your workspace free. Usage-based AI and production options remain visible before you run them.</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
              <Link href="/signup" className="glass-solid metal-shine flex min-h-14 min-w-52 items-center justify-between rounded-full pl-6 pr-3 text-sm font-semibold text-black">
                <span className="relative z-10">Create your workspace</span>
                <span className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.08]"><ArrowIcon diagonal /></span>
              </Link>
              <Link href="/login" className="glass-ghost flex min-h-14 min-w-52 items-center justify-center rounded-full px-6 text-sm font-medium text-white">Sign in</Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.1] px-5 py-8 text-sm text-[#777] sm:px-8 min-[901px]:px-12 min-[1280px]:px-16 min-[1600px]:px-[5vw]">
        <div className="mx-auto flex max-w-[1500px] flex-col justify-between gap-5 sm:flex-row sm:items-center">
          <Link href="/" className="inline-flex items-center gap-3 text-white"><LogoMark className="h-6 w-6" /><span className="font-semibold">AI Bookworm</span></Link>
          <p>Private by default. Human-reviewed publishing workflows.</p>
          <div className="flex gap-5"><Link href="/login" className="hover:text-white">Sign in</Link><Link href="/signup" className="hover:text-white">Get started</Link></div>
        </div>
      </footer>
    </main>
  );
}
