import { AuthorHeader, AuthorPage } from "../../../components/AuthorShell";
import BookSetupClient from "../../../components/BookSetupClient";

export default function NewBookPage() {
  return (
    <AuthorPage>
      <AuthorHeader />
      <BookSetupClient />
    </AuthorPage>
  );
}
