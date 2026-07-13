# s11: Error Recovery — An Error Is the Start of a Retry, Not the End

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s09 → s10 → `s11` → [s12](../s12_task_system/) → s13 → ... → s20
> *"Errors are not the end; they are the start of recovery"* — raise token limits, compact context, and switch models.
>
> **Harness layer**: Resilience — classify and recover from errors inside the main loop.

---

The first ten lessons share one assumption: every API call succeeds. One line breaks it:

```
Error: 529 overloaded
```

The Agent crashes immediately. No retry, no fallback, and twenty minutes of work disappears. In production, 429 rate limits, 529 overloads, and network instability are not unusual events. They happen every day.

![Error Recovery Overview](images/error-recovery-overview.svg)

---

## Why One Universal Retry Loop Fails

The first reaction is to wrap the call in `try/except` and repeat on failure:

```python
while True:
    try:
        response = client.messages.create(...)
        break
    except Exception:
        time.sleep(1)   # Surely another try will work?
```

Three failures appear immediately. Retrying `prompt_too_long` ten thousand times changes nothing because the request itself is too large; time cannot cure it. A fixed retry interval makes 429 worse: every client fails in the same second and returns in the same second, hitting the server again before it recovers. Most dangerously, this loop hides real bugs. A `TypeError` in your code retries forever, so the error that needs fixing is never surfaced.

The principle is: **the recovery action must match the nature of the error.** The teaching version separates four categories: truncated answers, oversized requests, transient failures, and unrecoverable errors.

---

## Path 1: Truncated Output — Add Space, Then Continue

When the model runs out of output tokens mid-answer, `stop_reason` is `"max_tokens"`. Recovery has two levels:

```python
if response.stop_reason == "max_tokens":
    # Level 1: raise the limit to 64K and resend. Do not append the truncated output.
    if not state.has_escalated:
        max_tokens = ESCALATED_MAX_TOKENS      # 8000 -> 64000
        state.has_escalated = True
        continue
    # Level 2: if 64K is still insufficient, save the fragment and ask to continue, at most 3 times
    messages.append({"role": "assistant", "content": response.content})
    if state.recovery_count < MAX_RECOVERY_RETRIES:
        messages.append({"role": "user", "content": CONTINUATION_PROMPT})
        state.recovery_count += 1
        continue
    return
# Append only normally completed responses here
messages.append({"role": "assistant", "content": response.content})
```

Level 1 has an easy-to-reverse detail: the truncated output **does not enter** `messages` during escalation. Increase the space from 8K to 64K and resend the same clean request; most answers now finish in one pass. Saving the fragment before retrying would leave a partial draft in history next to the complete replacement.

Level 2 begins stitching. Save the partial answer, append a continuation instruction — "continue directly; do not apologize or repeat" — and let the model resume at the cut. Stop after three continuations. More than that means the task itself needs decomposition.

Check order matters too: test `max_tokens` **before** appending the response. Reverse those operations and level 1 can no longer avoid saving the fragment.

---

## Path 2: Oversized Request — Slim It Once, and Only Once

An API `prompt_too_long` error means context exceeds a hard limit. The treatment is compaction, not waiting:

```python
except Exception as e:
    if is_prompt_too_long_error(e):
        if not state.has_attempted_reactive_compact:
            messages[:] = reactive_compact(messages)   # Keep only the last five plus a note
            state.has_attempted_reactive_compact = True
            continue
        # Still too large after one pass: exit. Repeating will not make it smaller.
        ...
        return
```

One teaching simplification: this `reactive_compact` only trims the head and keeps the last five messages. It does not call a model for a summary. s08 already explained LLM-based emergency summaries; this lesson focuses on the recovery framework.

The reason for one attempt is the same as s08. If the request is still too large after trimming, a single remaining message is probably enormous. Repeated compaction only creates an endless "compact, fail, compact again" loop.

---

## Path 3: Transient Failure — Back Off Correctly

429 and 529 are the errors that really deserve retries, but every retry needs two ingredients: exponential backoff and jitter.

```python
def retry_delay(attempt, retry_after=None):
    if retry_after:                                   # Honor the server's requested delay
        return retry_after
    base = min(BASE_DELAY_MS * (2 ** attempt), 32000) / 1000   # 0.5s, 1s, 2s ... cap at 32s
    jitter = random.uniform(0, base * 0.25)           # Add 0-25% random jitter
    return base + jitter
```

Exponential growth is courtesy to the server: it is already overloaded, so each retry waits longer. Jitter is courtesy to every other client: if thousands fail at the same millisecond and retry on exact intervals, the next surge is as large as the last. Random offsets spread the peak out.

529 has another escalation. Three consecutive overload responses suggest that the current model will not recover soon, so switch to a fallback when `FALLBACK_MODEL_ID` is configured. Without one, continue backing off:

```python
if state.consecutive_529 >= MAX_CONSECUTIVE_529:
    if FALLBACK_MODEL:
        state.current_model = FALLBACK_MODEL
        state.consecutive_529 = 0
```

Any successful call resets the counter, so occasional 529s do not accumulate. The entire retry process stops at ten attempts and raises `Max retries exceeded`; it never waits forever.

---

## Everything Else: Record It and Exit

Errors outside those three categories — authentication, invalid arguments, real code bugs — have one correct treatment: do not attempt recovery.

```python
messages.append({"role": "assistant", "content": [
    {"type": "text", "text": f"[Error] {name}: {str(e)[:200]}"}]})
return
```

Before exiting, record the error in the conversation. A silent crash is the worst behavior: the user returns to find the Agent gone with no explanation. An error in `messages` is visible to the user and remains available to the model on the next turn.

Three mechanisms own separate layers: inner `with_retry` absorbs transient failures; the outer `except` handles context overflow and unrecoverable errors; the `stop_reason` check handles truncation. Once categories are clear, every path is short enough to inspect at a glance.

> Real Claude Code evaluates more than a dozen reasons and transitions after each call, with specific paths for streaming aborts, image errors, hook blocks, token-budget continuation, and more. Switching to a fallback clears pending messages and tells the user it changed models because of high load. Continuation also detects diminishing returns: if three consecutive continuations add fewer than 500 tokens, it stops rather than continuing uselessly.

---

## Changes from s10

| Component | Before (s10) | After (s11) |
|-----------|--------------|-------------|
| Error handling | None; any error crashes | Four-category recovery + exponential backoff |
| New constants | — | `ESCALATED_MAX_TOKENS=64000`, `MAX_RETRIES=10`, `BASE_DELAY_MS=500`, `MAX_CONSECUTIVE_529=3` |
| New functions | — | `with_retry`, `retry_delay`, `reactive_compact`, `is_prompt_too_long_error`, `RecoveryState` |
| Tools | bash, read_file, write_file (3) | Unchanged |
| Loop | Bare LLM call | `try/except` plus retrying `continue` paths |

---

## Try It

```sh
cd learn-claude-code
python s11_error_recovery/code.py
```

1. **Truncation path (probabilistic, but often reproducible):** `Write a single Python file implementing a complete tic-tac-toe game with an AI opponent, full docstrings and type hints, at least 500 lines`. If output exceeds 8K tokens, you will see `[max_tokens] escalating 8000 -> 64000`.
2. **Unrecoverable path (deterministic):** set `MODEL_ID` in `.env` to a nonexistent name such as `claude-nonexistent`, then ask anything. Observe the `[unrecoverable]` log and the `[Error] NotFoundError: ...` message left in the conversation. Restore the model name afterward.
3. **Transient path (cannot be forced):** if a real 429 or 529 occurs, logs look like `[429 rate limit] retry 1/10, wait 0.5s`, with intervals doubling on later attempts. Recognizing the labels lets you see that production code is recovering rather than hanging.

---

## What's Next

The Agent is resilient now, but its tasks are still one-off: receive work, finish, exit. An in-memory TODO list from s05 cannot express dependencies, survive process restarts, or coordinate several workers claiming the same pool of tasks.

s12 Task System → Tasks form a persistent graph with state and dependencies: the foundation of multi-Agent coordination.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
