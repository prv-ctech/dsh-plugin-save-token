# codex-plugin-save-token

Cut token cost without cutting model intelligence — a **Codex CLI plugin**: structure-aware compression + TOON-style lossless encoding first + reversible spill-to-disk + `save_token_expand` retrieval.

Ported from the battle-tested brain of [dsh-plugin-save-token](../) (DeepSeek Harness bundle plugin v2.4.1). The compression module is line-for-line identical; the integration layer is a standard **MCP (Model Context Protocol) stdio server**, the official Codex extension point — no forks, no patches, works with `~/.codex/config.toml`.

> 只降 token、不降智 — 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## How it works

Codex (unlike the DSH harness) has no waterfall to intercept every built-in tool result, so the model **opts in** by calling these tools when output is expected to be large:

| Tool | Purpose |
| --- | --- |
| `save_token_run` | Run a shell command; oversized output is compressed, FULL output spilled to disk |
| `save_token_read` | Read a file with head/tail windowing; FULL content spilled to disk |
| `save_token_expand` | Retrieve the FULL original behind a `[save-token #id]` notice |

Three arms, inherited verbatim from the dsh plugin:

1. **Compress** — route order: lossless TOON tabular encoding (uniform JSON arrays, nested field groups, keyed maps, JSONL) → lossy structural elision (discloses what was elided) → line windowing (head/tail + ±1 error-line protection + tabular striding). Every candidate must pass the **never-worse double gate** (byte ratio + absolute saving + token estimate) or the original goes out untouched.
2. **Dedupe** — a byte-identical rerun within 10 minutes becomes a short stub pointing at the first copy (fingerprints hash the FULL strings, so no false "identical" claims).
3. **Expand** — `save_token_expand` hands back the FULL original from the in-memory cache, or from the persistent spill locator after a restart. **Reversibility red line: no spill, no compression.**

A compressed result looks like:

```
items[400]{model,input,output}:
m0,0,0
m1,1,2
...

[save-token #c1or losslessly re-encoded: 48,210 -> 6,530 bytes (~86% smaller), zero information loss. Need any omitted detail? Call the save_token_expand tool with id "c1or", or read the FULL ORIGINAL at: /Users/you/.codex/save-token/spill/20260905/xxx-run.txt.]
```

## Install

```bash
cd codex-plugin-save-token
node scripts/install.mjs          # registers [mcp_servers.save-token] in ~/.codex/config.toml
node scripts/install.mjs --skill  # optional: also install the agent guidance skill
```

The installer is idempotent, backs up `config.toml` first (`config.toml.bak.save-token.<ts>`), and needs no codex CLI. Equivalent manual registration (or `codex mcp add`):

```toml
[mcp_servers.save-token]
type = "stdio"
command = "node"                 # absolute node path is even better
args = ["/absolute/path/to/codex-plugin-save-token/src/index.js"]
```

Verify:

```bash
codex mcp list                   # save-token ... enabled
npm test                         # 82 tests: compression brain + store + tools + MCP protocol
```

## Configuration (env only, the config.toml block stays static)

| Env var | Default | Meaning |
| --- | --- | --- |
| `SAVE_TOKEN_COMPRESS_ENABLED` | `1` | Master switch for the compress arm |
| `SAVE_TOKEN_DEDUPE_ENABLED` | `1` | Byte-identical rerun stubs |
| `SAVE_TOKEN_MIN_BYTES` | `1400` | Compress outputs above this size |
| `SAVE_TOKEN_ERROR_MIN_BYTES` | `6000` | Looser floor for failing commands (errors stay verbose) |
| `SAVE_TOKEN_MIN_SAVING_BYTES` | `500` | Never-worse: minimum absolute saving |
| `SAVE_TOKEN_KEEP_RATIO_MAX` | `0.72` | Never-worse: max kept ratio |
| `SAVE_TOKEN_DEDUPE_TTL_MS` | `600000` | Dedupe window (0 disables) |
| `SAVE_TOKEN_MAX_LINES` / `HEAD_LINES` / `TAIL_LINES` | `240/140/80` | Line window |
| `SAVE_TOKEN_RUN_TIMEOUT_SEC` | `120` | Default command timeout (max 600) |
| `SAVE_TOKEN_MAX_CAPTURE_BYTES` | `2097152` | Per-stream capture cap |
| `SAVE_TOKEN_SPILL_DIR` | `$CODEX_HOME/save-token/spill` | Spill root (fallbacks: `~/.codex/...` → tmp) |

Set them in the config.toml block via the standard `[mcp_servers.save-token.env]` table.

## Seeing actual savings

Every adopted compression and dedupe appends one JSON line to `<spill-root>/stats.jsonl`. View the report:

```bash
npm run stats                       # totals + per-tool + per-day, with ~saved tokens
node scripts/stats.mjs --tail 10    # also list the last 10 events
```

```text
save-token savings — /Users/you/.codex/save-token/stats.jsonl
  events: 2 (1 compressions, 1 dedupes)
  bytes:  87,822 -> 2,064  (saved 85,758 B)
  tokens: ~23,112 -> ~544  (saved ~22,568 tok, 98% of compressed-input tokens)
```

**Inline dashboard (no commands needed):** install with `--skill`, then just ask in the conversation — "看看省了多少 token" / "show my save-token stats". The bundled `save-token-dashboard` skill reads `stats.jsonl` and emits an interactive inline visualization through Codex's official inline-HTML contract (`visualize{...}` reference, same mechanism as the built-in Visualize plugin). Renders in the desktop app / IDE; plain terminal TUI falls back to a compact markdown summary.

Two more observation channels: each compression logs one stderr line (visible in codex logs with `RUST_LOG=info`), and `<spill-root>` fills with the full originals so you can audit exactly what was held back.

## Spill & retention

Full originals live under `<spill-root>/<YYYYMMDD>/<id>-<tool>.txt` — plain files, readable by any tool, surviving restarts. Pruning is throttled and best-effort: day directories older than 7 days are dropped, and total files are capped at ~800 (oldest first).

## Known-good codex versions

- Registration verified with real binaries on codex **0.77.0** and **0.153.4** (`codex mcp list` → `enabled`; the Rust MCP client launches the server and completes `initialize` + `tools/list`).
- Unit-tested end-to-end at the protocol level (initialize → tools/list → run → compress → expand) with 82 tests.
- Version note: very new codex builds (≈0.15x) ship a `ToolSearchAlwaysDeferMcpTools` feature that holds MCP tools out of the request tool list in `codex exec` mode (they surface through tool search instead). On 0.77-era builds — and in the interactive TUI — MCP tools are advertised directly.
- Any codex with MCP support (`config.toml` `[mcp_servers.*]`) works; the server is zero-dependency Node ≥ 18.

## Relationship to dsh-plugin-save-token

| | dsh-plugin-save-token | codex-plugin-save-token |
| --- | --- | --- |
| Host | DeepSeek Harness (Cordis plugin) | Codex CLI (MCP stdio server) |
| Intercept | waterfall `tools/post-execute` (automatic) | model calls the tools (opt-in) |
| Compression brain | `src/compress.js` | identical (ported verbatim) |
| Spill backend | harness `spillStore` service | built-in `src/store.js` |
| Dashboard UI | Web GUI panel + JSON API | — (stderr logs only) |
| Compaction assist | optional, off by default | — (out of MCP scope) |

MIT — same as the parent project.
