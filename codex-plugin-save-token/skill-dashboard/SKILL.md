---
name: save-token-dashboard
description: |
  在对话里内联展示 save-token 插件的 token 节省统计。当用户问"省了多少 token /
  save-token 统计 / token 用量 / 节省报告 / dashboard"，或想看压缩效果、去重效果时使用。
  数据源是落盘的 stats.jsonl 事件流，产出 Codex 内联可视化（visualize 引用）。
---

# save-token dashboard

把 save-token 的节省统计渲染成对话内联 dashboard。数据永远以 stats.jsonl 为准，
不要凭记忆报数。

## 1. 读数据

stats 文件位置（依次尝试）：

1. `$CODEX_HOME/save-token/stats.jsonl`（通常即 `~/.codex/save-token/stats.jsonl`）
2. 问用户，或检查 `~/.codex/save-token/spill/stats.jsonl`

每行一个 JSON 事件：

```json
{"ts":1767000000000,"kind":"compress","tool":"run","label":"run: npm test","strategy":"toon-array","lossless":true,"before":87822,"after":2064,"estBefore":23112,"estAfter":544}
```

- `kind`: `compress`（结构感知压缩）或 `dedupe`（字节相同重跑出桩）
- `before/after` 字节数；`estBefore/estAfter` 估算 token 数
- 小事件多属正常：阈值（默认 1400B）以下的输出本来就原样放行

## 2. 生成 HTML fragment

遵守 Codex 内联可视化契约：

- 只写 **fragment**：不要 `<!doctype>`、`<html>`、`<head>`、`<body>`
- 写到可写的持久目录（线程级可视化目录优先，否则 scratch 目录），文件名小写连字符，如 `save-token-savings.html`
- 根元素用唯一 id，脚本用 `document.getElementById` 取根；不使用 `fetch`/XHR/WebSocket；如需 CDN 仅限 cdnjs.cloudflare.com / esm.sh / cdn.jsdelivr.net / unpkg.com
- 数据内联进 fragment；总量保持在 1MB 以下（stats 很小，无压力）
- 深浅色适配：`@media (prefers-color-scheme: dark)` 或用系统字体与中性色

建议内容（有数据才画，空段落省略）：

1. 顶部三个大数字：累计节省 token（estBefore-estAfter 之和）、压缩次数 + 去重次数、字节节省
2. 按天柱状图（纯 CSS/flex 即可，无需图表库）：每天 savedTokens
3. 按工具（run/read）两行横条：次数与节省占比
4. 最近 8 条事件明细表：时间、类型、label（截断 40 字符）、before → after、无损/有损标记
5. `lossless: false` 的事件用小标记提示"有损（省略细节可 expand）"

## 3. 引用

在最终回复**单独一行**输出引用（桌面端/IDE 会内联渲染为交互组件）：

```text
visualize{"path":"<absolute-path>/save-token-savings.html"}
```

- 同时给一句不超过两句话的文字结论（例如"累计节省 ~22.6k tokens（98%）"），不要用 markdown 表格复述数据
- 如果界面没有渲染（纯终端 TUI 只会显示那行引用文本），改为直接输出简洁的 markdown 汇总表并说明当前界面不支持内联可视化
- 没有任何事件时直接告诉用户"还没有压缩记录"并简述触发条件（跑一个大输出命令）
