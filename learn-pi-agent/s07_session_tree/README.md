# s07 · Session Tree

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s06](../s06_turn_state/README.md) · [Contents](../README.md) · [s08 →](../s08_context_resources/README.md)

> In one sentence: a session isn't a list of messages — it's an append-only entry tree, and the current conversation position is decided by a movable leaf pointer.
>
> Where this sits in Pi: the session layer of the `@earendil-works/pi-agent-core` harness (`session.ts` + `jsonl-storage.ts`); `/tree`, `/fork`, and `/clone` in `pi-coding-agent` are all built on top of it.

→ Go back to an old question and take a different path — nothing copied, nothing deleted, just one appended leaf-pointer record
→ Even the "move the leaf" navigation itself is one row in the JSONL; history is never rewritten, start to finish
→ The model only sees the path from leaf to root; old branches stay in the file but stay out of the current request
→ Precisely because it's append-only and never rewritten, any JSONL file can fully rebuild the whole tree and the leaf position

---

## The problem

Picture a perfectly ordinary session:

```text
You ask: where should I start reading this repo?
Pi answers: start with the README.
That doesn't feel right, so you want to go back to that question and try another path.
```

If the session is just a `messages[]`, you're stuck with three clumsy options:

```text
overwrite the old answer          history is gone; nothing left to compare when you want both paths side by side
copy the whole session            the file doubles, and the two histories drift apart from then on
stuff both paths into one list    the model sees two contradictory answers at the same time
```

All three are patching the same defect: a flat array cannot express "history forked here."

## The idea

Pi picked a fourth way: history is never rewritten — entries only ever get appended; every entry remembers its `parentId`; the current conversation position is decided by a leaf pointer. Want to go back and take another path? Move the leaf back there, and let new messages attach at that point.

So `/tree`, `/fork`, and `/clone` aren't little UI features — behind all of them is the same data structure: a conversation treated as a tree that can fork.

Real Pi has many entry types (`compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`...). s07 keeps just two, `message` and `leaf`, to capture the skeleton of the tree.

## Run it first

```sh
npm run session:s07
```

The output looks like this:

```text
Session: demo-session
Old branch: How should Pi store sessions? -> As a plain message list.
Active branch: How should Pi store sessions? -> As an append-only entry tree with a movable leaf.
Current leaf: e4
Children of question: e2, e4
JSONL row types: session -> message -> message -> leaf -> message
New answer parent: e1
```

Look at `Children of question: e2, e4` — the same question has two assistant answers hanging off it. That's a branch. The old answer (Old branch) can still be read in full, but the current branch (Active branch) already carries different content.

Hold on to that `leaf` row in the middle of `JSONL row types`: it's a navigation record, and you'll see how it gets created when branching comes up below.

## How the code works

### Two kinds of entry

```ts
export type MessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: SessionMessage;
};

export type LeafEntry = {
  type: "leaf";
  id: string;
  parentId: string | null;
  timestamp: string;
  targetId: string | null;
};
```

`message` is conversation content, `leaf` is a navigation record. Both carry a `parentId` — the tree grows on this field.

### appendMessage: new messages attach after the current leaf

```ts
appendMessage(message: SessionMessage): string {
  const entry: MessageEntry = {
    type: "message",
    id: this.createEntryId(),
    parentId: this.leafId,
    timestamp: this.now(),
    message: { ...message },
  };

  this.appendEntry(entry);
  this.leafId = entry.id;
  return entry.id;
}
```

Whatever the current `leafId` is, that's the new message's `parentId`; once appended, the leaf moves onto the new message:

```text
e1 user
└─ e2 assistant  ← leaf
```

### branch: no copying, no deleting — just move the leaf

```ts
branch(entryId: string): string {
  if (!this.byId.has(entryId)) {
    throw new Error(`Entry ${entryId} not found`);
  }
  return this.moveLeaf(entryId);
}
```

`branch()` hands the work to `moveLeaf()`, which boils down to two steps — append a `LeafEntry` (touching no historical entry), then point the in-memory `leafId` at `targetId`:

```ts
private moveLeaf(targetId: string | null): string {
  const entry: LeafEntry = {
    type: "leaf",
    id: this.createEntryId(),
    parentId: this.leafId,
    timestamp: this.now(),
    targetId,
  };

  this.appendEntry(entry);
  this.leafId = targetId;
  return entry.id;
}
```

That `leaf` row in the demo output is exactly this record: its `parentId` points to where the leaf was before the move, its `targetId` points to where it moved back to. The next appended message reads the already-changed `leafId` and naturally attaches at the new position, growing into a sibling branch:

```text
e1 user
├─ e2 assistant
└─ e4 assistant  ← leaf
```

The old branch doesn't move an inch; only the current branch changed. That's the cost and the payoff of Pi's "never overwrite an old answer": one extra pointer row, in exchange for history preserved in full.

### buildContext: the model only sees the current branch

```ts
buildContext(fromId: string | null = this.leafId): SessionContext {
  return {
    messages: this.getBranch(fromId)
      .filter((entry): entry is MessageEntry => entry.type === "message")
      .map((entry) => ({ ...entry.message })),
  };
}
```

The model doesn't need the whole tree — just the messages on the path from leaf to root. On the active branch, the demo sees only:

```text
How should Pi store sessions?
As an append-only entry tree with a movable leaf.
```

The old answer is still in the JSONL, but it never gets sent with the current request.

### JSONL: write it out, read it back

```ts
toJSONL(): string {
  return [this.header, ...this.entries].map((row) => JSON.stringify(row)).join("\n") + "\n";
}
```

One object per line, always appended. After a fork, the row types read:

```text
session -> message -> message -> leaf -> message
```

Not one old message was touched — the `leaf` row merely recorded a navigation.

Reading it back is `loadSessionTreeFromJSONL()`. It scans the JSONL line by line, and after the robustness checks (parent exists, leaf target exists, type is valid), the core is these four lines:

```ts
const entry = cloneEntry(row);
entries.push(entry);
byId.set(entry.id, entry);
leafId = entry.type === "leaf" ? entry.targetId : entry.id;
```

Messages go into `byId`, a `leaf` switches `leafId` to its `targetId`; every entry carries a `parentId`, so the tree structure rebuilds itself, and by the last row `leafId` lands exactly on the current position. Because history is append-only and never rewritten, any JSONL file can rebuild the whole tree losslessly — the round-trip in this section's tests (`toJSONL()` then `loadSessionTreeFromJSONL()`) verifies exactly that: the rebuilt tree has the same branch structure and the same leaf position as the original.

## Try it yourself

1. Give the same question a third branch. In `runDemo()`, right after the `secondAnswerId` line, add:

   ```ts
   session.branch(questionId);
   session.appendMessage({ role: "assistant", content: "As a database table." });
   ```

   Rerun, and `Children of question` becomes e2, e4, e6. Why did it skip e5? Because `branch()` wrote another leaf row, and e5 got taken by it — the tail of `JSONL row types` also grows an extra `leaf -> message`.

2. Dump the whole JSONL and look at it. Add `console.log(session.toJSONL())` at the end of `runDemo()`, count the leaf rows, then follow each row's `parentId` and `targetId` — you can draw the entire tree on paper.

3. Rebuild from the old branch's point of view. Read the JSONL back, then look backwards from the old answer's id:

   ```ts
   const loaded = loadSessionTreeFromJSONL(session.toJSONL());
   console.log(loaded.buildContext(firstAnswerId).messages.map((message) => message.content).join(" -> "));
   ```

   The rebuilt tree can still look back at the old branch — the output matches the demo's Old branch line exactly.

After changing things, run `npm run test:s07` to confirm you haven't broken this section's behavioral contract.

## Wiring into the main line

s06 treated the session as a black box: all it needed was the `buildContext()` and `getMetadata()` openings. s07 is what's actually inside that box:

| Component | Last section (s06) | This section (s07) |
| --- | --- | --- |
| Inside the session | a flat messages array | an append-only entry tree + a movable leaf |
| `buildContext()` | returns a copy of all messages | extracts the current branch's messages along the leaf -> root path |
| `getMetadata()` | id only | id, createdAt, cwd, from the JSONL header row |
| Persistence | none, memory only | `toJSONL()` / `loadSessionTreeFromJSONL()` round-trip |

In real Pi, `createTurnState()` in `agent-harness.ts` calls exactly this session tree's `buildContext()` and `getMetadata()` — everything the s06 snapshot asks of a session, this tree can deliver, and the branching ability stays completely transparent to the layer above.

## Against the Pi source

Read [pi-source.md](pi-source.md) after this section.

Three spots deserve the focus: `Session.appendMessage()` likewise uses the current leaf as `parentId`; `JsonlSessionStorage.setLeafId()` writes the leaf move as a leaf entry, the same move as mini's `moveLeaf()`; `getPathToRoot()` walks `parentId` links all the way back to root and is the foundation under buildContext. Connect the three, and you have the minimal closed loop of Pi's session tree.

## Next up

s07 answered "which messages are on the current branch." But one field in the s06 snapshot never got unpacked: resources. Skills, prompt templates, AGENTS.md — how does Pi discover these project resources and load them into a turn?

[s08 Context Resources](../s08_context_resources/README.md): collecting project resources into the current turn.
