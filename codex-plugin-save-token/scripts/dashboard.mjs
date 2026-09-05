#!/usr/bin/env node
/*!
 * codex-plugin-save-token — live savings dashboard
 *
 * A tiny zero-dependency local server that renders <spill-root>/stats.jsonl
 * as an auto-refreshing panel. Resident next to codex:
 *
 *   npm run dashboard                       # http://127.0.0.1:7788
 *   node scripts/dashboard.mjs --port 7800  # custom port
 *
 * Tip: `open -na "Google Chrome" --args --app=http://127.0.0.1:7788`
 * opens it as a frameless standalone window (a fake "sidebar" beside codex).
 */

import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aggregateStats, defaultStatsPath } from '../src/stats.js'

export function buildReport(file) {
  var events = []
  var damaged = 0
  try {
    for (var line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try { events.push(JSON.parse(line)) } catch (e) { damaged++ }
    }
  } catch (e) { /* no stats yet */ }
  var report = aggregateStats(events)
  report.recent = events.slice(-20)
  report.hasFile = fs.existsSync(file)
  report.damagedLines = damaged
  return report
}

var argv = process.argv.slice(2)
function argOf(flag, dflt) {
  var i = argv.indexOf(flag)
  return i >= 0 ? Number(argv[i + 1]) : dflt
}
var port = argOf('--port', 7788)
var statsFile = (function () {
  var i = argv.indexOf('--file')
  return i >= 0 ? argv[i + 1] : defaultStatsPath()
})()

var page = '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
  '<title>save-token 节省面板</title><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<style>' +
  ':root{color-scheme:light dark}' +
  'body{font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:0;padding:20px;background:#f6f7f9;color:#1f2937}' +
  '@media(prefers-color-scheme:dark){body{background:#111418;color:#e5e7eb}.card{border-color:#2a2f36!important}.muted{color:#9ca3af!important}}' +
  'h1{font-size:15px;margin:0 0 14px;display:flex;justify-content:space-between;align-items:baseline}' +
  '.muted{color:#6b7280;font-weight:400;font-size:12px}' +
  '.big{display:flex;gap:12px;margin-bottom:14px}' +
  '.card{flex:1;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px}' +
  '.num{font-size:26px;font-weight:700;color:#059669}' +
  '.num.plain{color:inherit}' +
  'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}' +
  '@media(prefers-color-scheme:dark){table,.card{background:#181c22}}' +
  'th,td{padding:5px 8px;text-align:left;border-bottom:1px solid #e5e7eb;font-size:12.5px}' +
  'th{color:#6b7280;font-weight:500}.lossy{color:#d97706}' +
  '.bars{display:flex;align-items:flex-end;gap:4px;height:70px;margin:10px 0 16px}' +
  '.bars div{flex:1;background:#059669;opacity:.75;border-radius:3px 3px 0 0;min-height:2px}' +
  '</style></head><body>' +
  '<h1>save-token 节省面板 <span class="muted" id="upd"></span></h1>' +
  '<div class="big">' +
  '<div class="card"><div class="num" id="tok">—</div>累计节省 tokens（估算）</div>' +
  '<div class="card"><div class="num plain" id="byt">—</div>累计节省字节</div>' +
  '<div class="card"><div class="num plain" id="cnt">—</div>压缩 + 去重次数</div>' +
  '</div>' +
  '<div class="muted" style="margin-bottom:2px">按天节省 tokens</div>' +
  '<div class="bars" id="days"></div>' +
  '<div class="muted" style="margin-bottom:2px">最近事件</div>' +
  '<table id="tbl"></table>' +
  '<script>' +
  'async function tick(){try{var r=await (await fetch("/stats")).json();' +
  'document.getElementById("tok").textContent="~"+fmt(r.totals.savedTokens);' +
  'document.getElementById("byt").textContent=fmt(r.totals.savedBytes)+" B";' +
  'document.getElementById("cnt").textContent=r.totals.compressions+" + "+r.totals.dedupes;' +
  'var mx=Math.max.apply(null,r.byDay.map(function(d){return d.savedTokens}).concat([1]));' +
  'document.getElementById("days").innerHTML=r.byDay.map(function(d){return "<div title=\\""+d.day+": ~"+fmt(d.savedTokens)+" tok\\" style=\\"height:"+Math.max(3,d.savedTokens*70/mx)+"px\\"></div>"}).join("");' +
  'document.getElementById("tbl").innerHTML="<tr><th>时间</th><th>类型</th><th>label</th><th>字节</th><th>模式</th></tr>"+' +
  'r.recent.slice().reverse().map(function(e){var d=new Date(e.ts);return "<tr><td>"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2)+" "+("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2)+"</td><td>"+e.kind+"</td><td>"+esc((e.label||"").slice(0,42))+"</td><td>"+fmt(e.before)+" → "+fmt(e.after)+"</td><td>"+(e.lossless?"lossless":"<span class=lossy>lossy</span>")+"</td></tr>"}).join("");' +
  'document.getElementById("upd").textContent="更新于 "+new Date().toLocaleTimeString();' +
  '}catch(e){}}' +
  'function fmt(n){return String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",")}' +
  'function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;")}' +
  'tick();setInterval(tick,3000);' +
  '</script></body></html>'

// server startup only when run directly — importing (tests) must be side-effect-free
var isMain = Boolean(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  http.createServer(function (req, res) {
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(buildReport(statsFile)))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  }).listen(port, '127.0.0.1', function () {
    console.log('save-token dashboard: http://127.0.0.1:' + port + '  (stats: ' + statsFile + ')')
    console.log('standalone window: open -na "Google Chrome" --args --app=http://127.0.0.1:' + port)
  })
}
