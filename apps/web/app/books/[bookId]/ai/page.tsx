import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import CustomerAiStudio from "../../../../components/CustomerAiStudio";
export default async function CustomerAiPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <AuthorPage><AuthorHeader bookId={bookId} /><CustomerAiStudio key={bookId} bookId={bookId} /></AuthorPage>;
}
