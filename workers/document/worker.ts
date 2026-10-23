import { setImmediate, setTimeout } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneDocumentJob } from "../../services/api/src/lib/document-worker.js";

export async function consumeDocumentJobs(sb: Parameters<typeof runOneDocumentJob>[0], options: {
  once?: boolean; runOne?: typeof runOneDocumentJob;
} = {}) {
  const once = options.once ?? false;
  let stopped = false;
  const wake = new AbortController();
  const owned = process.connected; let activated = !owned;
  let releaseOwner!: () => void;
  const ownerReady = new Promise<void>(resolveOwner => { releaseOwner = resolveOwner; });
  // Finish an already claimed transaction; stop only future claims and idle waits.
  const stop = () => { stopped = true; wake.abort(); releaseOwner(); };
  const message = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return;
    if ((value as { command?: unknown }).command === "stop") stop();
    else if ((value as { command?: unknown }).command === "start" && !stopped) { activated = true; releaseOwner(); }
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  process.on("message", message); process.on("disconnect", stop);
  try {
    if (owned) {
      // A stop sent while tsx was loading must not be lost before listeners exist.
      process.send!({ event: "document_worker_control_ready" }, error => { if (error) stop(); });
      await ownerReady;
    } else await setImmediate();
    while (!stopped && activated) {
      let delay = 0;
      try {
        const outcome = await (options.runOne ?? runOneDocumentJob)(sb);
        if (outcome.status === "idle") delay = 2000;
        else console.log(JSON.stringify(outcome));
      } catch {
        console.error(JSON.stringify({ status: "document_worker_unavailable" }));
        if (once) process.exitCode = 1;
        delay = 5000;
      }
      if (once || stopped) break;
      if (delay) {
        try { await setTimeout(delay, undefined, { signal: wake.signal }); }
        catch (error) { if (!stopped) throw error; }
      }
    }
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    process.removeListener("message", message); process.removeListener("disconnect", stop);
    if (process.connected) process.disconnect?.();
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--once")) throw new Error("Usage: worker:document [--once]");
  // Load private credentials only when the operator starts the worker.
  await consumeDocumentJobs(defaultSupabaseFactory(), { once: args.includes("--once") });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("Document worker startup failed. Check configuration and arguments."); process.exitCode = 1;
});
