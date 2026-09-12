import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import AdminConsole from "../../components/AdminConsole";

export default function AdminPage() {
  return <AuthorPage><AuthorHeader /><AdminConsole /></AuthorPage>;
}
