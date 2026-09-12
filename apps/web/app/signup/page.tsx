"use client";

import Link from "next/link";
import SiteBackground from "../../components/PageBackground";
import { SiteHeader } from "../../components/Header";
import { AuthCard } from "../../components/AuthCard";

export default function SignupPage() {
  return (
    <main className="relative isolate min-h-[100dvh] overflow-x-clip bg-black text-white">
      <SiteBackground />

      <SiteHeader />

      <section className="relative z-30 flex min-h-[calc(100dvh-80px)] items-center justify-center px-5 pb-16 pt-10 sm:px-8 min-[901px]:px-12 min-[1280px]:px-16 min-[1600px]:px-[5vw] min-[1920px]:px-[6vw]">
        <AuthCard
          mode="signup"
          badge="New account"
          headline="Begin writing"
          italicWord="in days."
          subtext="One form. Five minutes. Your first book on the way."
          primaryLabel="Create account"
          altPrompt="Already have an account?"
          altLabel="Sign in"
          altHref="/login"
        />
      </section>
    </main>
  );
}
