"use client";

import StarField from "./StarField";

export default function PageBackground() {
  return (
    <div className="absolute inset-0 bg-black overflow-hidden">
      <div
        aria-hidden="true"
        className="aurora pointer-events-none absolute -left-[18%] top-[2%] h-[68vh] w-[60vw] rounded-full blur-[140px]"
        style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.16), rgba(255,255,255,0.04) 45%, rgba(255,255,255,0) 75%)" }}
      />
      <div
        aria-hidden="true"
        className="aurora-alt pointer-events-none absolute -right-[22%] bottom-[2%] h-[72vh] w-[64vw] rounded-full blur-[160px]"
        style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.13), rgba(255,255,255,0.035) 45%, rgba(255,255,255,0) 75%)" }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-white/[0.12] to-transparent" />
      <StarField />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-full bg-[linear-gradient(to_bottom,rgba(0,0,0,0.5)_0%,rgba(0,0,0,0.85)_45%,#000_100%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] bg-[radial-gradient(ellipse_at_50%_125%,rgba(255,255,255,0.08),transparent_62%)]" />
    </div>
  );
}
