# HANDOFF — 状态 / 交接（最后更新 2026-09-24 20:0x CST）

> 新对话从这里读起。本文只写**状态、路径、命令**；**不含任何凭据值**（npm token、recovery code、密码一律不入文档、不入仓库、不入对话）。

## 0. 两条线，以及为什么走独立线

| | 位置 | 形态 | 状态 |
|---|---|---|---|
| **独立线（当前目标）** | 本仓库 `/Users/lb/Documents/Code/dsh-observational-memory` | 两个包：`@deepseek-ai/dsh-observational-memory`（ledger，**store 后端**，`~/.dsh/observational-memory/*.json`）、`@deepseek-ai/dsh-tool-observational-memory`（`memory_recall` 工具）。host-only，无 web 记忆面板 | 开发完成、预检全绿、**未发布到 npm** |
| 冻结线（已放弃） | `deepseek-harness` 分支 `parked/browser-ui`：`packages/context/observational-memory`（commit `92f44a4`）+ `packages/context/tool-observational-memory`（`3255131`） | 把记忆写进 session log + Memory 标签页 | 放弃原因：**必然侵入 harness**（要改 `KNOWN_SESSION_EVENT_TYPES`、persistence 读路径拒绝未知事件类型、上游不接受 PR） |

验收标准（用户明确要求）：**普通用户只安装插件、不改 harness，就能用**。

## 1. npm 发布：尚未发布，等 72 小时安全冻结解除

- 账号 `littleblacklb`；`@deepseek-ai` scope 对该账号 **read-write**（`npm access list packages @deepseek-ai` 全量显示 read-write）。
- 账号 2FA：**只有 passkey / 安全密钥，没有认证器 App** → 无法产出 TOTP。
- **账号处于 npm 72 小时安全冻结中**（触发原因：recovery code 被当 OTP 使用；npm 自 2026-09-09 起对所有账号生效的保护）。
  - 冻结期间**不能**：发布、创建 access token、修改账号设置 / 包可见性 / org 成员。
  - **不受影响**：登录、浏览 npmjs.com、安装与下载、已发布包与版本、org 内其他人用自己的凭据发布。
  - **自动解除，无需联系客服**。解除时刻 = 触发时刻 + 72h：最可能是 2026-09-13 16:52 或紧随其后的那次尝试，因此约 **9/16–9/17**（以 npm 通知邮件时间为准）。
- **禁令**：剩余 recovery code 一个都别再用（每次使用都会再触发冻结）；冻结期间不要试发布 —— 失败会被伪装成 `404 Not Found`，没有任何诊断价值。
- 冻结解除后第一件事：npm 2FA 设置里 **Regenerate recovery codes**（旧码已出现在聊天记录中）。

### 发布步骤（ledger 先，tool 后；版本 0.1.5-rc.2；dist-tag `next`）

```bash
cd /Users/lb/Documents/Code/dsh-observational-memory
pnpm run build                       # 必须：files 里只收 lib/，没有 prepack 钩子
pnpm run test && pnpm run check:artifacts
pnpm --filter @deepseek-ai/dsh-observational-memory pack --pack-destination /tmp/om-publish
pnpm --filter @deepseek-ai/dsh-tool-observational-memory  pack --pack-destination /tmp/om-publish

npm login --auth-type=web            # passkey 登录；凭据写入 ~/.npmrc
npm publish /tmp/om-publish/deepseek-ai-dsh-observational-memory-0.1.5-rc.2.tgz      --tag next
npm publish /tmp/om-publish/deepseek-ai-dsh-tool-observational-memory-0.1.5-rc.2.tgz --tag next
```

- 必须用 `pnpm pack`：它把 tool 的 `workspace:^` 依赖改写成 `^0.1.5-rc.2`，`npm pack` 不会。两个包都声明了 `publishConfig.access: public`，不需要 `--access`。
- 发布时若打印 `Authenticate your account at: https://www.npmjs.com/auth/cli/…` → **按 ENTER + passkey** 完成（这是正规路径）。
- **首发之后不再需要 2FA**：`npm stage publish`（免 2FA）→ npmjs.com 的 Staged Packages 里用 passkey 批准。
- 备选（不必等冻结）：让 org 内有权限的协作者（`imccyu`、`tianyicui-deepseek` 是 `@deepseek-ai/dsh` 的 read-write）或 org CI 用两个 tarball 各跑一次 `npm publish … --tag next` 把包名建出来；之后自己全走 staged 流程。

### 已实测的坑（别再踩）

- granular token 选 `Read and write (stage only)` 或受限的 bypass-2FA 类型时，所有 PUT 都被伪装成 `404 Not Found`（对已存在包发重复版本也一样 404，而不是 "cannot publish over…"）。
- `npm stage publish` **不能创建全新包名**（"you cannot stage a brand-new package"）；本机 npm 11.12.1 也没有 `stage` 子命令（需 ≥ 11.15；可在 /tmp 装临时新版验证）。
- `npm publish` 永不启动浏览器登录流程（凭据缺失时只报 ENEEDAUTH），所以凭据必须先 `npm login --auth-type=web` 落盘。

## 2. 本机 dsh web 里使用插件

- profile：`~/.dsh/profiles/web`；bundle 栈：`dsh-base → dsh-web-app → dsh-better-sidebar → @deepseek-ai/dsh-observational-memory → @deepseek-ai/dsh-tool-observational-memory`。profile 的 `cordis.patch.yml` 为空（`[]`），两个 `node_modules/@deepseek-ai` link 都指向本仓库 ⇒ **纯独立线，启动不需要任何 overlay**。
- 记忆节奏 = **插件默认值**（非动态，commit `b26db28` 起）：`observeAfterTokens 10000`、`reflectAfterTokens 20000`、`observeAfterRatio 0`、`reflectAfterRatio 0`、未知窗口时 `observerChunkMaxTokens` 回退 `60000`。与原项目 `elpapi42/pi-observational-memory` 默认一致。
- ~~当前 profile 是"混搭"状态~~ **已消除**（2026-09-24 核实）：两个 link 都指本仓库；harness `master` 的 `tsconfig.base.json` 已无记忆包映射，`packages/context/observational-memory` 目录也已不存在。
- **根因备忘录（最初那个启动失败，仅存历史）**：旧 fork 分支 `tsconfig.base.json`（412-413 行）把 `@deepseek-ai/dsh-observational-memory` / `…-tool-observational-memory` 映射到 `packages/context/…/src`，而子路径 `/startup` 无映射、仍走 `~/.dsh/profiles/web/node_modules` → **一个树里混入了两份实现** → `…/startup: pending (waiting for service: observationalMemoryStore)` → `dsh: 1 entry did not activate`。master 上没有这两行映射，干净 harness 不会遇到。
- 启动：`cd ~/Documents/Code/deepseek-harness && pnpm dsh --profile web web`（tsx 源码启动）或 `node apps/cli/lib/bin.js web`（构建产物）都可以；**不再需要 `--patch`** —— `~/.dsh/om-web-rows.yml` 已删除，它当年的作用是绕开上面的 tsconfig 劫持并钉死 cadence。要自定义节奏就改 profile 的 `cordis.patch.yml`（或临时 `--patch`），字段见 `packages/observational-memory/README.md` 配置表。
- 插件用法（host-only，**没有** web 记忆面板）：
  - `/om status`、`/om view`、`/om show <12 位 id>`；
  - 模型侧工具 `memory_recall`（按 id 回溯原始对话片段）；
  - 存储位置：`~/.dsh/observational-memory/<sessionId>.json`，每会话一个文件，配置项 `storageDir` 可改。
- 改扩展仓库 `src` 后必须 `pnpm run build`（bundle 加载的是 `lib/`）。

## 3. 已完成的验证（不必重做）

- 安装形态：只装 ledger → 2 行 ACTIVE + store 就绪；ledger + tool → 3 行 ACTIVE；**只装 tool → 启动失败**（`tool-observational-memory: pending (waiting for service: observationalMemoryStore)`）。README 已按此修正（commit `4ab40b8`，含中英两份）。
- 预检全绿：`pnpm run build` / `pnpm run test`（14 文件 **266** 用例）/ `pnpm run check:artifacts`（16/16）/ `pnpm run check:readme-pairing`（2/2）。
- 本仓库**没有 git remote**（全部为本地提交）。

## 4. 凭据与关键路径（只记路径，不记值）

**规则：凭据值不写进文档、仓库、对话。** 密码 / token / recovery code / API key 只存在于 npm 或 harness 自己的凭据文件里；需要代跑命令时只给**路径**，不贴值，也不打印文件内容。

| 用途 | 路径 | 说明 |
|---|---|---|
| npm 凭据 | `~/.npmrc` | 当前那个 token 是 `Read and write (stage only)`，**不能直接发布** |
| npm 凭据（隔离用） | 任意 `chmod 600` 文件 + `NPM_CONFIG_USERCONFIG=<path>` | 不动 `~/.npmrc` 时用，用完删除 |
| harness 模型凭据 | `~/.dsh/.credentials.yaml` | provider `commandcode`（`~/.dsh/settings.yaml:13` 声明 `apiKeyEnv: COMMANDCODE_API_KEY`）；模型 `deepseek/deepseek-v4.1-flash`，上下文 1,000,000 |
| dsh profile | `~/.dsh/profiles/web/` | `package.json`（link 依赖 + `dsh.profile.bundles`）、`cordis.patch.yml`（记忆节奏） |
| ~~启动 overlay~~ | ~~`~/.dsh/om-web-rows.yml`~~ | **已删除**（2026-09-24）：默认 cadence 已是非动态、tsconfig 劫持也已消失，不再需要 `--patch`；要覆盖配置就用 profile 的 `cordis.patch.yml` |
| 记忆 ledger | `~/.dsh/observational-memory/<sessionId>.json` | 每会话一个文件 |
| 扩展仓库 | `/Users/lb/Documents/Code/dsh-observational-memory` | 本仓库（无 git remote） |
| harness 仓库 | `/Users/lb/Documents/Code/deepseek-harness` | 分支 `memory-tab-integration`；**用户要求：不要修改它**；若某改动无法避免，先说明再让用户判断 |
