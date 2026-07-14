# s07 against the Pi 0.79.1 source

s07 maps to Pi's append-only Session tree and Context materialization.

```text
JSONL entries -> parent links -> active leaf path -> AgentMessage[]
```

## Corresponding files

- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/agent/src/harness/session/jsonl-storage.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/jsonl-storage.ts)
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/messages.ts)
- [`packages/coding-agent/docs/session-format.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/session-format.md)

## The mapping

| s07 | Pi 0.79.1 |
| --- | --- |
| `SessionHeader` | JSONL Session header |
| `SessionEntry` with `id` and `parentId` | `SessionTreeEntry` |
| `MessageEntry` | `MessageEntry` |
| `LeafEntry` | `LeafEntry` |
| `BranchSummaryEntry` | `BranchSummaryEntry` |
| `CompactionEntry` | `CompactionEntry` |
| `appendMessage()` | `Session.appendMessage()` |
| `getBranch()` | `Session.getBranch()` plus storage path-to-root lookup |
| `buildContext()` | `buildSessionContext()` |
| `toJSONL()` / `loadSessionTreeFromJSONL()` | the lesson-sized boundary around `JsonlSessionStorage` |

## Branch and leaf behavior

Pi's Storage treats the active leaf as derived state. Appending a normal entry advances it to that entry; appending a `leaf` row restores it to the row's target. The course uses the same rule when branching and when loading JSONL.

A branch therefore does not duplicate or delete Messages. It records navigation, then lets future entries use the selected target as their parent.

## Summary entries and Context

Pi's `buildSessionContext()` scans the active path and materializes session entries into `AgentMessage[]`. A Branch Summary becomes a `BranchSummaryMessage`. When Compaction is present, a `CompactionSummaryMessage` precedes the retained Message suffix.

s07 reconstructs those storage and materialization semantics. Its `appendBranchSummary()` and `appendCompaction()` accept already-produced Summary text and metadata.

## Deliberate algorithm boundary

This lesson does not implement the systems that decide when or how to summarize:

```text
token threshold selection
compaction trigger
first-kept cut-point selection
summary prompt construction
summary model call
branch-summary generation
```

Those belong to Pi's Compaction and Branch Summarization layers, not to the Session tree itself. s07 only proves that the resulting entries can exist in append-only history and enter the active Context correctly.

## Course scope

Pi supports more Entry types, including model changes, thinking-level changes, active-tool changes, labels, custom entries, and Session metadata. It also has Storage implementations that append to real files.

The course keeps four content/navigation Entry types and serializes the in-memory tree to JSONL text. The live lesson still uses that tree through the s06 Session interface and persists each Message produced by the real model-tool loop.

## Suggested reading order

1. Read `SessionTreeEntry`, `LeafEntry`, `BranchSummaryEntry`, and `CompactionEntry` in Harness types.
2. Follow `Session.getBranch()`, `Session.buildContext()`, and `Session.appendMessage()`.
3. Read the leaf restoration and path-to-root functions in `jsonl-storage.ts`.
4. Finish with `buildSessionContext()`, concentrating on Branch Summary and Compaction materialization rather than summary generation.
