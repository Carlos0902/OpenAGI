# OpenAGI 用户指南

[项目首页](../README.md) · [开发指南](developers.md)

基于 OpenCode v2 原客户端源码的项目决策与任务编排桌面 App。直接构建 `vendor/opencode` 中的原 Desktop、App、Session UI 和 GUI extensions，保留原会话、设置、思考输出和工具执行界面。Tutor 发现下一步，Collector/Jev 整理建议，Guider 研究方案，原有 OpenCode Worker 执行，Validator 独立验收后合并；这些流程通过原扩展 SDK 接入。

模型、API 地址、密钥及 Jev 来源由 **OpenAGI 根目录的全局配置** 控制。OpenCode 负责执行引擎和已有工具，不读取或沿用你的个人 OpenCode 模型设置。

## 运行前准备

当前任务执行依赖 macOS 的 `sandbox-exec`；Linux / Windows 尚不能运行严格隔离的任务流程。源码安装需要 Node.js 22 或更高版本（建议仍受支持的 LTS 版本）、npm、Git 和可用网络；`npm run upstream:prepare` 自动准备固定版本 Bun，无需全局安装。还需要支持工具调用的模型提供商账号，以及可访问 `jev-latest` 的 TypeSafe API key；实际运行会产生相应提供商的用量。

待开发目录必须是独立 Git 仓库的根目录，已有初始提交、位于命名分支，且代码工作区干净。新项目先按需创建 `.gitignore`、完成 `git init` 和初始提交，并配置 Git 用户信息。任务会写入代码和创建提交，使用前应保留自己的备份或远端分支。

## 开始使用

在 OpenAGI 源码目录安装一次：

```sh
git clone https://github.com/Carlos0902/OpenAGI.git
cd OpenAGI
npm ci
npm run upstream:prepare
npm run build
npm link
```

之后进入你要开发的项目目录，打开桌面 App：

```sh
cd /你的项目目录
openagi run
```

也可双击本机构建的 `release/mac-arm64/OpenAGI.app`。原客户端界面内新增 **OpenAGI** 标题栏按钮、命令和设置页。在“设置 → OpenAGI”选择项目文件夹，点击“配置模型”进行以下设置；后续无需在终端回答问题。

配置向导依次引导你：

1. 选择 provider 协议并填写 API 基础地址。
2. 隐藏输入你自己的 provider API key，读取账号可用模型列表。
3. 从真实列表选择 Heavy model 和 Light model；列表较长时可翻页，也可输入列表中的完整模型 ID。
4. 隐藏输入 TypeSafe Jev API key。来源固定为 TypeSafe 官方接口，模型固定为 `jev-latest`，不提供更改选项。
5. 校验成功后自动保存 OpenAGI 根目录 `.openagi/config.json`。取消或失败不会覆盖原文件。

再次打开配置入口时，会提示已有配置并显示隐藏密钥的摘要。你可以点击选择只修改 provider、provider API key、Heavy model、Light model、两个模型或 TypeSafe Jev API key，也可以重新配置全部。默认回车保留配置并退出。局部修改保留其他 provider、密钥和搜索设置；更换 provider 时会重选使用它的模型。旧版或无效配置仅提供保留原文件或重新配置全部两个选项。`openagi config` 仍保留为可选的终端配置入口。

TypeSafe 返回 HTTP 451 时，表示当前网络出口所在地区的访问受限，不能据此判定 API key 无效；请联系 TypeSafe 确认可用地区。向导会停止并保留原配置。只有 HTTP 401 认证被拒绝时，才要求重新输入 TypeSafe key；权限、限流和服务故障会分别提示原因。

Heavy 用于发现、规划、候选整理、代码执行和独立验收；Light 用于日常对话，两者可以选择同一模型。Jev 只负责独立的类型化评分和用户决策判断，候选文字由 Heavy model 整理。旧版本可自由选择 Jev 来源的配置需要重新运行向导；不会自动改用原有 LLM 评审器。

[完整配置与固定 Jev 协议](configuration.md)、[配置结构示例](../examples/openagi.config.json)。`openagi config init` 仍可仅生成模板，常规使用推荐交互式 `openagi config`。

填写后，点击标题栏 **OpenAGI** 或命令面板中的“开始 OpenAGI”，输入摘要并开始。会话输入框也支持 `/openagi 项目摘要`。运行中的 Agent 会话使用原时间线展示真实的思考、工具、权限和表单；独有任务与验收记录显示在 OpenAGI 侧面板。入口：

```sh
openagi run                 # 桌面 App
openagi run --cli            # 可选的终端持续交互
```

首次输入项目摘要，默认启用三个 Tutor 模块。桌面流程会推荐下一步，只询问阻塞核心交付的产品决策；没有待回答问题时自动进入实施，常规测试方案无需逐项确认。终端单步交互仍可回车开始、选编号或说明偏好。选定任务会自动研究、在独立 Worktree 实现、检查、独立验收、合并，再继续分析下一步。首次验收失败会携带证据修复一次；仍失败则保留现场与你讨论。

打开 App 会初始化原客户端自己的私有服务并恢复界面，OpenAGI 任务保持暂停。只有明确选择“开始 OpenAGI”或“继续上次项目”才推进；新摘要会保留并归档旧任务与执行记录，再按新目标分析。暂停保留任务记录，退出应用会清理它自己的后端。命令中提供的摘要（如 `openagi run "做一个贪吃蛇"`）只预填输入框，不自动执行。模型配置缺失时，在窗口内配置即可。Jev 来源、接口和模型不能通过编辑配置改变。

原设置页的外观、语言、通知、快捷键、提供方、模型、项目、扩展与服务器等界面保留。OpenAGI 的 Heavy / Light / Jev 配置独立控制流程，不随普通聊天会话的模型选择改变。

## Token 用量统计

桌面“设置 → Token usage”提供独立统计页面，也可从命令面板搜索“Token usage”打开。按提供方和模型分别显示输入、输出、推理、缓存读取、缓存写入及总 token；可选择一个项目，或汇总当前打开的所有项目。Heavy、Light 和 TypeSafe Jev 均按实际返回的模型标识统计；同一个模型承担多个角色时归为一行。

统计模块位于 `src/usage.ts`，原始用量账本保存在各项目 `.openagi/usage.jsonl`，与任务状态分开。原生会话包括子代理和上下文压缩，每五秒读取一次后台已报告的用量；同一消息的更新按 ID 覆盖统计值，重开不会重复累计。缓存不再计入输入列，推理不再计入输出列，总量只加一次。尚未返回用量的步骤单独标记；刷新或保存失败时显示提示并保留已有数据。

升级后可以从仍保留的原生会话补齐历史用量。TypeSafe 从启用统计后开始记录，旧版没有保留其原始用量，不能补算。终端模式也记录用量。这里只统计 token，不估算货币费用，也不替代提供方账单。

项目和真实会话元数据使用原扩展宿主持久化，重开 App 可恢复原项目来源；离线来源仍可重新连接。项目执行后端以前台方式运行，恢复界面或重启不会自行扫描并继续旧任务。OpenAGI 项目来源通过主进程校验后可使用原客户端的本机浏览器与终端能力。

内部编排指令默认折叠，点击阶段标题可查看；原客户端的思考和工具执行提示保持可见。评审或执行出错时会显示错误通知，并可从主界面的流程菜单打开详情；阻塞问题通过原生弹窗回答，不占用右侧工作区；TypeSafe 认证失败不会跳过 Jev，可在“配置模型”中更新密钥后明确继续项目，复用已保存的 Tutor 候选。

设置 → 提供商 直接新增、编辑或移除提供商，并单独更新 TypeSafe API key；设置 → 模型 从实际账号的模型列表中选择 Heavy、Light，Jev 来源与模型保持固定。密钥不回填到窗口，编辑时留空保留原密钥。两个原生设置入口管理 OpenAGI 根目录的全局配置，所有项目共享，替代原 OpenCode 的提供商认证和模型配置入口；旧的连接和模型管理弹窗也跳转到这里。

提供商页中的 Network proxy 提供全局代理开关、地址和“保存并测试 TypeSafe”。新配置默认启用 `http://127.0.0.1:7892`；已有配置会保留。保存后立即应用于 TypeSafe 请求，项目执行后端在下次明确开始时应用；本机服务始终绕过代理。命令行入口读取同一份配置。运行中的项目需要先暂停，再保存代理配置。

桌面构建、代理和复用来源详见 [desktop.md](desktop.md)。

默认减少追问：普通实现细节采用可修改的默认方案，只有阻塞核心交付的问题才需回答。Jev 逐条判断问题，首次门槛为 0.8，已有回答后的追加门槛为 0.95；清晰度偏低不再自动追加泛泛的确认。默认方案与真实用户回答分别记录，旧任务继续时也会按新规则重评。门槛可在配置的 `clarification` 中调整。

## 运行与文件范围

任务运行目录是项目边界。终端入口的 `--path`、`--config` 只能指向当前目录中的路径，指向项目外的符号链接会被拒绝；先 `cd` 目标仓库。桌面端通过原生选择器选定项目文件夹，再以该项目为任务边界。

OpenAGI 自动启动项目专用的 OpenCode v2 执行后端，无需手动启动服务。其配置、会话、HOME、npm 缓存和临时文件在 `.openagi/runtime/` 中，退出时只停止自己的后端。原客户端基础服务另外隔离在 OpenAGI 应用资料目录中，不发现或接管个人 OpenCode 服务。模型凭据不复制到任务状态，不继承个人 OpenCode 的配置或认证库。

桌面 App 携带固定版本执行二进制，并复用到当前项目中。终端独立入口首次需要下载后端；之后优先直接运行当前项目缓存中版本匹配的二进制，不再每次向 npm 查询。

当前严格文件隔离基于 macOS sandbox-exec，后台和检查进程允许项目数据与必要系统/工具链运行库。模型文件工具再检查路径与符号链接，禁止项目外目录；Worktree 位于 `.openagi/worktrees/` 内。未支持的沙箱平台会停止执行。

执行任务前，目标目录须为独立 Git 仓库根目录，已有初始提交且代码工作区干净。未检测到测试/静态检查时，会在对话内提出检查方案供你选择。状态位于 `.openagi/state.json`，包含用户回答、任务、评分、候选、原始评审回复与验收记录。生成的模型配置与状态文件权限为 `0600`。

## 模块与 Collector 恢复

| 模块 | 行为 |
| --- | --- |
| Function Finder | 根据目标、用户及实际代码发现具体功能改进，缺失决策转为问题。 |
| Performance Optimizer | 查找算法、缓存、I/O、渲染问题，区分测量与假设。 |
| UI Designer | 发现必要 UI、视觉、布局与可访问性改进；没有 UI 时可返回空列表。 |
| Collector/Jev | Heavy model 整理候选；固定 TypeSafe Jev 独立评估必要性、价值、紧急度、可行性、需求清晰度和用户决策。 |
| Problem Solving Guider | 复用已有读取、webfetch/websearch 工具，整理接入步骤、依赖风险及测试计划。搜索凭据可选在 OpenAGI 配置中指定。 |
| Worker | 将明确任务、用户回答、研究与验收标准交给原有 OpenCode build 执行循环。 |
| Validator | 运行配置检查，再用独立会话逐项验证代码、测试与验收证据，并绑定提交 SHA。 |

普通任务漏掉 `reevaluateWhen` 时补空数组；归档任务必须保留非空原因和重评条件。其他结构/业务错误最多按配置纠正 0–3 次，默认一次。失败时保存候选和原始回答，回车或重启只重试 Collector，不重新扫描项目；需求或模块改变时，保留旧记录并重新发现。

低必要性建议归档而不删除；真正阻塞交付的问题未回答时不能执行。清晰度分数偏低不会单独触发追问；具体问题使用 `clarification` 的首次/追加概率门槛。评分为 0–5 的期望值，可包含小数。排序权重为必要性 30%、价值 25%、紧急度 20%、可行性 15%、清晰度 10%。

## 单步命令

以下命令用于查看、排查或脚本调用，通常只需持续入口 `run`：

```sh
openagi list --all
openagi show TASK
openagi answer TASK QUESTION_ID '具体回答'
openagi reevaluate TASK
openagi work TASK
openagi resume TASK
openagi validate TASK
openagi rebase TASK
openagi merge TASK
```

`TASK` 支持无歧义 ID 前缀，单步查询支持 `--json`。`init` 的 `--project-config` 和 `configure --config` 使用项目元数据/检查配置（参考 `examples/project.json`），它们不能覆盖运行时的独立模型来源。业务服务从 `src/index.ts` 导出，并通过 `src/upstream-bridge.ts` 接入原桌面扩展宿主。

## 开发验证

完整开发环境、目录说明和提交前检查见 [开发指南](developers.md)。

```sh
npm run check
npm run upstream:check
npm run build

# 可选：真实隔离后端 + 本机模拟模型；验证模型与 Jev 地址/密钥及越界读取保护，无付费模型调用
OPENAGI_CONFIGURED_SMOKE=1 npx tsx --test test/configured-live.test.ts
```

测试覆盖独立模型配置、HTTP Jev、项目/符号链接边界、真实文件系统沙箱、Collector 字段兼容与有限纠错、候选重试恢复、完整任务编排及真实 Git 验收合并保护。固定的执行后端版本为 `@opencode/cli@2.0.26`，[上游接口与复用依据](opencode-v2.md)。

## 首页项目集成

首页“项目”直接展示 OpenAGI 的项目文件夹，执行后端仅用作内部连接，不再列出每项目服务器。首页加号、项目菜单、Cmd/Ctrl+O 和项目设置页共用原客户端项目管理入口。项目的新建会话会打开 OpenAGI 摘要流程，已有真实会话仍使用原时间线、思考、工具、权限及表单。

项目选择同步当前 OpenAGI 目录；首页会话区汇总开放项目的会话。关闭项目暂停流程并保留最近关闭记录，移除项目释放后台及相关标签而不删除磁盘文件。全局模型配置保持统一。原设置中项目、工作树和项目移除不依赖独立的“OpenAGI 服务器”页面。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `openagi: command not found` | 在 OpenAGI 源码目录完成构建并运行 `npm link`，确认 npm 全局 bin 在 PATH 中；也可在源码目录用 `npm run desktop -- --project /项目绝对路径` 启动。 |
| 窗口仍是旧版本 | `openagi run` 优先使用已有本机 `.app`，源码修改后重新打包，或用 `npm run desktop` 启动当前构建。 |
| 后端提示 Git 工作区或仓库不符合要求 | 进入独立仓库根目录，创建初始提交并切换到命名分支，提交或自行处理未提交代码；将 `.openagi/` 加入目标项目 `.gitignore`。 |
| TypeSafe 或模型请求连接失败 | 检查“提供商 → Network proxy”，按实际情况修改或关闭默认 `http://127.0.0.1:7892` 代理，再确认服务地址和网络。 |
| TypeSafe HTTP 401 / 451 | 401 时更新凭据；451 时联系 TypeSafe 核实地区可用性。失败会保留原配置，不跳过 Jev。 |
| 提示平台不支持严格隔离 | 当前任务执行需要 macOS 的 `sandbox-exec`，Linux / Windows 尚未支持。 |
| 关闭窗口后任务没有继续 | 恢复项目不会自动执行，明确选择“继续上次项目”。 |
| 验收失败 | 查看阶段会话和验收记录；自动修复一次仍失败时保留现场，修复后再验证。不要在未重新验收的提交上手动强制合并。 |
