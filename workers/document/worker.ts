import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneDocumentJob } from "../../services/api/src/lib/document-worker.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--once")) throw new Error("Usage: worker:document [--once]");
  const once = args.includes("--once");
  // Load private credentials only when the operator starts the worker.
  const sb = defaultSupabaseFactory();
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });
  do {
    let delay = 0;
    try {
      const outcome = await runOneDocumentJob(sb);
      if (outcome.status === "idle") delay = 2000;
      else console.log(JSON.stringify(outcome));
    } catch {
      console.error(JSON.stringify({ status: "document_worker_unavailable" }));
      if (once) process.exitCode = 1;
      delay = 5000;
    }
    if (once || stopped) break;
    if (delay) await setTimeout(delay);
  } while (!stopped);
}
main().catch(() => { console.error("Document worker startup failed. Check configuration and arguments."); process.exitCode = 1; });
