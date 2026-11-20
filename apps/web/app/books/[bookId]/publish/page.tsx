import { AuthorHeader, AuthorPage } from "../../../../components/AuthorShell";
import PublishingStudio from "../../../../components/PublishingStudio";
import { canonicalBookRouteId } from "../../../../lib/book-route-id";

export default async function PublishingPage({ params, searchParams }: { params: Promise<{ bookId: string }>; searchParams: Promise<{ packageJob?: string | string[] }> }) {
  const { bookId: requestedBookId } = await params;
  const bookId = canonicalBookRouteId(requestedBookId);
  const { packageJob } = await searchParams;
  const packageJobId = typeof packageJob === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(packageJob) ? packageJob.toLowerCase() : undefined;
  return <AuthorPage><AuthorHeader bookId={bookId} /><PublishingStudio key={bookId} bookId={bookId} packageJobId={packageJobId}
    managedPublishingEnabled={process.env.MANAGED_PUBLISHING_ENABLED === "true"} /></AuthorPage>;
}
