import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import PublishingStudio from "../../../../components/PublishingStudio";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export default async function PublishingPage({ params, searchParams }: { params: Promise<{ bookId: string }>; searchParams: Promise<{ packageJob?: string | string[]; edition?: string | string[] }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  const { packageJob, edition } = await searchParams;
  const packageJobId = typeof packageJob === "string" && uuid.test(packageJob) ? packageJob.toLowerCase() : undefined;
  const editionId = !packageJobId && typeof edition === "string" && uuid.test(edition) ? edition.toLowerCase() : undefined;
  return <AuthorPage><AuthorHeader bookId={bookId} /><PublishingStudio key={bookId} bookId={bookId} packageJobId={packageJobId} editionId={editionId}
    managedPublishingEnabled={process.env.MANAGED_PUBLISHING_ENABLED === "true"} /></AuthorPage>;
}
