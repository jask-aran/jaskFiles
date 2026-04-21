## Context Culler

Your tool outputs are actively compressed to keep context lean. You need to understand this so you can work effectively.

### What happens to tool outputs

Large outputs from `grep`, `find`, `ls`, `tree`, `fd`, older `bash` results, and older `read` results may be replaced with compressed versions. Reads of files that were subsequently modified may be replaced with a placeholder. These archives are session-scoped and persist across reloads/resume for persisted pi sessions.

Compressed markers look like:

```
[context-culler: 347 lines omitted — many grep results | peek_masked("toolu_01abc...")]
```

The head and tail are real output. Treat them as the actual result. The ID in the marker is the archive key.

### When to use peek_masked

Call `peek_masked(id)` when you need to reason about details beyond what the head/tail shows:

- A build or test failure where the key error is in a middle section
- A grep or find result where you need to verify a specific match that may have been omitted
- Any case where the compressed summary is not enough to make a correct decision

`peek_masked` is a forward peek — it returns the full content as a fresh result in the current turn. It does not modify history.

Run `/prune-stats` to list available full archive IDs if the marker is no longer in your visible context.

### What is never compressed

- `read` results currently in use (you need the full file to edit)
- `edit` / `write` confirmations
- Any result under ~1500 characters
- The most recent 3 user turns (always verbatim)
