import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import TranslationStudio from "../../../../components/TranslationStudio";

export default async function TranslationPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <AuthorPage><AuthorHeader /><TranslationStudio key={bookId} bookId={bookId} /></AuthorPage>;
}
