# s08 的 Pi 0.79.1 源码对照

s08 对应 Pi 的 Resource Loader、Skill 与 Prompt Template Parser，以及 System Prompt 构造过程。

```text
resource paths -> loaded resources -> system prompt / Harness resources -> TurnState
```

## 对应文件

- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/system-prompt.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/system-prompt.ts)
- [`packages/coding-agent/src/core/skills.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/skills.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)

## 对应关系

| s08 | Pi 0.79.1 |
| --- | --- |
| `createFileSystemResourceSource()` | `DefaultResourceLoader` 内的 Filesystem Access |
| `loadProjectContextFiles()` | `resource-loader.ts` 中的 Project Context Discovery |
| `ContextFile` | Agent File 的 Path 与 Content |
| `ContextSkill` | 教学版中 Coding Agent Skill Metadata 与已加载 Body 的组合 |
| `ContextPromptTemplate` | `PromptTemplate` |
| `formatPromptTemplateInvocation()` | Prompt Template Argument Substitution |
| `buildContextSystemPrompt()` | `buildSystemPrompt()` 的 Context File 与 Skill 部分 |
| `prepareContextResources()` | 把 Loaded Resource 送入 `AgentHarnessResources` 与 System Prompt |
| `runContextResourceTurn()` | 接入既有 Harness Turn 的课程组合代码 |

## Context File 顺序与来源

Pi 会先检查配置的 Agent Directory，再从 Root 到 Working Directory 检查 Ancestor。每个目录只选第一个受支持的 AGENTS 或 CLAUDE 文件名。课程通过 `ResourceSource` 遵循相同顺序。

两种实现都会让 File Path 与 Content 一起保留，并在 `project_instructions` Wrapper 中加入该 Path。因此 Prompt 能区分全局、Workspace 与更近的 Project Instruction。

## Skill 与 Prompt Template

Pi 只有在 Read Tool 可用时才会在 System Prompt 中展示 Skill，因为模型应在相关任务出现时从文件读取 Skill Body。课程还识别教学 Tool 名 `read_file`，并过滤标记 `disable-model-invocation` 的 Skill。

课程的 `ContextSkill` 保留解析后的 Body 便于观察，但进入 `harnessResources` 的只有 Skill Metadata。Prompt Template 替换与 Pi 一样采用单趟规则：参数值中看似 Placeholder 的内容不会被二次展开。

## 接入 Turn

Pi 的 Resource Loader 负责 Discovery 与 Reload；结果会进入 System Prompt 构造与 Harness Resource。`AgentHarness.createTurnState()` 再把这些值与选中的 Tool 一起建立快照。

s08 使用同样的职责划分。`prepareContextResources()` 生成 Prompt Callback 与 Resource；`runContextResourceTurn()` 则把 Model 与 Tool 推进交给 s06 Harness 路径。

## 课程范围

真实 Resource Loader 还会解析 Package 与 Setting、追踪 Diagnostic 与 Source Metadata、应用 Project Trust、加载 Extension 与 Theme、合并额外 Path，并支持 Reload。

课程保留 Context File 的真实 Filesystem Read，并显式接收 Skill 与 Prompt Template Path。Skill 缺少 Description 时，课程会报错；Pi 会记录 Diagnostic，并跳过该无效 Skill。

## 建议读法

1. 先看 `resource-loader.ts` 的 `loadProjectContextFiles()`。
2. 再看 `buildSystemPrompt()` 中 Context File 与 Skill 的部分。
3. 沿 `skills.ts` 阅读 Skill Parsing 与 `formatSkillsForPrompt()`。
4. 阅读 Prompt Template Parsing 与 Argument Substitution。
5. 最后查看 `AgentHarness.createTurnState()`，观察 Loaded Resource 如何进入 Turn Snapshot。
