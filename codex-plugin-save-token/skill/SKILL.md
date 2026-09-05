---
name: save-token
description: |
  Token-efficient command and file reading for Codex. Use the save-token MCP
  tools (save_token_run, save_token_read) instead of plain shell/read when the
  output is expected to be large — long builds, test suites, dependency trees,
  log dumps, big JSON — and use save_token_expand to unfold any omitted detail
  behind a [save-token #id] notice instead of re-running the command.
---

# save-token: spend fewer tokens on bulky tool output

Large outputs are the cheapest place to save tokens: the model needs the
shape and the interesting fragments, not all 40,000 lines.

## When to prefer these tools

- `save_token_run` for: builds, full test suites, `ls -R`, `grep` over big
  trees, `curl` of large JSON payloads, anything that dumped thousands of
  lines before.
- `save_token_read` for: big logs, lockfiles, generated artifacts, data dumps.
- Small outputs (<~50 lines) are returned verbatim anyway — no need to think
  about it.

## The two recovery channels (never guess)

Every compressed result ends with a notice like:

```
[save-token #c1ab compressed: 48,210 -> 6,530 bytes (~86% smaller). ...]
```

1. `save_token_expand` with the notice id — hands back the FULL original text
   losslessly. Always call it when an omitted region might contain a detail
   you need, instead of guessing from the preview.
2. The full-original file path printed in the same notice — readable even in
   a brand-new session after this server restarted.

## Rules of thumb

- Never re-run an expensive command just to "see it again": expand the id, or
  read the spill path.
- The compression is lossless (TOON tabular) whenever the shape allows; lossy
  windows disclose what was elided right in the notice.
- A byte-identical rerun within 10 minutes comes back as a `[save-token #d...
  deduped]` stub — the first copy is already in context.
