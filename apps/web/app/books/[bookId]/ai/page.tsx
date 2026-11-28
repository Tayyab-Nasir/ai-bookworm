import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import CustomerAiStudio from "../../../../components/CustomerAiStudio";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";
export default async function CustomerAiPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  return <AuthorPage><AuthorHeader bookId={bookId} /><CustomerAiStudio key={bookId} bookId={bookId} /></AuthorPage>;
}
