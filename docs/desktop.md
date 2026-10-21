# OpenAGI Desktop

桌面端直接构建 `vendor/opencode/packages/desktop` 的 OpenCode v2 客户端。主进程、preload、客户端入口、页面和样式来自原项目；OpenAGI 的任务流程通过原 GUI extension SDK 接入。原有会话界面没有替换成另一套聊天页面。

固定上游提交为 `903ec2bb35379efc255e6331fe264dd057eb84e4`，包版本为 `2.0.26`。`upstream.json` 记录来源、Bun 版本和 lockfile 校验值，`vendor/opencode` 保存源码，`THIRD_PARTY_NOTICES.md` 记录许可与修改范围。

## 在原客户端中使用 OpenAGI

运行 `openagi run` 或打开 `release/mac-arm64/OpenAGI.app`。项目导航、会话标签、设置、快捷键、文件与差异查看、终端及其他内置面板使用原客户端实现。打开、关闭项目及退出应用也沿用原客户端的菜单与窗口生命周期。

OpenAGI 的独有入口包括：

- 标题栏的 **OpenAGI** 按钮，以及命令面板中的“开始 OpenAGI”“暂停 OpenAGI”“OpenAGI 设置”。
- 会话输入框的 `/openagi 项目摘要` 命令。它进入 OpenAGI 的任务流程，而不是把摘要作为普通聊天消息交给当前 Agent。
- 原设置界面内新增的 **OpenAGI** 页面：选择项目，配置全局 Heavy / Light 模型及固定 TypeSafe Jev 密钥。
- 主界面的 **OpenAGI** 按钮与会话标题栏中的状态菜单：开始/暂停、阻塞问题、任务验收详情、切换原生阶段会话及配置入口。菜单复用原客户端下拉菜单，需求回答与任务详情使用原生弹窗。不会自动打开或占用右侧工作区；旧工作流侧边标签在恢复时清理，代码/审查等原面板仍可按需打开。

第一次使用时，在“提供商”页填写提供商和 TypeSafe 密钥，在“模型”页选择 Heavy / Light。配置成功后，从首页选择项目，点击“开始 OpenAGI”，填写项目摘要并启动。已存在摘要时，“继续上次项目”是单独的选择；恢复窗口、项目或会话不会自行开始 Tutor 或执行旧任务。命令行传入的摘要只预填，不自动执行。

原设置导航、外观、语言、通知、快捷键、项目、扩展、服务器和关于等功能继续复用原实现。“提供商”和“模型”的页内配置功能由 OpenAGI 全局配置接管；原连接提供商、管理模型弹窗也跳转到这两个页面。密钥不会回填，留空编辑保留已有密钥；单项修改无需重新走完整向导，校验失败保留原文件。CLI 配置向导仍可使用；详细规则见 [configuration.md](configuration.md)。

## 思考、工具与交互

每个 Tutor、Collector、研究、Worker 和 Validator 的 OpenCode 调用都会注册真实的后端会话，可从 OpenAGI 面板在原客户端的会话标签中打开。思考输出、流式文字、工具调用状态、参数与结果、重试、权限及表单由原 `packages/app` 和 `packages/session-ui` 的事件流与组件呈现。模型未返回思考内容时，客户端不会人为生成思考文本。

OpenAGI 侧面板只承载额外的任务状态、项目配置、产品需求问答及验收记录。模型工具权限与工具提出的表单走原会话的审批和回答界面；OpenAGI 不在侧面板中另画工具卡片，也不自动批准权限。

客户端会话、任务流程与执行后端分别管理生命周期。暂停任务会取消本次流程并保留项目状态；从原项目菜单移除项目会停止其后端而不删除代码和 `.openagi` 记录。应用退出只停止属于 OpenAGI 的私有服务。

项目来源接入原首页、项目列表和来源菜单。关闭原项目会暂停对应流程；原来源设置中的移除操作调用 OpenAGI 的后端退役流程。窗口退出前先中断当前调用并等待后端持久化空闲，再关闭服务，保留任务与真实会话记录。

OpenAGI 的本机后端保留原客户端的本机能力，例如原内置浏览器和终端。只有主进程确认其来源 ID 和实际后端地址均属于当前 OpenAGI 项目时，才赋予本机能力；仅凭地址写成 localhost 不会把陌生服务当作本机后端。

## 代码与构建

| 目录 / 文件 | 用途 |
| --- | --- |
| `vendor/opencode/packages/desktop` | 原 Electron 主进程、preload、窗口、原生菜单、文件与 IPC。 |
| `vendor/opencode/packages/app` | 原完整客户端、设置、项目导航、会话及页面布局。 |
| `vendor/opencode/packages/session-ui` | 原消息、思考、工具、时间线和差异等会话组件。 |
| `vendor/opencode/packages/ui` | 原设计 token、样式、字体、图标与共享组件。 |
| `vendor/opencode/packages/gui-extensions` | 原扩展 SDK、主进程/renderer 扩展宿主及内置扩展。 |
| `vendor/opencode/packages/gui-extensions/src/openagi` | 新增的 OpenAGI 命令、设置页、任务面板和类型化 IPC。 |
| `src/upstream-bridge.ts` | 将现有 Tutor、Collector、Worker、Validator 编排接到扩展宿主，并发布真实会话。 |
| `scripts/upstream-prepare.mjs` | 固定版本的工具、冻结依赖安装、CLI 资源与原客户端构建。 |
| `desktop-upstream-builder.mjs` | 继承上游打包配置，修改应用标识、输出路径和第三方许可资源。 |

在 OpenAGI 源码目录运行：

```sh
npm install
npm run upstream:prepare
npm run build
npm link
```

`upstream:prepare` 使用项目内的 Bun `1.4.2`，保留原 catalog、patches 和冻结 lockfile，安装桌面端依赖。它不会覆盖已有的 vendored 源码修改，也不执行完整 Core/CLI 的构建脚本。原生 CLI 使用固定 `2.0.26` 二进制。

`npm run build` 先编译 OpenAGI 编排层，再调用原 `electron-vite` 构建原 main、preload 和 renderer；没有构建自制的近似 UI。源码开发启动可使用 `npm run desktop -- --project /项目目录`。

`npm run check` 检查编排层并运行其回归测试；`npm run upstream:check` 使用原 Bun / tsgo 配置检查 Desktop、App 和 GUI extensions。类型检查覆盖上游原项目与组件测试，不修改原 tsconfig 来跳过它们。

生成本机 macOS App：

```sh
npm run desktop:package
```

输出位于 `release/mac-arm64/OpenAGI.app`。当前本机包没有开发者签名或自动更新服务。桌面或编排代码修改后需重新构建及打包，才能更新 `.app`。其他平台需要分别构建和验收，不能以 macOS 构建结果声称已支持。

## 项目数据与代理

原客户端使用 OpenAGI 自己的应用资料目录；macOS 为 `~/Library/Application Support/OpenAGI`。基础界面的服务、配置与数据库位于该目录的私有 `backend` 下，不发现或接管个人 OpenCode 的全局后台服务。窗口和会话恢复沿用原客户端持久化实现。

OpenAGI 通过原扩展宿主的 `Store.main` 保存项目目录、选中项目与原生会话 ID 等连接元数据，不保存模型密钥、聊天内容或自动聚焦标记。重开 App 会恢复项目来源；连接失败时保留离线来源以便重新连接。恢复来源与连接不会启动任务流程。

模型配置统一使用 OpenAGI 根目录的 `.openagi/config.json`；任务编排仍使用各项目的 `.openagi/state.json`、`.openagi/runtime/` 及 `.openagi/worktrees/`。基础客户端服务可能在 App 启动时初始化，但不会因此执行旧的 OpenAGI 任务；任务调用模型需用户显式开始或继续。文件范围和 Git 验收规则见 [README](../README.md)。

项目执行后端以当前流程拥有的前台 `serve` 运行，不采用会自动扫描持久任务的后台服务启动方式。真实后端测试已验证：思考和工具事件进入原事件流、会话保留模块名称、暂停释放执行占用、重启不自行调用模型。测试使用本机模型 fixture，不产生外部模型调用。

桌面启动读取保存的 `network.json`；没有保存的代理配置时，读取继承的 HTTP(S) 代理或 macOS 当前系统 HTTP(S) 代理。localhost 保持直连。该配置只用于 OpenAGI，不修改其他应用。代理地址可在应用资料目录的 `network.json` 中维护；本机端口由实际代理软件决定，不能固定假设为某一端口。

Node 请求显式配置代理，项目执行后端继承同一代理配置。模型及 TypeSafe 密钥保存在 OpenAGI 根目录的全局配置，不放入窗口状态或代理偏好文件。网络问题与 HTTP 401/403/451、限流和服务故障分别处理；连接中断不会被当作密钥无效。

`openagi run --cli` 与 `openagi config` 仍保留为终端排查及脚本入口，共用项目配置和编排层；桌面操作不依赖终端交互。

## 首页项目集成

首页“项目”直接展示 OpenAGI 的项目文件夹，执行后端仅用作内部连接，不再列出每项目服务器。首页加号、项目菜单、Cmd/Ctrl+O 和项目设置页共用原客户端项目管理入口。项目的新建会话会打开 OpenAGI 摘要流程，已有真实会话仍使用原时间线、思考、工具、权限及表单。

项目选择同步当前 OpenAGI 目录；首页会话区汇总开放项目的会话。关闭项目暂停流程并保留最近关闭记录，移除项目释放后台及相关标签而不删除磁盘文件。全局模型配置保持统一。原设置中项目、工作树和项目移除不依赖独立的“OpenAGI 服务器”页面。


OpenAGI 发行版以项目为主入口，不提供连接管理、添加连接、配对、SSH/WSL 或上游自动更新界面。内部执行进程与 OpenCode v2 的 RPC/工具协议继续复用。窗口、菜单、图标、关于和提示使用 OpenAGI 品牌，关于页保留真实 OpenCode v2 来源与 MIT 许可。核心流程和全局配置不可禁用；配置未加载时显示明确加载/恢复状态，不回退旧编辑功能。
