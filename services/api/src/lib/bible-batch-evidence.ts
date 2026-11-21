import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.guid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const bibleCitationNodeId = z.string().min(1).refine(value => value.length <= 200, "Citation identifier must be at most 200 UTF-16 code units.");
export const bibleEvidenceCitation = z.object({ chapterId: id, documentVersionId: id,
  nodeId: bibleCitationNodeId, textHash: hash }).strict();
type Citation = z.infer<typeof bibleEvidenceCitation>;
const version = z.object({ chapterId: id, documentVersionId: id, version: z.number().int().positive() }).strict();
const reading = z.object({ fingerprint: hash, pageIndex: z.number().int().nonnegative() }).strict();
const jobSchema = z.object({ id, book_id: id, workspace_id: id, created_by: id,
  agent_type: z.literal("bookbible"), billing_mode: z.literal("quoted"), status: z.literal("succeeded"),
  input_ref: z.object({ bookBibleQuoteRequestId: id, sourceSha256: hash, generationRequestSha256: hash,
    generationRequest: z.unknown(), chapterVersions: z.array(version).min(1).max(3), reading,
    contextSources: z.array(bibleEvidenceCitation).min(1).max(100) }).passthrough() }).passthrough();
const quoteSchema = z.object({ id, user_id: id, workspace_id: id, book_id: id, generation_job_id: id,
  accepted_job_id: id, status: z.literal("ready"), source_sha256: hash, generation_request_sha256: hash,
  source_versions_json: z.object({ versions: z.array(version).min(1).max(3), reading }).strict(),
  generation_request_json: z.unknown() }).passthrough();
const requestSchema = z.object({ jobId: id, workspaceId: id, bookId: id, agentType: z.literal("bookbible"),
  input: z.object({ chapters: z.record(z.string(), z.unknown()) }).passthrough() }).passthrough();
const chapterSchema = z.object({ id, documentVersionId: id, nodes: z.array(z.unknown()).max(100) }).passthrough();
const nodeSchema = z.object({ id: z.string().min(1).max(200), textHash: hash, text: z.string(),
  excerptStart: z.number().int().nonnegative(), excerptEnd: z.number().int().nonnegative(),
  fullTextLength: z.number().int().nonnegative() }).passthrough();

export function jobCitesBibleEvidence(job: unknown, citation: Citation): boolean {
  const output = z.object({ output_ref: z.object({ candidates: z.array(z.object({
    sourceRefs: z.array(bibleEvidenceCitation).min(1).max(30),
  }).passthrough()).max(10) }).passthrough() }).passthrough().safeParse(job);
  return output.success && output.data.output_ref.candidates.some((candidate) =>
    candidate.sourceRefs.some((ref) => isDeepStrictEqual(ref, citation)));
}

function isTextBoundary(text: string, position: number): boolean {
  return position === 0 || position === text.length || !(position > 0 && position < text.length
    && /[\uD800-\uDBFF]/u.test(text.charAt(position - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(position)));
}

/** Return only a range proven by the accepted immutable quote and saved node.
 * Missing or legacy snapshots never become a claim about what the model read. */
export function verifiedBibleBatchRange(jobValue: unknown, quoteValue: unknown, citation: Citation, text: string) {
  const job = jobSchema.safeParse(jobValue), quote = quoteSchema.safeParse(quoteValue);
  if (!job.success || !quote.success) return null;
  const input = job.data.input_ref, saved = quote.data;
  if (createHash("sha256").update(text).digest("hex") !== citation.textHash
    || saved.id !== input.bookBibleQuoteRequestId || saved.user_id !== job.data.created_by
    || saved.workspace_id !== job.data.workspace_id || saved.book_id !== job.data.book_id
    || saved.generation_job_id !== job.data.id || saved.accepted_job_id !== job.data.id
    || saved.source_sha256 !== input.sourceSha256 || saved.generation_request_sha256 !== input.generationRequestSha256
    || !isDeepStrictEqual(saved.generation_request_json, input.generationRequest)
    || !isDeepStrictEqual(saved.source_versions_json.versions, input.chapterVersions)
    || !isDeepStrictEqual(saved.source_versions_json.reading, input.reading)
    || !input.chapterVersions.some((value) => value.chapterId === citation.chapterId && value.documentVersionId === citation.documentVersionId)
    || !input.contextSources.some((ref) => isDeepStrictEqual(ref, citation))) return null;
  const request = requestSchema.safeParse(saved.generation_request_json);
  if (!request.success || request.data.jobId !== job.data.id || request.data.bookId !== job.data.book_id
    || request.data.workspaceId !== job.data.workspace_id) return null;
  const chapter = chapterSchema.safeParse(request.data.input.chapters[citation.chapterId]);
  if (!chapter.success || chapter.data.id !== citation.chapterId || chapter.data.documentVersionId !== citation.documentVersionId) return null;
  const matches = chapter.data.nodes.filter((value) => value && typeof value === "object"
    && "id" in value && value.id === citation.nodeId);
  if (matches.length !== 1) return null;
  const parsedNode = nodeSchema.safeParse(matches[0]);
  if (!parsedNode.success || parsedNode.data.textHash !== citation.textHash) return null;
  const node = parsedNode.data;
  if (node.fullTextLength !== text.length || node.excerptStart >= node.excerptEnd || node.excerptEnd > text.length
    || node.excerptEnd - node.excerptStart > 24000 || !isTextBoundary(text, node.excerptStart)
    || !isTextBoundary(text, node.excerptEnd) || text.slice(node.excerptStart, node.excerptEnd) !== node.text) return null;
  return { startOffset: node.excerptStart, endOffset: node.excerptEnd };
}
