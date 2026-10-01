# dsh-plugin-save-token

Cuts token cost in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
0.1.7 by shrinking oversized tool output before it reaches the model. The full
original still goes to disk and the model keeps a path back to it — nothing is
thrown away.

Local fork (v2.4.5) of `vibe-any/dsh-plugin-save-token` (MIT), ported to host
`0.1.7-rc.2`. Repairs add native-UUID markers with a retained-id reuse guard,
literal dedupe verification, semantic-equivalence gating for lossless encoding,
final notice gating for both compression and dedupe, bounded locator recovery,
and input validation on the dashboard API. Current
[verification report](<bench/verification.md>) and
[repair receipt](<bench/repair-plan.md#repair-receipt>) record the measured
results and the explicitly unverified scope (financial A/B). A separate
Codex CLI plugin ships alongside it in [`codex-plugin-save-token/`](./codex-plugin-save-token/).

## What This Does

| Surface | What it does |
|---|---|
| **Settings → Token Saver** | Panel with the numbers: tokens billed, tokens avoided, cache hits, busiest tools. Two switches — Compress, Dedupe. |
| Live strip | One compact pill under the input box; hover (or keyboard focus) expands the full stats. |
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

One trap: a later patch layer that overrides **one** key replaces the whole
`config` block — restate every key you want to keep.

**No compaction switch.** This plugin only compresses tool output, dedupes
repeats and meters tokens. It does **not** drive compaction: dsh mounts
`compaction-basic` inside an isolated group (`isolate: { compaction: true }`),
and cordis resolves an isolated service only inside its own scope, so a
top-level plugin can never reach `ctx.compaction`. The previous assist was
removed in v2.4.4 rather than silently doing nothing. dsh's own engine still
performs automatic pressure compaction; install a dedicated compaction plugin
to change that policy.

The panel toggles (`compressEnabled`, `dedupeEnabled`)
are persisted to `$DSH_HOME/plugin-state/save-token-state.json` and re-applied on
startup, so a toggle survives a restart and outranks the profile `config` block
(most recent user intent wins). Delete that file to fall back to the profile
config. Marker-to-spill-path lookups for `save_token_expand` are kept in
`$DSH_HOME/plugin-state/save-token-locators.json`. Load and new writes enforce the
same bound: at most 4000 entries, a 4 MiB file ceiling, and a 4 KiB per-locator
limit; invalid or oversized records are ignored, and an oversized custom locator
is never indexed (the original notice still prints its path). Recovery across a
genuinely fresh process is verified; expired markers can always use the locator
printed in the notice. Deleting the index loses lookups, not the spilled
originals.

Version 2.4.5 identifies these local artifacts; no npm release was published.
Local tests pass. Fresh GUI checks were blocked by browser sign-in; earlier GUI
verification covers 2.4.4. Restart the existing DSH host through its normal
lifecycle to reload the backend; this check did not restart it.

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
