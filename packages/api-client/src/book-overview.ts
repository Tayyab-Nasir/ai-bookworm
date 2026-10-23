/** Saved operational facts, not a compliance or publication certificate. */
export interface BookOverview {
  viewerId: string;
  observedAt: string;
  book: { id: string; workspaceId: string; title: string; subtitle: string | null; authorName: string; language: string; genre: string | null; status: string; updatedAt: string };
  workspace: { id: string; name: string; role: string };
  manuscript: { chapterCount: number; wordCount: number; chaptersWithoutSavedVersion: number };
  chapters: { id: string; title: string; orderIndex: number; versionNumber: number | null; wordCount: number; updatedAt: string | null }[];
  bibleItems: number;
  listing: { description: boolean; keywords: number; categories: number; isbn: boolean };
  editionsTotal: number;
  editions: { id: string; kind: "ebook" | "print" | "audiobook"; status: string; updatedAt: string; coverArtworkChosen: boolean }[];
  history: { renders: number; packages: number };
  jobs: { id: string; kind: "import" | "ai" | "publishing"; label: string; status: string; createdAt: string; completedAt: string | null; destination: "editor" | "memory" | "publish" | "translate" }[];
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const nullableText = (v: unknown, max: number) => v === null || typeof v === "string" && v.length <= max;
const id = (v: unknown): v is string => typeof v === "string" && uuid.test(v);
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT/u.test(v) && v.length <= 40 && Number.isFinite(Date.parse(v));
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k));
const unique = (rows: { id: string }[]) => new Set(rows.map(row => row.id)).size === rows.length;

/** Refuse foreign/malformed scope before rendering links or operational counts. */
export function parseBookOverview(value: unknown, bookId: string): BookOverview {
  const fail = () => { throw Error("The saved book overview could not be verified. Reload before continuing."); };
  if (!object(value) || !keys(value, ["viewerId", "observedAt", "book", "workspace", "manuscript", "chapters", "bibleItems", "listing", "editionsTotal", "editions", "history", "jobs"])) return fail();
  const { book, workspace, manuscript, listing, history } = value;
  if (!id(bookId) || !id(value.viewerId) || !date(value.observedAt)
    || !object(book) || !keys(book, ["id", "workspaceId", "title", "subtitle", "authorName", "language", "genre", "status", "updatedAt"])
    || book.id !== bookId || !id(book.workspaceId) || !text(book.title, 500) || !nullableText(book.subtitle, 500)
    || !text(book.authorName, 300) || !text(book.language, 40) || !nullableText(book.genre, 200) || !text(book.status, 40) || !date(book.updatedAt)
    || !object(workspace) || !keys(workspace, ["id", "name", "role"]) || workspace.id !== book.workspaceId || !text(workspace.name, 200)
    || !["owner", "admin", "editor", "writer", "illustrator", "designer", "reviewer", "viewer"].includes(String(workspace.role))) return fail();
  if (!object(manuscript) || !keys(manuscript, ["chapterCount", "wordCount", "chaptersWithoutSavedVersion"])
    || !Object.values(manuscript).every(count) || !count(value.bibleItems) || !count(value.editionsTotal)
    || !object(listing) || !keys(listing, ["description", "keywords", "categories", "isbn"])
    || typeof listing.description !== "boolean" || typeof listing.isbn !== "boolean" || !count(listing.keywords) || !count(listing.categories)
    || !object(history) || !keys(history, ["renders", "packages"]) || !Object.values(history).every(count)) return fail();
  if (!Array.isArray(value.chapters) || value.chapters.length > 500 || value.chapters.some(c => !object(c)
    || !keys(c, ["id", "title", "orderIndex", "versionNumber", "wordCount", "updatedAt"]) || !id(c.id) || !text(c.title, 500)
    || !count(c.orderIndex) || !count(c.wordCount) || (c.versionNumber !== null && (!count(c.versionNumber) || c.versionNumber < 1))
    || (c.updatedAt !== null && !date(c.updatedAt)) || (c.versionNumber === null && (c.wordCount !== 0 || c.updatedAt !== null)))) return fail();
  const chapters = value.chapters as BookOverview["chapters"];
  if (!unique(chapters) || new Set(chapters.map(c => c.orderIndex)).size !== chapters.length
    || chapters.some((c, i) => i > 0 && chapters[i - 1].orderIndex > c.orderIndex)
    || manuscript.chapterCount !== chapters.length || manuscript.wordCount !== chapters.reduce((n, c) => n + c.wordCount, 0)
    || manuscript.chaptersWithoutSavedVersion !== chapters.filter(c => c.versionNumber === null).length) return fail();
  if (!Array.isArray(value.editions) || value.editions.length > 12 || value.editionsTotal < value.editions.length
    || value.editions.some(e => !object(e) || !keys(e, ["id", "kind", "status", "updatedAt", "coverArtworkChosen"])
      || !id(e.id) || !["ebook", "print", "audiobook"].includes(String(e.kind)) || !text(e.status, 40)
      || !date(e.updatedAt) || typeof e.coverArtworkChosen !== "boolean") || !unique(value.editions as BookOverview["editions"])) return fail();
  if (!Array.isArray(value.jobs) || value.jobs.length > 12 || value.jobs.some(j => !object(j)
    || !keys(j, ["id", "kind", "label", "status", "createdAt", "completedAt", "destination"]) || !id(j.id)
    || !["import", "ai", "publishing"].includes(String(j.kind)) || !text(j.label, 80)
    || !["queued", "running", "succeeded", "failed", "cancelled"].includes(String(j.status))
    || !date(j.createdAt) || j.completedAt !== null && !date(j.completedAt)
    || !["editor", "memory", "publish", "translate"].includes(String(j.destination)))) return fail();
  const jobs = value.jobs as BookOverview["jobs"];
  if (new Set(jobs.map(j => `${j.kind}:${j.id}`)).size !== jobs.length || jobs.some((j, i) => i > 0 && Date.parse(jobs[i - 1].createdAt) < Date.parse(j.createdAt))) return fail();
  return value as unknown as BookOverview;
}
