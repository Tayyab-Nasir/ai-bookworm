import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import CollaborationCenter from "../../components/CollaborationCenter";

export default function ApprovalsPage() {
  return <AuthorPage><AuthorHeader /><CollaborationCenter view="approvals" /></AuthorPage>;
}
