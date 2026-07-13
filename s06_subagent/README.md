# s06: Subagent — Split Big Tasks into Clean Contexts

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → `s06` → [s07](../s07_skill_loading/) → s08 → ... → s20

> *"Split big tasks small; give every subtask clean context"* — a Subagent gets its own `messages[]` and does not pollute the parent conversation.
>
> **Harness layer**: Subagents — isolate context so attention does not drift.

---

The previous lesson's checklist controls order, but it cannot control volume.

An Agent is fixing a bug. To trace the call chain, it reads 30 files over 60 turns, growing `messages` to 120 entries. Most of those entries are intermediate artifacts from the investigation and no longer matter to "fix the bug," yet they still occupy context. When the Agent finally returns to the original bug, the description itself is almost out of sight.

What would you do? Open another terminal to trace the call chain, write the conclusion on a note, close that terminal, and return to the original task. The 30 files you inspected do not follow you back.

This lesson gives the Agent the same ability: send a Subagent into a fresh context to do the messy work, and bring back only one conclusion.

![Subagent Overview](images/subagent-overview.svg)

---

## Why the Parent Agent Cannot Do Everything Itself

The intuitive approach is to let the parent trace the call chain and then fix the bug. We have already seen the problem: the entire investigation remains in the parent conversation forever. s08 teaches compaction, but avoiding the garbage is better than compressing it later.

Could we simply delete intermediate messages after using them? No. Removing messages can break the `tool_use`/`tool_result` pairs from s01, and even the parent Agent cannot reliably decide which information is truly finished.

The way out is delegation: put the entire call-chain investigation in another conversation. That conversation can become as messy as it needs to. When it ends, discard everything except a summary.

---

## A Subagent Is a Second Copy of the s01 Loop

`spawn_subagent` introduces no new concept. It starts another s01-style loop with a brand-new `messages[]`:

```python
def spawn_subagent(description: str) -> str:
    messages = [{"role": "user", "content": description}]   # Fresh context containing only the task

    for _ in range(30):                                     # Safety limit: at most 30 turns
        response = client.messages.create(
            model=MODEL, system=SUB_SYSTEM,                 # The Subagent has its own system prompt
            messages=messages, tools=SUB_TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            break
        results = []
        for block in response.content:
            if block.type == "tool_use":
                blocked = trigger_hooks("PreToolUse", block)   # Delegation does not bypass permission checks
                if blocked:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": str(blocked)})
                    continue
                handler = SUB_HANDLERS.get(block.name)
                output = handler(**block.input) if handler else f"Unknown: {block.name}"
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": output})
        messages.append({"role": "user", "content": results})

    # Bring back only the conclusion; discard the entire conversation history here
    result = extract_text(messages[-1]["content"])
    ...
    return result
```

`SUB_SYSTEM` differs by one sentence: "Complete the task, return a concise summary, and do not delegate again." `SUB_TOOLS` is a subset of the parent Agent's tools: it has `bash`/`read`/`write`/`edit`/`glob`, but no `task` and no `todo_write`.

On the parent side, integration follows the same motto: one definition, one registration.

```python
TOOLS.append({
    "name": "task",
    "description": "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    "input_schema": {"type": "object", "properties": {"description": {"type": "string"}}, "required": ["description"]},
})
TOOL_HANDLERS["task"] = spawn_subagent
```

To the parent loop, `task` is no different from `read_file`: one call and one result. The only difference is that another Agent lived an entire working life behind that result.

---

## Four Safeguards You Cannot Omit

This code makes four deliberate choices, each preventing a particular failure.

**The Subagent has no `task` tool.** If it did, a Subagent could spawn a grandchild, which could spawn another generation. A runaway delegation chain with 30 turns at every level can burn through an API budget quickly. The tool set enforces one level of recursion; it does not rely on model discipline.

**Delegation does not waive permissions.** Every Subagent tool call still passes through the `PreToolUse` hook. Otherwise, "send a Subagent" becomes a permission escape: put a command blocked for the parent into the task description and let the child run it. Context isolation and permission isolation are different things. One is an efficiency design; the other is a security boundary.

**Conclusion extraction has a fallback.** When the loop hits its 30-turn limit, the last message may be a `tool_result` with no model text. Reading only that message would return an empty string, leaving the parent with an empty conclusion. The code therefore searches backward for the latest assistant text. If none exists, it returns `"Subagent stopped after 30 turns without final answer."` so the parent knows what happened.

**Anything outside the summary does not exist.** The parent never sees the files the Subagent read or the paths it tried. Delegation deliberately accepts lossy compression in exchange for a clean parent conversation. What survives depends on how clearly the `task` tool's `description` asks for the right conclusion.

> Real Claude Code has three Subagent execution modes. Fork mode does the opposite of clearing context: it constructs a message prefix identical to the parent conversation so it can hit the Anthropic API prompt cache and save time and cost. There is also an asynchronous path in which a Subagent runs in the background and notifies the parent when it finishes. We build that in s13.

---

## Changes from s05

| Component | Before (s05) | After (s06) |
|-----------|--------------|-------------|
| Tool count | 6 (`bash`, `read`, `write`, `edit`, `glob`, `todo_write`) | 7 (+`task`) |
| New function | — | `spawn_subagent` (isolated `messages[]`, 30-turn limit) |
| Context | Everything in the parent conversation | Subagent starts with a fresh `messages[]` |
| Loop | Unchanged | Dispatch unchanged; Subagent gets `SUB_SYSTEM` and hook protection |

---

## Try It

```sh
cd learn-claude-code
python s06_subagent/code.py
```

1. `Use a subtask to find what testing framework this project uses`: watch the three-part output — `[Subagent spawned]`, indented `[sub] read_file: ...` lines, then `[Subagent done]`. The parent receives only one conclusion.
2. `Delegate: read all Python files in s01_agent_loop/ and s02_tool_use/ and summarize what each one does`: the Subagent reads several files. When it finishes, ask the parent `Quote the exact SYSTEM prompt string from s01's code.py`. It cannot answer without reading again because those details stayed in the discarded child context. That is evidence that isolation really happened.
3. `Use a task to create s06_subagent/example/string_tools.py with a slugify(text: str) function, then verify it from the parent agent`: the file written by the Subagent remains on disk and the parent can read it. Conversation context is isolated; the filesystem is not. Keep those boundaries distinct.

---

## What's Next

The Agent can now split work. But different tasks need different knowledge: frontend changes require component rules, while SQL changes require the schema. Putting every domain guide into the system prompt makes every task carry every manual.

s07 Skill Loading → Load knowledge on demand: keep the catalog present, read the full text only when needed, just like a file.

<!-- translation-sync: zh@v3, en@v3, ja@v3 -->
