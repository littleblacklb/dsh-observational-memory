# HANDOFF — 状态 / 交接（最后更新 2026-09-24 compactAfterTokens 实现与验证完成）

> 新对话从这里读起。本文只写**状态、路径、命令**；**不含任何凭据值**（npm token、recovery code、密码一律不入文档、不入仓库、不入对话）。

## 0. 两条线，以及为什么走独立线

| | 位置 | 形态 | 状态 |
|---|---|---|---|
| **独立线（当前目标）** | 本仓库 `/Users/lb/Documents/Code/dsh-observational-memory` | 两个包：`@deepseek-ai/dsh-observational-memory`（ledger，**store 后端**，`~/.dsh/observational-memory/*.json`）、`@deepseek-ai/dsh-tool-observational-memory`（`memory_recall` 工具）。host-only，无 web 记忆面板 | 开发完成、预检全绿、**未发布到 npm** |
| 冻结线（已放弃） | **本仓库**分支 `parked/browser-ui`（`78964b0`）：`packages/observational-memory`（`92f44a4`）+ `packages/tool-observational-memory`（`3255131`）+ `patches/`（harness 侧补丁，含两个 git bundle） | 把记忆写进 session log + Memory 标签页 | 放弃原因：**必然侵入 harness**（要改 `KNOWN_SESSION_EVENT_TYPES`、persistence 读路径拒绝未知事件类型、上游不接受 PR） |

验收标准（用户明确要求）：**普通用户只安装插件、不改 harness，就能用**。

两条线的 cadence 默认值**刻意不同**，不是笔误：冻结线 `observeAfterRatio 0.05 / reflectAfterRatio 0.10`（窗口比例优先），独立线两个都是 `0`（固定绝对阈值优先，`observeAfterTokens 10000 / reflectAfterTokens 20000`）。

## 1. npm 发布：尚未发布，但**不再是冻结挡着**

- **实测（2026-09-24）**：`npm view @deepseek-ai/dsh-observational-memory` 与 `…-tool-observational-memory` 均 **E404** —— 包名仍未被创建。
- **72 小时安全冻结窗口早已结束**。触发时刻约 2026-09-12/13，窗口约 9/16–9/17；今天 9/24，已过期约一周。**不要再把"等冻结解除"当成未发布的原因** —— 真实原因就是发布流程还没跑。
- 账号 `littleblacklb`；`@deepseek-ai` scope 对该账号 **read-write**（`npm access list packages @deepseek-ai` 全量显示 read-write）。
- 账号 2FA：**只有 passkey / 安全密钥，没有认证器 App** → 无法产出 TOTP。
- **仍然有效的禁令**：恢复码一个都别再用（每次使用都会再触发冻结）。
- ⚠️ **本机 npm 缓存已损坏**：`~/.npm/_cacache` 里存在 root 属主文件，用**默认缓存**跑任何会写缓存的 npm 命令都会 `EPERM`（`npm view` 已复现）。发布前必须处理，否则可能以看不懂的 EPERM 失败。
  - 临时绕法：加 `--cache /tmp/npm-cache-om`（本次核实就是用这个跑通的）。
  - 根治（**需要用户自己执行**，涉及 sudo）：`sudo chown -R 501:20 ~/.npm`。

### 发布步骤（ledger 先，tool 后；版本 0.1.5-rc.2；dist-tag `next`）

```bash
cd /Users/lb/Documents/Code/dsh-observational-memory
pnpm run verify                      # 必须：files 里只收 lib/，没有 prepack 钩子
pnpm --filter @deepseek-ai/dsh-observational-memory pack --pack-destination /tmp/om-publish
pnpm --filter @deepseek-ai/dsh-tool-observational-memory  pack --pack-destination /tmp/om-publish

npm login --auth-type=web            # passkey 登录；凭据写入 ~/.npmrc
npm publish /tmp/om-publish/deepseek-ai-dsh-observational-memory-0.1.5-rc.2.tgz      --tag next
npm publish /tmp/om-publish/deepseek-ai-dsh-tool-observational-memory-0.1.5-rc.2.tgz --tag next
```

- 必须用 `pnpm pack`：它把 tool 的 `workspace:^` 依赖改写成 `^0.1.5-rc.2`，`npm pack` 不会。两个包都声明了 `publishConfig.access: public`，不需要 `--access`。
- 发布时若打印 `Authenticate your account at: https://www.npmjs.com/auth/cli/…` → **按 ENTER + passkey** 完成（这是正规路径）。
- **首发之后不再需要 2FA**：`npm stage publish`（免 2FA）→ npmjs.com 的 Staged Packages 里用 passkey 批准。
- 备选（不必等任何窗口）：让 org 内有权限的协作者（`imccyu`、`tianyicui-deepseek` 是 `@deepseek-ai/dsh` 的 read-write）或 org CI 用两个 tarball 各跑一次 `npm publish … --tag next` 把包名建出来；之后自己全走 staged 流程。

### 已实测的坑（别再踩）

- granular token 选 `Read and write (stage only)` 或受限的 bypass-2FA 类型时，所有 PUT 都被伪装成 `404 Not Found`（对已存在包发重复版本也一样 404，而不是 "cannot publish over…"）。**注意与上面"包名不存在"的真 404 区分**：读操作的 404 是真的，PUT 的 404 可能是伪装。
- `npm stage publish` **不能创建全新包名**（"you cannot stage a brand-new package"）；本机 npm 11.12.1 也没有 `stage` 子命令（需 ≥ 11.15；可在 /tmp 装临时新版验证）。
- `npm publish` 永不启动浏览器登录流程（凭据缺失时只报 ENEEDAUTH），所以凭据必须先 `npm login --auth-type=web` 落盘。

### 发布前的待办（见 §6）

- 仓库里**没有 `LICENSE` 文件**，而两个 `package.json` 都声明 `license: MIT`。发布后 tarball 里不会有许可证正文。

## 2. 本机 dsh web 里使用插件

- profile：`~/.dsh/profiles/web`；bundle 栈：`dsh-base → dsh-web-app → dsh-better-sidebar → @deepseek-ai/dsh-observational-memory → @deepseek-ai/dsh-tool-observational-memory`。profile 的 `cordis.patch.yml` 为空（`[]`），两个 `node_modules/@deepseek-ai` link 都指向本仓库 ⇒ **纯独立线，启动不需要任何 overlay**。
- 记忆节奏 = **插件默认值**（非动态，commit `b26db28` 起）：`observeAfterTokens 10000`、`reflectAfterTokens 20000`、`observeAfterRatio 0`、`reflectAfterRatio 0`、未知窗口时 `observerChunkMaxTokens` 回退 `60000`。与原项目 `elpapi42/pi-observational-memory` 默认一致。
- **观察来源（commit `6952302` 起）= 用户文本 + 助手文本（含 tool call）+ tool 结果文本**，每条来源上限 20,000 字符（`MAX_SOURCE_TEXT_CHARS`），插件注入的用户上下文不计入。此前 `tool/result` 是**刻意排除**的，那个理由已被推翻；决策记录见 `docs/decisions.md` 的 "Source scope" 一节。
- **新增主动压缩（实现与本地验证完成，尚未真实 web 验收）**：引擎行 `observational-memory-compaction` 默认 `compactAfterTokens: 81000`、`compactAfterTokensMode: calibrated`、`compactAfterTokensRatio: 0.68`、`autoCompact: true`；在**下一轮第一次 pre-step** 检查完整来源预算（不裁剪为 observer 的 20K 字符），压缩保留尾部继续计入阈值。与原版 Pi 空闲后触发时机不同。插件替代的压力引擎仍按窗口 80% 兜底，主动/常规压力路径默认都保留约 20K 原文（小窗口缩小），手动与溢出策略不变；来源水位不足时回退原生摘要。不影响未安装插件的 DSH，也不需修改 harness/profile。详见双语 README 与 `docs/decisions.md`。
- **实施验证**：`pnpm run verify` 已通过（15 文件、313 用例；statement/branch/function/line 覆盖率 100%；README pairing 2/2、artifacts 16/16）。构建产物已更新；**未重启/验证真实 dsh web，也未调用真实模型；未发布 npm**。
- **source token ≠ 服务商报告的请求 token**：它是本包对这些来源条目自己的估算，所以 `/om status` 的计数与 `ctx.tokenMeter` 统计的不是同一个量，对不上是正常的。
- ~~当前 profile 是"混搭"状态~~ **已消除**（2026-09-24 核实）：两个 link 都指本仓库；harness `master` 的 `tsconfig.base.json` 已无记忆包映射（实测 grep 无命中），`packages/context/observational-memory` 目录也已不存在。
- **根因备忘录（最初那个启动失败，仅存历史）**：旧 fork 分支 `tsconfig.base.json`（412-413 行）把 `@deepseek-ai/dsh-observational-memory` / `…-tool-observational-memory` 映射到 `packages/context/…/src`，而子路径 `/startup` 无映射、仍走 `~/.dsh/profiles/web/node_modules` → **一个树里混入了两份实现** → `…/startup: pending (waiting for service: observationalMemoryStore)` → `dsh: 1 entry did not activate`。master 上没有这两行映射，干净 harness 不会遇到。
- 启动：`cd ~/Documents/Code/deepseek-harness && pnpm dsh --profile web web`（tsx 源码启动）或 `node apps/cli/lib/bin.js web`（构建产物）都可以；**不再需要 `--patch`** —— `~/.dsh/om-web-rows.yml` 已删除，它当年的作用是绕开上面的 tsconfig 劫持并钉死 cadence。要自定义节奏就改 profile 的 `cordis.patch.yml`（或临时 `--patch`），字段见 `packages/observational-memory/README.md` 配置表。
- 插件用法（host-only，**没有** web 记忆面板）：
  - `/om status`、`/om view`、`/om show <12 位 id>`；
  - 模型侧工具 `memory_recall`（按 id 回溯原始对话片段）；
  - 存储位置：`~/.dsh/observational-memory/<sessionId>.json`，每会话一个文件，配置项 `storageDir` 可改。
- 改扩展仓库 `src` 后必须 `pnpm run build`（bundle 加载的是 `lib/`）。

## 3. 已完成的验证（不必重做）

- 安装形态：只装 ledger → 2 行 ACTIVE + store 就绪；ledger + tool → 3 行 ACTIVE；**只装 tool → 启动失败**（`tool-observational-memory: pending (waiting for service: observationalMemoryStore)`）。README 已按此修正（commit `4ab40b8`，含中英两份）。
- 历史预检（新功能改动前）：`pnpm run build` / `pnpm run test`（14 文件 **271** 用例）/ `pnpm run check:artifacts`（16/16）/ `pnpm run check:readme-pairing`（2/2）。用例数从 266 涨到 271 是 commit `6952302`（tool 输出纳入 source）加的 5 个。新功能预检见 §2（15 文件、313 用例）。
- **`pnpm run verify` 是含覆盖率的那道总门**（= build + typecheck + test:coverage + check:readme-pairing + check:artifacts）。上面四条是它的组成部分，别再只跑四条就宣布全绿。
- **覆盖率表里 `startup.ts` 那行显示 `0 | 0 | 0 | 0` 是正常的，别去查**（2026-09-24 核实）：该文件是纯 re-export（`export { default } from './compaction-engine.ts'`），在 v8 原始数据（`coverage/coverage-final.json`）里 `statementMap` / `fnMap` / `b` **全为空** —— 0/0 个可覆盖单元，vitest 把 0/0 渲染成了 0%。门确实在跑（`vitest.config.ts:29-35`，`perFile: true` + 四项 100%）且通过；除它之外每个文件都是 100%。
- **本轮新增的链接检查**：`check:readme-pairing` 只校验中英结构配对，**抓不到坏链接**。2026-09-24 全仓库扫过一遍，修掉了 ledger README 中英各 2 处 `../../tool-observational-memory/README.md`（多了一级，正确是 `../tool-observational-memory/README.md`）。改动 md 后建议重跑一次同类扫描。
- 本仓库**没有 git remote**（全部为本地提交）。

## 4. 凭据与关键路径（只记路径，不记值）

**规则：凭据值不写进文档、仓库、对话。** 密码 / token / recovery code / API key 只存在于 npm 或 harness 自己的凭据文件里；需要代跑命令时只给**路径**，不贴值，也不打印文件内容。

| 用途 | 路径 | 说明 |
|---|---|---|
| npm 凭据 | `~/.npmrc` | 当前那个 token 是 `Read and write (stage only)`，**不能直接发布** |
| npm 凭据（隔离用） | 任意 `chmod 600` 文件 + `NPM_CONFIG_USERCONFIG=<path>` | 不动 `~/.npmrc` 时用，用完删除 |
| npm 缓存 | `~/.npm/_cacache` | ⚠️ **含 root 属主文件，用默认缓存会 EPERM**（见 §1）。绕法 `--cache /tmp/npm-cache-om` |
| harness 模型凭据 | `~/.dsh/.credentials.yaml` | provider `commandcode`（`~/.dsh/settings.yaml:13` 声明 `apiKeyEnv: COMMANDCODE_API_KEY`）；模型 `deepseek/deepseek-v4.1-flash`，上下文 1,000,000 |
| dsh profile | `~/.dsh/profiles/web/` | `package.json`（link 依赖 + `dsh.profile.bundles`）、`cordis.patch.yml`（记忆节奏） |
| ~~启动 overlay~~ | ~~`~/.dsh/om-web-rows.yml`~~ | **已删除**（2026-09-24）：默认 cadence 已是非动态、tsconfig 劫持也已消失，不再需要 `--patch`；要覆盖配置就用 profile 的 `cordis.patch.yml` |
| 记忆 ledger | `~/.dsh/observational-memory/<sessionId>.json` | 每会话一个文件 |
| 扩展仓库 | `/Users/lb/Documents/Code/dsh-observational-memory` | 本仓库（无 git remote） |
| harness 仓库 | `/Users/lb/Documents/Code/deepseek-harness` | 分支 `master` @ `c291e7961a`（2026-09-10），工作树干净、与自身 `origin/master` 同步；**用户要求：不要修改它**（包括不要 `git fetch`）；若某改动无法避免，先说明再让用户判断 |

## 5. 当前 dsh 版本与漂移结论

**结论：独立线的技术前提没有变化，但本地 harness 的"上游视野"已经落后约两周，需要重新核对后才能上发布。**

已核实（2026-09-24）：

| 项 | 值 | 怎么测的 |
|---|---|---|
| 本地 harness HEAD | `c291e7961a`（2026-09-10），包版本 `0.1.5-rc.2` | `git log -1`、`apps/cli/package.json` |
| 本地 harness 的 `origin/master` | `c291e7961a` —— **没有任何比 9/10 更新的远程引用** | `git for-each-ref refs/remotes/` |
| 本地 checkout 是否被上游甩开 | 无法从本地判断（refs 停在 9/10，且未 fetch） | — |
| npm 上 `@deepseek-ai/dsh` 的 dist-tags | `latest: 0.1.5-rc.3`、`next: 0.1.7-rc.1`、`alpha: 0.1.7-alpha.2` | `npm view @deepseek-ai/dsh dist-tags` |
| 我们两个包 | 均 E404（未发布） | `npm view <pkg> version` |
| harness 里是否还有记忆包残留 | 无：目录已删、`tsconfig.base.json` 无映射 | `ls`、`grep` |

也就是说：**本地 checkout（0.1.5-rc.2）落后于已发布的 `latest`（0.1.5-rc.3），更落后于 `next`（0.1.7-rc.1）**。插件的开发与验证全部是在 0.1.5-rc.2 上做的。

需要在发布前重新核对、但目前**无法在本地证实**的两条（**不要当成已确认的结论引用**）：

1. 上游 9/10 之后到 0.1.7-rc.1 之间的 commit 规模（早前记录说"13 天 3165 commits"，来源是当时的一次远端查询，本地 refs 没有留痕，本次无法复现）。
2. "客户端 dock 已被上游 `.dock` 吸收"（早前记录的说法）。这条只影响冻结线的补丁是否仍可直接套用，**不影响独立线** —— 独立线不碰客户端。

要重新核实必须在 harness 仓库 `git fetch`，而那会改动用户的 harness checkout，**先问用户**。

仍然成立的部分：补丁为什么不进 harness 的核心论证（事件词汇必须编译进 `KNOWN_SESSION_EVENT_TYPES`、persistence 读路径拒绝未知必需事件类型、上游 PR 关闭）不依赖版本，见 `FREEZE.md`；独立线是纯插件、只装不改，因此上游漂移对它只有"seam 是否改名"这一类风险，没有"补丁是否还能打"的风险。

## 6. 未决事项

1. **发布前：`LICENSE` 文件缺失**。两个 `package.json` 都写 `license: MIT`，但仓库里没有 `LICENSE` 文件（README 原先那句"见公共仓库的 LICENSE 文件"已改写）。需要用户定版权归属（署名谁、哪一年）后才能补。
2. **发布前：`~/.npm/_cacache` 的 root 属主问题**（§1），根治要用户自己跑 sudo。
3. **是否 fetch harness 以重新核对上游漂移**（§5），需要用户同意改动其 checkout。
4. **发布动作本身**：版本仍是 `0.1.5-rc.2`；要不要在首发前提到与新 harness（0.1.7-rc.1）对齐的版本号，未定。
5. **`docs/design.md` 是两条线共享的设计记录，不是冻结线专属**（2026-09-24 定位修正）。它写在冻结线的视角下（session event 存储、in-repo 布局、Memory tab），但 §4.3 worker 契约、§4.4 model-visible channel、§4.5/§4.5b compaction 继承、§10 的 harness 实测坑都是 **main 今天在跑的**。因此它保留在 main 上，冻结专属的章节用 `**[frozen line only]**` / `**[partly frozen line only]**` 行内标注（§4.1、§4.1b、§4.2、§4.3b、§4.6、§4.7、§5、§6、§7、§8、§9、Implementation status）。
   - 冻结分支 `parked/browser-ui` 的 `FREEZE.md` 已同步为 main 版（另加一段"你在哪个分支"说明）；该分支的 `DESIGN.md` 仍在根目录且**没有**这些标注 —— 那是分支的原样记录，刻意不同步。
   - **待查线索**：§10 那条 "Override `compactIfNeeded` too, or the automatic pressure path throws `TargetPressureConfigError`"，而 main 的 `MemoryCompactionEngine` **只覆写了 `summarize`**。已确认该错误在 harness `packages/compaction/compaction-basic/src/config.ts:139,149` 抛出、`src/index.ts:157` 有 catch，**所以不能断定是 bug** —— 但这条警告是否仍适用于 main 值得单独查一次。
6. **`README.i18n.yaml` 的"一致性记录"不可信，而且没有任何门在读它**（2026-09-24 发现，**不是本轮引入的**）：
   - 两份 yaml 都停在 `657c971`，此后 tool README 又改过一次（`4ab40b8`）、ledger README 又改过两次（`b26db28`、`aca1853`），**一次都没重新记录** ⇒ 记录早已过期。
   - 更根本的是 `scripts/check-readme-pairing.mjs` 的哈希公式是错的：它把 `text.length`（UTF-16 码元数）当作 blob 的字节长度，而中文 README 两者差近一倍（`7307` vs `13493`）—— 算出来的**不是 git blob 哈希**，与它文件头自称的"the git blob hash"不符。
   - 实测四个文件，记录值**既不等于真实 git blob、也不等于脚本自己的公式**；`pnpm run verify` 与 `check:readme-pairing`（不带 `--write`）**只比较结构，从不读这两个 yaml**，所以记录既不准确也无人强制。
   - 修法（**未做**，属代码/门禁改动，不在本轮 md 整理范围内）：`text.length` → `Buffer.byteLength(text, 'utf8')`，再 `--write` 重录；如需，可把"记录是否匹配当前 blob"真正接进门禁。
