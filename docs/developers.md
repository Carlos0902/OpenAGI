# OpenAGI 开发指南

[项目首页](../README.md) · [用户指南](users.md) · [配置参考](configuration.md)

## 环境与首次安装

任务执行和文件系统隔离目前依赖 macOS 的 `/usr/bin/sandbox-exec`。Node.js 要求 `>=22`，建议使用仍受支持的 LTS 版本；同时需要 npm、Git、可写的工作目录以及访问 npm、GitHub、Electron 资源的网络。其他平台即使能安装或编译部分代码，也不能视为支持完整任务执行。

```sh
git clone https://github.com/Carlos0902/OpenAGI.git
cd OpenAGI
npm ci
npm run upstream:prepare
npm run check
npm run upstream:check
npm run build
```

根目录使用 npm 和 `package-lock.json`；上游工作区使用 `upstream.json` 固定的 Bun `1.4.2` 与 `vendor/opencode/bun.lock`。准备脚本把 Bun 安装到 `.openagi/tools/`，以冻结锁文件安装桌面依赖，不要求全局 Bun。上游工作区安装默认禁用生命周期脚本，Electron 二进制由准备脚本单独处理。首次准备会下载执行 CLI、Electron 和工作区依赖，需要额外磁盘空间。

`vendor/opencode` 直接保存在此仓库中，包含 OpenAGI 的集成修改。不要用上游原始克隆替换它。准备脚本在源目录存在时保留现有修改，并检查上游版本和锁文件 SHA-256。

## 架构与文件导航

OpenAGI 编排核心是 Node.js ESM / TypeScript；桌面使用上游 Electron、Solid 客户端及 GUI extension SDK。

| 路径 | 负责内容 |
| --- | --- |
| `src/cli.ts`、`src/session.ts`、`src/conversation.ts` | CLI、持续交互和任务会话入口。 |
| `src/engine.ts`、`src/domain.ts` | 任务生命周期、领域结构和编排。 |
| `src/tutor.ts`、`src/clarification.ts`、`src/typesafe.ts` | 候选发现、问题门槛、Collector / Jev 协议。 |
| `src/guider.ts`、`src/validator.ts`、`src/delivery.ts` | 研究、独立验收和交付证据。 |
| `src/runtime.ts`、`src/configured-runtime.ts`、`src/opencode.ts` | 运行时抽象、角色模型配置和 OpenCode 接口。 |
| `src/backend.ts`、`src/server.ts`、`src/isolation.ts`、`src/boundary.ts` | 私有后端、进程管理、沙箱和路径边界。 |
| `src/workspace.ts`、`src/store.ts`、`src/usage.ts` | Git Worktree、状态持久化、用量账本。 |
| `src/settings.ts`、`src/config-*.ts`、`src/network*.ts` | 全局配置、配置向导、设置编辑及网络代理。 |
| `src/upstream-bridge.ts` | 将编排服务接入原桌面扩展宿主并发布真实阶段会话。 |
| `src/desktop/launcher.ts` | 启动已打包应用或构建后的 Electron 主进程。 |
| `src/index.ts` | 核心库公开导出，编译后由 `dist/index.js` 提供。 |
| `vendor/opencode/packages/gui-extensions/src/openagi/` | OpenAGI 桌面命令、设置、任务交互及 IPC。 |
| `vendor/opencode/packages/desktop/` | Electron 主进程、preload、窗口与本机能力。 |
| `vendor/opencode/packages/app/`、`packages/session-ui/`、`packages/ui/` | 原客户端、会话时间线和共享组件；后两个也位于 `vendor/opencode/`。 |
| `scripts/` | 固定上游准备、类型检查及真实后端 smoke 测试。 |
| `test/`、`examples/`、`desktop-assets/` | 核心回归测试、无真实密钥的配置示例、应用图标。 |

执行链路为 Tutor → Heavy 整理候选 → TypeSafe Jev 评估 → Guider → Worktree Worker → 检查和独立 Validator → 合并。Heavy 承担发现、研究、代码执行、验收与候选整理；Light 用于日常对话。Jev 固定为 TypeSafe `jev-latest`，失败时保留证据，不自动改用普通 LLM 评分。协议与恢复规则见 [配置参考](configuration.md)。

## 日常开发

只修改核心编排时：

```sh
npm run typecheck
npm test
npm run build:core
npm run dev -- help
```

`npm run dev -- <command>` 通过 `tsx` 执行 `src/cli.ts`。例如 `npm run dev -- list --all` 会读取当前目录的项目状态；它不等于桌面热更新。CLI 的默认 `run` 会打开桌面，需要先完成桌面构建。

修改核心、桌面扩展或客户端后，重建并启动：

```sh
npm run build
npm run desktop -- --project /absolute/path/to/test-repository
```

该入口启动已生成的桌面代码。目标应是专用的测试 Git 仓库，已有初始提交且工作区干净；在应用内明确开始或继续任务后才运行模型。也可运行 `npm link`，然后进入目标仓库执行 `openagi run` 或 `openagi run --cli`。

`openagi run` 在 macOS 上优先启动已有的 `release/mac-<arch>/OpenAGI.app`。源码改动后若仍打开旧界面，重新执行 `npm run desktop:package`，或直接用上述 `npm run desktop` 启动当前构建。

## 检查与测试

| 命令 | 范围 |
| --- | --- |
| `npm run typecheck` | 按 `tsconfig.check.json` 检查核心、测试与 TypeScript 脚本。 |
| `npm test` | Node test runner + `tsx`，运行 `test/*.test.ts`。 |
| `npm run check` | 核心类型检查与回归测试。 |
| `npm run upstream:check` | 用项目内 Bun 检查上游 Desktop、App 和 GUI extensions。 |
| `npm run build:core` | 按 `tsconfig.json` 输出核心 ESM 和类型声明到 `dist/`。 |
| `npm run build` | 核心编译、执行资源准备及 Electron main / preload / renderer 构建。 |

普通测试使用桩与临时仓库覆盖模型配置、HTTP 协议、问题判断、路径和符号链接边界、状态恢复、任务编排、Git 与验收保护。真实后端测试由环境变量显式启用，默认跳过。

```sh
# 固定后端 + 本机模型 / Jev fixture，无付费模型调用
OPENAGI_CONFIGURED_SMOKE=1 npx tsx --test test/configured-live.test.ts

# 真实后端的会话事件、工具、暂停与清理，无外部模型调用
OPENAGI_NATIVE_SMOKE=1 npx tsx --test test/native-client-live.test.ts

# 已运行的测试后端：健康状态和会话协议，无模型调用
OPENAGI_LIVE_URL=http://127.0.0.1:4096 npx tsx --test test/live-opencode.test.ts
```

真实后端测试需要 macOS、可用的隔离能力和固定 CLI 资源；首次运行可能下载依赖。对有认证的测试后端，可通过 `OPENAGI_LIVE_PASSWORD` 提供密码，目录覆盖为 `OPENAGI_LIVE_DIRECTORY`。不要将真实密钥写进测试或终端命令记录。

## 配置与本地数据

模型配置默认位于 OpenAGI 源码根目录 `.openagi/config.json`，CLI 和桌面共享。用 `openagi config` 或桌面设置创建；示例为 [openagi.config.json](../examples/openagi.config.json)。独立的 TypeSafe 凭据是必需项。`OPENAGI_ROOT` 可指定绝对路径的配置根目录，显式 CLI `--config FILE` 则限定在当前目标项目内部。

| 位置 | 数据 |
| --- | --- |
| OpenAGI 根目录 `.openagi/` | 全局模型配置、固定工具和依赖缓存。 |
| 目标项目 `.openagi/state.json` | 摘要、问题、候选、任务与验收记录。 |
| 目标项目 `.openagi/usage.jsonl` | 模型实际返回的 token 用量。 |
| 目标项目 `.openagi/runtime/` | 项目后端配置、HOME、缓存及临时数据。 |
| 目标项目 `.openagi/worktrees/` | 任务实现的独立 Git Worktree。 |
| `~/Library/Application Support/OpenAGI/` | macOS 原客户端私有资料和基础后端。 |

密钥不应进入源码、任务状态、日志或提交。不要继承个人 OpenCode 的模型认证；后端应只注册明确配置的提供商。测试通过临时配置和桩验证边界，不依赖开发者的私有配置。

## 修改时需要保持的行为

- 目标目录是独立仓库根目录，基线有初始提交且处于命名分支；执行前工作区干净。
- 模型文件工具与符号链接检查限制在项目边界内；macOS 沙箱保护项目外文件和应用私有配置，未支持平台停止任务执行。
- 独立 Validator 的结论绑定具体提交，合并前重新核对基线和已验证 SHA，保留检查输出与失败证据。
- 重开窗口、恢复项目来源或连接后端不会自动推进任务；开始、继续、暂停和进程清理保持明确的生命周期。
- 原生阶段会话使用真实后端事件展示思考、工具、权限和表单；OpenAGI 通过原 GUI extension SDK 集成。
- TypeSafe 认证、网络、地区限制和服务故障分别处理；局部配置失败保留原文件。

## macOS 本机打包

```sh
npm run desktop:package
```

该命令包含完整构建，使用 `desktop-upstream-builder.mjs` 继承上游打包配置并生成 `release/mac-<arch>/OpenAGI.app`，携带固定执行 CLI 和第三方许可。当前配置关闭签名、公证和发布；这是本机应用目录，不是已发布安装包。其他平台需要各自构建和验收。

## 维护上游与提交变更

[upstream.json](../upstream.json) 固定仓库、提交、包版本、Bun 版本与锁文件摘要。升级时先比较上游变更，再迁移本仓库的桌面身份、私有配置、代理、后端归属验证和 GUI extension 集成；不要只改版本号或复制整个上游目录覆盖。同步更新第三方说明，运行核心检查、上游检查、构建及相关真实后端测试，最后检查会话恢复与进程退出行为。

提交前运行适用检查，并在变更说明中记录验证命令、结果和跳过的可选测试。对行为或协议变化更新相应文档；保持根目录 npm 锁文件与上游 Bun 锁文件的各自用途。

`.gitignore` 排除依赖、构建、`.openagi/`、`.env*`、日志、`tmp/` 和本地 `testProject/`。回归用例放入 `test/` 或对应上游测试目录；可复现的配置示例放入 `examples/`，使用占位符。保留 `vendor/opencode/LICENSE` 和 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。OpenAGI 自有代码目前未单独声明许可证。
