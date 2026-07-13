# s07 的 Pi 源码对照

s07 对应 Pi 的 session tree。

```text
append entry
  -> parentId points to current leaf
  -> leaf moves
  -> buildContext walks leaf -> root
  -> JSONL stores the tree
```

## 对应文件

- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/agent/src/harness/session/jsonl-storage.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/jsonl-storage.ts)
- [`packages/coding-agent/docs/session-format.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/session-format.md)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/session-manager.ts)

具体锚点：

```text
harness/types.ts:334-420           SessionTreeEntryBase、MessageEntry、LeafEntry
session.ts:22-80                   buildSessionContext(pathEntries)
session.ts:97-115                  getLeafId()、getBranch()、buildContext()
session.ts:132-139                 appendMessage() 用当前 leaf 作为 parentId
jsonl-storage.ts:109-110           leafIdAfterEntry()
jsonl-storage.ts:136-158           读取 JSONL 时逐行恢复 leafId
jsonl-storage.ts:226-243           setLeafId() 追加 leaf entry
jsonl-storage.ts:250-258           appendEntry() 追加 entry 并更新 currentLeafId
jsonl-storage.ts:275-287           getPathToRoot()
session-format.md:1-4              JSONL + id/parentId tree
session-format.md:171-181          entry base 字段
session-format.md:300-317          tree structure 和 context building
session-manager.ts:944-959         appendMessage() 的旧实现
session-manager.ts:1145-1167       getBranch() 和 buildSessionContext()
session-manager.ts:1235-1255       branch() / resetLeaf()
```

## 对应关系

| s07 | Pi |
| --- | --- |
| `MessageEntry` | `MessageEntry` / `SessionMessageEntry` |
| `LeafEntry` | `LeafEntry` |
| `appendMessage()` | `Session.appendMessage()` / `SessionManager.appendMessage()` |
| `branch()` | `Session.moveTo()` / `SessionManager.branch()` |
| `getBranch()` | `Session.getBranch()` / `SessionManager.getBranch()` |
| `buildContext()` | `buildSessionContext()` |
| `toJSONL()` | `JsonlSessionStorage` |
| `loadSessionTreeFromJSONL()` | `JsonlSessionStorage.open()` |

## 一个细节

Pi 现在有两条 session 相关代码线：

```text
packages/agent/src/harness/session/*
packages/coding-agent/src/core/session-manager.ts
```

`coding-agent` 里的 `SessionManager` 更像较早的产品实现：`branch()` 直接移动内存里的 leaf。

`packages/agent` 里的 `JsonlSessionStorage` 把 leaf 移动也写成 `LeafEntry`。本节采用这个写法，因为它更能说明 Pi 的 append-only 思想：连导航动作也可以作为一行 JSONL 记录下来。

## 本节暂时不做什么

s07 没有实现这些内容：

```text
compaction
branch_summary
label
session_info
custom entry
custom_message
真实文件系统写入
/fork 把某条分支复制成新 session 文件
/tree 的终端选择器
```

这些不是被忽略，而是之后再讲。

s07 只回答一个问题：为什么 Pi 的 session 不能只是 `messages[]`。

## 建议读法

先看 `harness/types.ts` 的 `SessionTreeEntryBase` 和 `LeafEntry`。

然后看 `jsonl-storage.ts` 的 `setLeafId()`。它会追加一条 `leaf` entry，并把 `currentLeafId` 指向 `targetId`。

最后看 `session.ts` 的 `buildSessionContext()`。它只从当前 path 里提取 message，所以同一个 JSONL 文件里可以有很多分支，但当前请求只会看到其中一条。
