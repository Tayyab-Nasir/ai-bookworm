import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { uploadTusArchive } from "./lib/audiobook-google-play-export-worker.js";

test("private export upload recovers over real HTTP without redirecting credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bookworm-export-http-"));
  const path = join(directory, "archive.zip");
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 19, 42);
  await writeFile(path, bytes, { mode: 0o600 });
  try {
    for (const mode of ["stored-reply-lost", "unstored-reply-lost", "redirect-create", "redirect-patch", "invalid-offset", "timeout", "cancel"] as const) {
      await t.test(mode, async () => {
        let offset = 0; let patches = 0; let heads = 0; let leaks = 0; let deletes = 0;
        const received: Buffer[] = [];
        const serverErrors: unknown[] = [];
        const abort = new AbortController();
        const server = createServer(async (req, res) => {
          try {
            if (req.url === "/leak") { leaks++; res.writeHead(200); res.end(); return; }
            assert.equal(req.headers.authorization, "Bearer fixture-service-key");
            assert.equal(req.headers.apikey, "fixture-service-key");
            assert.equal(req.headers["tus-resumable"], "1.0.0");
            if (req.method === "POST") {
              if (mode === "timeout") return;
              res.writeHead(mode === "redirect-create" ? 307 : 201, {
                location: mode === "redirect-create" ? "/leak" : "/storage/v1/upload/resumable/test",
              }); res.end(); return;
            }
            if (req.method === "DELETE") { deletes++; res.writeHead(204); res.end(); return; }
            if (req.method === "HEAD") {
              heads++;
              res.writeHead(200, { "upload-offset": String(mode === "invalid-offset" ? bytes.length + 1 : offset), "upload-length": String(bytes.length) });
              res.end(); return;
            }
            assert.equal(req.method, "PATCH"); patches++;
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const chunk = Buffer.concat(chunks);
            assert.equal(Number(req.headers["upload-offset"]), offset);
            if (mode === "redirect-patch") { res.writeHead(307, { location: "/leak" }); res.end(); return; }
            if (mode === "cancel") { abort.abort(new Error("fixture_cancelled")); req.socket.destroy(); return; }
            if (patches === 1 && (mode === "unstored-reply-lost" || mode === "invalid-offset")) { req.socket.destroy(); return; }
            received.push(chunk); offset += chunk.length;
            if (patches === 1 && mode === "stored-reply-lost") { req.socket.destroy(); return; }
            res.writeHead(204, { "upload-offset": String(offset) }); res.end();
          } catch (error) { serverErrors.push(error); res.destroy(); }
        });
        server.listen(0, "127.0.0.1"); await once(server, "listening");
        const address = server.address(); assert(address && typeof address !== "string");
        try {
          const upload = uploadTusArchive(path, "workspaces/fixture/audiobook-exports/test.zip", {
            projectUrl: `http://127.0.0.1:${address.port}`, serviceKey: "fixture-service-key", signal: abort.signal,
            requestTimeoutMs: mode === "timeout" ? 50 : 2000,
          });
          if (mode === "stored-reply-lost" || mode === "unstored-reply-lost") {
            await upload;
            assert.equal(heads, 1); assert.equal(deletes, 0);
            assert.equal(patches, mode === "stored-reply-lost" ? 2 : 3);
            assert.equal(createHash("sha256").update(Buffer.concat(received)).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
          } else {
            await assert.rejects(upload, mode === "cancel" ? /fixture_cancelled/ : /export_storage_/);
            if (mode === "invalid-offset") assert.equal(patches, 1, "invalid server offsets must not resend bytes");
            if (mode === "redirect-patch") assert.equal(patches, 3, "retries must be bounded");
          }
          assert.equal(leaks, 0, "custom service credentials were sent to a redirect destination");
          assert.deepEqual(serverErrors, []);
        } finally {
          server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
