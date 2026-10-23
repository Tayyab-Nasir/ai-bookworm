export type JobKind = "import" | "ai" | "publishing" | "audiobook_export";
export type JobDestination = "editor" | "memory" | "publish" | "translate" | "plan" | "assets" | "overview";

const agents: Record<string, readonly [string, JobDestination]> = {
  writer: ["AI writing", "editor"], proofreader: ["Proofreading", "editor"], copyeditor: ["Copy editing", "editor"],
  consistency: ["Consistency review", "editor"], bookbible: ["Book Bible extraction", "memory"],
  book_bible: ["Book Bible extraction", "memory"], metadata: ["Listing proposal", "memory"],
  story_blueprint: ["Story Blueprint proposal", "plan"], illustrator: ["Illustration", "assets"],
  cover_designer: ["Book cover", "assets"], translator: ["Translation", "translate"], narrator: ["Audiobook narration", "publish"],
};

/** Labels and destinations are allowlisted; never derive them from private job payloads or errors. */
export function jobSummary(kind: JobKind, row: { agent_type?: string; action?: string | null }) {
  const agent = row.agent_type ?? "", action = row.action ?? "";
  const actions: Record<string, string> = { render: "Edition render", validate: "Channel preflight", preflight: "Channel preflight", export_package: "Retailer package" };
  const [label, destination]: readonly [string, JobDestination] = kind === "import" ? ["Manuscript import", "editor"]
    : kind === "audiobook_export" ? ["Google Play audiobook package", "publish"]
      : kind === "ai" ? Object.hasOwn(agents, agent) ? agents[agent] : ["AI task", "overview"]
        : [Object.hasOwn(actions, action) ? actions[action] : "Publishing task", "publish"];
  return { label, destination };
}
