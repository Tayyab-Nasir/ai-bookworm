import test from "node:test";
import assert from "node:assert/strict";
import { privateDownloadUrl } from "../lib/private-download";

test("private attachment links preserve the signed object and token without changing previews", () => {
  for (const name of ["Saved interior.pdf", "Cover.png", "Part 1.mp3", "Archive.zip", "作者’s book.pdf"]) {
    const preview = "https://storage.example/storage/v1/object/sign/book-assets/workspaces/example/v1/book.pdf?token=signed%2Bvalue&cacheNonce=exact";
    const download = new URL(privateDownloadUrl(preview, name));
    assert.equal(download.searchParams.get("download"), name);
    download.searchParams.delete("download");
    assert.equal(download.href, preview);
    assert.equal(new URL(preview).searchParams.has("download"), false);
  }
});

test("attachment filenames cannot add headers or path separators and replace stale download options", () => {
  const url = "https://storage.example/object?token=synthetic&download=old&download=older";
  const result = new URL(privateDownloadUrl(url, "folder/part\\book\r\n\t\u0000\u007f.pdf"));
  assert.deepEqual(result.searchParams.getAll("download"), ["folder_part_book_____.pdf"]);
  assert.equal(result.searchParams.get("token"), "synthetic");
  assert.equal(new URL(privateDownloadUrl(url, "x".repeat(300))).searchParams.get("download")?.length, 240);
  assert.equal(new URL(privateDownloadUrl(url, "")).searchParams.get("download"), "file");
});
