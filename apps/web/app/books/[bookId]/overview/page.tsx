import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import BookOverview from "../../../../components/BookOverview";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";

export default async function BookOverviewPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  return <AuthorPage><AuthorHeader bookId={bookId} /><BookOverview key={bookId} bookId={bookId} /></AuthorPage>;
}
