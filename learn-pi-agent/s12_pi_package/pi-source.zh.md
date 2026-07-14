# s12 的 Pi 0.79.1 源码对照

s12 重建 Package Resolver，并把它的 Enabled Output 接入真实课程 Runtime。

```text
configured package source
  -> installed package root
  -> manifest / conventions / filters
  -> enabled resource paths
  -> Resource and Extension loading
```

## 对应文件

- [`packages/coding-agent/docs/packages.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/packages.md)
- [`packages/coding-agent/docs/security.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/security.md)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)

## 对应关系

| s12 | Pi 0.79.1 |
| --- | --- |
| `PiManifest` 与 `createPackageManifest()` | Package `package.json` 中的 `pi` Field |
| `PackageEntry` | String 与 Object-filter Package Source |
| `resolvePiPackages()` | `DefaultPackageManager.resolve()` 中的 Package Source 与 Resource Path 部分 |
| `discoverExtensionEntries()` | `collectAutoExtensionEntries()` 与 `resolveExtensionEntries()` |
| `applyPatterns()` | Include、Exclude、Force-include 与 Force-exclude Filter |
| `projectTrusted` | Package Manager 的 `SettingsManager.isProjectTrusted()` Gate |
| `ResolvedResource.metadata` 与 `enabled` | Pi 的 Resolved Path Metadata 与 Enabled State |
| 显式 `extensionSources` | Pi Extension Loader 完成后已加载的 Extension Module |
| `promptTemplates` 与 `invokePromptTemplate()` | 已加载 Prompt Template 与显式 `expandPromptTemplate()` Invocation |
| `selection.themePaths` | Pi Resource Loader 与 UI 消费的 Enabled Theme Path |

## Package Selection 优先级

Pi 会把 npm、Git 与 Local Source 解析到已安装 Root。Local File 是单个 Extension，Local Directory 继续执行 Package Rule。本课用 `MiniFiles` 表示这些 Root，不执行 Installation 或 Update。

两种实现保留以下主规则：

1. Project Package 只在 Project Trust 通过后加入。
2. 相同 npm 或 Git Identity 会去重，Project Scope 获胜。
3. String Package 存在 `pi` Manifest 时，把它作为 Selection Contract；省略的 Resource Key 不会 Fallback。
4. 没有 Manifest 时，发现 Conventional Resource Directory。
5. Object-form Filter 按 Manifest 与 Fallback Rule 选择并启用 Candidate。

本课让 Local Identity 保留 Scope，而 Pi 根据 Resolved Path 生成 Identity。这是实现差异，不会增加新的 Resource 类型。

## Resource Discovery 与 Filtering

Pi 发现的是 Extension Entry Point，不会递归地把每个 Source File 都当成 Extension。Top-level `.ts`/`.js`、Child `index.ts`/`index.js` 与显式 Manifest Entry 可以加载；嵌套 Helper 不会变成独立 Extension。

对所有 Resource Type，Filter 都只作用于 Candidate Set。Include/Exclude Glob 先执行，精确 `+`/`-` Override 随后执行。Skill Filter 还会匹配 `SKILL.md` 的 Parent Directory Identity。s12 使用 Node `path.posix.matchesGlob()` 代替 Pi 的 Matching Library，但保留测试覆盖的 Candidate 行为。

`+` Override 无法引入从未成为 Candidate 的 Path。这只是 Resolver Rule，不是 Containment。Pi 会直接解析 Manifest Entry，包括 `..` Segment，并不强制 Result 留在 `packageRoot` 之下；课程的规范化 Join 同样不承诺 Package-root Isolation。

## 从 Enabled Path 到真实 Turn

Pi 的 `ResourceLoader` 接收 Enabled Package Path，随后加载 Extension Module、Skill、Prompt Template 与 Theme。s12 把 Host Boundary 显式化：

- 每个 Enabled Extension Path 都必须匹配 `extensionSources` 中提供的 Factory；
- Enabled Skill Path 进入真实 s08 Context Resource Flow；
- Enabled Prompt Path 被解析成 `promptTemplates`；
- `invokePromptTemplate()` 展开一个选定 Template，再把它作为 User Prompt 提交；
- Enabled Theme Path 会返回，但不会渲染。

普通 Turn 绝不会在 System Prompt 中收到全部 Prompt Template Body。这与 Pi 一致：`AgentSession.prompt()` 只在显式调用 Named Slash Prompt 时，通过 `expandPromptTemplate()` 展开该 Template。

显式 Factory Map 代替 Pi 的动态 Extension Module Loader。Factory 缺失时构造失败，不会静默 import Source Code。

## 课程范围

真实 Package Manager 还负责 Installation、Update、Settings Persistence、Dependency Handling、Diagnostic，以及更多 Source 之间的 Resource Precedence。本课从已填充的 File Map 开始，只实现解释哪些 Path 生效所需的 Resolution Rule。

真实 Pi 也会解析并应用 Theme，而 s12 只报告 `themePaths`。选择结束后，课程使用真实 Model、Tool Loop、Extension Runner 与 AgentMessage Session；Package Layer 不会替换 Agent Core。

Package Resolution 不提供 Path 或 Execution Isolation。Project Trust 决定 Project Package 是否可以加载，但它不是 Sandbox。Package Extension 拥有进程权限。强隔离应由外部 Container、VM、micro-VM、Remote Sandbox 或 OS Policy 提供。

## 建议读法

1. 先读 `docs/packages.md` 的 Package Sources、Creating a Pi Package、Package Structure 与 Package Filtering。
2. 跟踪 `package-manager.ts` 中的 `resolvePackageSources()` 与 `dedupePackages()`。
3. 阅读 `collectPackageResources()`、`collectDefaultResources()` 与 `collectManifestFiles()`。
4. 继续看 Extension Entry Discovery 与 `applyPatterns()`。
5. 沿 Enabled Path 进入 `ResourceLoader.reload()` 与 `extensions/loader.ts`。
6. 最后阅读 `loadPromptTemplates()`、`expandPromptTemplate()`，以及 `AgentSession.prompt()` 中的显式展开分支。
