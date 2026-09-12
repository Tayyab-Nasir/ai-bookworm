import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import AuthorDashboard from "../../components/AuthorDashboard";

export default function DashboardPage() {
  return (
    <AuthorPage>
      <AuthorHeader />
      <AuthorDashboard />
    </AuthorPage>
  );
}
