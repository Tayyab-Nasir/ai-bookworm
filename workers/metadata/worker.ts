import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneQuotedMetadataJob } from "../../services/api/src/lib/quoted-metadata-worker.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--once") || args.length > 1) throw new Error("Usage: worker:metadata-quotes [--once]");
  const once = args.includes("--once");
  const sb = defaultSupabaseFactory();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  do {
    let delay = 0;
    try {
      const outcome = await runOneQuotedMetadataJob(sb);
      if (outcome.status === "idle") delay = 2_000;
      else console.log(JSON.stringify(outcome));
    } catch {
      console.error(JSON.stringify({ status: "metadata_quote_worker_unavailable" }));
      if (once) process.exitCode = 1;
      delay = 5_000;
    }
    if (once || stopped) break;
    if (delay) await setTimeout(delay);
  } while (!stopped);
}

main().catch(() => {
  console.error("Metadata quote worker startup failed. Check configuration and arguments.");
  process.exitCode = 1;
});
