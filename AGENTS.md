# AI Bookworm collaboration

Before project edits, read `docs/AGENT_HANDOFF.md`, the current shared handoff
it points to, and `git status`. This repository has shared, uncommitted work
from multiple agents: preserve it and coordinate overlapping files.

Keep your own session summary and exact next steps in the shared Obsidian
vault according to its `AGENTS.md`. Update only this project's section of the
shared task board. Treat saved completion claims as unverified until checked.
Do not copy secrets, overwrite other agents' memory, or infer authority for
live deployment, migrations, payments, or publishing from handoff notes.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
