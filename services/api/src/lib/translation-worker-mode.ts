export type TranslationWorkerMode = "quoted" | "prepare-quotes";

export function parseTranslationWorkerArguments(args: readonly string[]) {
  if (args.some((arg) => !["--once", "--quoted", "--prepare-quotes"].includes(arg))
    || (args.includes("--quoted") && args.includes("--prepare-quotes"))) {
    throw new Error("Usage: worker:translation [--once] [--quoted | --prepare-quotes]");
  }
  return { once: args.includes("--once"), mode: (args.includes("--prepare-quotes") ? "prepare-quotes" : "quoted") as TranslationWorkerMode };
}
