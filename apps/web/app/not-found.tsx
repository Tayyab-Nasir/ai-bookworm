import Link from "next/link";
import SiteBackground from "../components/PageBackground";

export default function NotFound() {
  return (
    <main className="relative isolate min-h-[100dvh] overflow-x-clip bg-black text-white">
      <SiteBackground />
      <section className="relative z-30 flex min-h-[100dvh] flex-col items-center justify-center px-5 text-center">
        <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.19em] text-[#6f6f6f]">404</p>
        <h1 className="text-[clamp(2.25rem,8.5vw,3.5rem)] font-medium leading-[0.95] tracking-[-0.072em]">
          This page
          <br />
          <span className="font-instrument instrument-italic font-normal italic tracking-[-0.045em] text-[#9a9a9a]">
            went missing.
          </span>
        </h1>
        <p className="mt-4 max-w-[380px] text-[14px] leading-[1.6] text-[#9a9a9a]">
          The link may be broken, or the page may have moved.
        </p>
        <Link
          href="/"
          className="glass-solid metal-shine group mt-8 flex h-14 items-center gap-3 rounded-full px-7 text-[15px] font-semibold text-black transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98]"
        >
          <span className="relative z-10">Back to home</span>
        </Link>
      </section>
    </main>
  );
}
