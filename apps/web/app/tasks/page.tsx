import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import CollaborationCenter from "../../components/CollaborationCenter";

export default function TasksPage() {
  return <AuthorPage><AuthorHeader /><CollaborationCenter view="tasks" /></AuthorPage>;
}
