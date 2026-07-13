# s11 的 Pi 源码对照

s11 对应 Pi 的 project trust 和执行环境边界。

```text
project trust
  -> decide whether project-local inputs load
  -> does not sandbox tools
  -> real isolation belongs to env / container / VM / custom operations
```

## 对应文件

- [`packages/coding-agent/docs/security.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/security.md)
- [`packages/coding-agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/README.md)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/trust-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/trust-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)
- [`packages/coding-agent/src/core/tools/write.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/write.ts)
- [`packages/coding-agent/src/core/tools/bash.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/bash.ts)
- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/extensions.md)

具体锚点：

```text
docs/security.md:3-7              Pi 以本地用户权限运行，project trust 不是 sandbox
docs/security.md:9-25             trust inputs、加载范围和非交互模式行为
docs/security.md:27-33            No Built-in Sandbox
docs/security.md:35-49            untrusted work 建议放进容器、VM、micro-VM 或受控 sandbox
README.md:294-304                 Project Trust 用户文档
README.md:497                     No permission popups
project-trust.ts:11               AppMode
project-trust.ts:45-95            resolveProjectTrusted()
trust-manager.ts:32-45            最近父目录 trust 决策
trust-manager.ts:58-87            trust 选项，包含 session only 和 trust parent folder
trust-manager.ts:174-190          hasProjectTrustInputs()
trust-manager.ts:193-229          ProjectTrustStore
resource-loader.ts:325-342        trust 前先加载 user/global 和 CLI extensions，再按 trust 状态 reload
resource-loader.ts:951-977        project SYSTEM.md / APPEND_SYSTEM.md 只有 trusted 时加载
read.ts:39-62                     ReadOperations 可替换，默认本地文件系统
write.ts:21-39                    WriteOperations 可替换，默认本地文件系统
bash.ts:36-66                     BashOperations 可替换
bash.ts:66-85                     默认本地 shell 后端
extensions.md:340-355             project_trust event
extensions.md:1905-1944           built-in tools 的 operations 可接 SSH、容器等远端（Gondolin 在 extensions.md:2638）
```

## 对应关系

| s11 | Pi |
| --- | --- |
| `hasProjectTrustInputs()` | `trust-manager.ts` 的 `hasProjectTrustInputs()` |
| `MiniTrustStore` | `ProjectTrustStore` |
| `resolveProjectTrusted()` | `project-trust.ts` 的 `resolveProjectTrusted()` |
| `extensionDecision` | `project_trust` extension event result |
| `loadProjectInputs()` | `ResourceLoader.reload()` 后按 trust 状态加载资源 |
| `createLocalExecutionEnv()` | read/write/bash 默认本地 operations |
| `createContainedExecutionEnv()` | 自定义 operations、容器、VM、Gondolin 这类外层执行策略 |

## 本节采用的简化

真实 Pi 的 trust 和执行环境比 s11 多很多内容：

```text
真实文件系统和 canonical path
trust.json 文件锁
trust parent folder / session only UI 选项
project_trust 事件的错误收集
settings reload 和 package manager resolve
AGENTS.md / CLAUDE.md 的完整向上查找规则
read / write / edit / bash 的完整渲染、截断、队列和 abort 处理
Gondolin、OpenShell、Docker 等具体执行后端
非交互判定：mini 用 mode !== "interactive"，Pi 实际看 projectTrustContext.hasUI
  （project-trust.ts:85）
```

s11 没有实现这些。它只保留一个关键区分：

```text
trust 是输入加载开关，不是执行权限边界
```

这个区分比多写几个安全检查更重要。否则读者很容易以为 `--no-approve` 就能保护文件系统，或者以为 trust 以后就一定安全。

## 和前几节的关系

```text
s08 Context Resources    讲资源怎样进入 turn state
s09 Extension Runtime    讲 extension 怎样注册能力
s10 Runtime Modes        讲非交互模式没有 UI prompt
s11 Trust Env            决定哪些项目本地资源和 extension 能被加载
```

所以 s11 是对 s08 到 s10 的补边界：资源和扩展不是无条件加载；运行模式不同，能不能询问用户也不同；但工具执行权限仍然来自进程所在的环境。

## 建议读法

先读 `docs/security.md`。它比源码更适合作为第一入口，因为这里直接说清楚 Pi 的安全模型。

再看 `project-trust.ts`。这段代码短，能看到 override、extension decision、saved decision、defaultProjectTrust 和 UI prompt 的顺序。

最后看 `read.ts`、`write.ts`、`bash.ts` 里的 operations 接口。Pi 没有把 sandbox 写死在内核里，而是允许把工具执行换到别的后端。
