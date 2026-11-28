import { AuthorHeader, AuthorPage } from "../../../components/AuthorShell";
import { AuthCard } from "../../../components/AuthCard";

export default function PasswordPage() {
  return <AuthorPage><AuthorHeader />
    <section className="flex justify-center px-5 pb-16 pt-12">
      <AuthCard mode="reset-password" badge="Secure your account" headline="A new" italicWord="password."
        subtext="Choose a unique password with at least eight characters." primaryLabel="Update password"
        altPrompt="No changes needed?" altLabel="Back to dashboard" altHref="/dashboard" />
    </section>
  </AuthorPage>;
}
