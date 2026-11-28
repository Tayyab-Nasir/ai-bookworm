import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import CommunityDirectory from "../../components/CommunityDirectory";

export default function CommunityPage() {
  return <AuthorPage><AuthorHeader /><CommunityDirectory /></AuthorPage>;
}
