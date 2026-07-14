# s07 的 Pi 0.79.1 源码对照

s07 对应 Pi 的 Append-only Session Tree 与 Context Materialization。

```text
JSONL entries -> parent links -> active leaf path -> AgentMessage[]
```

## 对应文件

- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/agent/src/harness/session/jsonl-storage.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/jsonl-storage.ts)
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/messages.ts)
- [`packages/coding-agent/docs/session-format.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/session-format.md)

## 对应关系

| s07 | Pi 0.79.1 |
| --- | --- |
| `SessionHeader` | JSONL Session Header |
| 带 `id` 和 `parentId` 的 `SessionEntry` | `SessionTreeEntry` |
| `MessageEntry` | `MessageEntry` |
| `LeafEntry` | `LeafEntry` |
| `BranchSummaryEntry` | `BranchSummaryEntry` |
| `CompactionEntry` | `CompactionEntry` |
| `appendMessage()` | `Session.appendMessage()` |
| `getBranch()` | `Session.getBranch()` 加 Storage 的 Path-to-root 查找 |
| `buildContext()` | `buildSessionContext()` |
| `toJSONL()` / `loadSessionTreeFromJSONL()` | 围绕 `JsonlSessionStorage` 的课程版边界 |

## Branch 与 Leaf 行为

Pi 的 Storage 把 Active Leaf 当作派生状态。追加普通 Entry 会把它推进到该 Entry；追加 `leaf` Row 则会把它恢复到 Row 的 Target。课程在 Branch 与加载 JSONL 时使用同一条规则。

因此，Branch 不会复制或删除 Message。它先记录导航，再让未来 Entry 使用选中的 Target 作为 Parent。

## Summary Entry 与 Context

Pi 的 `buildSessionContext()` 会扫描 Active Path，把 Session Entry 物化为 `AgentMessage[]`。Branch Summary 会变成 `BranchSummaryMessage`；存在 Compaction 时，一条 `CompactionSummaryMessage` 会位于保留的 Message Suffix 之前。

s07 重建的是这些 Storage 与 Materialization 语义。`appendBranchSummary()` 和 `appendCompaction()` 接收已经生成好的 Summary 文本与 Metadata。

## 明确的算法边界

本课不实现决定何时、如何生成摘要的系统：

```text
token threshold selection
compaction trigger
first-kept cut-point selection
summary prompt construction
summary model call
branch-summary generation
```

这些属于 Pi 的 Compaction 与 Branch Summarization 层，而不是 Session Tree 自身。s07 只证明结果 Entry 可以存在于 Append-only History 中，并正确进入 Active Context。

## 课程范围

Pi 支持更多 Entry Type，包括 Model Change、Thinking-level Change、Active-tool Change、Label、Custom Entry 和 Session Metadata，也有真正向文件追加内容的 Storage 实现。

课程只保留四种内容或导航 Entry，并把内存 Tree 序列化为 JSONL 文本。真实课程入口仍通过 s06 Session 接口使用这棵树，并持久化真实 Model-Tool Loop 产生的每条 Message。

## 建议读法

1. 先看 Harness Type 中的 `SessionTreeEntry`、`LeafEntry`、`BranchSummaryEntry` 与 `CompactionEntry`。
2. 继续看 `Session.getBranch()`、`Session.buildContext()` 和 `Session.appendMessage()`。
3. 阅读 `jsonl-storage.ts` 中的 Leaf 恢复与 Path-to-root 函数。
4. 最后看 `buildSessionContext()`，重点关注 Branch Summary 与 Compaction Materialization，而不是 Summary Generation。
