import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import BookOverview from "../../../../components/BookOverview";

export default async function BookOverviewPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <AuthorPage><AuthorHeader bookId={bookId} /><BookOverview key={bookId} bookId={bookId} /></AuthorPage>;
}
