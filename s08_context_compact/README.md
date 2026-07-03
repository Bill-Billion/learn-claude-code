# s08: Context Compact — The Context Will Fill Up: Tidy First, Summarize Last

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → s07 → `s08` → [s09](../s09_memory/) → s10 → ... → s20

---

On a long task, reading one file can cost thousands of tokens, and one test run dumps another wall of logs. File contents, command output, tool results: everything gets appended back into `messages`, and the pile keeps growing.

The more context, the more the model's attention spreads thin; once it is truly full, the request simply fails: `prompt_too_long`.

So s08 solves one thing:

> Keep the agent working through long tasks.

![Context Compact overview](images/compact-overview.svg)

---

## Don't Start by Summarizing the History

The most intuitive move is to have the model summarize the history.

But that should not be the first step.

A lot of content doesn't need summarizing: old logs, old file contents, tool results that have already served their purpose. They just take up space, and much of it no longer matters. For content like that, tidy first: persist to disk what can be persisted, replace with a placeholder what can be placeholdered, snip what can be snipped.

Only when all of that is done and the context is still close to the limit do you let the model generate a summary.

The reason is simple: the first three steps are mostly recoverable, while a summary is lossy. Once a summary replaces the history, the details are no longer in the current context.

---

## The Overall Flow

Before every model call, tidy `messages` once:

```python
messages = tool_result_budget(messages)  # park large results first
messages = snip_compact(messages)        # trim the middle of the history
messages = micro_compact(messages)       # placeholder older tool results

if estimate_size(messages) > CONTEXT_LIMIT:
    messages = compact_history(messages) # still too big, only then summarize
```

![Four-step compaction pipeline](images/compaction-layers.svg)

> The order is not arbitrary.
>
> In particular, `tool_result_budget` must run before `micro_compact`. `micro_compact` replaces old tool results with placeholders; if it ran first, the full content would already be gone, and there would be nothing left to persist.

---

## Step 1: tool_result_budget — Park Large Results First

Sometimes the problem isn't a long history but a single oversized tool result.

Say the agent reads several large files at once: the last `tool_result` can easily exceed 200KB. It is the newest result, so it can't just be dropped; but it shouldn't sit in the context in full either.

The move: write the full content to disk, and keep only the path plus a short preview in context.

![Park large results to disk](images/layer1-budget.svg)

```python
def tool_result_budget(messages, max_bytes=200_000):
    blocks = [b for b in messages[-1]["content"] if b.get("type") == "tool_result"]
    total = sum(len(str(b["content"])) for b in blocks)

    if total <= max_bytes:
        return messages

    for block in sorted(blocks, key=lambda b: len(str(b["content"])), reverse=True):
        block["content"] = persist_large_output(block["tool_use_id"], str(block["content"]))
        total = sum(len(str(b["content"])) for b in blocks)
        if total <= max_bytes:
            break

    return messages
```

This step loses nothing. It only moves content from "current context" to disk.

The model can still see where the content was saved and roughly how it starts. If the full content is needed later, read it back.

---

## Step 2: snip_compact — Trim the Old Conversation

When there are too many messages, keep the beginning and the end.

The beginning usually holds the original task and constraints; the end is what is being worked on right now. The old stretch in the middle can be replaced with a single note.

```python
def snip_compact(messages, max_messages=50):
    if len(messages) <= max_messages:
        return messages

    head = safe_head(messages, 3)
    tail = safe_tail(messages, max_messages - 3)
    snipped = len(messages) - len(head) - len(tail)

    return head + [
        {"role": "user", "content": f"[snipped {snipped} messages]"}
    ] + tail
```

One thing to watch: never separate an `assistant` `tool_use` from its matching `tool_result`. Otherwise the model sees a tool result that came from nowhere, and the API rejects the request outright.

That is why `safe_head` and `safe_tail` are not plain slices: they move the cut away from such break points (see `code.py`).

This step reduces the number of messages.

But it does nothing about large content inside a single message. If an old `tool_result` still carries tens of KB of file content, it keeps occupying the context.

So the tool results still need tidying.

---

## Step 3: micro_compact — Replace Older Tool Results with Placeholders

Tool results usually take more space than the conversation itself.

The agent reads ten files in a row; the full contents of the first several rarely need to stay in context. Keeping the most recent few is enough. If an older result turns out to matter later, fetch it again.

![Placeholder older results](images/micro-compact.svg)

```python
KEEP_RECENT = 3

def micro_compact(messages):
    results = collect_tool_results(messages)

    for _, _, block in results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"

    return messages
```

This step summarizes nothing. It just swaps older full results for a one-line note.

It handles "too many tool results", not "still too big after tidying". If the context is still over the limit at this point, the only option left is a model-generated summary.

---

## Step 4: compact_history — Still Over the Limit, Then Summarize

If the context is still too big after the first three steps, let the model summarize the history.

Three things happen:

Write the full conversation to disk.
Have the model generate a summary.
Replace the old history with the summary.

![Full LLM summary](images/auto-compact.svg)

```python
def compact_history(messages):
    transcript_path = write_transcript(messages)  # ① write the full conversation to disk
    summary = summarize_history(messages)         # ② generate the summary
    return [{
        "role": "user",
        "content": f"[Compacted]\n\n{summary}",   # ③ replace old history with the summary
    }]
```

The summary is required to preserve five kinds of information: current goal, user constraints, key findings, files changed, next steps.

This step is the most effective, and the riskiest.

The full history is still on disk, but the model can now see only the summary. Any detail that didn't make it into the summary is, for every later turn, effectively invisible.

That is why summarizing must come last.

---

## Emergency Compaction After an Error

Normally the context is tidied before the model is called.

But token estimates can be off, or one turn's tool output suddenly balloons, and the API may still return `prompt_too_long`. At that point, do one more aggressive pass: save the full record, squash most of the earlier history into a summary, and keep only the last few messages.

```python
def reactive_compact(messages):
    write_transcript(messages)
    tail = safe_tail(messages, 5)   # tail slice, same boundary guard
    summary = summarize_history(messages[:len(messages) - len(tail)])

    return [{
        "role": "user",
        "content": f"[Reactive compact]\n\n{summary}",
    }] + tail
```

This is not the normal path.

It runs only after an error has already occurred, and it retries a limited number of times (once, in the teaching version). Otherwise, if the summary itself fails, you can end up retrying forever.

---

## Back Into the Agent Loop

The tidying logic ultimately plugs back into the agent loop.

```python
def agent_loop(messages):
    reactive_retries = 0
    while True:
        messages[:] = tool_result_budget(messages)
        messages[:] = snip_compact(messages)
        messages[:] = micro_compact(messages)

        if estimate_size(messages) > CONTEXT_LIMIT:
            messages[:] = compact_history(messages)

        try:
            response = client.messages.create(
                model=MODEL, system=SYSTEM,
                messages=messages, tools=TOOLS, max_tokens=8000)
        except Exception as e:
            if "prompt_too_long" in str(e).lower() and reactive_retries < MAX_REACTIVE_RETRIES:
                messages[:] = reactive_compact(messages)
                reactive_retries += 1
                continue
            raise

        # ... run tools, append results back into messages ...
```

What matters most here is the order:

```text
park large results → trim middle history → placeholder older results → still over the limit, then summarize
```

The first three steps involve no model at all; they mostly clear space. Step 4 actually rewrites history, which is why it must come last.

---

## The compact Tool: Let the Model Ask

Besides automatic tidying, the model can be given a `compact` tool.

When the model notices the context getting long, or the task moving into a new phase, it can call the tool itself. The program then runs `compact_history`, ends the current turn, and starts the next one with the compacted context.

This way compaction isn't only program-triggered; the model can also request it at the right moment.

---

## Changes from s07

| Component | s07 | s08 |
|-----------|-----|-----|
| Context management | None | Tidy before every model call |
| Tool results | Stay in context forever | Large ones persisted, old ones placeholdered |
| Message history | Accumulates forever | Middle history can be snipped |
| Over the limit | Request fails | Tidy first, summarize only if needed |
| New tool | None | `compact` |

s07 made the agent better at its work.
s08 keeps the agent from being crushed by its own history on long tasks.

---

## Try It

```bash
cd learn-claude-code
python s08_context_compact/code.py
```

Tasks to try:

```text
Read README.md, then read code.py, then read s01_agent_loop/README.md
```

Watch whether older tool results get replaced with placeholders.

```text
Read every file in s08_context_compact/
```

Watch whether large outputs get persisted to disk.

```text
Keep discussing and editing for more than 20 turns
```

Watch whether a summary is triggered as the context nears the limit.

---

## Recap

The core principle of Context Compact fits in one line:

> Tidy what you can, don't summarize what you can recover; only when that's still not enough, have the model summarize the history.

s08 lets long tasks continue.
s09 tackles the next question: which information deserves to be kept for the long haul.

<!-- translation-sync: zh@v5, en@v5, ja@v5 -->
