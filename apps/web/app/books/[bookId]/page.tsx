import { AuthorHeader, AuthorPage } from "../../../components/AuthorShell";
import BookEditorClient from "../../../components/BookEditorClient";

export default async function BookEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ chapter?: string | string[]; aiJob?: string | string[] }>;
}) {
  const { bookId } = await params;
  const query = await searchParams;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const chapter = typeof query.chapter === "string" && uuid.test(query.chapter) ? query.chapter : undefined;
  const aiJob = typeof query.aiJob === "string" && uuid.test(query.aiJob) ? query.aiJob : undefined;
  return (
    <AuthorPage>
      <AuthorHeader />
      <BookEditorClient key={bookId} bookId={bookId} initialChapterId={chapter} initialAiJobId={aiJob} />
    </AuthorPage>
  );
}
