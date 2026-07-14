# 第 12 课 · Pi Package

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：Resource 加载前，把已配置 Package Source 解析成 Enabled Extension、Skill、Prompt Template 与 Theme 的 Resolver。

```text
package entries + installed file map + projectTrusted
  -> resolvePiPackages()
  -> enabled paths
       +-> Extension path -> explicit factory -> Extension runner
       +-> Skill path -------------------------> Context Resources
       +-> Prompt path ------------------------> explicit invocation catalog
       +-> Theme path -------------------------> selection only in s12
  -> the same MiniCoreRuntime
```

## 先搞懂：Package 解决的是分发，不是新的 Agent 机制

到 s11 为止，Harness 已能从已知 Path 加载 Extension、Skill 与 Prompt Template。若要分享一套 Workflow，还需要一个分发 Contract：给定一个 Package Source，哪些文件算 Resource，哪些被禁用，同一个 Package 同时出现在两个 Scope 时谁获胜？

Package 不会创造新的 Agent 机制。它只是在已有 Resource Loader 与 Extension Runtime 看到文件之前，完成 Resource Path 的选择与分组。难点在于不要混淆三种权力：

| 权力来源 | 决定什么 |
| --- | --- |
| Package Author | `pi` Manifest 导出的 Resource |
| Directory Convention | Manifest 规则允许时的 Fallback Discovery |
| Installer Configuration | Candidate 中哪些 Resource 保持 Enabled |

这是选择权，不是文件系统或执行安全边界。Manifest Entry 可以解析到 Package Directory 之外，选中的 Extension 仍拥有 Host Process 的权限。

## 思路：先解析 Path，再激活 Resource

s12 把 Package Resolution 与 Runtime Activation 分开。

`resolvePiPackages()` 接收规范化 File Map、User/Project Package Entry、Project Trust Decision，以及 Host 已放置好 Package Source 的 Root，返回四组 `ResolvedResource`。每个 Object 都保留 Path、Scope Metadata、Source 与 `enabled` Flag。

`createPackageRuntime()` 只激活 Enabled Resource：

| Resource | s12 如何处理 |
| --- | --- |
| Extension | 要求存在匹配的显式 `MiniExtensionSource` Factory，再载入 Extension Runner |
| Skill | 把 Path 加入真实 Context Resource Turn |
| Prompt | 加载 Catalog Metadata，只在调用 `invokePromptTemplate()` 时展开 Template |
| Theme | 在 `selection.themePaths` 中报告 Enabled Path；本课没有 TUI 应用它 |

只有 `projectTrusted` 为 true 时，Project Package 才进入 Resolution。同一 npm 或 Git Identity 同时出现时，Project Entry 会覆盖 User Entry。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s12 -- "使用 read_file 检查 package.json，并总结本课依赖。"
```

本节不安装 Package，只讲已经存在的 Package Resource 如何解析并配置真实 Runtime。CLI 传入空 Package List 与空 File Map，同时运行前面课程中的真实 Model、Session Tree、Extension Turn 与 Tool Loop。

要观察 Package 行为，先使用 Host 已经拥有的 File Map 与 Package Entry 调用 `resolvePiPackages()`，再把同一组输入交给 `createPackageRuntime()`。返回的 `selection` 会展示哪些 Resource Path 被启用，Runtime 与 Session 则会展示这些 Resource 如何影响 Turn。

## 代码怎么写的

### 1. 解析 Package Source 与 Scope

`resolvePackageSourcePath()` 会把配置 Source 映射到 Host 已经放好文件的位置：

| Source | User Scope | Project Scope |
| --- | --- | --- |
| `npm:name` | `~/.pi/agent/npm/node_modules/name` | `.pi/npm/node_modules/name` |
| Git Source | `~/.pi/agent/git/host/path` | `.pi/git/host/path` |
| Relative Local Path | 相对 Agent Directory | 相对项目 `.pi/` |
| Absolute Local File | 文件本身 | 文件本身 |

Local File 会被视为单个 Extension；Directory 则继续执行 Package Rule。缺失 Root 会被跳过，因为 s12 不执行 Install 或 Fetch。

Project Package 先参与处理，随后才是 User Package。`dedupePackageEntries()` 会跨 Scope 识别 npm 与 Git Source，因此 Project 版本获胜；Local Identity 则保留 Scope。

### 2. 合并 Manifest、Convention 与 Filter

精确规则取决于 Package Entry 的形式。

对 String Entry 而言，只要 `pi` Manifest 存在，它就是 Resource Selection 的权威：缺失或为空的 Key 不导出该类型 Resource；没有 Manifest 时，才使用 `extensions/`、`skills/`、`prompts/` 与 `themes/` Convention。

对带 Installer Filter 的 Object Entry：

- Filter Key 缺失时，使用已存在的 Manifest Key，包括空 Array；若 Manifest Key 不存在，则由 Convention 提供 Candidate；
- Filter Key 存在时，非空 Manifest Key 提供 Candidate；缺失或为空的 Manifest Key 会先回退到 Convention，再执行 Filter；
- Include 与 `!` Pattern 先选择或排除 Candidate，再按顺序执行精确的 `+` 与 `-` Override；
- Force-include 只能重新启用已知 Candidate，无法凭空创建 Candidate Set 之外的 Path。

Resolver 会在 Result 中保留 Disabled Candidate。Runtime Activation 前，以 `getEnabledPaths()` 作为边界。

### 3. 发现 Extension Entry，再要求显式 Factory

Extension Discovery 不会把每个嵌套 `.ts` 或 `.js` 文件都当成 Extension。它只接收 Top-level File、Child Directory 的 `index.ts`/`index.js`，或该 Child Directory Manifest 中显式声明的 Entry。被 Entry import 的 Helper 仍然只是 Helper。

Resolution 产出的是 Path，不是可执行 Module。`createPackageRuntime()` 会把每个 `extensionSources[].path` 映射到 Factory。Enabled Package Extension 没有匹配 Factory 时，构造立即失败：

```ts
const source = extensionByPath.get(normalizePath(path));
if (!source) {
  throw new Error("Missing extension factory for resolved package path: " + path);
}
```

显式 Factory Map 是本课的 Host Contract：它让执行资格可见，但不是 Sandbox。s12 不会动态 import 任意 TypeScript。

### 4. 把 Enabled Resource 接入真实 Turn

完成选择后，`createPackageRuntime()` 会组合 s10 已有的同一个 Runtime：

```ts
const prepared = await createPackageRuntime({
  files,
  userPackages: ["/packages/review"],
  projectPackages: [],
  projectTrusted: true,
  extensionSources: [{ path: extensionPath, factory: reviewExtension }],
  runtimeOptions,
});

await runPrintMode(prepared.runtime, "审查这次修改");
```

Enabled Extension 会注册真实 Tool 与 Hook；Enabled Skill 通过 s08 进入 System Prompt；Enabled Prompt File 会成为 `prepared.promptTemplates` 中的 Catalog Entry，普通 Turn 不会把 Template Body 注入 System Prompt。只有 `prepared.invokePromptTemplate(name, args)` 才会调用 s08 的 `formatPromptTemplateInvocation()`，把展开后的文本作为该 Turn 的 User Prompt 提交。在正常 Turn 中，Model Context 会包含 Skill 与 Tool，Package Tool 可以运行，真实 AgentMessage Session 也会记录 Tool Call 与 Tool Result。

Theme 仍是 Presentation Resource。Enabled Path 可以从 `selection.themePaths` 观察，但本课没有 Theme Renderer。

## 动手试一试

1. 给 String Package 添加 `pi` Manifest，但省略 `prompts`。再加入 Conventional Prompt File，确认它不会被导出。
2. 把同一 Source 改为带显式 Prompt Filter 的 Object Form，观察什么时候 Convention 会成为 Candidate Set，什么时候 Filter 会禁用 Path。
3. 在 Child Extension 的 `index.ts` 旁加入 `helper.ts`。`discoverExtensionEntries()` 应只选择 Entry Point。
4. 解析一个 Enabled Extension，却不把它加入 `extensionSources`。构造应失败，而不是偷偷 import。
5. 通过 `prepared.runtime` 提交一次普通 Prompt，再检查 Model 的 Tool List、System Prompt 与 AgentMessage Session。Extension 与 Skill 应影响该 Turn；Prompt Body 必须保持缺席，直到 `invokePromptTemplate()` 把它作为 User Input 提交。Theme 仍只是一份 Selection Data。
6. 把 `projectTrusted` 设为 false，确认 User Package 保留、Project Package 消失。

## 接入课程主线

| 边界 | s11 | s12 |
| --- | --- | --- |
| Trust | 决定 Project Input 是否参与 | 对整组 Project Package 执行 Gate |
| Resource Path | 直接 Project Path | 从 Package Source 中选择的 Path |
| Extension | Trusted Direct Extension Path | Enabled Package Path 加显式 Factory |
| Skill 与 Prompt | Trusted Direct Path | 加载 Enabled Path；Prompt Text 只在显式调用时进入 Turn |
| Theme | 未使用 | 解析并报告，但不渲染 |
| Core 与 Session | 一个真实累计 Runtime | 保持不变 |

## 对照 Pi 源码

Pi 0.79.1 使用相同 Resolver Model：npm、Git 与 Local Source 指向 Package Root；`package.json#pi` 与 Convention Directory 产生 Resource Candidate；Filter 决定 Enabled State；Project Trust 控制 Project Package；Project Scope 赢得重复 Identity；`ResourceLoader` 消费 Enabled Path。

真实 Pi 还会安装与更新 Package、动态加载 Extension Module、解析所有受支持的 Resource Type、报告 Diagnostic，并在 UI 中应用 Theme。s12 假设 File Map 已填充，使用显式 Factory Map，并把 Theme 保留为 Selection Data。

两种实现都没有把 Package Root 当作 Containment Boundary。Manifest Entry 是 Resource Selection Instruction，不是 Sandbox Rule。加载前应审查 Package Content；需要强隔离时，应使用外部 Container、VM、micro-VM、Remote Sandbox 或 OS Policy。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 13 课 · Integrated Harness](../s13_integrated_harness/) 会把 Project Trust、Direct 与 Packaged Resource、Extension、真实 Model、AgentMessage Session 与全部 Runtime Shell 组合成一个 Host-facing API。
