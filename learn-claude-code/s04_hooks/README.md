# s04: Hooks — Attach to the Loop, Don't Write into It

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → `s04` → [s05](../s05_todo_write/) → s06 → ... → s20

> *"Attach to the loop; don't write into it"* — hooks inject extension logic before and after tool execution.
>
> **Harness layer**: Hooks — extension points without invading the loop.

---

The permission check from the previous lesson works, but it is still a hardcoded function call inside the loop. Now add two ordinary requirements: write one log line for every tool call, and warn when output gets too large. Using the old approach, we keep stuffing lines into the loop:

```python
def agent_loop(messages):
    while True:
        # ... LLM call ...
        for block in response.content:
            if block.type != "tool_use":
                continue
            log_to_file(block)          # add a line
            check_permission(block)     # add a line
            notify_slack(block)         # another line
            output = execute(block)
            auto_git_add(block)         # and another
            # ... soon the loop is unrecognizable
```

The problem is the approach: you want to extend the Agent's behavior, but you keep modifying its engine. s01 promised that every later lesson would add something around the loop while the loop itself stayed the same. To keep that promise, extensions cannot live inside the loop. They have to hang from it.

![Hooks Overview](images/hooks-overview.svg)

---

## What Goes Wrong When You Edit the Loop Directly

**Every request touches core code.** The loop is the Agent's heart; logging, notifications, and automatic commits are peripheral needs. Repeatedly opening the heart for peripheral work means one bad change can stop everything.

**Requirements become tangled together.** Want to remove Slack notifications? Find the line inside the loop. Want to log only bash? Add another conditional to the same loop. Every feature switch is buried in one function, so none of them can evolve independently.

**The main path disappears.** The loop originally took five steps to explain. After seven or eight extensions, a new reader has to excavate it from a pile of `log_`, `notify_`, and `auto_` calls.

Use a different design: reserve a few attachment points at important moments. The loop only announces "we reached this point." Registered functions decide what to do there.

---

## The Registry: Event Names to Callback Lists

The entire hook system is one dictionary and two functions:

```python
HOOKS = {"UserPromptSubmit": [], "PreToolUse": [], "PostToolUse": [], "Stop": []}

def register_hook(event: str, callback):
    HOOKS[event].append(callback)          # Register by appending to the list

def trigger_hooks(event: str, *args):
    for callback in HOOKS[event]:
        result = callback(*args)
        if result is not None:             # Teaching shortcut: non-None means intervene
            return result
    return None
```

The contract is simple: a hook returns `None` to say "checked; continue." Any non-`None` value means "stop here," and the remaining hooks in that chain do not run.

Four events sit at four important points in one Agent cycle:

| Event | When it fires | What the teaching version attaches |
|-------|---------------|------------------------------------|
| `UserPromptSubmit` | After user input, before the LLM | Log the working directory |
| `PreToolUse` | Before a tool runs | Permission check and call log |
| `PostToolUse` | After a tool runs | Large-output warning |
| `Stop` | Just before the loop exits | Count tool calls in the turn |

---

## PreToolUse: Move s03's Permission Check into a Hook

s03's `check_permission()` moves wholesale into a hook function. The logic does not change; only its address does:

```python
def permission_hook(block):
    """The s03 permission logic, now running as a hook."""
    if block.name == "bash":
        for pattern in DENY_LIST:
            if pattern in block.input.get("command", ""):
                return "Permission denied by deny list"     # Non-None -> block
        for kw in DESTRUCTIVE:
            if kw in block.input.get("command", ""):
                choice = input("   Allow? [y/N] ").strip().lower()
                if choice not in ("y", "yes"):
                    return "Permission denied by user"
    ...
    return None                                             # allow

def log_hook(block):
    """Write one line for every tool call."""
    print(f"[HOOK] {block.name}(...)")
    return None

register_hook("PreToolUse", permission_hook)
register_hook("PreToolUse", log_hook)
```

The loop's old `if not check_permission(block)` becomes:

```python
blocked = trigger_hooks("PreToolUse", block)
if blocked:
    results.append({"type": "tool_result", "tool_use_id": block.id,
                    "content": str(blocked)})   # Return the reason verbatim to the model
    continue
```

The s03 rule still holds: a blocked call needs a `tool_result`, and the reason itself becomes its content. When the model reads `Permission denied by user`, it can choose another route.

One hard rule is easy to overlook: **registration order is execution order.** `permission_hook` is registered before `log_hook`, so a blocked call is never logged — the permission hook returns a non-`None` value and short-circuits the rest of the chain. Move `log_hook` first and both allowed and blocked calls are logged. Order is semantics, not formatting.

---

## PostToolUse: Inspect the Output After Execution

```python
def large_output_hook(block, output):
    if len(str(output)) > 100000:      # Warn when output exceeds 100 KB
        print(f"[HOOK] ⚠ Large output from {block.name}: {len(str(output))} chars")
    return None

register_hook("PostToolUse", large_output_hook)
```

For now, this hook only raises a warning. It cannot stop those 100 KB from entering the conversation history. s08 actually handles large output, and the processing logic will be inserted at this exact point.

---

## UserPromptSubmit and Stop: The Two Ends of a Turn

At the input end, the event fires after the user presses Enter but before the content enters `messages`:

```python
query = input("s04 >> ")
trigger_hooks("UserPromptSubmit", query)   # Before entering the LLM
history.append({"role": "user", "content": query})
```

The teaching version only writes a log line. A production system can validate input or inject project context here. The position matters more than the current action: this is the shared gate for all input.

The exit end is more interesting. Before the loop finishes, it asks the Stop hooks one last time:

```python
if response.stop_reason != "tool_use":
    force = trigger_hooks("Stop", messages)   # Ask once more before exiting
    if force:
        messages.append({"role": "user", "content": force})
        continue                              # The hook says "not done"; keep running
    return
```

The teaching version's `summary_hook` only counts tool calls and returns `None`, allowing the exit. But notice what this mechanism permits: a Stop hook that returns a value can refuse to let the Agent finish and push it back into the loop. s01 said exiting was a model decision. This is the first time the program gains veto power over that decision. s22 turns it into a complete goal loop.

> Real Claude Code has 27 hook events, with instrumentation for sessions, compaction, subagents, and team coordination. A hook returns a 14-field object rather than a single None/non-None channel. The key safety invariant is that even an allow result cannot override deny or ask rules in `settings.json`; an extension point must never become a privilege-escalation path. The teaching version's four events and one return channel are the smallest runnable form of the same pattern.

---

## Changes from s03

| Component | Before (s03) | After (s04) |
|-----------|--------------|-------------|
| Extension style | `check_permission()` hardcoded in the loop | `HOOKS` registry + `trigger_hooks()` |
| New functions | — | `register_hook`, `trigger_hooks` |
| Hook callbacks | — | `context_inject_hook`, `permission_hook`, `log_hook`, `large_output_hook`, `summary_hook` |
| Exit control | None | A non-None Stop result can force another turn |
| Input gate | None | `UserPromptSubmit` fires before the LLM |

---

## Try It

```sh
cd learn-claude-code
python s04_hooks/code.py
```

1. `Read the file README.md`: watch one complete hook timeline. Input produces `[HOOK] UserPromptSubmit`, execution produces `[HOOK] read_file(...)`, and shutdown produces `[HOOK] Stop: session used N tool calls`.
2. `Use read_file to read web/src/data/generated/docs.json without a limit`: this file exceeds 700 KB, so the `PostToolUse` large-output warning crosses its 100 KB threshold.
3. `Create a file called test.txt, then delete it`: writing passes silently; `rm` triggers permission approval. Press N and notice that the blocked call has no `[HOOK] bash(...)` log. Registration order is responsible: the permission hook comes first and short-circuits the logging hook.

---

## What's Next

The Agent can execute safely and accept observable extensions. Give it a complex task, though, and it still starts immediately, improvising one step at a time. It makes no plan, and you cannot see where it intends to go.

s05 TodoWrite → Give the Agent a planning tool. Write the checklist first, then act.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
