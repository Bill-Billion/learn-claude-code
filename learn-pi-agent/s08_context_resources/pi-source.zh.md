# s08 的 Pi 源码对照

s08 对应 Pi 的 context resources。

```text
resource loader
  -> context files / skills / prompt templates
  -> build system prompt
  -> createTurnState()
```

## 对应文件

- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/system-prompt.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/system-prompt.ts)
- [`packages/coding-agent/src/core/skills.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/skills.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)

具体锚点：

```text
resource-loader.ts:61-77       在目录里找 AGENTS.md / CLAUDE.md
resource-loader.ts:79-117      loadProjectContextFiles() 的全局 + 祖先目录顺序
resource-loader.ts:261-283     getSkills() / getPrompts() / getAgentsFiles()
resource-loader.ts:333-425     reload() 里解析 extensions、skills、prompts
system-prompt.ts:8-25          BuildSystemPromptOptions
system-prompt.ts:60-74         custom prompt 下追加 context files 和 skills
system-prompt.ts:153-166       default prompt 下追加 context files 和 skills
agent-harness.ts:331-362       createTurnState() 读取 resources 并生成 systemPrompt
agent-harness.ts:981-995       getResources() / setResources()
harness/types.ts:46-78         Skill、PromptTemplate、AgentHarnessResources
harness/types.ts:804-820       AgentHarnessOptions.resources 和 systemPrompt callback
```

## 对应关系

| s08 | Pi |
| --- | --- |
| `MemoryFiles` | 本地文件系统和 settings/package manager |
| `loadContextResources()` | `DefaultResourceLoader.reload()` |
| `loadProjectContextFiles()` | `loadProjectContextFiles()` |
| `ContextSkill` | `Skill` |
| `ContextPromptTemplate` | `PromptTemplate` |
| `formatSkillsForSystemPrompt()` | `formatSkillsForPrompt()` / `formatSkillsForSystemPrompt()` |
| `buildContextSystemPrompt()` | `buildSystemPrompt()` |
| `createContextResourceTurnState()` | `AgentHarness.createTurnState()` |

## 本节为什么不扫描真实目录

真实 Pi 的资源来源很多：

```text
~/.pi/agent/AGENTS.md
父目录和当前目录的 AGENTS.md / CLAUDE.md
~/.pi/agent/skills
.pi/skills
.agents/skills
~/.pi/agent/prompts
.pi/prompts
pi package
extension 动态补充的资源路径
CLI 临时路径
```

如果 s08 一上来就复刻这些路径，读者会被文件扫描细节带走。教学代码先用显式路径模拟资源输入，只保留 Pi 的核心边界：

```text
context files 进入 system prompt
skills 先以索引形式进入 system prompt
prompt templates 留给显式调用
harness 每轮拿 resources 快照
```

## 一个容易混的点

`AgentHarnessResources` 只有两类：

```text
skills
promptTemplates
```

`AGENTS.md` 这类 context files 在 coding-agent 外层被拼进 system prompt，不是 `AgentHarnessResources` 的字段。

s08 的 `ContextResourceTurnState` 额外返回 `contextFiles`，只是为了让 demo 和测试能看见它们。真实 Pi 里，context files 会通过 `buildSystemPrompt()` 进入 `systemPrompt`。

## 本节暂时不做什么

s08 没有实现这些内容：

```text
project trust
resource diagnostics
settings manager
package manager
extension resources_discover
theme loading
真实文件系统扫描
完整 YAML frontmatter
复杂 prompt template 占位符（${N:-default}、${@:N} 这类 bash 式语法）
```

占位符替换本身 mini 已和 Pi 对齐：单趟替换，参数值里的 `$1`、`$@`、`$ARGUMENTS` 不会被二次展开（Pi `prompt-templates.ts:67` 注释明确了这条性质）。

两个行为差异要知道：skill 缺 description 时 mini 直接抛错，Pi 是记 warning diagnostic 并跳过该 skill 继续加载（`skills.ts:290-307`）；另外 coding-agent 层的 `Skill` 类型没有 content 字段（`skills.ts:74-81`，正文靠模型现读文件），harness 层的 `Skill` 才有 content——mini 的 `ContextSkill` 载了 content 但传给 harness 前会剥掉。

这些后面分开讲。s08 只回答一个问题：除了 session messages，一轮请求还需要哪些项目资源。

## 建议读法

先看 `resource-loader.ts` 的 `loadProjectContextFiles()`，确认 `AGENTS.md` 和 `CLAUDE.md` 的加载顺序。

然后看 `system-prompt.ts`，注意 skills 只有在 `read` 工具可用时才会追加到 prompt。

最后看 `agent-harness.ts` 的 `createTurnState()`。它不负责扫描文件，只读取已经准备好的 resources，并把它们交给 system prompt callback。
