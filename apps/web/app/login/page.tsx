"use client";

import Link from "next/link";
import SiteBackground from "../../components/PageBackground";
import { SiteHeader } from "../../components/Header";
import { AuthCard } from "../../components/AuthCard";

export default function LoginPage() {
  return (
    <main className="relative isolate min-h-[100dvh] overflow-x-clip bg-black text-white">
      <SiteBackground />

      <SiteHeader />

      {/* Login form — AuthCard for the login flow */}
      <section className="relative z-30 flex min-h-[calc(100dvh-80px)] items-center justify-center px-5 pb-16 pt-10 sm:px-8 min-[901px]:px-12 min-[1280px]:px-16 min-[1600px]:px-[5vw] min-[1920px]:px-[6vw]">
        <AuthCard
          badge="Back to library"
          headline="Sign in to"
          italicWord="your library."
          subtext="Pick up where you left off. Your drafts, edits, and books are waiting."
          primaryLabel="Sign in"
          altPrompt="New to Bookworm?"
          altLabel="Create an account"
          altHref="/signup"
        />
      </section>
    </main>
  );
}