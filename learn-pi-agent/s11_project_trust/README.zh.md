# 第 11 课 · Project Trust

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：Agent Session 启动前，控制项目本地设置、资源、Package 与 Extension 是否加载的 Gate。

```text
project files
  -> detect trust inputs
  -> resolve one project-trusted decision
       +-> first Context candidate in each directory - outside trust gate
       +-> project settings / skills / extensions --- trusted only
       +-> project prompts / packages --------------- trusted only
  -> configure the same MiniCoreRuntime
```

## 先搞懂：Runtime 启动前，哪些项目文件可以改变它

s10 已经让多个 Shell 共享同一个 Agent Runtime。任何 Shell 启动前，Harness 仍需决定：工作目录里的哪些文件可以改变这个 Runtime。

项目中可能存在设置、可执行 Extension、Prompt Template、Skill 与 Package 声明。若静默加载全部内容，刚打开的仓库就能改变 Agent 行为；若拒绝所有项目文件也不对，因为 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md` 与 `CLAUDE.MD` 是 Context Candidate，Pi 会把它们与 Trust Decision 分开处理。同一目录中按上述顺序选择第一个存在的文件。

边界很明确：Project Trust 只决定哪些项目本地输入可以加载，不决定 Runtime 启动后 Tool 能做什么。

## 思路：把检测、决策与加载拆开

s11 把三个容易混淆的问题分开：

| 问题 | 课程机制 |
| --- | --- |
| 项目是否包含需要 Trust 的输入？ | `hasProjectTrustInputs()` |
| 当前项目是否受信任？ | `resolveProjectTrusted()` 与 `MiniTrustStore` |
| 哪些输入可以进入 Runtime？ | `loadProjectInputs()` 与 `createProjectTrustRuntime()` |

本课中，当前目录的 `.pi/` 树，或当前目录及祖先目录中的 `.agents/skills/`，都会触发 Trust Resolution。四种 Context Candidate 都不会触发它。

Decision 产生后，加载规则保持显式：

| 输入 | Untrusted | Trusted |
| --- | --- | --- |
| 每个祖先目录中首个匹配的 Context Candidate | 加载 | 加载 |
| 当前目录的 `.pi/settings.json` | 跳过 | 暴露 |
| 祖先目录的 `.agents/skills/**/SKILL.md` | 跳过 | 暴露 |
| 当前目录的 `.pi/extensions/**` | 跳过 | 暴露 |
| 当前目录的 `.pi/prompts/**/*.md` | 跳过 | 暴露 |
| 当前目录的 `.pi/packages/**` | 跳过 | 暴露 |

这里特意使用“暴露”。本课会把受信任的 Skill 与 Prompt Path 接入真实的 s10 Runtime；Settings、Extension 与 Package Path 只会被报告出来，让加载决策保持可检查，但不会解析 Settings、执行项目 Extension 或安装 Package。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s11 -- "总结当前可用的项目说明。"
```

默认策略是 `ask`。这个精简 CLI 没有实现 Pi 的 Trust Selection UI，因此没有 Override 或 Saved Decision 时，受保护的项目输入会保持关闭。明确启用它们时，可以使用课程开关：

```bash
PI_PROJECT_TRUST=always npm run s11 -- "列出当前可用的项目 Skill 与 Prompt Template。"
```

Prompt 仍会经过前面课程中的真实 Model、Session Tree、Context Resource Loader、Extension Turn 与 `read_file` Tool。Trust 只改变交给该 Runtime 的项目输入。

## 代码怎么写的

### 1. 只检测需要 Trust Decision 的输入

`hasProjectTrustInputs()` 先检查当前目录的 `.pi/` 树，再从当前目录一路向文件系统根目录查找 `.agents/skills/`。Context File 特意没有参与这项检测。

CLI 使用 `discoverProjectTrustFiles()` 在真实文件系统中执行 Discovery。它的返回值也可以直接交给公开的 Trust Function，因此 Host 可以在构造 Runtime 之前检查同样的祖先查找与加载规则。

### 2. 按固定优先级得到一个 Decision

`resolveProjectTrusted()` 使用以下顺序：

```text
explicit override
  -> no trust inputs: trusted
  -> Extension decision, optionally remembered
  -> nearest saved decision for cwd or an ancestor
  -> default policy: always / never / ask
  -> ask without UI: untrusted
  -> interactive prompt decision
```

`MiniTrustStore.get()` 会向祖先路径查找，因此最近的 Saved Parent Decision 生效。与 Pi 持久化到 `~/.pi/agent/trust.json` 不同，本课 Store 只存在于内存中，进程退出后不会保留。

### 3. 让 Context 始终位于 Gate 之外

`loadProjectInputs()` 无论 Trust 是 true 还是 false，都会从文件系统根目录走到工作目录。在每个目录中，它按 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 的顺序选择第一个存在的文件，与 s08 的 Precedence 一致。Trust 为 false 时，所有受保护集合均为空；Trust 为 true 时，函数返回本课允许的 Settings、Skill、Extension、Prompt 与 Package Path。

这是加载边界，不代表 Context 天然安全。若仓库本身不受信任，项目说明仍是不受信任的文本，应该经过审查。

### 4. 配置同一个真实 Runtime

`createProjectTrustRuntime()` 先准备 Trust Decision，再把受信任的 Skill 与 Prompt Path 添加到 `MiniCoreRuntime`。它既不会替换 Runtime，也不会创建第二套 Agent Core。

已有 Context Resource Source 仍执行相同的 Per-directory Context Candidate Precedence。最终仍是一个累计 Session，只是可用 Resource 会随 Gate 改变。

## 动手试一试

1. 创建一个真实项目目录，确保它没有 `.pi/` 树，任何祖先目录也没有 `.agents/skills/`。把路径交给 `discoverProjectTrustFiles()`，再把返回的文件映射交给 `prepareProjectTrust()`。因为没有受保护输入，`projectTrusted` 应为 true。
2. 在该目录同时加入 `AGENTS.md` 与 `CLAUDE.md`，再次执行 Discovery。`projectInputs.contextFiles` 中应只有 `AGENTS.md`，Context Candidate 不应改变 Trust Decision。
3. 加入 `.pi/settings.json`，分别使用 `defaultProjectTrust: "never"` 与 `"always"` 调用 `prepareProjectTrust()`。`projectSettingsLoaded` 应从 false 变为 true。对课程工作目录而言，`PI_PROJECT_TRUST=never npm run s11 -- "..."` 与 `PI_PROJECT_TRUST=always npm run s11 -- "..."` 选择的就是这两条 Policy Branch。
4. 在项目或祖先目录中放入 `.agents/skills/review/SKILL.md`，再在项目中放入 `.pi/prompts/review.md`。使用两种 Policy 分别构造 `createProjectTrustRuntime()` 并对比 `projectInputs`。通过两个 Runtime 提交同一 Prompt 后，只有 Trusted Runtime 会收到 Skill Instruction 与选中的 Prompt Template Resource。
5. 在 `MiniTrustStore` 中为真实父路径保存 `true`，为子路径保存 `false`，再准备子项目。最近的 Saved Decision 应获胜，已选中的 Context File 仍位于 Gate 之外。

## 接入课程主线

| 边界 | s10 | s11 |
| --- | --- | --- |
| Runtime | 一个累计 `MiniCoreRuntime` | 仍是同一个 Runtime |
| Session | 由所有 Shell 共享 | 继续共享 |
| Context | 每个目录选择首个匹配 Candidate | 始终位于 Trust Gate 之外 |
| Project Skill 与 Prompt | 由调用方传入 Path | 只在 Trusted 后加入 |
| Settings、Extension、Package | 不属于 s10 | 被发现并经过 Gate，但本课不激活 |
| Decision State | 无 | Override、Extension Decision、最近 Saved Decision 或 Default |

## 对照 Pi 源码

Pi 0.79.1 使用相同边界：当前 `.pi/` 与当前或祖先目录的 `.agents/skills/` 会触发 Trust Resolution；每个目录中首个匹配的 `AGENTS.md`/`AGENTS.MD`/`CLAUDE.md`/`CLAUDE.MD` Context Candidate 独立加载；受保护的项目设置、资源、Package 与 Extension 只有在批准后才加载。Pi 会持久化 Decision，并执行本课省略的真实 Resource Reload、Package Resolution 与 Extension Loading。

Project Trust 不是 Permission System 或 Sandbox。Pi 的 Tool 与 Extension 拥有 Pi 进程本身的权限。课程 `read_file` Tool 的工作目录检查只是教学 Tool Policy，不是 Pi 的安全边界，也不是 Project Trust 带来的能力。强隔离必须由外部 Container、VM、micro-VM、Remote Sandbox 或操作系统 Policy 提供。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 12 课 · Pi Package](../s12_pi_package/) 会继续追踪 Trust 后的一类受保护输入：Package 如何解析成 Runtime 已经理解的 Resource 类型。
