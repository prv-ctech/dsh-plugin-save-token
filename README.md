# dsh-plugin-save-token

Token-cost reducer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
0.1.7. Slims oversized tool output on its way into the model's context — reversibly
and structure-aware. The full original always lands on disk; the model sees a
condensed copy carrying a retrieval path.

This checkout is a local fork (v2.4.2) of `vibe-any/dsh-plugin-save-token` (MIT),
ported to host `0.1.7-rc.2`. Compression logic is upstream's, unchanged — what the
port touched is listed in [Port Notes](#port-notes-017-rc2) and
[PORTING-SAVE-TOKEN-TO-0.1.7-rc2.md](./PORTING-SAVE-TOKEN-TO-0.1.7-rc2.md).
The repo also carries a standalone Codex CLI plugin in
[`codex-plugin-save-token/`](./codex-plugin-save-token/).

## What This Does

| Surface | What it does |
|---|---|
| `tools/post-execute` (prepend) | Compresses tool results over threshold: lossless TOON re-encode, structure-aware table windowing, head/tail elision with error-line retention. |
| Cross-turn dedupe | A byte-identical result inside the TTL becomes a stub pointing at the earlier copy. Keys carry the session id and hash full args/content. |
| `save_token_expand` | Fetches a compressed original by `[save-token #id]`. A miss returns the spill file path instead of a dead end. |
| Retrieval notice | Every replacement carries `[save-token #id]` plus a file locator; `read`/`grep` work directly on that path — no tool needed. |
| `llm/stream` metering | Real billed tokens (input / cached / output / reasoning) and avoided tokens accounted separately. No capping, ever. |
| Settings → Token Saver | Full panel: KPIs, per-request stacked chart, top-tools leaderboard, activity feed. Plus a live strip under the input box. Three toggles: Compress / Dedupe / Compact. |
| `agent/pre-step` (optional) | `compactAssistEnabled` only *triggers* dsh's own `compaction.compactIfNeeded('pressure')`. Off by default — see the config table. |

## Red Lines

1. **Reversible** — a failed spill write abandons compression; `read` and `save_token_expand` results are never compressed.
2. **Lossless first** — lossy elision runs only as the gate-checked fallback, and its notice discloses what was omitted.
3. **Double gate** — adopted only when the result is ≤ `keepRatioMax` bytes **and** estimated tokens strictly decrease **and** ≥ `minSavingBytes` is saved.
4. **Error-line protection** — `error / fatal / traceback / timeout` anchors are kept, with ±1 context line, inside elided regions.
5. **Cache-stable** — compression happens once, at tool-result entry; history stays byte-stable afterwards, so the provider prompt cache keeps hitting. Replay-time history rewriting is out of scope by design.
6. **Same-origin POST** — `/save-token/api/set-enabled` and `/api/reset` reject cross-origin callers. The GET dashboard stays open; do not expose the GUI beyond loopback.

## Getting Started

Requirements: dsh `0.1.7-rc.x` with the Web profile, and a live `spillStore`
(the standard `spill-local` row). **No spillStore ⇒ compression stays off** — that
is the reversibility precondition, not a bug.

```sh
# from this checkout (already link-installed in the `web` profile)
dsh plugin --profile web add /workspace/dsh-plugins/dsh-plugin-save-token

# verify the row, then restart dsh web (ESM caches are per-process)
dsh --profile web --dump-config | grep save-token
```

Nothing is compiled on install: `lib/` is committed.

## Using It

Nothing to operate. Open **Settings → Token Saver** for the panel, and watch the
live strip under the input box. Both follow dsh's language setting
(Settings → General → Language).

## Configuration

The `config:` block of the `save-token` row in [cordis.patch.yml](./cordis.patch.yml)
restates every owned key; code fallbacks live in `src/index.js`.

| Field | Default | Meaning |
|---|---|---|
| `compressEnabled` / `dedupeEnabled` | `true` / `true` | Master switches (also togglable in the panel). |
| `minBytes` / `errorMinBytes` | 1400 / 6000 | Entry size for ordinary output / for error output. |
| `minSavingBytes` / `keepRatioMax` | 500 / 0.72 | Byte gate: absolute saving and cap as a fraction of the original. |
| `maxLines` / `headLines` / `tailLines` | 240 / 140 / 80 | Window shape for ordinary long output. |
| `tabularHeadRows` / `tabularTailRows` / `tabularStrideSamples` | 60 / 40 / 50 | Verbatim head, verbatim tail, and stride density in table mode. |
| `longLineChars` | 420 | Truncation threshold for a single oversized line. |
| `jsonMaxParseBytes` / `jsonlMinLines` | 524288 / 8 | Lossless JSON parse cap; minimum uniform lines for the JSONL route. |
| `noticeFullTrailerCount` | 3 | First N compressions carry the verbose notice; later ones use the compact trailer (same id + locator). |
| `dedupeTtlMs` / `dedupeTtlOverrides` | 600000 / `{}` | Dedup window (10 min); per-tool ms override, `0` opts that tool out. |
| `compactAssistEnabled` | `false` | Compaction coupling. Keep off: summarizing history turns cheap cached replay into full-price input — break-even ≈ 60 requests. |
| `compactBudgetTokens` / `compactCooldownMs` | 120000 / 600000 | Watermark and cooldown for that assist. |
| `contextWindowTokens` / `compactWatermarkRatio` | 0 / 0.85 | When the window is known, the watermark is `window × ratio` instead of the absolute budget. |

Patch semantics trap: a later layer that overrides **one** key replaces the row's
whole `config` — restate the entire block, or the other keys silently reset.

## Port Notes (0.1.7-rc.2)

Five deltas against upstream v2.4.1; nothing else was touched.

| # | Change | Why |
|---|---|---|
| 1 | `peerDependencies` `@deepseek-ai/dsh` + `@deepseek-ai/dsh-tools`, `>=0.1.7-rc.1 <0.2.0` | Upstream declared none — the harness compat gate certified nothing. |
| 2 | `devDependencies` = same two packages; plain `npm install` | A profile install never materializes peers (`autoInstallPeers: false`), so `import '@deepseek-ai/dsh-tools'` failed at mount. |
| 3 | `dsh.client.inject: ["@deepseek-ai/dsh-client-locale"]`, `immediately: true` | Empty inject starved the locale wiring the panel uses. |
| 4 | `src/index.js:234` — spill `source` carries `kind: 'tool'` | 0.1.7 `SpillSource` is a discriminated union. |
| 5 | `src/index.js:512` — same-origin guard on the POST branch | Prefix routes have no host trust fence, and `reset` ran even when body parsing failed. |

`src/compress.js` and `src/client/index.js` are byte-identical to upstream.
`save_token_expand`'s `spillStore.readText` branch is dead on 0.1.7 (`spill-local`
exposes `saveText` only) and is deliberately kept as the locator fallback.

## Development

```sh
npm test        # node --test, 5 suites, zero test dependencies
node build.mjs  # rebuild lib/ (esbuild; client half wrapped for __ModuleLoader__)
```

## Removing It

```sh
dsh plugin --profile web remove dsh-plugin-save-token
```

Restart `dsh web`. If the `save-token` row survives in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`, delete it by hand.

## Licence

MIT — see [LICENSE](LICENSE). Forked from
[vibe-any/dsh-plugin-save-token](https://github.com/vibe-any/dsh-plugin-save-token) (MIT).
