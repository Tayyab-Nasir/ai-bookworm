import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import PublishingStudio from "../../../../components/PublishingStudio";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";

export default async function PublishingPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  return <AuthorPage><AuthorHeader bookId={bookId} /><PublishingStudio key={bookId} bookId={bookId} /></AuthorPage>;
}
