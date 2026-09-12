import SiteBackground from "../../components/PageBackground";
import { SiteHeader } from "../../components/Header";
import { AuthCard } from "../../components/AuthCard";

export default function ForgotPasswordPage() {
  return <main className="relative isolate min-h-screen bg-black text-white">
    <SiteBackground /><SiteHeader />
    <section className="relative z-30 flex justify-center px-5 pb-16 pt-12">
      <AuthCard mode="forgot-password" badge="Account recovery" headline="Back to" italicWord="your stories."
        subtext="Enter your account email and we’ll send you a secure reset link." primaryLabel="Send reset email"
        altPrompt="Remember your password?" altLabel="Sign in" altHref="/login" />
    </section>
  </main>;
}
