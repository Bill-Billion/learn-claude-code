# 第 8 课 · Context Resources

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：Coding Agent 的 Resource Loader 与 System Prompt Builder，它们会把 Context File、Skill 和 Prompt Template 送入 Harness。

```text
filesystem source -> context files + skills + prompt templates
                                  |
                                  +-> system prompt + TurnState resources -> 真实 Harness Turn
```

## 先搞懂：为什么 Tool Loop 还不够理解项目

仅有 Tool Loop 不足以在仓库内工作。模型还需要项目指令、按需读取的专业 Skill 列表，以及可复用的 Prompt Template。

把这些内容硬编码进 Agent Loop 会混合产品 Policy 与执行逻辑。把所有可能文件都塞进每次请求则会浪费 Context，也很难解释来源。Resource 需要独立的加载边界。

## 思路：把 Context File、Skill 与 Prompt Template 分开加载

s08 引入三种 Resource：

```text
ContextFile     插入 System Prompt 的项目指令
ContextSkill    从 Skill 文件加载的名称、描述、位置与正文
PromptTemplate  支持位置参数替换的可复用 Prompt 文本
```

`ResourceSource` 负责提供文本。课程的生产入口使用 `createFileSystemResourceSource()` 读取真实文件。`prepareContextResources()` 会把加载结果转换为 s06 Harness Shape 与动态 System Prompt。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s08
```

也可以直接发送一次 Prompt：

```bash
npm run s08 -- "使用 read_file 检查仓库 README，并遵循其中的项目指令。"
```

CLI 会从真实 Filesystem 读取 Context File、建立 Turn Snapshot，并运行同一条真实 `read_file` Loop。模型措辞与 Tool 选择可能变化。显式 Skill 和 Prompt Template 路径通过 API 提供，与默认 CLI 配置分开练习。

## 代码怎么写的

### 1. 从真实 Source 加载 Context File

`createFileSystemResourceSource()` 包装 `readFile(path, "utf8")`，只把文件不存在视为缺席。`loadProjectContextFiles()` 先检查 Agent Directory，再从 Filesystem Root 到 `cwd` 逐级检查 Ancestor。

每个目录中，第一个存在的候选文件生效：

```text
AGENTS.md
AGENTS.MD
CLAUDE.md
CLAUDE.MD
```

返回的 `ContextFile` 同时保留 Path 与 Content，因此 System Prompt 可以展示每条指令来自哪里。

### 2. 解析 Skill 与 Prompt Template

Skill 和 Prompt Template Path 是显式输入。`loadSkill()` 解析精简 Frontmatter，要求存在 Description，并保留 Body 与 File Path。带 `disable-model-invocation: true` 的 Skill 会被加载，但不会向模型展示。

`loadPromptTemplate()` 从文件名得到 Name 并保存 Body。`formatPromptTemplateInvocation()` 会单趟展开 `$1`、`$2`、`$@` 与 `$ARGUMENTS`，因此参数值里看似 Placeholder 的文本不会再次展开。

### 3. 在 Snapshot 时构造 System Prompt

`buildContextSystemPrompt()` 加入当前 Working Directory，并用带 Path 的 `project_instructions` Block 包住每个 Context File。只有 `read` 或 `read_file` 处于 Active 状态时，它才列出模型可见 Skill，因为模型必须能打开对应文件。

`prepareContextResources()` 返回：

```ts
{
  contextResources, // 产品层使用的完整加载值
  harnessResources, // TurnState 使用的 Skill 与 Prompt Template Metadata
  systemPrompt,     // 根据 Active Tool Set 解析的 Callback
}
```

这样，Resource Loading 保持在 Agent Loop 外部，而最终 Prompt 仍可依赖当前 Turn。

### 4. 运行同一条真实 Harness Turn

`runContextResourceTurn()` 会准备 Resource，再把得到的 System Prompt 与 Harness Resource 交给 `runHarnessTurn()`。它不会创建第二条 Loop。

真实路径仍然是：

```text
filesystem Context -> TurnState -> model -> read_file -> Tool Result -> model
```

User、Assistant 和 Tool Result Message 仍通过 s07 Session Tree 持久化。

## 动手试一试

1. 在 Parent Directory 加入 `AGENTS.md`，在 Working Directory 加入 `CLAUDE.md`，观察 `contextResources.contextFiles` 与 System Prompt 顺序。
2. 传入带 `disable-model-invocation: true` 的 Skill 文件，再移除该字段，对比已加载 Skill List 与 `available_skills` Block。
3. 加载包含 `Fix $1 with focus on $@` 的 Prompt Template，并用两个参数调用 `formatPromptTemplateInvocation()`。

## 接入课程主线

| 边界 | s07 | s08 |
| --- | --- | --- |
| Session Context | Active `AgentMessage[]` | 同一份 Active History |
| 项目指令 | 无 | Filesystem-backed Context File |
| 专业指导 | 无 | 按需展示的显式 Skill File |
| 可复用 Prompt | 无 | 单趟替换的 Prompt Template |
| System Prompt | 通用或调用方提供 | 由 `cwd`、Active Tool、Context File 与 Skill 构造 |
| 真实执行 | Session Tree 加 `runHarnessTurn()` | 带 Prepared Resource 的同一路径 |

## 对照 Pi 源码

Context File 顺序、带 Path 的 System Prompt Section、Skill 可见性与 Prompt Template 替换都对应 Pi 0.79.1。课程使用显式 Skill 与 Prompt Path，没有重建 Pi 的 Package Resolution、Diagnostic、Trust 与 Reload 机制。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 9 课 · Extension Runtime](../s09_extension_runtime/) 会让外部 Factory 注册 Tool、Command 与 Event，并让 Extension 带来源信息地贡献 Resource Path。
