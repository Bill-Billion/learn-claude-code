# s08: Context Compact — Context Will Fill Up, Have a Way to Make Room

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → s07 → `s08` → [s09](../s09_memory/) → s10 → ... → s20
> *"Context will fill up — have a way to make room"* — Four-layer compaction pipeline: cheap first, expensive last.
>
> **Harness Layer**: Compaction — auto-summarize when context exceeds limits, keeping sessions sustainable.

---

## The Problem

The last chapter gave the agent Skills, so it picked up a bit of "domain experience": hand it a PDF, an MCP server, or a code review, and it loads the right playbook before acting.

But the more capable the agent gets, the worse a second problem becomes. It reads one 1000-line file (that's ~4000 tokens), then 30 more files, then runs 20 commands. Every command's output and every file's contents get appended back into the `messages` list, piling up turn after turn.

A few dozen turns of ordinary chat is nothing. A coding agent is different: one read is thousands of lines, one test run is a wall of logs. The task isn't even done, and the context window may already be full.

Once it's full, the problem isn't "the model answered a little worse." The API rejects the call outright: `prompt_too_long`. Without compaction, an agent simply can't work on a large project.

---

## The Solution

![Compact Overview](images/compact-overview.svg)

The hook structure, skill loading, and subagent from s07 all stay; this chapter adds just one layer: before every LLM call, tidy up `messages` first.

The obvious idea is to let the model summarize once things fill up. But that has two problems. First, a summary costs an extra API call, and summarizing every time the context grows makes the bill climb fast. Second, not everything is worth summarizing: plenty of old tool results aren't needed anymore, and some content is merely big: a `cat` that dumps a few hundred KB of logs doesn't need to be *understood*, it just needs to move out of the context and be re-read if it ever matters again.

So compaction isn't one action, it's a pipeline. **Cheap first, expensive last**: run a few local passes that never call the model: trim what can be trimmed, swap placeholders in for old results, spill big outputs to disk. Only when none of that is enough do you let the LLM do a real summary.

---

## How It Works

![Four-Layer Compaction Pipeline](images/compaction-layers.svg)

### L1: snip_compact — Trim Irrelevant Old Conversation

The agent has run 80 turns and `messages` holds 160 entries. That opening "create hello.py for me" has almost nothing to do with the current work, yet it still takes up space.

Once the count passes 50 → keep the first 3 (the original task and constraints) and the last 47 (the current work), and cut the middle. The one boundary to respect: don't split an `assistant(tool_use)` from the `user(tool_result)` that follows it, or the model sees an orphaned result with no idea which call it belongs to.

```python
def snip_compact(messages, max_messages=50):
    if len(messages) <= max_messages: return messages
    keep_head, keep_tail = 3, max_messages - 3
    head_end, tail_start = keep_head, len(messages) - keep_tail
    if head_end > 0 and _message_has_tool_use(messages[head_end - 1]):
        while head_end < len(messages) and _is_tool_result_message(messages[head_end]):
            head_end += 1
    if (tail_start > 0 and tail_start < len(messages)
            and _is_tool_result_message(messages[tail_start])
            and _message_has_tool_use(messages[tail_start - 1])):
        tail_start -= 1
    if head_end >= tail_start: return messages
    snipped = tail_start - head_end
    return messages[:head_end] + [{"role": "user", "content": f"[snipped {snipped} messages]"}] + messages[tail_start:]
```

What gets cut is the messages themselves, with one guard at the seam. But in the messages that remain, `tool_result` content is still piling up, and message 34 might still be sitting on 30KB of an old file. Fewer messages, but not fewer tokens. → L2.

### L2: micro_compact — Placeholder for Old Tool Results

![Old Result Placeholders](images/micro-compact.svg)

What blows up the context is usually not the conversation itself but the tool results. The agent read 10 files in a row; the full contents of files 1 through 7 stopped being useful long ago, yet they sit there verbatim.

Keep the full content of the 3 most recent `tool_result`s and replace anything older with a one-line placeholder. The idea is plain: if an old result is really needed, the model can just read it again; it shouldn't hog space the whole time.

```python
KEEP_RECENT = 3

def micro_compact(messages):
    tool_results = collect_tool_results(messages)
    if len(tool_results) <= KEEP_RECENT: return messages
    for _, _, block in tool_results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"
    return messages
```

The old results are cleared, but one case still slips through: a single new result can be 500KB on its own: one `cat` of a big file is enough to fill the context, and it's too fresh for micro_compact to touch. → L3.

### L3: tool_result_budget — Persist Large Results to Disk

![Persist Large Results](images/layer1-budget.svg)

Some results aren't a problem of *many*, but of *one too big*. The model read 5 large files at once, and the `tool_result`s in that last user message add up to over 200KB, and keeping the 3 most recent doesn't help here, because the newest one alone can fill the context.

Give tool results a budget. Add up the size of every `tool_result` in the last user message; if it's over 200KB, persist them to `.task_outputs/tool-results/` starting with the largest, leaving only a `<persisted-output>` marker plus the first 2000 characters as a preview. The model sees the marker and knows the full content is on disk, to be re-read when needed.

```python
def tool_result_budget(messages, max_bytes=200_000):
    last = messages[-1] if messages else None
    if not last or last.get("role") != "user" or not isinstance(last.get("content"), list): return messages
    blocks = [(i, b) for i, b in enumerate(last["content"])
              if isinstance(b, dict) and b.get("type") == "tool_result"]
    total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    if total <= max_bytes: return messages
    ranked = sorted(blocks, key=lambda p: len(str(p[1].get("content", ""))), reverse=True)
    for _, block in ranked:
        if total <= max_bytes: break
        block["content"] = persist_large_output(block.get("tool_use_id", "unknown"), str(block.get("content", "")))
        total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    return messages
```

What matters here isn't discarding; it's moving content from "active context" to "recoverable external storage". That completes the first three layers: pure text/structure operations, 0 API calls, each watching one kind of bloat. But they share one limit: they can't read what the conversation is about, can't tell which findings matter or which constraints must stay. If the context is still too big, the model has to step in. → L4.

### L4: compact_history — Full LLM Summary

![Full LLM Summary](images/auto-compact.svg)

All three layers have run and the token count still tops the threshold. This is what most people picture as "context compaction": hand the history to the model and have it summarize into a shorter state.

Three steps: first write the full conversation to `.transcripts/` (JSONL), so the active context keeps only the summary while the complete record stays on disk; then have the LLM produce a summary that preserves the current goal, key findings, files already changed, remaining work, and user constraints; finally replace all the old messages with that one summary.

```python
def compact_history(messages):
    transcript_path = write_transcript(messages)   # save the full conversation first
    summary = summarize_history(messages)            # LLM generates the summary
    return [{"role": "user", "content": f"[Compacted]\n\n{summary}"}]
```

This step is lossy: the transcript holds the full history, but the model can no longer see those details; it has only the summary to go on. That's why L1/L2/L3 run first: don't make the model summarize if you can avoid it, because once you do, detail is gone for good. The teaching version also adds a circuit breaker: stop after 3 consecutive compaction failures instead of burning API calls in a loop.

### Reactive: reactive_compact

Normally we tidy the context before calling the model. But when context grows too fast, or the token estimate is off, the API can still come back with `prompt_too_long`.

That's when reactive_compact kicks in: much like compact_history but more aggressive: save the transcript, summarize most of the front, and keep only the last 5 messages as tail context (again avoiding an orphaned `tool_result`).

```python
def reactive_compact(messages):
    transcript = write_transcript(messages)
    tail_start = max(0, len(messages) - 5)
    if (tail_start > 0 and tail_start < len(messages)
            and _is_tool_result_message(messages[tail_start])
            and _message_has_tool_use(messages[tail_start - 1])):
        tail_start -= 1
    summary = summarize_history(messages[:tail_start])
    return [{"role": "user", "content": f"[Reactive compact]\n\n{summary}"}, *messages[tail_start:]]
```

Reactive is the fallback, not the normal path: it retries once by default, and on another failure it raises rather than looping forever. The full error-recovery logic is left to s11.

### Putting It All Together

Wire it all back into the Agent Loop: before each LLM call, run the three local passes, summarize if that's not enough, and fall back to the emergency path only if the call actually errors.

```python
def agent_loop(messages):
    reactive_retries = 0
    while True:
        # three preprocessors (0 API calls), order: budget -> snip -> micro
        messages[:] = tool_result_budget(messages)    # L3: persist large results
        messages[:] = snip_compact(messages)          # L1: trim the middle
        messages[:] = micro_compact(messages)         # L2: old result placeholders

        if estimate_size(messages) > CONTEXT_LIMIT:   # still too big -> LLM summary (1 API call)
            messages[:] = compact_history(messages)

        try:
            response = client.messages.create(model=MODEL, system=SYSTEM, messages=messages, tools=TOOLS, max_tokens=8000)
        except Exception as e:
            if "prompt_too_long" in str(e).lower() and reactive_retries < MAX_REACTIVE_RETRIES:
                messages[:] = reactive_compact(messages)   # emergency
                reactive_retries += 1
                continue
            raise
        # ... tool execution ...
```

**The order can't change.** L3 (budget) has to run before L2 (micro): micro replaces old large `tool_result`s with a one-line placeholder, so if it ran first, budget would never get to persist the full content. Save the big content first, then do the placeholdering and trimming. That's also why Claude Code's source puts `applyToolResultBudget` first.

### The compact Tool — Let the Model Ask, Too

Beyond automatic compaction, the model can ask for a tidy-up itself: when it feels the context is too long, or the task has shifted phase, it can call the `compact` tool. In the teaching version that tool triggers `compact_history`, then ends the current turn and starts fresh with the compacted context. It feels much like a manual `/compact`, except this time the model itself realized it was time.

---

## Changes From s07

| Component | Before (s07) | After (s08) |
|-----------|-------------|-------------|
| Context management | None (context grows without bound) | Four-layer compaction pipeline + emergency |
| New functions | — | snip_compact, micro_compact, tool_result_budget, compact_history, reactive_compact |
| Tools | bash, read, write, edit, glob, todo_write, task, load_skill (8) | 8 + compact (9) |
| Loop | LLM call → tool execution | Run three preprocessors each round + threshold-triggered compact_history |
| Design principle | Make the agent capable | Keep the agent from crashing on long runs |

This step doesn't add a *capability* so much as *stamina*: s07 made the agent better at specialized work, s08 keeps it from being dragged down by its own history on a long task.

---

## Try It

```sh
cd learn-claude-code
python s08_context_compact/code.py
```

Try these prompts:

1. `Read the file README.md, then read code.py, then read s01_agent_loop/README.md` (read several files in a row, watch L2 compact old results)
2. `Read every file in s08_context_compact/` (read a lot at once, watch L3 persist to disk)
3. Keep the conversation going 20+ turns, watch for `[auto compact]` or `[reactive compact]`

What to watch: after each tool runs, does the old `tool_result` get replaced? Do large outputs get persisted? When tokens pass the threshold, does a summary get generated?

---

## What's Next

Compaction lets the agent run a long time without crashing. But every compaction loses some detail: a preference the user stated earlier, a long-standing project constraint, a fact that matters across tasks. None of it is guaranteed to survive in the summary.

Compaction answers "the current session is nearly full, how do we keep going". It doesn't answer "which information is worth keeping for the long haul".

s09 Memory → three subsystems: choosing what to remember, extracting the key information, and consolidating it. Across compactions, across sessions.

<details>
<summary>Deep Dive Into Claude Code Source Code</summary>

> The following is based on analysis of Claude Code source code `compact.ts`, `autoCompact.ts`, `microCompact.ts`, and `query.ts`.

### Execution Order Comparison

The teaching version labels layers L1/L2/L3/L4 for pedagogical clarity, but actual execution order does not match the numbering:

| Dimension | Teaching Version | Claude Code |
|-----------|-----------------|-------------|
| Execution order | budget → snip → micro → auto | budget → snip → micro → collapse → auto (`query.ts:379-468`) |
| snip_compact | Keep head 3 + tail 47 | Claude Code only enables on main thread; implementation not in open-source repo (`HISTORY_SNIP` feature gate), but interface is visible: `snipCompactIfNeeded(messages)` → `{ messages, tokensFreed, boundaryMessage? }`, also exposes `SnipTool` for model-initiated snipping. Teaching version's 3/47 are simplified parameters |
| micro_compact | Text placeholder replacement | Two paths: time-based clears content directly, cached uses API `cache_edits` (legacy path removed) |
| micro_compact whitelist | By position (most recent 3) | time-based triggers by time threshold; cached triggers by count (`microCompact.ts`) |
| tool_result_budget | 200KB characters | 200,000 characters (`toolLimits.ts:49`) |
| compact_history threshold | Character count estimate | Precise tokens: `contextWindow - maxOutputTokens - 13_000` |
| Summary requirements | 5 categories of info | 9 sections + `<analysis>`/`<summary>` dual tags |
| Compression prompt | Simple prompt | Double-ended hard guardrails forbidding tool calls |
| PTL retry | Yes (simplified) | `truncateHeadForPTLRetry()` retreats by message groups (`compact.ts:243-290`) |
| Post-compaction recovery | None (teaching version only keeps summary) | Auto re-read recent files, plans, agent/skill/tool context |
| Circuit breaker | 3 times | 3 times (`autoCompact.ts:70`) |
| Reactive retry | 1 time | Claude Code has more granular tiered retries |

### Execution Order Details

The real order in Claude Code source `query.ts`:

1. `applyToolResultBudget` (L379): persist large results first, ensuring full content is saved
2. `snipCompact` (L403): trim middle messages
3. `microcompact` (L414): old result placeholders
4. `contextCollapse` (L441): independent context management system (not in teaching version)
5. `autoCompact` (L454): LLM full summary

The teaching version's budget → snip → micro order matches this. The teaching version does not have the contextCollapse mechanism.

### read_file Trade-off

The teaching version's `micro_compact` replaces old `tool_result` blocks with placeholders uniformly, including `read_file`. This usually does not affect functional correctness: if the model needs the file contents later, it can read the file again. The cost is an extra tool call and potentially lower prompt cache hit rates.

Claude Code does not solve this with the teaching version's simple rule. It also puts `Read` in the microcompactable tool set, but maintains a separate `readFileState`: repeated reads of unchanged files return `FILE_UNCHANGED_STUB`, and after compaction it restores recently read file contents within a budget (for example, up to 5 files, 5K tokens per file, 50K tokens total). That is a production-level cache and recovery mechanism. The teaching version does not expand into that machinery; it keeps the simpler trade-off of compacting old results and re-reading when needed.

### Full Constant Reference

| Constant | Value | Source File |
|----------|-------|-------------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | `autoCompact.ts:62` |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | `autoCompact.ts:70` |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | `autoCompact.ts:30` |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | `compact.ts:123` |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | `compact.ts:122` |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | `compact.ts:124` |
| Time micro_compact interval | 60 minutes | `timeBasedMCConfig.ts` |
| `MAX_COMPACT_STREAMING_RETRIES` | 2 | `compact.ts:131` |

### contextCollapse and sessionMemoryCompact

Claude Code source code has two additional mechanisms not covered in this teaching version:

- **contextCollapse**: An independent context management system that, when enabled, suppresses proactive autocompact (`autoCompact.ts:215-222`), with collapse's commit/blocking flow taking over context management. Manual `/compact` and reactive fallback remain independent paths, unaffected by contextCollapse.
- **sessionMemoryCompact**: Before compact_history, Claude Code first attempts a lightweight summary using existing session memory (covered in s09) without calling the LLM. This mechanism becomes clearer after learning s09.

### What Does the Compression Prompt Look Like?

Claude Code's compression prompt has two hard requirements:

1. **Absolutely no tool calls**: It begins with `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`, and appends another REMINDER at the end
2. **Analyze first, then summarize**: The model must first reason in an `<analysis>` tag, then output the formal summary in a `<summary>` tag. The analysis is stripped during formatting

### Teaching Version Simplifications Are Intentional

- micro_compact uses text placeholders → we don't have API-level `cache_edits` access
- read_file is not special-cased → the teaching version accepts re-reading when needed instead of introducing readFileState and post-compaction recovery
- Tokens estimated via character count → precise tokenizers are out of scope
- Post-compaction recovery omitted → teaching version only keeps summary, does not auto re-attach files
- Two auxiliary mechanisms not covered → they fall in the 10% detail category

The core design principle is fully preserved.

</details>

<!-- translation-sync: zh@v3, en@v3, ja@v3 -->
