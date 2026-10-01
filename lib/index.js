// src/index.js
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/compress.js
/*!
 * dsh-plugin-save-token v2.4.5 — pure compression/format helpers (host half)
 *
 * Extracted from src/index.js so the whole compression brain is unit-testable
 * with `node --test test/` (no host imports, no I/O, no state). Every function
 * is deterministic: same inputs -> same outputs. The orchestration half
 * (src/index.js) owns all mutable state (counters, caches, spill) and calls
 * into this module.
 *
 * Design red lines kept verbatim from v2.1.x:
 * - lossless-first: uniform JSON arrays are re-encoded TOON-style with zero
 *   information loss; lossy elision only when lossless routes do not apply.
 * - never-worse: candidates must pass byte (keepRatioMax + absolute saving)
 *   AND token gates; otherwise the original text goes out untouched.
 */
var enc = new TextEncoder();
function utf8Bytes(s) {
  return enc.encode(s).length;
}
function estTokens(s) {
  if (!s) return 0;
  var cjk = 0, other = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 11904 && c <= 40959) cjk++;
    else if (c >= 55296 && c <= 57343) {
      cjk++;
      i++;
    } else other++;
  }
  return Math.ceil(other / 3.8 + cjk * 0.75);
}
function fnv1a(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}
function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function argsToString(args) {
  try {
    return typeof args === "string" ? args : JSON.stringify(args);
  } catch (e) {
    return String(args);
  }
}
function dedupeFingerprint(sessionId, toolName, argsString, content) {
  return JSON.stringify([sessionId === void 0 ? null : String(sessionId), toolName, fnv1a(argsString || ""), fnv1a(content)]);
}
function looksLikeScalarLiteral(s) {
  return /^(?:null|true|false|NaN|-?Infinity|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(s);
}
function exactJsonNumbers(text) {
  var tokens = /"(?:[^"\\]|\\[\s\S])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  var match;
  while ((match = tokens.exec(text)) !== null) {
    if (match[1] !== void 0 && match[1] !== String(Number(match[1]))) return false;
  }
  return true;
}
function csvCell(v) {
  if (v === null) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  var s = String(v);
  if (s === "" || s.trim() !== s || /[",\n\r\t]/.test(s) || looksLikeScalarLiteral(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function safeHeaderTok(k) {
  return typeof k === "string" && k !== "" && !/["',{}\[\]:.\s]/.test(k);
}
function uniformTabular(arr) {
  if (!Array.isArray(arr) || arr.length < 8) return null;
  for (var i = 0; i < arr.length; i++) {
    if (!isPlainObject(arr[i])) return null;
  }
  var keys = Object.keys(arr[0]);
  if (keys.length === 0 || keys.length > 24) return null;
  for (var r0 = 0; r0 < arr.length; r0++) {
    var ek = Object.keys(arr[r0]);
    if (ek.length !== keys.length) return null;
    for (var q = 0; q < keys.length; q++) {
      if (!Object.prototype.hasOwnProperty.call(arr[r0], keys[q])) return null;
    }
  }
  var groups = [];
  var width = 0;
  for (var ki = 0; ki < keys.length; ki++) {
    var k = keys[ki];
    var first = arr[0][k];
    if (Array.isArray(first)) return null;
    if (first === null || typeof first !== "object") {
      for (var r1 = 1; r1 < arr.length; r1++) {
        var v1 = arr[r1][k];
        if (v1 !== null && typeof v1 === "object") return null;
      }
      if (!safeHeaderTok(k)) return null;
      groups.push({ header: k, get: /* @__PURE__ */ (function(key) {
        return function(row) {
          return [row[key]];
        };
      })(k) });
      width++;
      continue;
    }
    var sub = Object.keys(first);
    if (sub.length === 0) return null;
    for (var r2 = 0; r2 < arr.length; r2++) {
      var v2 = arr[r2][k];
      if (!isPlainObject(v2)) return null;
      if (Object.keys(v2).length !== sub.length) return null;
      for (var sj = 0; sj < sub.length; sj++) {
        if (!Object.prototype.hasOwnProperty.call(v2, sub[sj])) return null;
        var sv = v2[sub[sj]];
        if (sv !== null && typeof sv === "object") return null;
      }
    }
    var headerOk = safeHeaderTok(k);
    for (var sj2 = 0; sj2 < sub.length; sj2++) {
      if (!safeHeaderTok(sub[sj2])) headerOk = false;
    }
    if (!headerOk) return null;
    groups.push({
      header: k + "{" + sub.join(",") + "}",
      get: /* @__PURE__ */ (function(key, subs) {
        return function(row) {
          return subs.map(function(s) {
            return row[key][s];
          });
        };
      })(k, sub)
    });
    width += sub.length;
  }
  if (width > 64) return null;
  return { groups, width };
}
function toonEncodeCols(arr, tab, nameArg) {
  var out = [];
  out.push(nameArg + "[" + arr.length + "]{" + tab.groups.map(function(g) {
    return g.header;
  }).join(",") + "}:");
  for (var i = 0; i < arr.length; i++) {
    var cells = [];
    for (var k = 0; k < tab.groups.length; k++) {
      var vals = tab.groups[k].get(arr[i]);
      for (var v = 0; v < vals.length; v++) cells.push(csvCell(vals[v]));
    }
    out.push(cells.join(","));
  }
  return out.join("\n");
}
function findDominantUniformArray(parsed, minLen) {
  minLen = minLen || 8;
  if (Array.isArray(parsed)) return { arr: parsed, name: "items", parent: null, key: null, isRoot: true, path: "items" };
  if (!isPlainObject(parsed)) return null;
  var best = null;
  function consider(arr, name2, parent, key, path) {
    if (arr.length >= minLen && (best === null || arr.length > best.arr.length)) {
      best = { arr, name: name2, parent, key, isRoot: false, path };
    }
  }
  for (var k in parsed) {
    var v = parsed[k];
    if (Array.isArray(v) && safeHeaderTok(k)) consider(v, k, parsed, k, k);
  }
  if (best === null) {
    for (var k2 in parsed) {
      var v2 = parsed[k2];
      if (isPlainObject(v2)) {
        for (var k3 in v2) {
          var v3 = v2[k3];
          if (Array.isArray(v3) && safeHeaderTok(k2) && safeHeaderTok(k3)) consider(v3, k3, v2, k3, k2 + "." + k3);
        }
      }
    }
  }
  return best;
}
function keyedMapRows(parsed) {
  if (!isPlainObject(parsed)) return null;
  var ks = Object.keys(parsed);
  if (ks.length < 8) return null;
  var rows = [];
  for (var i = 0; i < ks.length; i++) {
    var v = parsed[ks[i]];
    if (!isPlainObject(v)) return null;
    if (Object.prototype.hasOwnProperty.call(v, "key")) return null;
    var row = { key: ks[i], ...v };
    rows.push(row);
  }
  return rows;
}
var ERROR_LINE_RE = /(fatal|panic|traceback|exception|\berror\b|err:|fail(?:ed|ure|ing)?\b|denied|rejected|timeout|timed out|abort|cannot|unable to|syntax error|assertion|segfault)/i;
function collapseBlanksNums(lines, nums) {
  var out = [], ons = [], blanks = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      blanks++;
      if (blanks >= 2) continue;
    } else blanks = 0;
    out.push(lines[i]);
    ons.push(nums[i]);
  }
  return { lines: out, nums: ons };
}
function collapseRepeatsNums(lines, nums) {
  var out = [], ons = [], i = 0;
  while (i < lines.length) {
    var j = i;
    while (j < lines.length && lines[j] === lines[i]) j++;
    var run = j - i;
    if (run > 4 && lines[i].trim() !== "") {
      out.push(lines[i]);
      ons.push(nums[i]);
      out.push("[x" + run + " identical lines]");
      ons.push(0);
    } else {
      for (var k = i; k < j; k++) {
        out.push(lines[k]);
        ons.push(nums[k]);
      }
    }
    i = j;
  }
  return { lines: out, nums: ons };
}
function trimLongLines(lines, longLineChars) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.length > longLineChars) {
      var head = 260, tail = 100;
      l = l.slice(0, head) + " ...[+" + (l.length - head - tail) + " chars]... " + l.slice(l.length - tail);
    }
    out.push(l);
  }
  return out;
}
function delimiterProfile(l) {
  var pipes = 0, tabs = 0;
  for (var i = 0; i < l.length; i++) {
    var ch = l.charAt(i);
    if (ch === "|") pipes++;
    else if (ch === "	") tabs++;
  }
  return pipes > 0 ? "p" + pipes : tabs > 0 ? "t" + tabs : "x";
}
function looksTabular(lines, cfg) {
  var dense = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") dense.push(lines[i]);
  }
  if (dense.length < cfg.tabularHeadRows + cfg.tabularTailRows) return false;
  var profiles = /* @__PURE__ */ new Map();
  for (var j = 0; j < dense.length; j++) {
    var p = delimiterProfile(dense[j]);
    profiles.set(p, (profiles.get(p) || 0) + 1);
  }
  var best = 0;
  var bestKey = "x0";
  profiles.forEach(function(v, k) {
    if (v > best) {
      best = v;
      bestKey = k;
    }
  });
  return bestKey.charAt(0) !== "x" && best >= dense.length * 0.7 && best >= 12;
}
function labelled(num, line) {
  return num > 0 ? "L" + num + ": " + line : line;
}
function windowLines(lines, cfg, nums) {
  if (lines.length <= cfg.maxLines) return { lines };
  var head = lines.slice(0, cfg.headLines);
  var tail = lines.slice(lines.length - cfg.tailLines);
  var omittedCount = lines.length - cfg.headLines - cfg.tailLines;
  var middle = lines.slice(cfg.headLines, lines.length - cfg.tailLines);
  var anchors = [];
  for (var i = 0; i < middle.length && anchors.length < 25; i++) {
    if (ERROR_LINE_RE.test(middle[i])) anchors.push(i);
  }
  var ranges = [];
  for (var a = 0; a < anchors.length; a++) {
    var lo = Math.max(0, anchors[a] - 1), hi = Math.min(middle.length - 1, anchors[a] + 1);
    var prev = ranges[ranges.length - 1];
    if (prev && lo <= prev.hi + 1) {
      if (hi > prev.hi) prev.hi = hi;
    } else ranges.push({ lo, hi });
  }
  var out = head.slice();
  out.push("[... +" + omittedCount + " lines omitted ...]");
  if (ranges.length > 0) {
    var rows = 0;
    for (var r = 0; r < ranges.length; r++) rows += ranges[r].hi - ranges[r].lo + 1;
    out.push("[save-token kept " + rows + " error-related lines (with +-1 context lines) from the omitted region:]");
    for (var rg = 0; rg < ranges.length; rg++) {
      for (var m = ranges[rg].lo; m <= ranges[rg].hi; m++) {
        out.push(labelled(nums ? nums[cfg.headLines + m] : cfg.headLines + m + 1, middle[m]));
      }
    }
  }
  out = out.concat(tail);
  return { lines: out };
}
function windowLinesStrided(lines, cfg, nums) {
  if (lines.length <= cfg.maxLines) return { lines };
  var headN = cfg.tabularHeadRows, tailN = cfg.tabularTailRows;
  var middle = lines.slice(headN, lines.length - tailN);
  var stride = Math.max(1, Math.ceil(middle.length / cfg.tabularStrideSamples));
  var out = lines.slice(0, headN);
  out.push("[... +" + middle.length + " data rows omitted; every " + stride + ". row sampled below WITH original line numbers so any range can be retrieved precisely ...]");
  for (var i = 0; i < middle.length; i += stride) {
    out.push(labelled(nums ? nums[headN + i] : headN + i + 1, middle[i]));
  }
  out = out.concat(lines.slice(lines.length - tailN));
  return { lines: out, strided: true };
}
function compressLinesText(text, cfg) {
  var src = text.split("\n");
  var collapsedBlanks = collapseBlanksNums(src, src.map(function(_l, i) {
    return i + 1;
  }));
  var collapsedRuns = collapseRepeatsNums(collapsedBlanks.lines, collapsedBlanks.nums);
  var lines = trimLongLines(collapsedRuns.lines, cfg.longLineChars);
  var nums = collapsedRuns.nums;
  if (looksTabular(lines, cfg)) {
    var t = windowLinesStrided(lines, cfg, nums);
    return { text: t.lines.join("\n"), strided: t.strided === true };
  }
  var w = windowLines(lines, cfg, nums);
  return { text: w.lines.join("\n"), strided: false };
}
function isProtectedKey(k) {
  return /error|message|stack|fail|fatal|exception|warn/i.test(String(k));
}
function newElisionStats() {
  return { omittedItems: 0, omittedKeys: 0, trimmedStrings: 0 };
}
function transformValue(v, depth, stats) {
  if (depth > 6) return "[deep]";
  if (Array.isArray(v)) {
    if (v.length > 10) {
      if (stats) stats.omittedItems += v.length - 5;
      var kept = [];
      for (var i = 0; i < 3; i++) kept.push(transformValue(v[i], depth + 1, stats));
      kept.push({ __omitted__: "+" + (v.length - 5) + " more items" });
      kept.push(transformValue(v[v.length - 2], depth + 1, stats));
      kept.push(transformValue(v[v.length - 1], depth + 1, stats));
      return kept;
    }
    return v.map(function(x) {
      return transformValue(x, depth + 1, stats);
    });
  }
  if (v && typeof v === "object") {
    var out = {}, keys = Object.keys(v), n = 0;
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      n++;
      if (n > 30) {
        if (stats) stats.omittedKeys += keys.length - 30;
        out.__omitted_keys__ = "+" + (keys.length - 30) + " more keys";
        break;
      }
      var val = v[k];
      if (typeof val === "string" && val.length > 400 && !isProtectedKey(k)) {
        if (stats) stats.trimmedStrings++;
        val = val.slice(0, 220) + " ...[+" + (val.length - 300) + " chars]... " + val.slice(val.length - 80);
      } else if (typeof val === "string" && isProtectedKey(k) && val.length > 2e3) {
        if (stats) stats.trimmedStrings++;
        val = val.slice(0, 1800) + " ...[+" + (val.length - 1800) + " chars truncated error detail]... ";
      } else if (val && typeof val === "object") {
        val = transformValue(val, depth + 1, stats);
      }
      out[k] = val;
    }
    return out;
  }
  return v;
}
function elisionText(parsed) {
  var stats = newElisionStats();
  try {
    var reb = JSON.stringify(transformValue(parsed, 0, stats));
    if (typeof reb !== "string" || reb.length < 20) return null;
    return { text: reb, stats };
  } catch (e) {
    return null;
  }
}
function jsonRoutes(text, cfg) {
  var t = text.trim();
  if (t.length > cfg.jsonMaxParseBytes) return [];
  if (t.charAt(0) !== "{" && t.charAt(0) !== "[") return [];
  var parsed;
  try {
    parsed = JSON.parse(t);
  } catch (e) {
    return [];
  }
  var elision = elisionText(parsed);
  var routes = [];
  var toon = null;
  var exactNumbers = exactJsonNumbers(t);
  var dom = exactNumbers ? findDominantUniformArray(parsed, 8) : null;
  if (dom !== null) {
    var tab = uniformTabular(dom.arr);
    if (tab !== null) {
      var parts = [];
      if (dom.isRoot) {
        parts.push(toonEncodeCols(dom.arr, tab, dom.name));
      } else {
        delete dom.parent[dom.key];
        var restJson = JSON.stringify(parsed);
        parts.push(restJson);
        parts.push(toonEncodeCols(dom.arr, tab, dom.path));
      }
      var enc2 = parts.filter(function(s) {
        return s.length > 0;
      }).join("\n");
      if (enc2.length >= 20) toon = { text: enc2, strategy: "toon-array" };
    }
  }
  if (toon === null && exactNumbers && isPlainObject(parsed)) {
    var rows = keyedMapRows(parsed);
    if (rows !== null) {
      var ktab = uniformTabular(rows);
      if (ktab !== null) {
        var kenc = toonEncodeCols(rows, ktab, "items");
        if (kenc.length >= 20) toon = { text: kenc, strategy: "toon-keyed" };
      }
    }
  }
  if (toon !== null) routes.push({ text: toon.text, lossless: true, strategy: toon.strategy });
  if (elision !== null) routes.push({ text: elision.text, lossless: false, strategy: "elision", stats: elision.stats });
  return routes;
}
function compressJsonlText(text, cfg) {
  var t = text.trim();
  if (!t || t.length > cfg.jsonMaxParseBytes) return null;
  if (t.charAt(0) !== "{") return null;
  var lines = t.split("\n");
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (ln === "") continue;
    var p;
    try {
      p = JSON.parse(ln);
    } catch (e) {
      return null;
    }
    if (!isPlainObject(p) || !exactJsonNumbers(ln)) return null;
    rows.push(p);
  }
  if (rows.length < (cfg.jsonlMinLines || 8)) return null;
  var tab = uniformTabular(rows);
  if (tab === null) return null;
  var out = toonEncodeCols(rows, tab, "items");
  if (out.length < 20) return null;
  return { text: out, lossless: true, strategy: "jsonl" };
}
function gate(route, text, cfg) {
  if (!route) return null;
  var candidate = route.text;
  if (!candidate || candidate.length < 20) return null;
  var before = utf8Bytes(text), after = utf8Bytes(candidate);
  if (after > before * cfg.keepRatioMax) return null;
  if (before - after < cfg.minSavingBytes) return null;
  if (estTokens(candidate) >= estTokens(text)) return null;
  return { text: candidate, before, after, lossless: route.lossless === true, strategy: route.strategy, stats: route.stats };
}
function buildCandidate(text, cfg) {
  var routes = jsonRoutes(text, cfg);
  var viaJsonl = compressJsonlText(text, cfg);
  if (viaJsonl !== null) routes.push(viaJsonl);
  for (var i = 0; i < routes.length; i++) {
    var g = gate(routes[i], text, cfg);
    if (g !== null) return g;
  }
  var lines = compressLinesText(text, cfg);
  return gate({ text: lines.text, lossless: false, strategy: lines.strided ? "lines-strided" : "lines" }, text, cfg);
}
function buildNotice(opts) {
  var head = opts.lossless ? " losslessly re-encoded" : " compressed";
  if (opts.lossless && opts.strategy === "toon-keyed") head += " keyed map (key column = original map key)";
  if (opts.lossless && opts.strategy === "jsonl") head += " JSONL (one object per original line)";
  var id = opts.id;
  if (!opts.verbose) {
    return opts.body + "\n\n[save-token #" + id + head + ": " + fmtInt(opts.before) + " -> " + fmtInt(opts.after) + ' bytes. expand: save_token_expand id="' + id + '" | full: ' + opts.locator + "]";
  }
  var pct = Math.round((1 - opts.after / opts.before) * 100);
  var shape = "";
  if (!opts.lossless && opts.stats) {
    var bits = [];
    if (opts.stats.omittedItems > 0) bits.push("+" + fmtInt(opts.stats.omittedItems) + " array items");
    if (opts.stats.omittedKeys > 0) bits.push("+" + fmtInt(opts.stats.omittedKeys) + " object keys");
    if (opts.stats.trimmedStrings > 0) bits.push(fmtInt(opts.stats.trimmedStrings) + " long strings trimmed");
    if (bits.length > 0) shape = " Omitted: " + bits.join(", ") + ".";
  }
  return opts.body + "\n\n[save-token #" + id + head + ": " + fmtInt(opts.before) + " -> " + fmtInt(opts.after) + " bytes (~" + pct + "% smaller)" + (opts.lossless ? ", zero information loss" : "") + "." + shape + ' Need any omitted detail? Call the save_token_expand tool with id "' + id + '", or read the FULL ORIGINAL at: ' + opts.locator + ". " + (opts.retrievalHint || "") + "]";
}

// src/index.js
/*!
 * dsh-plugin-save-token v2.4.5 — Host half (node)
 *
 * Standard Cordis plugin loaded from the bundle layer declared in
 * cordis.patch.yml (`dsh plugin --profile web add <pkg>`). Contract:
 *
 * - `inject = ['tools', 'webServer']` — the dsh-tools registry for the
 *   `save_token_expand` dynamic tool, and the web server surface for the
 *   package-private JSON API consumed by the client dashboard.
 * - `spillStore` is read lazily with ctx.get() and is optional at runtime:
 *   a missing spill store keeps compression permanently off (reversibility
 *   first).
 * - Waterfalls: `tools/post-execute` (prepend) and `llm/stream`. The
 *   compaction assist was REMOVED in v2.4.4: dsh mounts `compaction-basic`
 *   inside an isolated group (`isolate: { compaction: true }`) and cordis
 *   resolves an isolated service only inside its own scope, so a top-level
 *   plugin can never reach `ctx.compaction`. dsh's own engine still performs
 *   automatic pressure compaction; install a dedicated compaction plugin if
 *   you need a different policy.
 *
 * v2.2.0 changes (all pure-compression logic moved to ./compress.js for unit
 * testing; behavior fixes marked):
 * - dedupe keys carry the owning session id (cross-session stubs were false)
 *   and hash the FULL args/content strings (prefix truncation could claim
 *   byte-identity for different outputs);
 * - `save_token_expand` output is exempt from both arms: re-compressing an
 *   expand result handed the model the same elided preview it just paid a
 *   turn to unfold;
 * - lossless counters increment on ADOPTED candidates (previously counted
 *   attempts the never-worse gates later rejected);
 * - the compression trigger floor also respects the saving/keepRatio
 *   arithmetic (outputs that cannot save minSavingBytes at keepRatioMax are
 *   skipped without building a candidate);
 * - the first `noticeFullTrailerCount` notices are verbose; later ones use a
 *   compact trailer with the same id/locator (fewer replayed tokens, both
 *   recovery channels intact);
 * - lossless TOON routes extended: nested field groups, keyed maps, deep
 *   dominant-array search, JSONL/NDJSON, and a lossless-vs-lossy price
 *   comparison; lossy notices disclose what was elided.
 *
 * v2.3.0 changes (cache-aware layer; bench evidence: 88.9% of input tokens
 * ride the provider prompt cache, billed at ~1/30 of the miss price):
 * - cacheRead/cacheWrite are metered separately and surfaced as a cache-hit
 *   sentinel KPI (any change that tanks it is saving tokens while raising
 *   real cost);
 * - per-model online calibration (EMA of billed/estimated tokens) corrects
 *   the avoided-token accounting without bundling a tokenizer.
 *
 * v2.4.0 changes:
 * - dedupe TTL default raised 90s -> 600s (adoption literally compares the
 *   retained full args + content, so an identical replay carries no new
 *   information; the stub already tells the model to re-run when freshness
 *   matters) with
 *   per-tool overrides (`dedupeTtlOverrides`, 0 disables dedupe for a tool);
 * - error-line protection in plain-text windows widened to ±1 context line;
 * - `save_token_expand` survives restarts/eviction via a persistent
 *   id->locator index: on a miss it hands back the spill locator (and tries
 *   a spillStore readText API when one exists) instead of a dead end;
 * - top-level vs nested tool calls are counted (dashboard) to measure the
 *   unexploited subagent surface before the nesting exemption is ever
 *   touched.
 */
var name = "save-token";
var inject = ["tools", "webServer"];
function apply(ctx, config) {
  var cfg = {
    compressEnabled: true,
    dedupeEnabled: true,
    minBytes: 1400,
    errorMinBytes: 6e3,
    minSavingBytes: 500,
    keepRatioMax: 0.72,
    maxLines: 240,
    headLines: 140,
    tailLines: 80,
    tabularHeadRows: 60,
    tabularTailRows: 40,
    tabularStrideSamples: 50,
    longLineChars: 420,
    jsonMaxParseBytes: 524288,
    jsonlMinLines: 8,
    noticeFullTrailerCount: 3,
    dedupeTtlMs: 6e5,
    dedupeTtlOverrides: {}
  };
  if (config && typeof config === "object") {
    for (var ck in cfg) {
      if (Object.prototype.hasOwnProperty.call(config, ck) && config[ck] !== void 0) cfg[ck] = config[ck];
    }
  }
  var PERSIST_KEYS = ["compressEnabled", "dedupeEnabled"];
  var statePath = null;
  try {
    statePath = join(dshHomePath("plugin-state"), "save-token-state.json");
  } catch (e) {
    console.error("save-token: dshHomePath unavailable, config persistence disabled", e);
  }
  function loadState() {
    if (statePath === null) return;
    try {
      var saved = JSON.parse(readFileSync(statePath, "utf8")).config;
      if (!saved || typeof saved !== "object") return;
      for (var i = 0; i < PERSIST_KEYS.length; i++) {
        if (typeof saved[PERSIST_KEYS[i]] === "boolean") cfg[PERSIST_KEYS[i]] = saved[PERSIST_KEYS[i]];
      }
    } catch (e) {
    }
  }
  function persistState() {
    if (statePath === null) return;
    try {
      var out = { version: 1, config: {} };
      for (var i = 0; i < PERSIST_KEYS.length; i++) out.config[PERSIST_KEYS[i]] = !!cfg[PERSIST_KEYS[i]];
      mkdirSync(dirname(statePath), { recursive: true });
      var tmp = statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(out), "utf8");
      renameSync(tmp, statePath);
    } catch (e) {
      console.error("save-token: config persist failed", e);
    }
  }
  loadState();
  var locatorStatePath = null;
  try {
    locatorStatePath = join(dshHomePath("plugin-state"), "save-token-locators.json");
  } catch (e) {
    console.error("save-token: dshHomePath unavailable, locator persistence disabled", e);
  }
  var LOCATOR_MAX_BYTES = 4194304;
  var LOCATOR_MAX_ENTRY_BYTES = 4096;
  function validLocator(id, entry) {
    return /^[a-z0-9]{1,64}$/.test(id) && entry && !Array.isArray(entry) && typeof entry.locator === "string" && entry.locator.length > 0 && utf8Bytes(entry.locator) <= LOCATOR_MAX_ENTRY_BYTES && Number.isSafeInteger(entry.ts) && entry.ts >= 0;
  }
  function rememberLocator(id, entry) {
    if (!validLocator(id, entry)) return false;
    var old = locatorIndex.get(id);
    if (old) locatorRetainedBytes -= utf8Bytes(JSON.stringify({ [id]: old }));
    var value = { locator: entry.locator, ts: entry.ts };
    locatorIndex.set(id, value);
    locatorRetainedBytes += utf8Bytes(JSON.stringify({ [id]: value }));
    var target = locatorIndex.size > 4e3 ? 3200 : 4e3;
    while (locatorIndex.size > target || locatorRetainedBytes > LOCATOR_MAX_BYTES - 32) {
      var first = locatorIndex.keys().next().value;
      locatorRetainedBytes -= utf8Bytes(JSON.stringify({ [first]: locatorIndex.get(first) }));
      locatorIndex.delete(first);
    }
    return locatorIndex.has(id);
  }
  function loadLocatorState() {
    if (locatorStatePath === null) return;
    var fd;
    try {
      fd = openSync(locatorStatePath, "r");
      var size = fstatSync(fd).size;
      if (size > LOCATOR_MAX_BYTES) return;
      var buffer = Buffer.alloc(size + 1), used = 0, n;
      while (used < buffer.length && (n = readSync(fd, buffer, used, buffer.length - used, null)) > 0) used += n;
      if (used > size) return;
      var saved = JSON.parse(buffer.subarray(0, used).toString("utf8"));
      var entries = saved && saved.version === 1 ? saved.entries : null;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
      Object.entries(entries).filter(function(pair) {
        return validLocator(pair[0], pair[1]);
      }).sort(function(a, b) {
        return a[1].ts - b[1].ts;
      }).slice(-4e3).forEach(function(pair) {
        rememberLocator(pair[0], pair[1]);
      });
    } catch (e) {
    } finally {
      if (fd !== void 0) closeSync(fd);
    }
  }
  function persistLocators() {
    if (locatorStatePath === null) return;
    try {
      var out = { version: 1, entries: Object.fromEntries(locatorIndex) };
      mkdirSync(dirname(locatorStatePath), { recursive: true });
      var tmp = locatorStatePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(out), "utf8");
      renameSync(tmp, locatorStatePath);
    } catch (e) {
      console.error("save-token: locator persist failed", e);
    }
  }
  var startedAt = Date.now();
  var totals = { requests: 0, auxRequests: 0, inputTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, avoidedTokens: 0, estPromptTokens: 0 };
  var comp = { count: 0, bytesBefore: 0, bytesAfter: 0, dedupeHits: 0, dedupeSavedBytes: 0, replays: 0, losslessEncodes: 0, tabularWindows: 0, topLevelCalls: 0, nestedCalls: 0 };
  var records = [];
  var recent = [];
  var byTool = /* @__PURE__ */ new Map();
  var compressedIndex = /* @__PURE__ */ new Map();
  var dedupeCache = /* @__PURE__ */ new Map();
  var originals = /* @__PURE__ */ new Map();
  var locatorIndex = /* @__PURE__ */ new Map();
  var locatorRetainedBytes = 0;
  var calibration = /* @__PURE__ */ new Map();
  var spillAvailable = null;
  var lastSkip = "";
  loadLocatorState();
  function ratioFor(model) {
    var ent = calibration.get(model || "");
    return ent ? ent.ratio : 1;
  }
  function observeRatio(model, actual, est) {
    if (!(actual >= 500) || !(est >= 500)) return;
    var key = model || "";
    var ent = calibration.get(key);
    var r = actual / est;
    if (ent) {
      ent.ratio = ent.ratio * 0.8 + r * 0.2;
      ent.samples = Math.min(50, ent.samples + 1);
    } else {
      ent = { ratio: r, samples: 1 };
    }
    calibration.delete(key);
    calibration.set(key, ent);
    if (calibration.size > 32) {
      var oldest = calibration.keys().next();
      if (!oldest.done) calibration.delete(oldest.value);
    }
  }
  function noteRecent(kind, label, detail, savedTokens) {
    recent.unshift({ ts: Date.now(), kind, label: String(label || ""), detail: String(detail || ""), saved: savedTokens || 0 });
    if (recent.length > 60) recent.length = 60;
  }
  function shortId(prefix) {
    for (; ; ) {
      var id = prefix + randomUUID().replace(/-/g, "");
      if (!originals.has(id) && !locatorIndex.has(id) && !compressedIndex.has(id)) return id;
    }
  }
  function flattenPlainText(content) {
    var text = "";
    if (!Array.isArray(content)) return void 0;
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (!b || b.type !== "text" || typeof b.text !== "string") return void 0;
      text += b.text;
    }
    return text;
  }
  function ownerSessionId(exec) {
    try {
      return exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.id : void 0;
    } catch (e) {
      return void 0;
    }
  }
  function rememberOriginal(id, text, locator) {
    if (!rememberLocator(id, { locator, ts: Date.now() })) return;
    var truncated = text.length > 262144;
    originals.set(id, { text: truncated ? text.slice(0, 262144) : text, locator, truncated, ts: Date.now() });
    persistLocators();
    if (originals.size > 160) {
      var it = originals.keys();
      while (originals.size > 120) {
        var nx = it.next();
        if (nx.done) break;
        originals.delete(nx.value);
      }
    }
  }
  function rememberCompressed(id, origText, replacedText, toolName) {
    var origTok = estTokens(origText), keptTok = estTokens(replacedText);
    compressedIndex.set(id, { o: Math.max(origTok, 1), k: keptTok, ts: Date.now() });
    if (compressedIndex.size > 4e3) {
      var drop = compressedIndex.keys();
      while (compressedIndex.size > 3200) {
        var nx = drop.next();
        if (nx.done) break;
        compressedIndex.delete(nx.value);
      }
    }
    var e = byTool.get(toolName) || { count: 0, savedBytes: 0 };
    e.count++;
    e.savedBytes += utf8Bytes(origText) - utf8Bytes(replacedText);
    byTool.set(toolName, e);
  }
  var DEDUPE_MAX_ENTRY = 2097152;
  var DEDUPE_MAX_CHARS = 8388608;
  var dedupeRetainedChars = 0;
  function rememberDedupe(fp, ts, callId, args, content) {
    var old = dedupeCache.get(fp);
    if (old) dedupeRetainedChars -= old.args.length + old.content.length;
    if (args.length + content.length > DEDUPE_MAX_ENTRY) {
      dedupeCache.delete(fp);
      return;
    }
    dedupeCache.set(fp, { ts, callId, args, content });
    dedupeRetainedChars += args.length + content.length;
    while (dedupeCache.size > 800 || dedupeRetainedChars > DEDUPE_MAX_CHARS) {
      var itD = dedupeCache.keys(), nxD = itD.next();
      if (nxD.done) break;
      var eD = dedupeCache.get(nxD.value);
      dedupeCache.delete(nxD.value);
      dedupeRetainedChars -= eD.args.length + eD.content.length;
    }
  }
  async function spillOriginal(text, sessionId, toolName, callId) {
    var store = ctx.get("spillStore");
    spillAvailable = store !== void 0;
    if (store === void 0) {
      lastSkip = "no spillStore backend: reversibility guaranteed, so compression stays off";
      return void 0;
    }
    if (sessionId === void 0) {
      lastSkip = "no owning session";
      return void 0;
    }
    try {
      var ref = await store.saveText({
        owner: { sessionId },
        source: { kind: "tool", toolName, callId, label: "result" },
        suggestedName: toolName + ".txt",
        content: text
      });
      if (!ref || typeof ref.locator !== "string" || ref.locator.length === 0) {
        lastSkip = "spill ref had no locator";
        return void 0;
      }
      return ref;
    } catch (e) {
      lastSkip = "spill save failed: " + String(e);
      return void 0;
    }
  }
  ctx.on("tools/post-execute", async function(exec, result, next) {
    var decision = await next();
    if (!decision || decision.kind !== "accept") return decision;
    if (Object.prototype.hasOwnProperty.call(decision, "value")) return decision;
    if (exec.parent !== void 0) comp.nestedCalls++;
    else comp.topLevelCalls++;
    if (exec.parent !== void 0) return decision;
    if (exec.name === "read") return decision;
    if (exec.name === "save_token_expand") return decision;
    var content = decision.content !== void 0 ? decision.content : result.content;
    var text = flattenPlainText(content);
    if (text === void 0) return decision;
    var isError = result.isError === true;
    var sessionId = ownerSessionId(exec);
    if (cfg.dedupeEnabled && !isError) {
      var ttl = Object.prototype.hasOwnProperty.call(cfg.dedupeTtlOverrides, exec.name) ? cfg.dedupeTtlOverrides[exec.name] : cfg.dedupeTtlMs;
      if (ttl > 0) {
        var argsText = argsToString(exec.arguments);
        var fp = dedupeFingerprint(sessionId, exec.name, argsText, text);
        var prev = dedupeCache.get(fp);
        var now = Date.now();
        if (prev && now - prev.ts <= ttl && prev.args === argsText && prev.content === text) {
          var ref2 = await spillOriginal(text, sessionId, exec.name, exec.callId);
          if (ref2 !== void 0) {
            var did = shortId("d");
            var agoSec = Math.round((now - prev.ts) / 1e3);
            var stub = "[save-token #" + did + " deduped: this " + exec.name + " call returned BYTE-IDENTICAL output to a call " + agoSec + "s ago, which remains in context above. Do not answer from this stub alone; retrieve the earlier message, or re-run if freshness matters. Full copy of THIS call stored at: " + ref2.locator + ". " + (ref2.retrievalHint || "") + "]";
            var stubGate = gate({ text: stub }, text, cfg);
            if (stubGate !== null) {
              rememberOriginal(did, text, ref2.locator);
              comp.dedupeHits++;
              comp.dedupeSavedBytes += stubGate.before - stubGate.after;
              rememberCompressed(did, text, stub, exec.name);
              noteRecent("dedupe", exec.name, "identical output within " + agoSec + "s -> stubbed", estTokens(text) - estTokens(stub));
              return { kind: "accept", content: [{ type: "text", text: stub }] };
            }
          }
        }
        rememberDedupe(fp, now, exec.callId, argsText, text);
      }
    }
    if (!cfg.compressEnabled) return decision;
    var threshold = isError ? cfg.errorMinBytes : cfg.minBytes;
    if (utf8Bytes(text) <= threshold) return decision;
    var cand = buildCandidate(text, cfg);
    if (cand === null) return decision;
    var ref = await spillOriginal(text, sessionId, exec.name, exec.callId);
    if (ref === void 0) {
      noteRecent("skip", exec.name, lastSkip, 0);
      return decision;
    }
    var id = shortId("c");
    var verbose = comp.count < cfg.noticeFullTrailerCount;
    var notice = {
      body: cand.text,
      id,
      before: cand.before,
      after: cand.after,
      lossless: cand.lossless,
      strategy: cand.strategy,
      stats: cand.stats,
      locator: ref.locator,
      retrievalHint: ref.retrievalHint || "",
      verbose
    };
    var finalText = buildNotice(notice);
    var finalGate = gate({ text: finalText, lossless: cand.lossless, strategy: cand.strategy, stats: cand.stats }, text, cfg);
    if (finalGate === null) {
      finalText = buildNotice(Object.assign({}, notice, { retrievalHint: "", verbose: false }));
      finalGate = gate({ text: finalText, lossless: cand.lossless, strategy: cand.strategy, stats: cand.stats }, text, cfg);
    }
    if (finalGate === null) return decision;
    if (cand.lossless) comp.losslessEncodes++;
    if (cand.strategy === "lines-strided") comp.tabularWindows++;
    comp.count++;
    comp.bytesBefore += finalGate.before;
    comp.bytesAfter += finalGate.after;
    rememberOriginal(id, text, ref.locator);
    rememberCompressed(id, text, finalText, exec.name);
    noteRecent(cand.lossless ? "lossless" : "compress", exec.name, fmtInt(finalGate.before) + "B -> " + fmtInt(finalGate.after) + "B (-" + Math.round((1 - finalGate.after / finalGate.before) * 100) + "%)", estTokens(text) - estTokens(finalText));
    return { kind: "accept", content: [{ type: "text", text: finalText }] };
  }, { prepend: true });
  var MARKER_RE = /\[save-token #([a-z0-9]+) /g;
  function collectTexts(blocks, out, depth) {
    if (!Array.isArray(blocks)) return;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b !== "object") continue;
      if (typeof b.text === "string") out.push(b.text);
      else if (typeof b.arguments === "string") out.push(b.arguments);
      else if (Array.isArray(b.content) && depth < 3) collectTexts(b.content, out, depth + 1);
    }
  }
  function computeAvoided(messages) {
    var texts = [];
    collectTexts(messages, texts, 0);
    var avoided = 0, hits = 0;
    for (var i = 0; i < texts.length; i++) {
      MARKER_RE.lastIndex = 0;
      var m;
      while ((m = MARKER_RE.exec(texts[i])) !== null) {
        var ent = compressedIndex.get(m[1]);
        if (ent) {
          avoided += Math.max(0, ent.o - ent.k);
          hits++;
        }
      }
    }
    return { avoided, hits };
  }
  ctx.on("llm/stream", function(options, next) {
    var rec = {
      ts: Date.now(),
      kind: options.purpose ? "aux" : "request",
      provider: String(options.provider || ""),
      model: String(options.model || ""),
      estPrompt: 0,
      input: 0,
      cached: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      avoided: 0,
      replayHits: 0,
      closed: false
    };
    try {
      var texts = [];
      if (typeof options.system === "string") texts.push(options.system);
      collectTexts(options.messages, texts, 0);
      for (var i = 0; i < texts.length; i++) rec.estPrompt += estTokens(texts[i]);
      if (Array.isArray(options.tools) && options.tools.length > 0) {
        try {
          rec.estPrompt += estTokens(JSON.stringify(options.tools).slice(0, 2e5));
        } catch (e) {
        }
      }
      var av = computeAvoided(options.messages);
      rec.avoided = av.avoided;
      rec.replayHits = av.hits;
    } catch (e) {
      console.error("save-token: measure failed", e);
    }
    function observe(chunk) {
      if (chunk && chunk.type === "usage" && chunk.usage) {
        rec.input += chunk.usage.inputTokens || 0;
        var cr = chunk.usage.cacheReadTokens || 0;
        var cw = chunk.usage.cacheWriteTokens || 0;
        rec.cacheRead += cr;
        rec.cacheWrite += cw;
        rec.cached += cr + cw;
        rec.output += chunk.usage.outputTokens || 0;
        rec.reasoning += chunk.usage.reasoningTokens || 0;
      }
    }
    function closeRecord() {
      if (rec.closed) return;
      rec.closed = true;
      observeRatio(rec.model, rec.input + rec.cached, rec.estPrompt);
      var ratio = ratioFor(rec.model);
      if (rec.kind === "aux") totals.auxRequests++;
      else totals.requests++;
      totals.inputTokens += rec.input;
      totals.cachedTokens += rec.cached;
      totals.cacheReadTokens += rec.cacheRead;
      totals.cacheWriteTokens += rec.cacheWrite;
      totals.outputTokens += rec.output;
      totals.reasoningTokens += rec.reasoning;
      rec.avoidedCal = Math.round(rec.avoided * ratio);
      totals.avoidedTokens += rec.avoidedCal;
      totals.estPromptTokens += rec.estPrompt;
      comp.replays += rec.replayHits;
      records.push(rec);
      if (records.length > 480) records.splice(0, records.length - 400);
      noteRecent(
        rec.kind === "aux" ? "aux" : "request",
        rec.model || rec.provider || "?",
        "prompt~" + fmtInt(rec.estPrompt) + " tok, out " + fmtInt(rec.output) + ", avoided ~" + fmtInt(rec.avoidedCal) + (rec.replayHits ? " (" + rec.replayHits + " replayed)" : ""),
        rec.avoidedCal
      );
    }
    var inner = next();
    async function* tracked() {
      try {
        for await (var chunk of inner) {
          observe(chunk);
          yield chunk;
        }
      } finally {
        closeRecord();
      }
    }
    return tracked();
  });
  ctx.tools.register(defineTool({
    name: "save_token_expand",
    description: "Retrieve the FULL ORIGINAL text behind a compressed [save-token #id] tool-output notice. Use it whenever an omitted region might contain a detail you need, instead of guessing from the preview.",
    parameters: {
      id: { type: "string", required: true, description: 'The short marker id from the notice, e.g. "c1or".' }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: function(args, value) {
        if (value && typeof value.text === "string" && value.text.length > 0) {
          var out = value.text;
          if (value.truncated === true) {
            out += "\n\n[save-token: expansion truncated at the in-memory cap of 262144 chars. FULL ORIGINAL at: " + String(value.locator || "") + ". Use the read tool on that path.]";
          }
          return [{ type: "text", text: out }];
        }
        return [{ type: "text", text: String(value && value.error || "not found") }];
      }
    },
    execute: function(args) {
      var key = args && typeof args.id === "string" ? args.id.trim() : "";
      var ent = originals.get(key);
      if (ent) return Promise.resolve({ text: ent.text, locator: ent.locator, truncated: ent.truncated === true });
      var loc = locatorIndex.get(key);
      function locatorFallback() {
        return { error: "expired id. The FULL ORIGINAL is still stored at: " + loc.locator + ". Use the read tool on that path.", locator: loc.locator };
      }
      if (loc) {
        var store = ctx.get("spillStore");
        if (store && typeof store.readText === "function") {
          return Promise.resolve().then(function() {
            return store.readText({ locator: loc.locator });
          }).then(function(out) {
            var t = out && (typeof out.text === "string" && out.text.length > 0 ? out.text : typeof out === "string" && out.length > 0 ? out : null);
            if (t) return { text: t, locator: loc.locator, truncated: false };
            return locatorFallback();
          }, function() {
            return locatorFallback();
          });
        }
        return Promise.resolve(locatorFallback());
      }
      return Promise.resolve({ error: "unknown or expired id. Find the FULL ORIGINAL path printed inside the original [save-token #...] notice and use the read tool on that path." });
    }
  }));
  ctx.effect(
    () => {
      const handler = async (req, res) => {
        try {
          const path = String(req.url ?? "").split("?")[0].replace(/\/+$/, "");
          const action = path.endsWith("/api/dashboard") ? "dashboard" : path.endsWith("/api/set-enabled") ? "set-enabled" : path.endsWith("/api/reset") ? "reset" : "";
          if (req.method === "GET" && action === "dashboard") {
            sendJson(res, 200, dashboardPayload());
            return;
          }
          if (req.method === "POST" && (action === "set-enabled" || action === "reset")) {
            const fetchSite = req.headers["sec-fetch-site"];
            let sameOrigin = fetchSite === void 0 || fetchSite === "same-origin" || fetchSite === "none";
            const originHeader = req.headers["origin"] || req.headers["referer"];
            if (sameOrigin && originHeader) {
              try {
                sameOrigin = new URL(String(originHeader)).host === req.headers["host"];
              } catch (e) {
                sameOrigin = false;
              }
            }
            if (!sameOrigin) {
              sendJson(res, 403, { ok: false, error: "cross-origin POST rejected" });
              return;
            }
            let args = {};
            try {
              const chunks = [];
              let len = 0;
              for await (const c of req) {
                len += c.length;
                if (len > 1 << 20) throw new Error("body too large");
                chunks.push(c);
              }
              const raw = Buffer.concat(chunks).toString("utf8");
              if (raw.trim() !== "") args = JSON.parse(raw);
              if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("body must be an object");
            } catch (e) {
              sendJson(res, 400, { ok: false, error: "invalid JSON body" });
              return;
            }
            if (action === "set-enabled") {
              const out = setEnabled(args);
              if (!out.ok) {
                sendJson(res, 400, out);
                return;
              }
              sendJson(res, 200, out);
              return;
            }
            sendJson(res, 200, resetAll());
            return;
          }
          sendJson(res, 404, { ok: false, error: "unknown save-token endpoint" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      };
      return ctx.webServer.register({ kind: "prefix", path: "/save-token", handler });
    },
    "save-token: dashboard API routes"
  );
  function sendJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  }
  function dashboardPayload() {
    var series = records.slice(-60).map(function(r) {
      return { p: r.input + r.cached || r.estPrompt, a: r.avoidedCal, aux: r.kind === "aux" };
    });
    var tools = [];
    byTool.forEach(function(v, k) {
      tools.push({ name: k, count: v.count, savedBytes: v.savedBytes });
    });
    tools.sort(function(a, b) {
      return b.savedBytes - a.savedBytes;
    });
    var billedInput = totals.inputTokens + totals.cachedTokens;
    var ratioSum = 0, ratioSamples = 0;
    calibration.forEach(function(e) {
      ratioSum += e.ratio * e.samples;
      ratioSamples += e.samples;
    });
    return {
      uptimeSec: Math.round((Date.now() - startedAt) / 1e3),
      flags: { compress: cfg.compressEnabled, dedupe: cfg.dedupeEnabled, expandTool: true },
      spillReady: spillAvailable,
      lastSkip,
      totals,
      reliefPct: billedInput + totals.avoidedTokens > 0 ? Math.round(totals.avoidedTokens * 100 / (billedInput + totals.avoidedTokens)) : 0,
      // cache-health sentinel: most input rides provider prompt cache (bench:
      // 88.9% cache-read at 1/30 price), so any change that tanks this number
      // is saving tokens while silently raising real cost
      cacheHitPct: billedInput > 0 ? Math.round(totals.cacheReadTokens * 100 / billedInput) : 0,
      estRatio: ratioSamples > 0 ? Math.round(ratioSum / ratioSamples * 100) / 100 : null,
      compression: comp,
      byTool: tools.slice(0, 8),
      series,
      recent: recent.slice(0, 18)
    };
  }
  function setEnabled(args) {
    var a = args || {};
    var known = a.key === "compress" || a.key === "dedupe";
    if (!known || typeof a.value !== "boolean") return { ok: false };
    if (a.key === "compress") cfg.compressEnabled = a.value;
    else cfg.dedupeEnabled = a.value;
    persistState();
    noteRecent("config", a.key, a.value ? "enabled" : "disabled", 0);
    return { ok: true, flags: { compress: cfg.compressEnabled, dedupe: cfg.dedupeEnabled, expandTool: true } };
  }
  function resetAll() {
    totals.requests = 0;
    totals.auxRequests = 0;
    totals.inputTokens = 0;
    totals.cachedTokens = 0;
    totals.cacheReadTokens = 0;
    totals.cacheWriteTokens = 0;
    totals.outputTokens = 0;
    totals.reasoningTokens = 0;
    totals.avoidedTokens = 0;
    totals.estPromptTokens = 0;
    comp.count = 0;
    comp.bytesBefore = 0;
    comp.bytesAfter = 0;
    comp.dedupeHits = 0;
    comp.dedupeSavedBytes = 0;
    comp.replays = 0;
    comp.losslessEncodes = 0;
    comp.tabularWindows = 0;
    comp.topLevelCalls = 0;
    comp.nestedCalls = 0;
    records.length = 0;
    recent.length = 0;
    byTool.clear();
    compressedIndex.clear();
    dedupeCache.clear();
    dedupeRetainedChars = 0;
    originals.clear();
    startedAt = Date.now();
    return { ok: true };
  }
  console.log("save-token v2.4.5 loaded: structure-aware compress + lossless tabular encode + expand tool");
}
export {
  apply,
  inject,
  name
};
