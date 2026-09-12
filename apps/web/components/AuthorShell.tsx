"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AccountMenu } from "./AccountMenu";
import { apiClient } from "./api";
import { claimPendingReferral } from "../lib/referrals";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/assets", label: "Assets" },
  { href: "/tasks", label: "Workflow" },
  { href: "/billing", label: "Billing" },
  { href: "/community", label: "Community" },
] as const;

function LogoMark() {
  return (
    <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 32 32" fill="none">
      <rect x="5.2" y="11" width="20" height="8" rx="4" fill="white" transform="rotate(-32 5.2 11)" />
      <rect x="6.8" y="17.4" width="20" height="8" rx="4" fill="white" transform="rotate(32 6.8 17.4)" />
    </svg>
  );
}

export function AuthorHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    void claimPendingReferral(apiClient().claimReferral);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  const isActive = (href: string) => href === "/dashboard"
    ? pathname === "/dashboard"
    : href === "/tasks"
      ? ["/tasks", "/team", "/approvals"].some((path) => pathname.startsWith(path))
      : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-black/80 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <Link
          href="/dashboard"
          className="inline-flex shrink-0 items-center gap-2.5 rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
          aria-label="AI Bookworm dashboard"
        >
          <LogoMark />
          <span className="hidden text-[15px] font-semibold tracking-[-0.03em] sm:inline">AI Bookworm</span>
        </Link>

        <nav aria-label="Author navigation" className="hidden items-center gap-1 lg:flex">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors ${
                  active ? "bg-white text-black" : "text-[#a6a6a6] hover:bg-white/[0.07] hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="relative ml-auto lg:hidden">
          <button type="button" aria-expanded={menuOpen} aria-controls="author-mobile-nav" aria-label={menuOpen ? "Close author navigation" : "Open author navigation"} onClick={() => setMenuOpen((open) => !open)} className="min-h-11 rounded-full border border-white/15 px-4 text-xs text-white/75">Menu</button>
          {menuOpen && <nav id="author-mobile-nav" aria-label="Author mobile navigation" className="absolute right-0 top-12 z-50 w-52 rounded-2xl border border-white/15 bg-[#080808] p-2 shadow-2xl">
            {[...navItems, { href: "/books/new", label: "New book" }].map((item) => <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)} aria-current={isActive(item.href) ? "page" : undefined} className={`block rounded-xl px-4 py-3 text-sm ${isActive(item.href) ? "bg-white text-black" : "text-white/65 hover:bg-white/[0.07] hover:text-white"}`}>{item.label}</Link>)}
          </nav>}
        </div>

        <Link
          href="/books/new"
          className="glass-solid metal-shine hidden min-h-10 items-center rounded-full px-4 text-[13px] font-semibold text-black outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:inline-flex"
        >
          <span className="relative z-10">New book</span>
        </Link>
        <AccountMenu />
      </div>
    </header>
  );
}

export function AuthorPage({ children }: { children: ReactNode }) {
  return <div className="min-h-[100dvh] bg-black text-white">{children}</div>;
}
