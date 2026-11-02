import assert from "node:assert/strict";
import { test } from "node:test";
import { privateUploadUrl } from "../lib/private-upload";

test("signed upload ticket binds origin, object identity, filename and a single token", () => {
  const expected = { workspaceId: "workspace", assetId: "asset", filename: "../A book.txt", storageOrigin: "https://storage.example" };
  const path = "workspaces/workspace/assets/asset/v1/A_book.txt";
  const ticket = { assetId: "asset", path, uploadUrl: `https://storage.example/storage/v1/object/upload/sign/book-assets/${path}?token=fixture` };
  assert.equal(privateUploadUrl(ticket, expected), ticket.uploadUrl);
  for (const bad of [
    { ...ticket, assetId: "other" }, { ...ticket, path: path.replace("/v1/", "/v2/") },
    { ...ticket, uploadUrl: ticket.uploadUrl.replace("storage.example", "elsewhere.example") },
    { ...ticket, uploadUrl: ticket.uploadUrl.replace("/asset/", "/other/") },
    { ...ticket, uploadUrl: ticket.uploadUrl.replace("?token=fixture", "") },
    { ...ticket, uploadUrl: `${ticket.uploadUrl}&token=second` },
    { ...ticket, uploadUrl: `${ticket.uploadUrl}&other=1` },
    { ...ticket, uploadUrl: `${ticket.uploadUrl}#fragment` },
    { ...ticket, uploadUrl: ticket.uploadUrl.replace("A_book.txt", "%E0%A4%A") },
  ]) assert.throws(() => privateUploadUrl(bad, expected), /destination could not be verified/);
});
