import { AuthorHeader, AuthorPage } from "../../../components/AuthorShell";
import BookEditorClient from "../../../components/BookEditorClient";
import { canonicalBookRouteId } from "../../../lib/book-route-id";

export default async function BookEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ chapter?: string | string[]; aiJob?: string | string[]; draftPlan?: string | string[] }>;
}) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  const query = await searchParams;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const chapter = typeof query.chapter === "string" && uuid.test(query.chapter) ? canonicalBookRouteId(query.chapter) : undefined;
  const aiJob = typeof query.aiJob === "string" && uuid.test(query.aiJob) ? canonicalBookRouteId(query.aiJob) : undefined;
  const draftPlan = typeof query.draftPlan === "string" && uuid.test(query.draftPlan) ? canonicalBookRouteId(query.draftPlan) : undefined;
  return (
    <AuthorPage>
      <AuthorHeader bookId={bookId} />
      <BookEditorClient key={bookId} bookId={bookId} initialChapterId={chapter} initialAiJobId={aiJob} initialDraftPlanItemId={draftPlan} />
    </AuthorPage>
  );
}
