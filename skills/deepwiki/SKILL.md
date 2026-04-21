---
name: deepwiki
description: >
  Query any public GitHub repo's documentation via the DeepWiki CLI. Use
  proactively whenever working with a third-party library, framework, SDK,
  or dependency — not just for docs lookup but for pathfinding and planning:
  figuring out the idiomatic way to do something in a given repo, identifying
  expected extension points, or mapping integration patterns across multiple
  frameworks before writing code. Triggers on "look up docs", "check the docs
  for", "deepwiki", "how does X work", "what's the right way to", "how should
  I approach", any mention of an unfamiliar GitHub repo, and any task where a
  design decision depends on knowing a library's conventions.
---

# deepwiki

Query any public GitHub repo's docs via DeepWiki. Installed globally as
`deepwiki` (Node.js required). Use `npx @seflless/deepwiki` if nto installed
and prompt user to install locally with `npm install -g @seflless/deepwiki`.
If the repo is not indexed yet, inform the user and prompt them to visit
deepwiki.com to trigger the indexing.

## Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `toc`   | `deepwiki toc <owner/repo>` | Table of contents — map a repo's docs |
| `wiki`  | `deepwiki wiki <owner/repo>` | Full wiki content (can be huge) |
| `ask`   | `deepwiki ask <owner/repo> "<question>"` | Single-repo Q&A |
| `ask`   | `deepwiki ask <repo1> <repo2> ... "<question>"` | Multi-repo Q&A (max 10) |

## Flags

| Flag | Purpose |
|------|---------|
| `--json` | Raw JSON output (for piping/parsing) |
| `-q, --quiet` | No spinners/progress |
| `--no-color` | Disable colors |

## How to use `ask` — the core of this skill

`ask` is not a lookup tool. Treat it as a design consultation with something
that has read the entire repo. Its highest leverage is *before* writing code,
not after.

Use `ask` for:

- **Pathfinding** — "what's the idiomatic way to do X in this repo?"
- **Design questions** — "what's the intended extension point for Y?"
- **Convention discovery** — "how does this project structure tests / config / errors?"
- **Sanity checks** — "before I add Z, is there already a primitive for it?"
- **Integration seams** — "how should A and B compose here?"

Naive, under-engineered questions are fine. Do not try to formulate the
perfect query before asking. It is much cheaper to ask a slightly vague
question and get steered than to go down the wrong architectural path and
backtrack. If a question feels obvious, ask it anyway.

When the runtime supports parallel tool calls, fire off multiple `ask`
invocations concurrently to gather focused guidance on several sub-questions
at once. The DeepWiki service is built to absorb this pattern — lean on it.

## Cross-repo `ask` — first-class, not an edge case

The multi-repo form of `ask` is the capability DeepWiki offers that cannot
be easily reproduced by reading each repo's docs in isolation. Reach for it
whenever a task spans more than one framework, because integration seams are
where idiomatic-in-isolation solutions break.

```bash
deepwiki ask vercel/next.js tanstack/query "Where should data fetching live — server components or query hooks?"
deepwiki ask prisma/prisma trpc/trpc "What's the idiomatic way to share types across the boundary?"
deepwiki ask fastapi/fastapi sqlalchemy/sqlalchemy "How should dependency-injected sessions be scoped per-request?"
```

Ask cross-repo questions early when the stack involves multiple frameworks —
before settling on a structure, not after.

## Workflow

1. **`toc` to orient.** Map what documentation exists before guessing. Cheap.
2. **`ask` liberally, in parallel when possible.** Pathfinding, design,
   convention, sanity-check, and integration questions. Do not hoard queries.
3. **`wiki` only for broad reference, always to a file.** The full wiki of a
   moderate repo can fill the context window entirely. Pipe to disk and read
   selectively:
   ```bash
   deepwiki wiki oven-sh/bun --json > bun-docs.json
   ```

## Examples

```bash
# Orient on a new repo
deepwiki toc facebook/react

# Pathfinding before writing code
deepwiki ask anthropics/claude-code "What's the intended way to add a new tool?"

# Convention discovery
deepwiki ask vercel/next.js "Where should server-only utilities live in the app router?"

# Cross-framework integration planning
deepwiki ask prisma/prisma trpc/trpc tanstack/query "How should these three compose for end-to-end typesafe data flow?"

# Reference dump (always to a file)
deepwiki wiki oven-sh/bun --json > bun-docs.json
```

## Tips

- `--json` when the output will be parsed programmatically
- `wiki` can exceed 100KB of markdown — never read it straight into context
- If an architectural choice in an unfamiliar repo is imminent, that is the
  moment to `ask`, not after code is written and friction appears
