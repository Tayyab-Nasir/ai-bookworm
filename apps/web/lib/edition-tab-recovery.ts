import type { Edition } from "@bookworm/types";
import { DEFAULT_FORM, FONTS, type FormState } from "./publishing-edition-form";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = 512 * 1024;
const choices: Record<string, readonly string[]> = {
  kind: ["ebook", "print", "audiobook"], textDirection: ["auto", "ltr", "rtl"], flow: ["reflowable", "fixed"],
  navigation: ["toc", "toc+landmarks", "none"], trimSize: ["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"],
  bleedEdges: ["all", "outer"], bodyFont: FONTS, headingFont: FONTS, textAlign: ["left", "justify"],
  numbering: ["arabic", "roman", "none"], numberPosition: ["bottom-center", "bottom-outer", "top-center"],
  qrPosition: ["bottom-left", "bottom-right"], voice: ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"],
  wrapProfile: ["kdp-white", "kdp-cream", "kdp-standard-color", "kdp-premium-color", "custom"],
};
type Scope = { actor: string; bookId: string };
export type EditionTabCopy = Scope & { editionId: string; base: string; form: FormState; format: 1 };
export function editionTabKey({ actor, bookId }: Scope): string {
  if (!uuid.test(actor) || !uuid.test(bookId)) throw new Error("The account or book could not be verified.");
  return `bookworm-edition-tab-v1:${JSON.stringify([actor, bookId])}`;
}
export function editionBase(edition: Edition, bookId: string): string {
  if (!edition || edition.book_id !== bookId || !uuid.test(edition.id) || typeof edition.updated_at !== "string"
      || !Number.isFinite(Date.parse(edition.updated_at)) || typeof edition.language !== "string"
      || !edition.edition_metadata_json || typeof edition.edition_metadata_json !== "object" || Array.isArray(edition.edition_metadata_json)) throw new Error("The saved edition could not be verified.");
  const value = JSON.stringify([edition.id, edition.book_id, edition.type, edition.language, edition.updated_at, edition.edition_metadata_json]);
  if (new TextEncoder().encode(value).byteLength > MAX_BYTES) throw new Error("The saved edition is too large for tab recovery.");
  return value;
}
export function parseEditionTab(raw: string, scope: Scope): EditionTabCopy {
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error("The local edition copy is too large. Contact support; clearing site data can remove unconfirmed request warnings.");
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("The local edition copy could not be read."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The local edition copy could not be read.");
  const record = value as Record<string, unknown>;
  if (record.format !== 1 || record.actor !== scope.actor || record.bookId !== scope.bookId || typeof record.editionId !== "string" || !uuid.test(record.editionId)
      || typeof record.base !== "string" || !record.form || typeof record.form !== "object" || Array.isArray(record.form)) throw new Error("The local edition copy belongs to another account or book.");
  const form = record.form as Record<string, unknown>, defaults = DEFAULT_FORM as unknown as Record<string, unknown>;
  if (Object.keys(form).length !== Object.keys(defaults).length || Object.keys(defaults).some(key => !Object.hasOwn(form,key)
      || typeof form[key] !== typeof defaults[key] || (typeof form[key] === "string" && form[key].length > 4096)
      || (typeof form[key] === "number" && (!Number.isFinite(form[key]) || Math.abs(form[key]) > 1_000_000)))) throw new Error("The local edition copy is invalid.");
  if (Object.entries(choices).some(([key, values]) => !values.includes(form[key] as string))) throw new Error("The local edition copy has an invalid format or setting.");
  return record as unknown as EditionTabCopy;
}
export function readEditionTab(storage: Storage, scope: Scope): string | null {
  const raw = storage.getItem(editionTabKey(scope));
  if (raw !== null && new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error("The local edition copy is too large. Contact support; clearing site data can remove unconfirmed request warnings.");
  return raw;
}
export function writeEditionTab(storage: Storage, scope: Scope, edition: Edition, form: FormState, expected: string | null): string {
  const key = editionTabKey(scope);
  if (storage.getItem(key) !== expected) throw new Error("The local edition copy changed. Reload before replacing it.");
  const raw = JSON.stringify({ format: 1, ...scope, editionId: edition.id, base: editionBase(edition,scope.bookId), form });
  parseEditionTab(raw, scope);
  try { storage.setItem(key,raw); } catch { throw new Error("The browser could not save the local edition copy."); }
  return raw;
}
export function discardEditionTab(storage: Storage, scope: Scope, expected: string): void {
  const key = editionTabKey(scope);
  if (storage.getItem(key) !== expected) throw new Error("The local edition copy changed. Reload before discarding it.");
  try { storage.removeItem(key); } catch { throw new Error("The browser could not remove the local edition copy."); }
}
