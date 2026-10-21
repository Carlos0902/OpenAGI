# OpenAGI

OpenAGI 是一个面向已有 Git 项目的 AI 开发桌面应用：从项目目标发现下一步任务，整理和评估候选方案，在独立 Git Worktree 中实施，再由独立会话验收并合并。桌面界面基于仓库内固定版本的 OpenCode v2，保留真实会话、思考输出、工具执行、权限交互和代码差异查看。

当前版本为 `0.1.0`。任务执行依赖 **macOS 的 `sandbox-exec`**；Linux 和 Windows 的严格隔离任务流程尚未支持。仓库提供源码构建流程，macOS 本机打包未签名、未公证，也没有自动更新服务。

## 文档入口

| 读者 / 主题 | 文档 |
| --- | --- |
| 用户：安装、模型配置、启动、暂停、恢复、命令与用量统计 | [用户指南](docs/users.md) |
| 开发者：环境、架构、开发流程、检查、构建与上游维护 | [开发指南](docs/developers.md) |
| 模型提供商、固定 TypeSafe Jev、密钥和全局配置 | [配置参考](docs/configuration.md) |
| 桌面集成、原生会话、打包、代理和数据位置 | [桌面说明](docs/desktop.md) |
| OpenCode 接口与复用依据 | [OpenCode v2 集成](docs/opencode-v2.md) |

## 从源码开始

需要 Node.js **22 或更高版本**（建议仍受支持的 LTS 版本）、npm、Git、macOS，以及可访问依赖与模型服务的网络。准备自己的模型提供商 API key 和独立的 TypeSafe API key。Heavy 模型需要支持推理和工具调用，Light 模型用于日常对话；两者可使用同一模型。Jev 固定使用 TypeSafe 的 `jev-latest`。

```sh
git clone https://github.com/Carlos0902/OpenAGI.git
cd OpenAGI
npm ci
npm run upstream:prepare
npm run build
npm link
```

`upstream:prepare` 会下载固定版本 Bun、上游工作区依赖和执行后端，不需要全局安装 Bun。首次构建需要网络和较多磁盘空间。

进入需要开发的项目目录后启动：

```sh
cd /absolute/path/to/your-project
openagi run
```

目标目录必须是独立 Git 仓库根目录，已有初始提交、处于命名分支且工作区干净。可先用 `git status` 检查。请在目标项目的 `.gitignore` 中加入 `.openagi/`。

1. 在桌面设置的“提供商”页配置模型提供商、API key 和 TypeSafe key。
2. 在“模型”页选择 Heavy / Light。CLI 配置入口为 `openagi config`。
3. 选择项目，点击“开始 OpenAGI”，填写摘要；已有任务通过“继续上次项目”恢复。

应用打开时任务保持暂停，只有明确开始或继续才推进。运行可能调用付费模型、修改项目文件、创建提交并将通过验收的任务合并到项目基线分支。模型配置默认保存在 OpenAGI 源码根目录的 `.openagi/config.json`；任务、用量和运行数据保存在各目标项目的 `.openagi/` 中。

初次网络配置可能默认启用 `http://127.0.0.1:7892` 代理，请在“提供商 → Network proxy”中按本机实际情况修改或关闭。密钥配置、HTTP 401 / 451、暂停恢复和常见问题见 [用户指南](docs/users.md) 与 [配置参考](docs/configuration.md)。

可选终端交互和 macOS 本机打包：

```sh
openagi run --cli

# 在 OpenAGI 源码目录执行，输出 release/mac-<arch>/OpenAGI.app
npm run desktop:package
```

## 工作流程

| 阶段 | 作用 |
| --- | --- |
| Tutor | Function Finder、Performance Optimizer、UI Designer 发现候选改进。 |
| Collector / Jev | Heavy 整理候选，TypeSafe Jev 独立评估优先级和阻塞决策。 |
| Guider | 研究实现方案、依赖风险和验收计划。 |
| Worker | 通过 OpenCode 在独立 Worktree 中实施任务。 |
| Validator | 执行检查，用独立会话逐项验收，并绑定已验证的提交。 |
| Merge | 满足工作区和提交保护条件后合并，继续分析下一步。 |

## 开发检查

```sh
npm run check
npm run upstream:check
npm run build
```

日常编排层开发可先运行 `npm run build:core`；完整桌面构建与可选真实后端测试见 [开发指南](docs/developers.md)。`vendor/opencode` 包含 OpenAGI 的必要集成修改，应随项目完整保留。

## 上游与许可

OpenCode 上游固定为 `2.0.26`，提交 `903ec2bb35379efc255e6331fe264dd057eb84e4`；版本、来源、Bun 和锁文件摘要记录在 [upstream.json](upstream.json)。上游 MIT 许可保存在 [vendor/opencode/LICENSE](vendor/opencode/LICENSE)，修改范围与第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本仓库尚未为 OpenAGI 自有代码单独声明许可证；上游 MIT 许可适用于对应的上游代码，其他依赖按各自许可分发。
