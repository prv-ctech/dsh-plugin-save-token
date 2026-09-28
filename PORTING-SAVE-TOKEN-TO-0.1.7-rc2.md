# Porting `dsh-plugin-save-token` to DSH 0.1.7-rc.2

Target: [vibe-any/dsh-plugin-save-token](https://github.com/vibe-any/dsh-plugin-save-token) — npm `dsh-plugin-save-token@2.4.1` (published 2026-09-04); repo `main` is also `2.4.1`.
Host: DSH `0.1.7-rc.2`, profile `web`, `DSH_HOME=/home/node/.dsh`.

Every claim below is marked **[verified]** (read from installed source, npm metadata, or the plugin's own shipped code) or **[not verified]** (needs a live run).

---

## 0. Read this first

- This plugin is **multi-layer**: L2 tool results + L5 dedup + L0 metering, with an **optional, default-OFF** L3 assist. It is not an L2-only reducer.
- **It composes with native `dsh-spill-policy`** and with `dsh-taskfold` **[verified from source]**, but it is the *only* community reducer your stack may hold.
- It declares **no DSH peers and no `engines.dsh`** → `NO-GATE` **[verified: npm packument 2.4.1 + repo main]**. That means the harness gate certifies **nothing**; the row mounts on any version. Adding the peer range is part of the port.

---

## 1. Manifest and bundle shape **[verified]**

```json
{
  "version": "2.4.1",
  "peerDependencies": {},
  "dependencies": {},
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  }
}
```

- Bundle patch inserts row `id: save-token`, `name: dsh-plugin-save-token`.
- Host half = `exports["."]`, browser half = `exports["./client"]` (**22,371 B** client bundle + a `settings.section`).
- Runtime preconditions: a running **Web GUI** (the dashboard/API half assumes it) and **`pnpm` on `PATH`**.
- The plugin's own patch comment says its `config` block **restates every owned key** so later layers can override individual values.

---

## 2. Patch semantics trap **[verified]**

DSH patch semantics replace a row's **whole `config`**. If you override one key in your profile patch, you must restate the entire block, or you silently reset the rest to schema defaults.

Shipped defaults (all of them):

```yaml
- id: save-token
  name: dsh-plugin-save-token
  config:
    compressEnabled: true
    dedupeEnabled: true
    minBytes: 1400
    errorMinBytes: 6000
    minSavingBytes: 500
    keepRatioMax: 0.72
    maxLines: 240
    headLines: 140
    tailLines: 80
    tabularHeadRows: 60
    tabularTailRows: 40
    tabularStrideSamples: 50
    longLineChars: 420
    jsonMaxParseBytes: 524288
    jsonlMinLines: 8
    noticeFullTrailerCount: 3
    dedupeTtlMs: 600000
    dedupeTtlOverrides: {}
    compactAssistEnabled: false     # KEEP FALSE — see §6
    compactBudgetTokens: 120000
    compactCooldownMs: 600000
    contextWindowTokens: 0
    compactWatermarkRatio: 0.85
```

---

## 3. What it hooks **[verified — `src/index.js`]**

| Hook | Line | Behaviour |
|---|---|---|
| `tools/post-execute` | `:244` | registered `{ prepend: true }`; **calls `next()` first**, then compresses the returned content. Early-returns when the inner decision carries `value` or is not `accept`. |
| `llm/stream` | `:360` | metering only: billed input / cached / output / reasoning + **avoided** tokens accounted separately. No capping. |
| `agent/pre-step` | `:431` | pressure check → native `compaction.compactIfNeeded('pressure')` (trigger only, gated by `compactAssistEnabled`). |
| `ctx.tools.register` | `:459` | one tool: `save_token_expand` |
| `ctx.webServer.register` | `:527` | prefix route `/save-token` (+ `:504-506`) |

`inject = ['tools', 'webServer']`; `spillStore` and `compaction` are fetched lazily with `ctx.get()` (`:227`) and both are **optional**:
- **no `spillStore` → compression stays permanently off** (reversibility is a hard precondition; `:229` logs `no spillStore backend`). "Installed" ≠ "active".
- no `compaction` → only the pressure assist is disabled.

---

## 4. Ordering vs native `dsh-spill-policy` **[verified from source]**

Cordis implements `prepend` as `unshift` (`cordis/lib/index.js:336`), so among prepended listeners **the last registered runs first**. Native `dsh-spill-policy` mounts in the base layer; save-token mounts later as a profile bundle → **save-token ends up outermost**:

```
tool result ──► save-token   (await next() first, decide after)
                   └──► dsh-spill-policy   (await next(), bound to maxInlineTokens: 12500)
                            └──► default accept
```

Consequences:
- Normal results (≤12,500 tok) are compressed by save-token alone.
- Oversized results are bounded by spill **first**; save-token then applies its never-worse gate to spill's head/tail plain text, which its structural reducers rarely re-claim → usually **one notice**.
- Two notices need a result that survives spill still structured **and** large. Redundant, not destructive. **[not verified: exact one-vs-two count on a live oversized result]**

Do not "fix" this by reordering mounts unless you re-prove the wrapping direction — moving the plugin between layers flips who wraps whom.

---

## 5. Retrieval and the dead fallback **[verified]**

- Notice format: `[save-token #<id>]`, plus a file locator when spilled.
- `save_token_expand` looks up an in-memory `originals` map, then tries `ctx.get('spillStore').readText({ locator })`.
- **`dsh-spill-local` exposes `saveText` only — there is no `readText`** **[verified: installed package API surface]**. So that branch is dead code on 0.1.7-rc.2 and an evicted/expired id degrades to: `expired id. The FULL ORIGINAL is still stored at: <path>. Use the read tool`. Acceptable behaviour; just don't document it as a transparent store read.
- Native spill's own path needs **no tool and no schema**: the notice carries a path and the model uses `read --offset/--limit` or `grep`.

---

## 6. The L3 assist: keep it off **[verified]**

`compactAssistEnabled: false` is the default and must stay so while `dsh-taskfold` owns L3:
- The assist only **triggers** the native engine (`compactIfNeeded('pressure')`); it is not an engine.
- The author repositioned it as anti-overflow, not a saver: rewriting history converts cheap cache replay into full-price input; documented break-even ≈ 60 requests for a 120k→40k summary.
- `dsh-taskfold` builds its own `ScopedEngine` with `auto: false` and explicitly leaves auto compaction to the realm engine, so there is no engine collision either way.

---

## 7. Port checklist

1. **Add peers.** `>=0.1.5-rc.1 <0.2.0` (or `>=0.1.7-rc.1`) so `evaluatePluginCompatibility` has something to enforce. Widen, don't narrow — `^0.1.7-rc.1` would break it on older channels.
2. **`compactAssistEnabled: false`** (§6).
3. **Never pair with another reducer**: `dsh-trim`, `toolshrink`, `dsh-headroom`, `@goodandready/dsh-context-lens` all own the same `tools/post-execute` seam.
4. **Confirm `spillStore` resolves** (`dsh-spill-local` row enabled). Without it compression is silently off.
5. **Restate the full `config`** on any override (§2).
6. **Price the schema**: `save_token_expand` = **2,193 B ≈ 550 tok/request**, permanent, even when nothing is compressed.
7. **Route hygiene**: `/save-token/api/dashboard`, `/api/set-enabled`, `/api/reset` — two are **mutating** and **no trust fence (`connection.requestRejection`/origin check) was found in the plugin** **[verified: grep of `src/index.js`]**. Confirm the host's route trust applies before exposing the GUI beyond loopback.
8. **Check for bundled core packages** after install (a plugin shipping its own `@deepseek-ai/*` copies can break the whole harness — see discussion #3033).

---

## 8. Acceptance tests (run these; all are **[not verified]** until you do)

1. `dsh --profile web --dump-config` → row `save-token` present, **no `skipping profile bundle` on stderr**, no competitor re-enabled.
2. One tool result clearly above 12,500 tokens → count retrieval notices (want one; two means spill and save-token both claimed it).
3. Repeat an identical tool call within 600 s → dedupe stub instead of the full body; per-tool override `0` disables.
4. After a container restart or id eviction, call `save_token_expand` → expect the locator fallback text, then `read` the path.
5. Compare **`prompt_tokens` and cache read/write** before/after (dsh-context / token-meter). Compression happens once at entry; history stays byte-stable afterwards, which is the property that protects the prefix cache.
6. Trigger one `dsh-taskfold` fold → must still work (it uses its own engine, unaffected).

---

## 9. Vendor-reported numbers (unverified here)

From the repo's own bench artifacts: round-2 A/B success **100 % both arms (48/48)**, cache hit **90.0 % → 90.7 %**, **~560 k tokens avoided**, SWE long-context **sympy −19.7 % / django −18.0 %**; round-1 total tokens **−17.6 %**; single events **41,727 B → 15,191 B (−64 %)** table and **34,000 B → 19,935 B (−41 %)** TOON. Treat as claims, not measurements.

---

## 10. Not verified

- Nothing was installed or executed for this note; no live turn, no compaction event, no route probe.
- The one-vs-two-notice case (§4) is derived from registration order, not observed.
- Host-level route fencing was not inspected — only the plugin's own code.
- Token figures are `chars/4` estimates, not tokenizer-accurate.
- Session-log inspection is not possible on this host: the log is `session.v4.jsonl.zstd` and there is **no `zstd` binary**, so runtime compaction/compression events cannot be grepped without one.

---

## 11. Port design — APPROVED (supersedes §7 where they differ)

Status: user-approved design for porting repo `main` (2.4.1, HEAD e241dbc) to the DSH
0.1.7-rc.2 running on this host. Every host contract below was re-verified [verified]
against the installed 0.1.7-rc.2 types/source and live inspect (host Event/Service
catalogs, client Slots/Theme), not just the npm metadata §1–§10 used.

### 11.1 Seam verification result

Intact, no change needed:
- `tools/post-execute` waterfall + `{kind:'accept',content}` decision + `exec.{name,arguments,callId,parent,agent}`; prepend = unshift (cordis 4.0.4 `lib/index.js:336`).
- `llm/stream`: `GenerateOptions.{purpose,sessionId,provider,model,system,messages,tools}`; `StreamChunk` usage `{inputTokens,cacheReadTokens,cacheWriteTokens,outputTokens,reasoningTokens}` (disjoint counts — plugin's billed-input sum stays correct) + `finish.reason.kind`.
- `agent/pre-step` passthrough; `compaction.compactIfNeeded(agent,'pressure',signal)` — `'pressure'` is a valid `CompactionTrigger`.
- `defineTool` exists in `@deepseek-ai/dsh-tools@0.1.7-rc.2`; the plugin's `parameters`/`output.schema` shapes match the `ValueSchemaSpec` DSL exactly.
- `webServer.register({kind:'prefix',path,handler})` unchanged; dispatch = gzip → route match → handler.
- `ctx.get('spillStore')` returns `undefined` when absent (cordis `get(name, strict)` never throws) — the optional-service pattern holds.
- Client: `settings.section` (list) and `conversation.composer.dock` (list, session scope) slots live; `ctx.slots.inject → ctx.slots.register` is the current sanctioned template pattern; React seeded in the browser module table; locale service `getLocale().active` + `subscribe` match the plugin's guard; every `--dsw-alias-*` token the CSS uses exists in the live token set.
- Roster: `spill-local` + `spill-policy (maxInlineTokens: 12500)` present; NO other installed plugin hooks `tools/post-execute` (checked dsh-context, dsh-taskfold, dsh-codex-subscription) — §4 ordering analysis holds unchanged.

Deltas requiring edits:
1. **`SpillSource` is now a discriminated union requiring `kind: 'tool'`** (`dsh-spill/lib/types/types.d.ts`); the plugin omits `kind`. `LocalSpillStore.saveText` ignores `source` at runtime, so this is contract hygiene, not a live crash.
2. **`@deepseek-ai/dsh-tools` does not resolve** from a profile-installed plugin: the profile root `node_modules/@deepseek-ai/` lacks it and profile pnpm runs `autoInstallPeers: false`. Working analog (dsh-caveman): declare peers + materialize in the plugin's own workspace `node_modules` (link:-installed plugins resolve imports there).
3. **`dsh.client.inject: []` starves composition edges.** Every working client analog declares package edges (dsh-theme-picker — same facets, slots+locale+settings.section — declares exactly `["@deepseek-ai/dsh-client-locale"]`). `WebBootEntry.inject` = "package rows whose factories must arrive before this row materializes" + Cordis composition edges.
4. **Compat gate mechanics** (`dsh-app-boot` `evaluatePluginCompatibility`): only peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` are checked, via `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`; absent `peerDependencies` = NO-GATE (confirms §0).
5. **No host trust fence on webServer prefix routes** (confirms §7.7): dispatch never calls `connection.admit`/`requestRejection`. `POST /save-token/api/reset` executes even when JSON body parsing fails (`args={}` → reset runs), so it is CSRF-reachable from any web page while the GUI runs (impact: stats wipe only). `set-enabled` requires a JSON content-type → preflight-blocked → not silently reachable.

### 11.2 Approved changes (behavior otherwise byte-identical)

`package.json`:
- `peerDependencies`: `"@deepseek-ai/dsh": ">=0.1.7-rc.1 <0.2.0"`, `"@deepseek-ai/dsh-tools": ">=0.1.7-rc.1 <0.2.0"` (user decision: taskfold-convention range; rc satisfies via includePrerelease).
- `devDependencies` += `"@deepseek-ai/dsh-tools": ">=0.1.7-rc.1 <0.2.0"` (local materialization for build + link-mount resolution) **and** `"@deepseek-ai/dsh": "0.1.7-rc.2"`. Local install: **plain `npm install`** — *T4 deviation, measured*: `--legacy-peer-deps` suppresses peer resolution, so `dsh-tools`' own peer graph (`@deepseek-ai/cordis`, `dsh-sandbox`, …) never materializes and the plugin dies at mount with `ERR_MODULE_NOT_FOUND` from inside `node_modules/@deepseek-ai/dsh-tools/lib/index.js`. The umbrella devDep seeds the tree; peer auto-install closes it (284 `@deepseek-ai/*` packages, 187 MB). `dsh-caveman` (proven link:-installed analog) uses exactly this shape.
- `dsh.client.inject`: `["@deepseek-ai/dsh-client-locale"]`; `dsh.client.immediately: true`.
- `version`: `2.4.1` → `2.4.2`.

`src/index.js`:
- `spillOriginal`: add `kind: 'tool'` to the `source` object (1 line).
- Dashboard handler: minimal same-origin guard on the POST branch (~6 lines): reject with 403 when `sec-fetch-site` is present and not `same-origin`/`none`; else compare `Origin`/`Referer` host against `Host`. GET dashboard stays open (user decision: minimal origin check).

`src/client/index.js`, `src/compress.js`, `cordis.patch.yml`: NO changes.

Non-goals: `codex-plugin-save-token/` subproject; removing the dead `spillStore.readText` branch (§5 — harmless, keeps logic intact); L3 assist stays default-OFF (§6); no `Config` schema export; bench reruns.

### 11.3 Mechanics

`npm install` (plain, see §11.2 deviation) → `node --test` (5 suites green, logic untouched) → `node build.mjs` (rebuild `lib/`; self-checks handshake + react-external) → **closure proof** `node -e 'import("./lib/index.js")…'` must resolve to a factory (`apply` fn) — `build.mjs`'s face check is a false negative (`build.mjs:84` swallows any resolution error whose message mentions `@deepseek-ai/dsh-tools`) → `plugin_manager install_bundle target=/workspace/dsh-plugins/dsh-plugin-save-token` (sanctioned install path; do NOT hand-edit profile `package.json`/`cordis.patch.yml`; affects every session in the profile; new bundle may activate via HMR, replaced package requires restart).

Rollback: `plugin_manager remove_bundle dsh-plugin-save-token`; workspace edits are git-tracked against a clean upstream clone.

### 11.4 Acceptance — RESULTS (T8, live on 0.1.7-rc.2)

1. **PASS** — `install_bundle` → `application: applied`, `warnings: []`, pnpm exit 0.
2. **PASS** — `dsh --profile web --dump-config`: row `save-token` present with all 25 config keys intact, `compactAssistEnabled: false`, empty stderr.
3. **PASS (substituted evidence)** — `save_token_expand` is in the live Tool catalog (48 tools; present in the delivered result and both spilled copies). Config-entry lookup was blocked by a harness defect: any `cordis_inspect_query` call that passes `input` is rejected `"input" must be an object`, and Config page 1 of 207 is alphabetical (`include:*`) so the entry cannot be paged to. Entry liveness is proven instead by dump-config + the live behavior in items 4–5.
4. **PASS** — first large result → `[save-token #c2ej …]`; lossless encode `#c3av` 4,376→1,983 B (−55%); identical repeat of a spill-free result → `[save-token #d7i8 deduped: … BYTE-IDENTICAL output to a call 82s ago …]`, and the plugin's own dashboard records `kind:"dedupe", detail:"identical output within 82s -> stubbed", saved:1041`.
5. **PASS** — GET `/save-token/api/dashboard` → 200, `spillReady:true`, `flags {compress,dedupe,expandTool} = true`, live metering (11 requests, 344,879 avoided tokens). POST probes: foreign `Origin` → 403, `sec-fetch-site: cross-site` → 403, malformed `Origin` → 403, foreign `Referer` → 403, `set-enabled` foreign → 403; same-origin → 200; **no headers at all → 200** (bare clients unaffected). Guard behaves 8/8 as designed.
6. **PENDING (page refresh)** — registration code verified in source (`src/client/index.js:337-345`: `settings.section` id `save-token`, order 430, label `Token Saver`; `conversation.composer.dock` id `save-token-strip`, order 85). The live client Slot tree returned by the connected page contains **no** `save-token` occupant and `composer.dock` has empty children → the client half was installed after the page loaded and does not hot-apply without `pnpm run dev:web`. Refresh the GUI tab to mount it.
7. **PASS — 2 notices, as predicted** — both oversized results produced the native spill notice `(Omitted 12,277 bytes. Full formatted result stored at: …)` **and** a save-token notice (50,019→13,084 B −74%; 49,945→8,541 B −83%). Matches the §4 ordering analysis: spill bounds first, save-token then claims the structured remainder. Redundant, non-destructive.

Verified interactions, no action required (both are host behavior, not plugin logic):
- **Dedupe is inert on spill-touched results.** Native spill embeds a unique per-call file path inside the result content, so byte-exact fingerprints can never match: the two `listTools` results differed **only** at char 49,914 (the spill path). Dedupe still fires for results below spill's 12,500-token bound (item 4). Net: L5 is partial-coverage on 0.1.7-rc.2.
- **`bash` results were neither compressed nor deduped** across two identical 4.0 KB trials (both arrived raw, no stub), while every `cordis_inspect_query`/`list` result was claimed. Most likely the `:247` early-return for a `value`-carrying decision or a non-text content shape at `:264` — **inferred, not pinned**. No regression: that gate is unchanged upstream logic.

---

## 12. Execution plan (writing-plans output; executes §11)

Why a durable plan: edits span compat (peers), security (POST guard), and
distribution (profile install) surfaces. Saved into this owner doc — repo
authority override of the default `docs/aegis/plans/` path; spec + plan +
acceptance stay in one place, no sibling file.

- Basis: §11 (user-approved incl. both decisions). Requirement Ready Check: **ready** — source/scope/acceptance all pinned by §11.2/§11.4; no open blockers.
- Change Necessity: docs/config alone insufficient — the `SpillSource` union and profile module resolution break the mount at runtime, and no host trust fence exists for prefix routes, so the CSRF fix must live in the handler. Minimum code boundary: 2 surgical `src/index.js` edits; zero logic change.
- Ripple Signal Triage: fires (contract, security, distribution). Canonical owner: plugin host half (`src/index.js`). Consumers: profile composition (all sessions) and the plugin's own GUI — same-origin fetch sends `sec-fetch-site: same-origin` (passes guard); bare curl sends neither header (passes). No producer/consumer split.
- TDD Route: mode **off** → decision **skipped** (no explicit TDD request; approved plan is not strict authority). Posture: existing 5 `node:test` suites stay green (regression) + live acceptance battery §11.4, where the curl CSRF probes are the guard's runnable check.
- Plan Pressure Test: all edits land in existing owner files, no new files/owners/artifacts; every task carries a command-level proof → proceed.
- Architecture: unchanged — cordis bundle row, host factory `exports["."]`, client entry `exports["./client"]`, esbuild → `lib/`. Tech stack: node ≥18 ESM, cordis 4.0.4, esbuild, node:test.
- Baseline refs: §11.1 seam table; installed types under `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*/lib/types/`.
- Compatibility boundary: peers gate activation to `>=0.1.7-rc.1 <0.2.0`; behavior byte-identical except the guard. Rollback: `plugin_manager remove_bundle dsh-plugin-save-token` + `git checkout` (clean upstream clone baseline).

### Tasks (strictly sequential)

- **T1** `package.json` — version `2.4.2`; add `peerDependencies` `{"@deepseek-ai/dsh": ">=0.1.7-rc.1 <0.2.0", "@deepseek-ai/dsh-tools": ">=0.1.7-rc.1 <0.2.0"}`; `devDependencies` += `"@deepseek-ai/dsh-tools"` same range; `dsh.client` → `{"inject": ["@deepseek-ai/dsh-client-locale"], "platform": "web", "immediately": true}`. Prove: `node -e` JSON.parse + field echo.
- **T2** `src/index.js:234` — `source: { kind: 'tool', toolName: toolName, callId: callId, label: 'result' }` (§11.1 Δ1). Prove: grep + `node --check`.
- **T3** `src/index.js` POST branch (line ~511, before body read) — same-origin guard (§11.1 Δ5): 403 when `sec-fetch-site` present and not `same-origin`/`none`; else 403 when `Origin`/`Referer` URL host ≠ `Host` header (malformed → 403). GET dashboard untouched. Prove: grep + `node --check`.
- **T1–T3 DONE (verified)** — field echo: version 2.4.2, both peers, devDep, `inject:["@deepseek-ai/dsh-client-locale"]`+`immediately:true`; markers `src/index.js:234` (`kind: 'tool', toolName…`) and `:513`/`:519` (guard + 403); `node --check` clean on both files.
- **T4 DONE (deviation)** — preflight `npm view "@deepseek-ai/dsh-tools@>=0.1.7-rc.1 <0.2.0" version` returned `0.1.7-rc.1` + `0.1.7-rc.2`; plain `npm install` then materialized `dsh-tools@0.1.7-rc.2` and 284 `@deepseek-ai/*` packages. The plan's `--legacy-peer-deps` recipe was **refuted by evidence** (open peer graph → mount-time `ERR_MODULE_NOT_FOUND`) and replaced per §11.2.
- **T5 DONE** — `node --test`: **151 pass / 0 fail** across the 5 suites.
- **T6 DONE (verified)** — `node build.mjs`: `lib/index.js` 44690 B + `lib/client.js` 24667 B, face-check note gone; markers present (`kind: "tool"` esbuild form + `sec-fetch-site`); closure proof `import("./lib/index.js")` → `{apply:function, inject:["tools","webServer"]}`.
- **T7** install — `plugin_manager install_bundle target=/workspace/dsh-plugins/dsh-plugin-save-token`. Prove: result `applied`, no compat warnings (§11.4.1).
- **T8** acceptance battery — §11.4 items 2–7 in order. Contingency: if the host row is not live in the running process (replaced-package restart rule), run the config/inspect/curl items, record GUI + live-compression items as restart-pending, and report exactly that.

Retirement: nothing retired; dead `readText` branch deliberately retained (§11.2 non-goal). Guard is the only new branch — no fallbacks added.
Risks: npm prerelease resolution (T4 preflight covers); HMR-vs-restart activation (T8 contingency); guard false-positives — mitigated by header analysis above.
Execution route: **inline** (sequential tasks, shared files; subagent fan-out pays nothing). Fallback: n/a. User confirmation required: **no** — install mechanics and both user decisions already approved in §11.

**Execution status: T1–T8 EXECUTED** against live 0.1.7-rc.2. One approved-recipe correction, forced by evidence: T4 uses plain `npm install` + the `@deepseek-ai/dsh` devDep (§11.2) — `--legacy-peer-deps` leaves the peer graph open and the plugin dies at mount. All acceptance results, including two newly measured host interactions, are recorded in §11.4. Only GUI mount (item 6) remains pending a page refresh.
