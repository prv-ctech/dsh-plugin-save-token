# codex-plugin-save-token

只降 token、不降智 —— **Codex CLI 插件**：结构感知压缩 + TOON 式无损编码优先 + 可逆落盘 + `save_token_expand` 取回全文。

移植自久经 A/B 实测的 [dsh-plugin-save-token](../)（DeepSeek Harness bundle 插件 v2.4.1）。压缩模块逐行一致；集成层是标准的 **MCP（Model Context Protocol）stdio server** —— Codex 官方扩展点，不 fork、不打补丁，走 `~/.codex/config.toml` 标准 registration。

> English: see [README.md](README.md)。

## 工作原理

Codex（不像 DSH 宿主）没有可以拦截每个内置工具结果的水瀑布，所以由**模型主动调用**这些工具来处理预期的大输出：

| 工具 | 用途 |
| --- | --- |
| `save_token_run` | 运行 shell 命令；超大输出被压缩，全文落盘 |
| `save_token_read` | 读取文件（头尾窗口）；全文落盘 |
| `save_token_expand` | 按 `[save-token #id]` 通知里的 id 取回完整原文 |

三条臂，全部继承自 dsh 插件：

1. **压缩臂** —— 路由顺序：无损 TOON 表格编码（均匀 JSON 数组、嵌套字段组、键值 map、JSONL）→ 有损结构裁剪（通知里披露裁掉了什么）→ 行窗口（头尾 + 错误行 ±1 保护 + 表格步进采样）。每个候选必须通过 **never-worse 双重闸门**（字节比例 + 绝对节省 + token 估算），否则原文原样放行。
2. **去重臂** —— 10 分钟内字节级完全相同的重跑返回一个短桩，指向第一次的完整结果（指纹对全量字符串哈希，绝不误判"相同"）。
3. **取回臂** —— `save_token_expand` 优先从内存缓存返回全文；重启/驱逐后通过持久化 locator 从落盘文件恢复。**可逆红线：落盘失败就不压缩。**

压缩结果长这样：

```
items[400]{model,input,output}:
m0,0,0
m1,1,2
...

[save-token #c1or losslessly re-encoded: 48,210 -> 6,530 bytes (~86% smaller), zero information loss. ... or read the FULL ORIGINAL at: /Users/you/.codex/save-token/spill/20260905/xxx-run.txt.]
```

## 安装

```bash
cd codex-plugin-save-token
node scripts/install.mjs          # 在 ~/.codex/config.toml 注册 [mcp_servers.save-token]
node scripts/install.mjs --skill  # 可选：同时安装 agent 使用指南 skill
```

安装器幂等，改写前先备份 `config.toml`（`config.toml.bak.save-token.<时间戳>`），不依赖 codex CLI。等价的手工写法（或 `codex mcp add`）：

```toml
[mcp_servers.save-token]
type = "stdio"
command = "node"                 # 建议写 node 的绝对路径
args = ["/绝对路径/codex-plugin-save-token/src/index.js"]
```

验证：

```bash
codex mcp list                   # save-token ... enabled
npm test                         # 82 个测试：压缩大脑 + store + tools + MCP 协议
```

## 配置（全部走环境变量，config.toml 块保持静态）

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `SAVE_TOKEN_COMPRESS_ENABLED` | `1` | 压缩臂总开关 |
| `SAVE_TOKEN_DEDUPE_ENABLED` | `1` | 字节相同重跑出桩 |
| `SAVE_TOKEN_MIN_BYTES` | `1400` | 超过此大小才压缩 |
| `SAVE_TOKEN_ERROR_MIN_BYTES` | `6000` | 失败命令的更宽松阈值（报错保持详尽） |
| `SAVE_TOKEN_MIN_SAVING_BYTES` | `500` | never-worse：最小绝对节省 |
| `SAVE_TOKEN_KEEP_RATIO_MAX` | `0.72` | never-worse：最大保留比例 |
| `SAVE_TOKEN_DEDUPE_TTL_MS` | `600000` | 去重窗口（0 关闭） |
| `SAVE_TOKEN_MAX_LINES` / `HEAD_LINES` / `TAIL_LINES` | `240/140/80` | 行窗口 |
| `SAVE_TOKEN_RUN_TIMEOUT_SEC` | `120` | 命令默认超时（上限 600） |
| `SAVE_TOKEN_MAX_CAPTURE_BYTES` | `2097152` | 单流捕获上限 |
| `SAVE_TOKEN_SPILL_DIR` | `$CODEX_HOME/save-token/spill` | 落盘根目录（回退 `~/.codex/...` → 系统临时目录） |

在 config.toml 块里用标准的 `[mcp_servers.save-token.env]` 表设置。

## 落盘与清理

完整原文存放在 `<落盘根目录>/<YYYYMMDD>/<id>-<tool>.txt` —— 普通文件，任何工具都能读，重启不丢。清理是节流且尽力而为的：超过 7 天的日期目录删除，总量上限约 800 个文件（先删最旧）。

## 已验证的 codex 版本

- 已用真实二进制在 codex **0.77.0** 与 **0.153.4** 上验证注册（`codex mcp list` → `enabled`；Rust MCP 客户端成功拉起 server 并完成 `initialize` + `tools/list`）。
- 协议层端到端由 82 个单测覆盖（initialize → tools/list → run → 压缩 → expand）。
- 版本提示：较新的 codex（约 0.15x 起）带 `ToolSearchAlwaysDeferMcpTools` 特性，`codex exec` 模式下 MCP 工具不直接出现在首轮工具清单里（改由 tool search 检索呈现）；0.77 一代与交互式 TUI 中 MCP 工具是直接投放的。
- 任何支持 MCP 的 codex（config.toml `[mcp_servers.*]`）都可用；server 为零依赖 Node ≥ 18。

## 与 dsh-plugin-save-token 的关系

| | dsh-plugin-save-token | codex-plugin-save-token |
| --- | --- | --- |
| 宿主 | DeepSeek Harness（Cordis 插件） | Codex CLI（MCP stdio server） |
| 拦截方式 | 水瀑布 `tools/post-execute`（自动） | 模型主动调用工具（opt-in） |
| 压缩大脑 | `src/compress.js` | 完全一致（逐行移植） |
| 落盘后端 | 宿主 `spillStore` 服务 | 内置 `src/store.js` |
| 面板 UI | Web GUI 面板 + JSON API | ——（仅 stderr 日志） |
| 压缩辅助 | 可选，默认关 | ——（不在 MCP 能力范围内） |

MIT —— 与父项目一致。
