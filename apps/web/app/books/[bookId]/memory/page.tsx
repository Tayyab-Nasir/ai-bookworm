import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import BookMemoryClient from "../../../../components/BookMemoryClient";

export default async function BookMemoryPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <AuthorPage><AuthorHeader /><BookMemoryClient key={bookId} bookId={bookId} /></AuthorPage>;
}
