# s21: Workflow Runtime — The Model Decides Each Step; a Script Decides the Orchestration

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s19 → s20 → `s21`

> *"One tool_use starts an entire orchestration in the background"* — The `Workflow` tool starts a deterministic, recoverable script runtime that dispatches many subagents in bulk.
>
> **Harness layer**: Orchestration — a deterministic multi-agent script runtime above the single-agent loop.

---

From s01 through s20, our loop has always been model-driven and step-by-step: the model chooses one tool each round, its result enters `messages[]`, and another round begins. That is ideal for open-ended tasks because the model can inspect the current context and decide the next step on the spot.

Some jobs, however, require deterministic command of a group of agents. Consider reviewing a large change: inspect ten dimensions in parallel → send each finding to a separate agent for adversarial verification → combine and deduplicate the results → sort by severity. The shape is fixed, and you really need three properties:

- **Parallelism**, rather than waiting for one item at a time;
- **Determinism**, so the same input produces the same result structure;
- **Recoverability**, so an interruption does not rerun work that is already complete.

Making the model drive this process one round at a time in the main loop is slow and nondeterministic, and an interruption starts everything over. At that point, you do not need "one more conversation turn." You need to encode the orchestration directly as code.

## Put the Plan in Code, Not in a Sequence of Chat Turns

Claude Code includes a `Workflow` tool in its tool pool. You, or the model when it enters a high-intensity mode, provide a script that expresses deterministic orchestration through a few simple primitives: `agent()`, `parallel()`, `pipeline()`, and `phase()`.

The main loop sees only one `tool_use` and immediately receives a "started in the background" result. Real execution continues inside the background runtime, which reports progress in real time and records every step in a journal on disk. Intermediate script results live in variables instead of taking space in conversation history. When restarted with `resumeFromRunId`, unchanged `agent()` calls hit the journal cache and reuse previous results, resuming from the checkpoint.

![Workflow Runtime Overview](images/workflow-runtime-overview.svg)

```python
SAMPLE_META = {"name": "review-changes", "description": "Review code changes", "phases": ["Review", "Verify"]}

async def sample_workflow(ctx, args):
    ctx.phase("Review")
    results = await ctx.pipeline(DIMENSIONS, audit, verify)   # Each dimension independently runs audit → verify
    confirmed = [f for r in results if r for f in r["confirmed"]]
    ctx.log(f"Confirmed {len(confirmed)} real issues")
    return {"confirmed": confirmed}
```

## The Workflow Tool: Start in the Background; the Main Loop Sees One Call

`Workflow`, also known as `RunWorkflow`, lives in the main agent's tool pool. You may explicitly ask to "run this workflow," invoke a saved `/command`, or let the model enter a high-intensity path automatically. In each case, the model emits a `Workflow(...)` tool call.

The tool parses the arguments, validates metadata, checks permissions, registers a local workflow task, and immediately returns "started asynchronously." The main loop does not block and can continue with other work while the workflow runs in the background. This is the claim-ticket pattern from s13 at a larger scale: hand over the ticket now, notify the user when the result is ready.

```python
class WorkflowTool:
    async def call(self, meta, script_fn, args=None, resume_from_run_id=None):
        validate_meta(meta)
        check_permission(meta)
        run_id = resume_from_run_id or create_run_id(meta)
        task = LocalWorkflowTask(create_task_id(run_id), run_id, meta)
        task.event("async_launched", runId=run_id, taskId=task.task_id)   # Return immediately
        ...                                                                # The rest proceeds in the background
```

> The real Claude Code immediately returns `{status:'async_launched', taskId, taskType:'local_workflow', runId, summary, transcriptDir, scriptPath}`, then sends a notification when the background task finishes.

## Script and Meta: The First Line Must Be Correct

The script's first line must be `export const meta = { name, description, phases }`, and it must contain only literals: no variables, function calls, or string concatenation. The runtime parses it before executing any code. `name` and `description` identify the task in the UI, while `phases` names groups in the progress display.

Invalid input raises `WorkflowInputError` immediately and is rejected during registration. This is the same idea as validating cron expressions in s14: do not wait until execution to discover a bad script.

```python
def validate_meta(meta):
    if not meta.get("name") or not meta.get("description"):
        raise WorkflowInputError("meta must include name and description")
    if "phases" in meta and not isinstance(meta["phases"], list):
        raise WorkflowInputError("meta.phases must be a list")
    return meta
```

> The real Claude Code's `parseWorkflowScript` requires meta to be the first line and a pure literal. The teaching version accepts a dict directly to simplify this part.

## Orchestration Primitives: A Small Set Is Enough for Every Flow

A script runs in an isolated context with only a small set of orchestration primitives as globals. The script does not read files or run shell commands directly. All real code operations are performed by dispatched subagents under their own tool permissions. These primitives are methods on `ExecutionState`:

| Primitive | Purpose |
|------|------|
| `agent(prompt, {schema, label, phase})` | Dispatch one subagent |
| `parallel(thunks)` | **Barrier**: run every task concurrently and wait until all results return |
| `pipeline(items, *stages)` | Run each item through stages **without a barrier**; finished items proceed immediately |
| `phase(title)` | Mark the current progress phase and update the progress display |
| `log(message)` | Emit a progress log line |
| `workflow(name, args)` | Run a nested sub-workflow, one level only |

`pipeline` should be the default. Each item independently crosses every stage. Item A may reach stage three while item B is still in stage one. Use the `parallel` barrier only when the next stage truly requires every result from the previous stage. A barrier waits for the slowest task, so do not add one without need.

```python
async def pipeline(self, items, *stages):
    async def run_item(item, idx):
        value = item
        for stage in stages:                       # Each item independently completes every stage
            value = await stage(value, item, idx)
        return value
    return await asyncio.gather(*[run_item(it, i) for i, it in enumerate(items)])
```

> The real Claude Code injects same-named primitives into the script VM. It also exposes `args`, `budget` with total/spent/remaining values, an agent limit of up to 1000, and a concurrency semaphore.

## Structured Output: Do Not Let Subagents Return Essays

`agent({schema})` requires a subagent to return a JSON object matching the schema, internally through one structured-output call. The runtime validates the result and retries once if it does not match. Downstream code receives a regular object instead of a long essay that must be parsed again.

s05 warned that tool arguments cannot be trusted completely. This is the same lesson in reverse: subagent output cannot be trusted completely either. Validate at the orchestration boundary, give one retry, and keep uncertainty out of the rest of the flow.

```python
result = self.runner.run(prompt, schema, label)
if schema is not None:
    ok, err = SimpleJsonSchema(schema).validate(result)
    if not ok:                                       # Retry once with a reminder, then fail
        result = self.runner.run(prompt + "\n\nReturn valid JSON.", schema, label)
        ok, err = SimpleJsonSchema(schema).validate(result)
        if not ok:
            raise WorkflowInputError(f"agent({{schema}}) returned invalid output: {err}")
```

> The real Claude Code combines `SimpleJsonSchema`, a `StructuredOutput` tool, and schema-aware retries to enforce the output format.

## Background Tasks and Progress Events

`LocalWorkflowTask` maintains status and token usage and emits an SDK-style event stream: `task_started` → a sequence of `task_progress` events containing phase changes, subagent starts, and log batches → one final `task_notification` reporting completion, failure, or stop, plus output files, token count, tool calls, and elapsed time.

The main session treats these as ordinary events. Only the final completion notification re-enters the main loop.

```python
class LocalWorkflowTask:
    def progress_event(self, ptype, **data):         # Phase/subagent/log
        self.progress.append({"type": ptype, **data})
        print(f"  progress   {ptype} ...")
```

> The real Claude Code folds progress into task state and sends it to the UI and SDK as `task_progress.workflow_progress`.

## Storage: Snapshot + Journal for Resuming after Interruptions

Each run writes five artifacts under `~/.claude/projects/<project>/<session>/`: a `<runId>.json` snapshot, `<runId>.output.json` output, `<runId>.journal.jsonl` journal, a `scripts/<runId>.js` script copy, and subagent transcripts under `subagents/workflows/<runId>/`. Reusable workflows that you save live in `.claude/workflows/` at project scope or `~/.claude/workflows/` at user scope.

The journal is the core of checkpointed resume. It records every `agent()` result one line at a time:

```python
class WorkflowJournal:
    def record(self, key, value):
        self._f.write(json.dumps({"key": key, "value": value}) + "\n")
        self._f.flush()
        self.cache[key] = value
```

## Resume: Continue by runId and Reuse Everything Unchanged

Calling `Workflow({scriptPath, resumeFromRunId, args})` reruns the script, but every `agent()` computes a deterministic semantic key. If that key is present in the journal, it returns the cached result without executing again. Every unchanged call hits the cache; only a changed call and the downstream steps that depend on it actually rerun.

The key detail is that keys cannot depend on concurrency order. Agents in `parallel` and `pipeline` finish in nondeterministic order. If "the nth completion" became the key, cache entries would map to the wrong calls on the next run. A key therefore uses a stable hash of call content, including type, label, prompt, and schema, rather than a shared counter:

```python
def key(self, kind, label, prompt, schema):
    basis = f"{kind}|{label}|{prompt}|{json.dumps(schema, sort_keys=True)}"
    return f"{kind}-{_stable_hash(basis) % 10**10:010d}"

# Inside agent():
cached = self.journal.cached(key)
if cached is not MISS:
    self.task.progress_event("workflow_agent", label=label, status="cached")
    return cached
```

> The real Claude Code uses the same idea: deterministic semantic keys plus a journal cache. Resuming within the same session returns cached results for completed `agent()` calls and runs only the remaining ones.

## Determinism: Reproducibility Makes Resume Meaningful

Resume works only if the script is reproducible. The runtime therefore removes nondeterministic sources such as `Date.now()`, no-argument `new Date()`, and `Math.random()` from the script context, and does not expose native Node APIs. The same script plus the same arguments produces the same keys and a 100% cache hit. The teaching version obtains the same property through stable key hashing; the real version runs the entire JavaScript inside a sandboxed VM with those sources removed.

## See It Run

The sample `review-changes` workflow uses `pipeline` to send each review dimension independently through audit → verify. An `agent()` with a schema finds issues during audit. During verification, `parallel()` dispatches a separate adversarial subagent for every finding. Only confirmed issues remain, sorted by severity.

```python
async def sample_workflow(ctx, args):
    ctx.phase("Review")

    async def audit(_v, dimension, _i):
        out = await ctx.agent(f"Inspect the changed code for {dimension} issues",
                              schema=FINDINGS_SCHEMA, label=f"audit:{dimension}", phase="Review")
        return {"dimension": dimension, "findings": out["findings"]}

    async def verify(audited, dimension, _i):
        ctx.phase("Verify")
        verdicts = await ctx.parallel([                       # Verify every finding independently
            (lambda f=f: ctx.agent(f"Adversarially verify whether this issue is real: {f['title']}",
                                   schema=VERDICT_SCHEMA, label=f"verify:{dimension}:{f['title']}"))
            for f in audited["findings"]])
        return {"dimension": dimension,
                "confirmed": [f for f, v in zip(audited["findings"], verdicts) if v and v["isReal"]]}

    results = await ctx.pipeline(DIMENSIONS, audit, verify)
    ...
```

## Changes from s20

| | s20 Comprehensive Agent | s21 Workflow Runtime |
|--|-----------|---------------------|
| Loop | One model-driven loop | Main loop unchanged; deterministic orchestration added above it |
| Who decides the next step | Model decides each round | Script declares the orchestration in advance |
| Multiple agents | One-shot s06 subagents | Scripted, reproducible, recoverable bulk orchestration |
| New mechanisms | — | Script DSL, background tasks, progress events, journal/resume, structured output, deterministic VM |

s21 does not replace the main loop. It exposes `Workflow` at the tool layer and starts a local workflow runtime behind it: one workflow deterministically drives N agent loops. An s06 subagent is dispatched once at the model's discretion; s21 turns orchestration into a replayable script.

## Try It

```bash
python s21_workflow_runtime/code.py          # Start review-changes and watch the event stream
python s21_workflow_runtime/code.py resume   # Resume by the last runId; every agent() hits the journal cache
```

Watch one launch produce `async_launched`, followed by background phase changes and subagent progress, then `task_notification`; the result is stored on the task object. A resumed run reports `agents=0 tokens=0` because every call hits the cache, and its result is byte-for-byte identical.

## Next

Orchestration adds a layer above agent capabilities: the main loop handles individual operations, while a script manages the whole team's flow. Once work becomes a deterministic, recoverable script, the model changes from the round-by-round driver into an execution unit scheduled by that script. The same `agent()` can be invoked ad hoc by the model in the main loop or orchestrated in bulk inside a workflow.

Next: [s22 Goal Loop](../s22_goal_loop/) — Orchestration fans work out and leaves the main loop. The next chapter moves in the opposite direction: a goal pulls control back into the main loop and refuses to let the turn end until the objective is achieved.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
