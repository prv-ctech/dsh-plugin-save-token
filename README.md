# dsh-plugin-save-token

Cuts token cost in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
0.1.7 by shrinking oversized tool output before it reaches the model. The full
original still goes to disk and the model keeps a path back to it — nothing is
thrown away.

Local fork (v2.4.3) of `vibe-any/dsh-plugin-save-token` (MIT), ported to host
`0.1.7-rc.2`. The compression logic is upstream's, unchanged. A separate Codex CLI
plugin ships alongside it in [`codex-plugin-save-token/`](./codex-plugin-save-token/).

## What This Does

| Surface | What it does |
|---|---|
| **Settings → Token Saver** | Panel with the numbers: tokens billed, tokens avoided, cache hits, busiest tools. Three switches — Compress, Dedupe, Compact. |
| Live strip | One line under the input box, visible whenever a session is running. |
| Automatic | Large tool results are condensed on the way in: lossless when the shape allows it, otherwise a head/tail window that always keeps the error lines. Nothing to run. |
| Repeat protection | The same result twice inside ten minutes becomes a short pointer to the first copy. |
| `save_token_expand` | Hands back a condensed original by its `[save-token #id]` marker. A miss returns the file path instead — those files can also be opened directly. |
| Metering | Billed input / cached / output / reasoning tokens and avoided tokens are counted separately. It never changes your request. |

## Getting Started

Needs dsh `0.1.7-rc.x` with the web profile, and its spill store (standard). **No
spill store ⇒ compression stays off** — that is the safety rule, not a fault:
nothing is ever dropped without a saved copy.

```sh
dsh plugin --profile web add /workspace/dsh-plugins/dsh-plugin-save-token

# the row is there, then restart dsh web
dsh --profile web --dump-config | grep save-token
```

Nothing is compiled on install. The panel and the strip follow dsh's language
setting (Settings → General → Language).

## Configuration

Lives in the `config:` block of the `save-token` row in
[cordis.patch.yml](./cordis.patch.yml), which lists every key.

| Field | Default | Meaning |
|---|---|---|
| `compressEnabled` / `dedupeEnabled` | `true` / `true` | Master switches — the panel toggles the same two. |
| `minBytes` / `errorMinBytes` | 1400 / 6000 | Smallest output worth touching; error output has to be much bigger. |
| `minSavingBytes` / `keepRatioMax` | 500 / 0.72 | A replacement must save this many bytes and land under 72% of the original. |
| `dedupeTtlMs` / `dedupeTtlOverrides` | 600000 / `{}` | Repeat window (10 min); per-tool override in ms, `0` opts a tool out. |
| `compactAssistEnabled` | `false` | Hands a long session to dsh's own compaction. Keep it off: summarising history turns cheap cached replay into full-price input. |

One trap: a later patch layer that overrides **one** key replaces the whole
`config` block — restate every key you want to keep.

The panel toggles (`compressEnabled`, `dedupeEnabled`, `compactAssistEnabled`)
are persisted to `$DSH_HOME/plugin-state/save-token-state.json` and re-applied on
startup, so a toggle survives a restart and outranks the profile `config` block
(most recent user intent wins). Delete that file to fall back to the profile
config.

## Development

```sh
npm test        # node --test
node build.mjs  # rebuild lib/ (committed, so installs need no build step)
```

## Removing It

```sh
dsh plugin --profile web remove dsh-plugin-save-token
```

Restart `dsh web`. Delete the `save-token` row by hand if it survives in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`.

## Licence

MIT — see [LICENSE](LICENSE). Forked from
[vibe-any/dsh-plugin-save-token](https://github.com/vibe-any/dsh-plugin-save-token)
(MIT), then ported to dsh `0.1.7-rc.2`: metadata fixes plus a same-origin guard on
the plugin's own POST routes.
