# 交互配置与固定 TypeSafe Jev

桌面端在原客户端的“设置 → OpenAGI”中选择项目并点击“配置模型”；终端也可在当前项目目录运行 `openagi config`。两个入口共享配置向导。首次配置时，向导选择 provider 协议、填写地址和隐藏 API key，从账号的可用模型列表选择 Heavy/Light，再填写独立的 TypeSafe API key。只有所选配置校验通过才原子保存 OpenAGI 根目录的 `.openagi/config.json`（权限 `0600`）；取消或失败时原文件保持不变。

原客户端的提供方与模型设置入口保留，页内配置由 OpenAGI 全局设置接管。Heavy / Light / Jev 使用 OpenAGI 根目录的全局配置；普通会话的模型选择不会替代这些明确配置。

已有配置时，先显示隐藏密钥的摘要和修改菜单。默认回车保留并退出；可选择 provider 地址/协议/密钥、单独的 provider API key、Heavy、Light、两个模型、Jev API key，或全部重新配置。修改模型复用已有 provider 密钥读取模型列表；更换 provider 会重选引用它的模型；单独更换 provider 密钥会确认原有模型仍可用。多 provider 配置会让用户选择修改对象，局部修改保留其他配置和搜索设置。无效或旧版配置仅支持保留原文件或全部重新配置。

## Provider 与可用模型

支持 OpenAI-compatible Chat Completions、OpenAI Responses、Anthropic 和 Google Gemini。模型列表从填写的 provider `/models` 接口取得，按对应协议鉴权并处理分页。Gemini 只显示支持 `generateContent` 的模型。不会使用静态推荐列表或允许填写列表之外的模型 ID。模型列表存在并不证明模型支持所有 Agent 工具，选 Heavy 时应选择适合推理和工具调用的模型。

配置版本为 2，结构参考 `examples/openagi.config.json`。`models.heavy` 和 `models.light` 均必填。提供方 ID 引用本文件的 `providers`；运行时以独立命名空间注册，不继承 OpenCode 的默认模型和账号。

Heavy 映射到发现模块、Guider、Worker、Validator 和候选文字整理；Light 映射到对话顾问。可选择相同模型。向导按返回的模型信息保守设置输入/输出限额；provider 未提供限额时采用配置默认值，应按真实模型能力调整。

## Jev 来源不可修改

Jev 固定为 TypeSafe AI：

- 请求接口：`https://api.typesafe.ai/v1/systemone`
- 密钥校验/模型查询：`https://api.typesafe.ai/v1/models`
- 请求模型：`jev-latest`
- 认证：`Authorization: Bearer <你自己的 TypeSafe API key>`

这些地址和模型在实现中固定，不从用户配置读取。`jev.type` 只能是 `typesafe`；额外的 `url`、`model` 或其他来源字段会被拒绝。向导仅询问密钥，不显示来源/模型选择。账号必须拥有固定模型的访问权限；失败不会改用 LLM 或其他厂商。

Jev 不是文本生成模型，不能直接生成完整任务说明。Collector 先让 Heavy model 整理候选、问题、依据和验收标准，然后发给 Jev。每个候选组有五个 Score 问题（必要性、价值、紧急度、可行性、需求清晰度）和一个 Noul 问题（是否仍需用户决定）。Score 用六级 0–5 rubric，返回概率加权期望值，可含小数。此外对每条具体问题独立询问一个 Noul（是否真正阻塞交付）。Noul 是 0–1 的概率，按下文首次/追加门槛判断具体问题，不让总体概率或清晰度分数单独产生追问。

Jev 的评分覆盖 LLM 的评审假设，原始分布、置信度和实际解析模型版本保存在任务评审来源中。重评条件和解释是 Heavy 的文字整理及本地流程规则，不声称是 Jev 生成的文本。问题或条件缺失时按既有严格业务校验处理；低必要性仍归档、不删除。

协议依据：[TypeSafe 官方介绍](https://docs.typesafe.ai/introduction)、[官方 OpenAPI](https://api.typesafe.ai/openapi.json)。实际 Jev 请求必须使用用户自己的 key；测试使用协议桩，不调用付费评审。

## 密钥、升级和取消

向导输入不会回显，不通过日志打印密钥。配置文件中可直接使用 `apiKey`，手动维护时也支持显式 `apiKeyEnv`，二选一。Jev 必须提供自己的 TypeSafe 凭据。密钥不复制到 `state.json`，模型工具与命令环境不能读取应用私有配置。

旧版本（version 1）或旧 Jev LLM/HTTP 配置不能运行，须重新执行配置向导。向导成功后替换配置，任务与用户回答不变。桌面向导保存后重新连接该项目后端；已运行的独立终端流程应退出并重新运行 `openagi run --cli`，以载入新的模型和密钥。

## 减少不必要的追问

默认只询问真正阻塞核心交付、且无法用常规可逆方案解决的事项。Jev 会逐条评估问题的必要性：首次提问概率门槛为 `0.8`，已有用户回答后的追加追问为 `0.95`。已回答的问题、可选教学讲解、常规尺寸/速度/颜色等实现参数不应阻塞开发；默认方案保存在任务的 `assumptions`，会展示给用户，并明确区别于实际用户回答。

清晰度分数保留用于评审和排序，但不会单独产生泛泛的澄清问题。可选问题保留在任务记录中，以 `blocking: false` 标记，既不伪造回答，也不阻止进入实现。核心范围冲突、必要输入或不可逆授权仍需确认；模型工具权限和验收流程保持原有规则。

手动配置 `.openagi/config.json` 可调整门槛（缺省自动采用以上值）：

```json
"clarification": {
  "decisionThreshold": 0.8,
  "followupDecisionThreshold": 0.95
}
```

重新配置模型或 Jev 密钥会保留此设置。旧版正在等待回答的任务，在用户主动继续后重新评估一次，并保留历史答案和执行记录。

## 项目范围和 Collector 恢复

编排层读取 OpenAGI 根目录的全局模型配置；模型仍只能读取当前项目代码和任务 Worktree，不能读取全局密钥文件。模型路径和符号链接不能越出项目；后台与检查进程使用 macOS 文件系统沙箱，HOME、配置、缓存、数据和临时文件均在 `.openagi/runtime/`。必要系统/工具链运行库不作为项目上下文。未实现等价沙箱的平台停止执行，不放开项目外访问。

普通任务缺少 `reevaluateWhen` 时补空数组；归档任务仍须非空理由与重评条件。其他结构错误按 `repairAttempts` 有限纠正（默认一次），但不会让普通 LLM替代 Jev 打分。失败候选/原始回答保留，重试 Collector 不重新运行 Tutor；摘要或模块改变时保留旧记录并重新发现。

可选 `search` 仍支持 Tavily、Exa、Firecrawl、Parallel、TinyFish 的显式密钥配置，沿用已有搜索工具。运行目录应是有初始提交的独立 Git 仓库根目录。

## 全局配置位置

默认读取 OpenAGI 安装源码根目录的 `.openagi/config.json`，CLI 和桌面 App 共用同一个文件。切换项目文件夹不会改变 Heavy、Light、provider 或 Jev；各项目已有的模型配置不会自动覆盖它。项目摘要、任务、执行后端和工作树继续按项目隔离。

在桌面“设置 → OpenAGI”或任意项目目录执行 `openagi config` 修改同一份全局配置。更改前先暂停运行中的流程；保存后桌面已打开项目同步更新。可用绝对路径环境变量 `OPENAGI_ROOT` 指定 OpenAGI 根目录（例如源码目录移动后）；显式 `--config FILE` 仍作为 CLI 的项目内高级覆盖选项。密钥不会复制到其他项目的配置文件。


桌面端直接在原“提供商”和“模型”设置页管理上述全局配置。提供商页支持协议、地址、密钥、上下文与输出上限的单独修改，TypeSafe 密钥与网络代理也在此页；模型页从账号返回的真实列表选择 Heavy/Light，Jev 固定不变。留空编辑密钥会保留原值，API key 不回填到窗口。新增提供商后需要在模型页明确选择角色模型；无法使用当前角色模型的提供商修改会拒绝保存，可新增提供商后切换角色。运行中的流程需先暂停再修改，设置页提供暂停入口。


自定义供应商可以手动填写模型 ID、显示名称和请求头。在此模式下不会请求供应商的 `/models`，角色模型只能从你声明的 ID 中选择；未声明手动模型时，使用供应商返回的模型列表。请求头值与 API key 均隐藏，编辑已有请求头留空保留原值，移除行会删除对应请求头。供应商及角色选择保存到同一份全局配置，执行后端使用这些模型和请求头。
