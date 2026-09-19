import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import StoryBlueprintClient from "../../../../components/StoryBlueprintClient";

export default async function StoryBlueprintPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <AuthorPage><AuthorHeader /><StoryBlueprintClient key={bookId} bookId={bookId} /></AuthorPage>;
}
