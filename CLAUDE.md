# AI Bookworm cross-agent context

Read `AGENTS.md` and `docs/AGENT_HANDOFF.md` before continuing this project.
They point to the current Codex handoff in the shared Obsidian vault and the
Claude/Hermes/Codex task board. Reload those notes when resuming: prior claims
that the frontend or entire platform is complete are not acceptance evidence.

Preserve the existing working tree. Record your own changes and next steps in
`Claude Sessions/` using the vault's conventions; do not overwrite Codex or
Hermes memory files. Coordinate overlapping source edits through the board.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
