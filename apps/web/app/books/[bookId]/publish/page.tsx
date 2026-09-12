import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import PublishingStudio from "../../../../components/PublishingStudio";

export default async function PublishingPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <AuthorPage><AuthorHeader /><PublishingStudio key={bookId} bookId={bookId} /></AuthorPage>;
}
