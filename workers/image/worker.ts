import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneQuotedImageJob } from "../../services/api/src/lib/quoted-image-worker.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--once") || args.length > 1) throw new Error("Usage: worker:image-quotes [--once]");
  const once = args.includes("--once");
  const sb = defaultSupabaseFactory();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  do {
    let delay = 2000;
    try {
      const outcome = await runOneQuotedImageJob(sb);
      if (outcome.status !== "idle") console.log(JSON.stringify(outcome));
      if (outcome.status === "completion_unknown") {
        delay = 5000;
        if (once) process.exitCode = 1;
      }
    } catch {
      console.error(JSON.stringify({ status: "image_quote_worker_unavailable" }));
      if (once) process.exitCode = 1;
      delay = 5000;
    }
    if (once || stopped) break;
    await setTimeout(delay);
  } while (!stopped);
}
main().catch(() => {
  console.error("Image quote worker startup failed. Check configuration and arguments.");
  process.exitCode = 1;
});
