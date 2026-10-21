# OpenCode v2 复用边界

OpenAGI 自有逻辑负责发现下一步任务、收集用户决策、整理解决思路及验收流程。模型调用、代码阅读、搜索、文件编辑、Shell、子代理和原有执行循环由 OpenCode 提供。`src/opencode.ts` 是编排层的薄 HTTP 适配器，不另建 Coding Agent。桌面界面直接构建完整的原 Desktop / App / Session UI / GUI extensions 源码，接入方式见 [desktop.md](desktop.md)。

生产入口现在使用当前项目的独立 OpenAGI 配置和隔离后端，详见 [配置与 Jev 来源](configuration.md)。下面的手动服务连接方式用于底层协议调试，不是运行时的模型配置来源。受当前项目边界限制，生产入口不开放任意子代理、MCP 或项目外文件工具。

以下协议审计最初核对 `anomalyco/opencode` 的 `v2` 分支，提交 **`93a7c8404fdc4fdb182eb6bbef7d925cb81e8306`**，包版本 **`2.0.26`**，核对时间为 2026-10-09；下文链接保留这个历史审计依据。当前完整桌面源码固定在 **`903ec2bb35379efc255e6331fe264dd057eb84e4`**，版本同为 **`2.0.26`**，来源记录见 `upstream.json` 与 `vendor/opencode`。源码结构为 `packages/core`、`packages/server`、`packages/protocol`、`packages/schema`、`packages/client` 和 `packages/sdk`；不能沿用旧版 `@opencode-ai/sdk` 的请求形状。

## 启动与连接

安装对应 v2 版本后，可启动独立服务：

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

未设置密码时服务会生成并显示密码。也可通过 `OPENCODE_PASSWORD` 环境变量提供密码。请求采用 HTTP Basic，用户名为 `opencode`。OpenAGI 的 `OpenCodeRuntime` 接受 `baseUrl`、`username`、`password`；包含凭据的 URL 会先提取凭据再构造请求，错误消息不打印 URL 凭据。生产使用应配置显式密码。

从源码运行：

```sh
git clone --branch v2 https://github.com/anomalyco/opencode.git
cd opencode
git checkout 93a7c8404fdc4fdb182eb6bbef7d925cb81e8306
bun install
bun run dev serve --hostname 127.0.0.1 --port 4096
```

该提交的 `packageManager` 是 `bun@1.4.2`。已有后台服务时，可用 `opencode service status` 获得地址、`opencode service get password` 获得密码。不要默认已安装的 `opencode` 属于 v2；适配器会检查 `GET /api/info` 的 `version`，拒绝 v1。

生产配置由 OpenAGI 翻译成 v2 的 `providers`、`models` 和插件设置。配置、数据、认证库和缓存隔离在当前项目 `.openagi/runtime/` 下，关闭项目/父目录 OpenCode 配置发现，不继承个人 OpenCode 的模型与凭据。自定义提供方以 `openagi-config-` 前缀注册，避免撞上内置提供方。任务执行保持独立服务，通过薄 HTTP 适配器复用执行循环；桌面使用原客户端源码直接订阅真实会话，文件保护插件复用后端已有的 Effect 和 Tool.Error 接口。

## 已复用的接口

| 用途 | v2 请求 | 关键语义 |
| --- | --- | --- |
| 验证版本 | `GET /api/info` | 响应直接包含 `version`，不包在 `data` 中。 |
| 创建会话 | `POST /api/session` | `{agent:"build",location:{directory},model?,permissions}`；返回 `{data:session}`。 |
| 更新权限 | `PATCH /api/session/:sessionID` | `{permissions:[{action,resource,effect}]}`。 |
| 切换模型 | `POST /api/session/:sessionID/model` | `{model:{providerID,id,variant?}}`；本项目 `modelID` 在边界映射到 `id`。 |
| 提交任务 | `POST /api/session/:sessionID/prompt` | `{text,delivery:"steer",resume:true}`；返回持久化 inbox 项，尚未代表任务完成。 |
| 等待执行 | `POST /api/experimental/session/:sessionID/wait` | 等待原有执行循环 idle，成功响应 `204`。 |
| 读取结果 | `GET /api/session/:sessionID/message` | `{data:[...],cursor:{next?,previous?}}`；倒序读取，并分页到本次提交的 user message。 |
| 待处理权限 | `GET /api/session/:sessionID/permission` | 响应 `{data:[...]}`。 |
| 待处理表单 | `GET /api/session/:sessionID/form` | 响应 `{data:[...]}`。 |
| 回复权限 | `POST /api/session/:sessionID/permission/:requestID/reply` | `{decision:"once"\|"always"\|"reject"}`；交互入口只提供单次授权或拒绝。 |
| 回复表单 | `POST /api/session/:sessionID/form/:formID/reply` | `{answer:{fieldKey:value}}`；支持字符串、数字、布尔值与字符串数组。 |
| 中断执行 | `POST /api/session/:sessionID/interrupt` | 返回 `{interrupted:boolean}`；超时或取消时尝试停止远端执行。 |
| 解决方案搜索 | `POST /api/websearch?location[directory]=...` | `{query}`；返回 `{location,data:{providerID,results}}`。 |

权限是有序规则数组，**最后一个匹配的规则生效**。会话规则排在 agent 规则之后。只读模式（Tutor、研究、Judge）设置 deny-all，然后仅允许 `read`、`glob`、`grep`、`webfetch`、`websearch`。生产 Build 模式保留原有执行工具，并加上不可批准的项目外目录限制及私有文件限制；路径/符号链接保护插件和 macOS 文件沙箱共同约束访问，不会自动批准待处理权限。上游 `write` 和 `edit` 工具都使用权限 action `edit`，Shell 使用 `shell`。

最终结果必须包含本次 user message 之后的 `idle` 消息，且其 `outcome` 为 `succeeded`；`failed` 或 `interrupted` 不会当成任务成功。助手结果读取 `content` 中 `type:"text"` 的内容，排除 reasoning 内容。等待接口存在与调度 wakeup 的竞争可能，因此仅收到 `204` 不足以接受旧结果。

单步命令出现待处理权限或表单时，会抛出包含 `sessionId` 及请求 ID 的 `OpenCodeError`，保留会话。桌面端通过原会话的权限与表单组件回答，上游 reply 接口继续同一条入队任务。`openagi run --cli` 则通过 `onInteraction` 回调在终端收集授权决定和表单回答。两种入口都不重复提交 prompt，空回答不会授权。超时和取消会尝试中断；若不能确认中断，错误会明确说明，保留任务工作目录以便检查。

重试已有会话时，适配器先检查待处理交互与 `/api/session/active`。单步命令会返回明确错误，不改变权限、不重复提交任务；持续交互入口会处理待回答的问题并等待前一次执行结束，随后才提交继续处理的指令。

上游 Effect Schema 的可选字段在 JSON 编码时可以表现为 `null`。适配器兼容分页 cursor 与搜索结果可选字段中的 `null`，不能仅按 TypeScript 的 `undefined` 推断线上的响应。

OpenCode v2 本次核对的 `PromptInput` **没有** `format`、`json_schema` 或结构化输出选项；`/api/experimental/generate` 也只接受 `prompt`、`model`。本项目在提示词中给出输出约束，并用自己的业务 Schema 验证。不能给 v2 发送 v1 的 `parts` 或 `format` 字段。

Web search 直接复用上游提供者系统，已有 TinyFish、Exa、Firecrawl、Tavily、Parallel 的实现。生产入口通过 OpenAGI 配置的 `search` 字段显式选择提供者和密钥，不继承个人搜索凭据。缺少搜索结果时保留“未找到外部证据”的状态，不能伪造来源或宣称找到了 SOTA。

## Worktree 与合并

上游已经提供以下接口，可由未来的远程后端复用：

```text
GET    /api/worktree?projectID=...
POST   /api/worktree
DELETE /api/worktree
POST   /api/worktree/refresh
```

创建请求为 `{projectID,from?,branch?,directory?,name?}`；响应为 `{directory}`，没有 `data` 包装。`directory` 指新 worktree 的父目录，`from` 必须是项目已知 checkout。它采用项目已有策略并执行项目 setup 脚本。

特别注意：该提交的 Git 策略实际执行 `git worktree add --detach <directory> <ref-or-HEAD>`；`branch` 是用于选取提交的 ref，**不会新建同名分支**。上游没有验收后合并的 HTTP API。本项目的本地 Git 生命周期层负责命名分支、隔离任务、记录验收证据与通过后合并；这属于任务管理，不是重新实现 Coding Agent。

## 源码依据与验证范围

以下链接全部固定在本次检查的提交：

- [会话 HTTP 协议](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/protocol/src/groups/session.ts)
- [消息协议与分页](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/protocol/src/groups/message.ts)
- [消息结构及 idle outcome](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/schema/src/session-message.ts)
- [PromptInput](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/schema/src/prompt-input.ts)
- [权限评估](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/core/src/permission.ts)
- [权限回复协议](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/protocol/src/groups/permission.ts)
- [表单字段和回复结构](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/schema/src/form.ts)
- [Web search 协议](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/protocol/src/groups/websearch.ts)
- [Worktree 协议](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/protocol/src/groups/worktree.ts)
- [Git worktree 实现](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/core/src/git.ts)
- [客户端初始化](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/client/src/promise/client.ts)
- [SDK 初始化](https://github.com/anomalyco/opencode/blob/93a7c8404fdc4fdb182eb6bbef7d925cb81e8306/packages/sdk/src/promise.ts)

`test/opencode.test.ts` 使用本机 HTTP 服务验证 v2 请求和响应契约，包括鉴权、版本拒绝、权限限制、持久化提交、idle outcome、分页、待处理交互、重复提交保护及中断。它没有调用真实模型。

本次还通过 `npm exec --package @opencode/cli@2.0.26 -- opencode2 serve --port 0 --hostname 127.0.0.1` 启动独立临时服务，隔离配置、数据、缓存与状态目录，运行 `test/live-opencode.test.ts` 成功验证真实 v2 连接：健康信息、适配器创建只读会话、会话读写、权限/表单列表、消息分页、idle 等待、活动会话列表及搜索提供者发现，最后删除测试会话。提示词发送在本地被拦截，**真实模型调用数为 0**；不检查或修改用户模型凭据与提供者配置。临时进程已清理。

在自己的临时服务上复测：

```sh
OPENAGI_LIVE_URL=http://127.0.0.1:4096 \
OPENAGI_LIVE_PASSWORD="$OPENCODE_PASSWORD" \
npx tsx --test test/live-opencode.test.ts
```

也可以执行 `npx tsx scripts/smoke-opencode.ts` 得到检查摘要。没有 `OPENAGI_LIVE_URL` 时，常规测试会跳过这项集成检查。真实 prompt admission、模型生成、工具执行及完整任务验收仍需配置并运行 OpenCode v2 服务后执行项目流程。

新增的 `scripts/smoke-configured.ts` 已在真实隔离后端验证：Heavy 和 Light 模型均调用 OpenAGI 配置指定的本机模拟接口，带上明确配置的密钥；真实 read 工具的项目外访问被拒绝且保护插件保持正常。模型请求由本机 fixture 响应，不产生付费模型调用。用户填写的远程模型和固定 TypeSafe Jev 仍需配置账号后验证。TypeSafe 请求与响应另有官方 OpenAPI 契约桩测试。
