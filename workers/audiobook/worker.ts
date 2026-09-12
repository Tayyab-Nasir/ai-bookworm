import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneAudiobookJob } from "../../services/api/src/lib/audiobook-worker.js";

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--once")) throw new Error("Usage: worker:audiobook [--once]");
  const once = process.argv.includes("--once");
  const sb = defaultSupabaseFactory();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  do {
    let delay = 0;
    try {
      const result = await runOneAudiobookJob(sb);
      if (result.status === "idle") delay = 2_000;
      else console.log(JSON.stringify(result));
    } catch {
      console.error(JSON.stringify({ status: "audiobook_worker_unavailable" }));
      if (once) process.exitCode = 1;
      delay = 5_000;
    }
    if (once || stopped) break;
    if (delay) await setTimeout(delay);
  } while (!stopped);
}

main().catch(() => { console.error("Audiobook worker startup failed. Check configuration and arguments."); process.exitCode = 1; });
