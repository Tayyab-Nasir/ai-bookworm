/** Provider-free test bridge to the same canonical operation engine used by the API. */
import { readFileSync } from "node:fs";
import { BookModelSchema } from "../../packages/book-model/src/schema.js";
import { DocumentOperationSchema } from "../../packages/book-model/src/operations.js";
import { applyOperation } from "../../packages/book-model/src/engine.js";

const input = JSON.parse(readFileSync(0, "utf8"));
let book = BookModelSchema.parse(input.bookModel);
let version = input.version;
if (!Number.isInteger(version) || version < 0 || !Array.isArray(input.operations))
  throw new Error("A saved version and operation list are required");
for (const value of input.operations) {
  const result = applyOperation(book, DocumentOperationSchema.parse(value), version);
  book = BookModelSchema.parse(result.book);
  version = result.version;
}
process.stdout.write(JSON.stringify({ bookModel: book, version }));
