import Image from "next/image";
import Link from "next/link";
import { AuthCard } from "../../components/AuthCard";
import BookieMascot from "../../components/BookieMascot";
import styles from "../bookiewookie.module.css";

export default function SignupPage() {
  return (
    <main className={styles.site}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}><Image src="/brand/mark.png" width={36} height={36} alt="" />BookieWookie</Link>
      </header>
      <div className={styles.signupGrid}>
        <BookieMascot signup />
        <AuthCard
          mode="signup"
          appearance="paper"
          headline="Create your account"
          subtext="Start a new book or bring a manuscript into your private author workspace."
          primaryLabel="Create account"
          altPrompt="Already have an account?"
          altLabel="Sign in"
          altHref="/login"
        />
      </div>
      <footer className={styles.footer}>
        <Link href="/data-and-privacy">Data &amp; privacy</Link>
      </footer>
    </main>
  );
}
