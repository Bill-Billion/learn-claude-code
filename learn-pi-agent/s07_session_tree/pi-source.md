# Pi Source Map for s07

s07 corresponds to Pi's session tree.

```text
append entry
  -> parentId points to current leaf
  -> leaf moves
  -> buildContext walks leaf -> root
  -> JSONL stores the tree
```

## Files

- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/agent/src/harness/session/jsonl-storage.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/jsonl-storage.ts)
- [`packages/coding-agent/docs/session-format.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/session-format.md)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/session-manager.ts)

Specific anchors:

```text
harness/types.ts:334-420           SessionTreeEntryBase, MessageEntry, LeafEntry
session.ts:22-80                   buildSessionContext(pathEntries)
session.ts:97-115                  getLeafId(), getBranch(), buildContext()
session.ts:132-139                 appendMessage() uses the current leaf as parentId
jsonl-storage.ts:109-110           leafIdAfterEntry()
jsonl-storage.ts:136-158           restoring leafId row by row while reading JSONL
jsonl-storage.ts:226-243           setLeafId() appends a leaf entry
jsonl-storage.ts:250-258           appendEntry() appends an entry and updates currentLeafId
jsonl-storage.ts:275-287           getPathToRoot()
session-format.md:1-4              JSONL + id/parentId tree
session-format.md:171-181          entry base fields
session-format.md:300-317          tree structure and context building
session-manager.ts:944-959         the older appendMessage() implementation
session-manager.ts:1145-1167       getBranch() and buildSessionContext()
session-manager.ts:1235-1255       branch() / resetLeaf()
```

## Mapping

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

## One detail

Pi currently has two session-related code lines:

```text
packages/agent/src/harness/session/*
packages/coding-agent/src/core/session-manager.ts
```

The `SessionManager` in `coding-agent` looks more like the earlier product implementation: `branch()` moves the in-memory leaf directly.

The `JsonlSessionStorage` in `packages/agent` writes the leaf move out as a `LeafEntry` too. This section adopts that style, because it better illustrates Pi's append-only idea: even a navigation action can be recorded as one line of JSONL.

## What s07 doesn't do yet

s07 does not implement any of this:

```text
compaction
branch_summary
label
session_info
custom entry
custom_message
real filesystem writes
/fork copying a branch into a new session file
/tree's terminal picker
```

None of these are being ignored — they come later.

s07 answers one question only: why Pi's session cannot just be a `messages[]`.

## Suggested reading path

Start with `SessionTreeEntryBase` and `LeafEntry` in `harness/types.ts`.

Then look at `setLeafId()` in `jsonl-storage.ts`. It appends a `leaf` entry and points `currentLeafId` at `targetId`.

Finish with `buildSessionContext()` in `session.ts`. It extracts messages from the current path only, which is why one JSONL file can hold many branches while the current request only ever sees one of them.
