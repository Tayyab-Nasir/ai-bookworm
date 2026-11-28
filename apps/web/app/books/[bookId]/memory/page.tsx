import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import BookMemoryClient from "../../../../components/BookMemoryClient";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";

export default async function BookMemoryPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  return <AuthorPage><AuthorHeader bookId={bookId} /><BookMemoryClient key={bookId} bookId={bookId} /></AuthorPage>;
}
