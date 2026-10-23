type Destination = "editor" | "memory" | "publish" | "translate" | "plan" | "assets" | "overview";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

/** Only build local, typed workflow URLs. Navigation never retries or applies a job. */
export function jobLink(job: { id: string; kind: string; bookId: string | null; destination?: Destination }, workspaceId: string): string | null {
  if (!uuid.test(job.id) || !uuid.test(workspaceId) || !["ai", "import", "publishing", "audiobook_export"].includes(job.kind)) return null;
  if (job.destination === "assets") return `/assets?ws=${encodeURIComponent(workspaceId)}`;
  if (!job.bookId || !uuid.test(job.bookId)) return null;
  const root = `/books/${encodeURIComponent(job.bookId)}`;
  if (job.destination === "editor") return job.kind === "ai" ? `${root}?aiJob=${encodeURIComponent(job.id)}` : root;
  if (job.destination && ["memory", "publish", "translate", "plan", "overview"].includes(job.destination)) return `${root}/${job.destination}`;
  return null;
}
