import BookEditorClient from "@/components/BookEditorClient";

export default async function BookEditorPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return <BookEditorClient bookId={bookId} />;
}
