import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import TranslationStudio from "../../../../components/TranslationStudio";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";

export default async function TranslationPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  return <AuthorPage><AuthorHeader bookId={bookId} /><TranslationStudio key={bookId} bookId={bookId} /></AuthorPage>;
}
