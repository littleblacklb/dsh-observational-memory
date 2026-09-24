# AGENTS.md

本仓库当前的工作状态、未决事项、固定命令与凭据约定，全部记录在 **[HANDOFF.md](./HANDOFF.md)** —— 开始任何工作前先读它。

要点：

- 这是**独立线**（standalone plugin）仓库：`@deepseek-ai/dsh-observational-memory`（ledger，store 后端）+ `@deepseek-ai/dsh-tool-observational-memory`（`memory_recall` 工具），目标是"普通用户只装插件、不改 harness"。
- `HANDOFF.md` 只写状态、路径与命令，**不放任何凭据值**（token / recovery code / 密码一律不入文档、不入仓库、不入对话）。
- 改 `src` 后必须 `pnpm run build`：两个包的 `files` 只收 `lib/`，且没有 prepack 钩子。
