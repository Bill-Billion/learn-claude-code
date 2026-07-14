# s07 · Session Tree

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: append-only Session entries, JSONL storage, branch navigation, and Context materialization in the Harness Session layer.

```text
append-only entries + parentId + current leaf
                    |
                    +-> active root-to-leaf path -> AgentMessage[] -> s06 Harness Turn
```

## The problem

A flat Message array can continue a conversation, but it cannot preserve two answers to the same earlier question without copying or rewriting history. Coding sessions also need to record navigation and summaries without making old records silently disappear.

The model has the opposite need: it should not receive every abandoned branch. It needs one coherent Context for the active path.

## The idea

s07 stores a Session as a header followed by append-only entries:

```text
session
message
message
leaf
branch_summary
message
compaction
```

Every entry has an ID, a `parentId`, and a timestamp. `message` stores an `AgentMessage`; `leaf` records a navigation move; `branch_summary` and `compaction` store caller-supplied summaries. The in-memory leaf identifies the active position.

`buildContext()` walks only the active root-to-leaf path and materializes its entries back into `AgentMessage[]`.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s07
```

Or send one prompt directly:

```bash
npm run s07 -- "Use read_file to inspect README.md and summarize the learning phases."
```

The command runs the real model and `read_file` loop from s06, now backed by `createSessionTree()`. Exact output can vary. The stable change is storage: each User, Assistant, and Tool Result Message becomes a new `message` entry under the current leaf.

## How the code works

### 1. Append Messages under the current leaf

`appendMessage()` deep-clones the `AgentMessage`, sets its `parentId` to the current leaf, appends the entry, and advances the leaf to the new ID.

```text
e1 user
└─ e2 assistant  <- leaf
```

Old entries are never edited when the conversation grows.

### 2. Move the leaf without deleting a branch

`branch(entryId)` first appends a `leaf` entry that records the old position and target. It then moves the in-memory leaf to `entryId`. The next Message naturally becomes another child of that target:

```text
e1 user
├─ e2 assistant
└─ e4 assistant  <- leaf
```

The first answer remains addressable through `buildContext(e2)`; the active Context follows `e4`.

### 3. Materialize summary entries into Context

`appendBranchSummary(summary, fromId)` stores the supplied summary and the entry it describes. On the active path, `buildContext()` turns it into a `BranchSummaryMessage`.

`appendCompaction({ summary, firstKeptEntryId, tokensBefore })` records a supplied summary and retained suffix boundary. When that entry is the latest Compaction on the active path, Context begins with one `CompactionSummaryMessage`, followed by Messages from `firstKeptEntryId` onward.

This lesson implements entry storage and Context materialization only. It does not choose a token threshold, select the cut point, or generate either kind of summary. Callers provide those values.

### 4. Round-trip the append-only JSONL

`toJSONL()` emits the Session header and every entry as one JSON object per line. `loadSessionTreeFromJSONL()` validates references while rebuilding the entry map and leaf position.

The same Session object implements the s06 interface: `buildContext()`, `getMetadata()`, and `appendMessage()`. Therefore `runHarnessTurn()` can use the tree directly and persist each completed Message during the real Tool Loop.

## Try it yourself

1. Append one User Message and two alternative Assistant Messages by calling `branch()` between them. Compare `buildContext()` for both leaf IDs.
2. Serialize with `toJSONL()`, reload with `loadSessionTreeFromJSONL()`, and confirm the active Context and entry types are unchanged.
3. Add a Branch Summary after returning from an abandoned leaf. Then add a Compaction with a chosen retained boundary and inspect the resulting `AgentMessage` roles.

## Wiring into the main line

| Boundary | s06 | s07 |
| --- | --- | --- |
| Session storage | in-memory `AgentMessage[]` | append-only entry tree |
| Current position | end of the array | movable leaf |
| Alternatives | not represented | sibling branches through `parentId` |
| Summaries | Message types exist | summary entries materialize those Message types |
| Persistence format | none | JSONL header plus entries |
| Live execution | `runHarnessTurn()` | the same real Loop using `SessionTree` |

## Against the Pi source

The entry tree, leaf restoration, active-path Context, and materialization of Branch and Compaction Summaries map to Pi 0.79.1. Pi has more entry types and separate storage implementations; the lesson keeps the smallest set needed to expose the data model.

See [pi-source.md](pi-source.md) for the pinned source mapping and the exact boundary around summary generation.

## Next up

[s08 · Context Resources](../s08_context_resources/) loads project instructions, Skills, and Prompt Templates from filesystem-backed sources and includes them in the next Turn snapshot.
