import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { publishingActions, runOnePublishingJob, type PublishingAction } from "../../services/api/src/lib/publishing-worker.js";

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const actionArg = args.find((arg) => arg.startsWith("--actions="));
  const actions = actionArg ? actionArg.slice("--actions=".length).split(",") : [...publishingActions];
  if (args.some((arg) => arg !== "--once" && arg !== actionArg) || !actions.length
    || actions.some((action) => !publishingActions.includes(action as PublishingAction))) {
    throw new Error("Usage: worker:publishing [--once] [--actions=render,validate,export_package]");
  }
  // Credentials are loaded only when the operator explicitly starts this command.
  const sb = defaultSupabaseFactory();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  do {
    let delay = 0;
    try {
      const outcome = await runOnePublishingJob(sb, { actions: actions as PublishingAction[] });
      if (outcome.status !== "idle") console.log(JSON.stringify(outcome));
      else delay = 2000;
    } catch {
      // No arbitrary errors/provider responses/connection strings enter logs.
      console.error(JSON.stringify({ status: "worker_unavailable" }));
      if (once) process.exitCode = 1;
      delay = 5000;
    }
    if (stopped || once) break;
    if (delay) await setTimeout(delay);
  } while (!stopped);
}

main().catch(() => { console.error("Worker startup failed. Check configuration and CLI arguments."); process.exitCode = 1; });
