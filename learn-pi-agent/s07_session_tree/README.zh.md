# 第 7 课 · Session Tree

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：Harness Session 层的 Append-only Session Entry、JSONL Storage、Branch Navigation 与 Context Materialization。

```text
append-only entries + parentId + current leaf
                    |
                    +-> active root-to-leaf path -> AgentMessage[] -> s06 Harness Turn
```

## 先搞懂：为什么 Message Array 不足以保存分支历史

扁平 Message Array 可以延续对话，却无法在不复制或改写历史的前提下，为同一个旧问题保留两个回答。Coding Session 还需要记录导航与摘要，同时不能让旧记录悄悄消失。

模型的需求正好相反：它不应该收到所有已放弃 Branch，而只需要 Active Path 上一份连贯的 Context。

## 思路：用 Append-only Entry Tree 保存 Session

s07 把 Session 保存为 Header 加一组只能追加的 Entry：

```text
session
message
message
leaf
branch_summary
message
compaction
```

每个 Entry 都有 ID、`parentId` 与时间戳。`message` 保存 `AgentMessage`；`leaf` 记录一次导航；`branch_summary` 与 `compaction` 保存调用方提供的 Summary。内存中的 Leaf 表示 Active Position。

`buildContext()` 只遍历 Active Root-to-leaf Path，再把沿途 Entry 物化成 `AgentMessage[]`。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s07
```

也可以直接发送一次 Prompt：

```bash
npm run s07 -- "使用 read_file 检查 README.md，并总结学习阶段。"
```

这条命令运行 s06 的真实模型与 `read_file` Loop，但 Session 现在由 `createSessionTree()` 提供。具体输出可能变化；稳定变化在存储层：每条 User、Assistant 和 Tool Result Message 都会成为当前 Leaf 下的新 `message` Entry。

## 代码怎么写的

### 1. 在当前 Leaf 下追加 Message

`appendMessage()` 会深拷贝 `AgentMessage`，把 `parentId` 设为当前 Leaf，追加 Entry，再把 Leaf 推进到新 ID。

```text
e1 user
└─ e2 assistant  <- leaf
```

对话继续增长时，旧 Entry 永远不会被改写。

### 2. 移动 Leaf，但不删除 Branch

`branch(entryId)` 会先追加一条 `leaf` Entry，记录旧位置与目标，再把内存 Leaf 移到 `entryId`。下一条 Message 自然成为目标的另一个 Child：

```text
e1 user
├─ e2 assistant
└─ e4 assistant  <- leaf
```

第一个回答仍可通过 `buildContext(e2)` 访问；Active Context 则沿着 `e4`。

### 3. 把 Summary Entry 物化进 Context

`appendBranchSummary(summary, fromId)` 保存外部提供的 Summary，以及它描述的 Entry。该 Entry 位于 Active Path 时，`buildContext()` 会把它变成 `BranchSummaryMessage`。

`appendCompaction({ summary, firstKeptEntryId, tokensBefore })` 记录外部提供的 Summary 与 Retained Suffix Boundary。当它是 Active Path 上最新的 Compaction 时，Context 会以一条 `CompactionSummaryMessage` 开始，后接从 `firstKeptEntryId` 起保留的 Message。

本课只实现 Entry Storage 与 Context Materialization。它不会选择 Token Threshold、决定 Cut Point，也不会生成任一种 Summary；这些值都由调用方提供。

### 4. 让 Append-only JSONL 往返一致

`toJSONL()` 会把 Session Header 与所有 Entry 按每行一个 JSON Object 输出。`loadSessionTreeFromJSONL()` 在重建 Entry Map 和 Leaf Position 时校验引用。

同一个 Session Object 实现 s06 所需的 `buildContext()`、`getMetadata()` 与 `appendMessage()`。因此 `runHarnessTurn()` 可以直接使用这棵树，并在真实 Tool Loop 中逐条持久化已完成 Message。

## 动手试一试

1. 追加一条 User Message，并在两条 Assistant Message 之间调用 `branch()`，再比较两个 Leaf ID 的 `buildContext()`。
2. 用 `toJSONL()` 序列化，再用 `loadSessionTreeFromJSONL()` 重载，确认 Active Context 与 Entry Type 不变。
3. 从放弃的 Leaf 返回后加入 Branch Summary，再用自己选择的 Retained Boundary 加入 Compaction，观察最终 `AgentMessage` Role。

## 接入课程主线

| 边界 | s06 | s07 |
| --- | --- | --- |
| Session Storage | 内存 `AgentMessage[]` | Append-only Entry Tree |
| 当前位置 | Array 末尾 | 可移动 Leaf |
| 备选历史 | 无法表达 | 通过 `parentId` 形成 Sibling Branch |
| Summary | 已有 Message Type | Summary Entry 物化成这些 Message Type |
| 持久化格式 | 无 | JSONL Header 加 Entry |
| 真实执行 | `runHarnessTurn()` | 同一条真实 Loop 使用 `SessionTree` |

## 对照 Pi 源码

Entry Tree、Leaf 恢复、Active Path Context，以及 Branch 与 Compaction Summary 的物化都对应 Pi 0.79.1。Pi 有更多 Entry Type 与独立 Storage 实现；课程只保留展示数据模型所需的最小集合。

固定源码映射与 Summary Generation 的准确边界见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 8 课 · Context Resources](../s08_context_resources/) 会从 Filesystem-backed Source 加载项目指令、Skill 与 Prompt Template，并把它们放进下一份 Turn Snapshot。
