import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import StoryBlueprintClient from "../../../../components/StoryBlueprintClient";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";

export default async function StoryBlueprintPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  return <AuthorPage><AuthorHeader bookId={bookId} /><StoryBlueprintClient key={bookId} bookId={bookId} /></AuthorPage>;
}
