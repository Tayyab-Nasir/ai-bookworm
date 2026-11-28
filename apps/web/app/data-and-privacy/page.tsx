import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "../bookiewookie.module.css";

export const metadata: Metadata = {
  title: "Data & privacy | BookieWookie",
  description: "Learn how to manage manuscript access, review AI requests, and ask for an account data export or deletion.",
};

export default function DataAndPrivacyPage() {
  return (
    <main className={styles.site}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          <Image src="/brand/mark.png" width={36} height={36} alt="" />BookieWookie
        </Link>
      </header>
      <article className="mx-auto max-w-[44rem] py-12 sm:py-20">
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">Data &amp; privacy</h1>
        <p className="mt-5 max-w-prose text-lg leading-7 text-[#584451]">
          Manage who can work on your manuscript and request help with your account data.
        </p>
        <div className="mt-10 divide-y divide-[#d9cec0] border-y border-[#d9cec0]">
          <section className="py-6">
            <h2 className="text-xl font-semibold">Manuscripts and artwork</h2>
            <p className="mt-2 leading-7 text-[#584451]">
              Books, uploads, and saved proofs are kept in your workspace. A teammate’s workspace role determines what they can view or change. You choose when to download or share a retailer package.
            </p>
          </section>
          <section className="py-6">
            <h2 className="text-xl font-semibold">AI requests</h2>
            <p className="mt-2 leading-7 text-[#584451]">
              Review the selected material and any quote shown by the tool before you approve an AI request. The connected provider processes the approved input for the selected task.
            </p>
          </section>
          <section className="py-6">
            <h2 className="text-xl font-semibold">Account data requests and support</h2>
            <p className="mt-2 leading-7 text-[#584451]">
              Use Data rights &amp; support to request an account data copy or deletion, or to open a support ticket. Requests go to a private review queue, and you can track their status from your account.
            </p>
          </section>
        </div>
        <Link href="/settings/data-rights" className={`${styles.primary} mt-8`}>Open Data rights &amp; support</Link>
      </article>
    </main>
  );
}
