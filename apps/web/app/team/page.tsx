import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import CollaborationCenter from "../../components/CollaborationCenter";

export default function TeamPage() {
  return <AuthorPage><AuthorHeader /><CollaborationCenter view="team" /></AuthorPage>;
}
