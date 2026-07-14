# s11 的 Pi 0.79.1 源码对照

s11 把 Project Trust 重建为 Shared Agent Session Runtime 配置前的一道 Loading Gate。

```text
detect protected project inputs
  -> resolve projectTrusted
  -> reload project resources for that decision
```

## 对应文件

- [`packages/coding-agent/docs/security.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/security.md)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/trust-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/trust-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/settings-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/settings-manager.ts)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)

## 对应关系

| s11 | Pi 0.79.1 |
| --- | --- |
| `hasProjectTrustInputs()` | `trust-manager.ts` 中的 `hasProjectTrustInputs()` |
| `MiniTrustStore` | `ProjectTrustStore` 的 Nearest-path 行为 |
| `resolveProjectTrusted()` | `project-trust.ts` 中的 `resolveProjectTrusted()` |
| `extensionDecision` | `project_trust` Extension Event 的 Result |
| `loadProjectInputs()` | Settings、Package 与 Resource Loader 执行的 Trust-sensitive Project Resource 选择 |
| 不受 Trust 影响的 `contextFiles` | `resource-loader.ts` 中按目录执行的 Candidate Discovery |
| `createProjectTrustRuntime()` | Final Resource Reload 与 Agent Session Setup 之前的 Trust Resolution |

本节特意不映射任何 Tool 执行后端概念。Project Trust 讨论的是项目输入加载，不是选择 Tool 如何运行。

## Trust Input 与 Decision 顺序

Pi 把两类文件系统状态视为 Trust Input：当前工作目录中存在 `.pi/`，或当前目录及任意祖先目录中存在 `.agents/skills/`。`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md` 与 `CLAUDE.MD` 都不属于 Trust Input。

Pi 的 Decision 顺序与 s11 展示的顺序一致：

```text
--approve / --no-approve override
  -> no trust inputs: trusted
  -> first decisive project_trust Extension result
  -> closest saved cwd-or-parent decision
  -> defaultProjectTrust: always / never / ask
  -> ask with no UI: untrusted
  -> interactive selection
```

`ProjectTrustStore` 会规范化 Path、读取 `~/.pi/agent/trust.json`，并应用最近的 Saved Entry。课程 `MiniTrustStore` 保留向祖先查找的行为，但用内存代替持久化文件的锁定与更新。

Trust 解析前，Pi 可以加载 User/Global Extension 与临时 CLI Extension。这些 Extension 可以处理 `project_trust`；第一个给出 yes/no 的 Result 拥有 Decision，`remember: true` 会保存它。本课不在 Bootstrap 阶段加载 Extension，而是把该 Result 作为 `extensionDecision` 注入。

## Loading Gate

Pi 的 `ResourceLoader.reload()` 会在 Bootstrap Pass 中先强制使用 Untrusted Project Settings。随后它取得可能的 Pre-trust Extension Decision，把 `projectTrusted` 写入 `SettingsManager`，重新加载 Settings，解析 Package 与 Project Resource，最后加载完整 Extension Set。

这条边界是不对称的：

- 每个目录都按 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 的顺序选择首个存在的 Context Candidate；除非显式关闭 Context Loading，否则它不受 Project Trust 影响。
- Untrusted Project 会跳过受保护的项目 Settings、Resource、Package 与 Extension。
- Trusted Project 可以加载 `.pi/settings.json`、`.pi` 中的 Extension、Skill、Prompt Template、Theme、System Prompt File 等 Resource、Project Package，以及祖先目录的 `.agents/skills`。

本课使用相同 Gate，但 Resource List 刻意更窄：当前目录的 `.pi/settings.json`、`.pi/extensions`、`.pi/prompts`、`.pi/packages`，以及祖先目录的 `.agents/skills`。它并不声称实现 Pi 完整的 `.pi` Resource Discovery。

## 不是 Sandbox

Pi 的 Security 文档明确说明：Project Trust 不是 Sandbox，也不会在启动后限制 Model 可以要求 Tool 做什么。Built-in Tool 与 Extension 拥有 Pi 进程本身的权限。

课程继承的 `read_file` Path Boundary 是该教学 Tool 内部的 Local Policy。它不由 Pi Project Trust 强制执行，无法约束任意 Extension 或 Host Process，也不能被描述成强隔离。

对不受信任或无人监督的工作，Pi 建议使用外部 Container、VM、micro-VM、Remote Sandbox 或 Policy-controlled Sandbox。Mount 与 Credential 的选择仍决定该环境实际能影响什么。

## 课程范围

本课保留测试这条边界所需的部分：

- 通过 `MiniFiles` 直接发现文件，并为 CLI 提供 Real-filesystem Adapter；
- Override、Extension、最近 Saved Decision、Default 与 Interactive Decision Branch；
- 拒绝 Trust 后仍然存在的 Context；
- 接入同一个真实 `MiniCoreRuntime` 的 Trusted Skill 与 Prompt Path。

本课省略 Interactive Selection UI、持久化 `trust.json` Lock、完整 Settings Reload、Package Installation 与 Resolution、Project Extension Execution、Theme、System Prompt File，以及 Pi 更广的 Resource Graph。Settings、Extension 与 Package Path 只会列举，不会激活。

## 建议读法

1. 先读 `docs/security.md` 的 Project Trust 与 No Built-in Sandbox。
2. 阅读 `trust-manager.ts` 中的 `hasProjectTrustInputs()` 与 `ProjectTrustStore.get()`。
3. 从 Override 开始，沿 `resolveProjectTrusted()` 读到 No-UI Fallback。
4. 跟踪 `ResourceLoader.reload()` 的 Bootstrap 与 Trusted Reload。
5. 继续观察 `projectTrusted` 如何传入 `SettingsManager` 与 `PackageManager`。
6. 最后对照 `MiniTrustStore`、`loadProjectInputs()` 与 `createProjectTrustRuntime()`。
