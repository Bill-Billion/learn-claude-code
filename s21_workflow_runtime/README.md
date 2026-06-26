# s21: Workflow Runtime — The Model Owns Each Step, the Script Owns the Orchestration

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s19 → s20 → `s21`

> *"One tool_use, a whole orchestration runs in the background"* — the `Workflow` tool launches a deterministic, resumable script runtime that fans out a fleet of subagents.
>
> **Harness layer**: Orchestration — above the single-agent loop, a deterministic multi-agent script runtime.

---

## The problem

From s01 to s20 the loop is model-driven and single-step: each round the model picks one tool, the result goes back into `messages[]`, and another round begins. For open-ended tasks this is the best you can do — let the model decide the next step on the spot, looking at the context.

But some work needs to **orchestrate a fleet of agents deterministically**. Take reviewing a large change: find problems across ten dimensions in parallel → dispatch an adversarial verification for each finding → merge and dedup → sort by severity. The shape of this orchestration is fixed, and what you want is:

- **parallel**, not waiting one at a time;
- **deterministic**, the same input producing the same structure;
- **resumable**, so that if it dies halfway through, the parts already done are not redone.

Having the model drive all of this step by step inside the main loop is slow, non-deterministic, and starts over when interrupted. At that point what you want is not "one more chat round" but to **write the orchestration as a piece of code**.

## The solution

Claude Code puts a `Workflow` tool in the tool pool. You (or the model, under an `ultracode` trigger) hand it a **script**, and the script uses the primitives `agent() / parallel() / pipeline() / phase()` to write the orchestration as deterministic code.

The main loop sees a single `tool_use` and **immediately** gets back `async_launched` — the real execution proceeds in a **background runtime** that reports progress and writes a journal to disk. Intermediate results live in script variables, not in the conversation. `resumeFromRunId` lets any unchanged `agent()` hit the journal cache and resume from where it stopped.

![Workflow Runtime overview](images/workflow-runtime-overview.svg)

The plan is code, not a chat turn:

```python
SAMPLE_META = {"name": "review-changes", "description": "...", "phases": ["Review", "Verify"]}

async def sample_workflow(ctx, args):
    ctx.phase("Review")
    results = await ctx.pipeline(DIMENSIONS, audit, verify)   # each dimension runs audit -> verify independently
    confirmed = [f for r in results if r for f in r["confirmed"]]
    ctx.log(f"confirmed {len(confirmed)} real finding(s)")
    return {"confirmed": confirmed}
```

## How it works

### The Workflow tool: launches in the background, the main loop sees one tool_use

`Workflow` (aliased `RunWorkflow`) sits in the main agent's tool pool. A trigger arrives — an explicit "run/build workflow", a saved `/command`, or the high-effort `ultracode` path — and the model emits a `Workflow(...)` `tool_use`. `WorkflowTool.call` parses the arguments, validates the meta, passes permission, registers a `local_workflow` task, and **returns immediately** with `async_launched`. The main loop does not block; it keeps going while the workflow runs in the background.

```python
class WorkflowTool:
    async def call(self, meta, script_fn, args=None, resume_from_run_id=None):
        validate_meta(meta)
        check_permission(meta)
        run_id = resume_from_run_id or create_run_id(meta)
        task = LocalWorkflowTask(create_task_id(run_id), run_id, meta)
        task.event("async_launched", runId=run_id, taskId=task.task_id)   # returns immediately
        ...                                                                # the rest runs in the background
```

> Real Claude Code: the tool returns immediately with `{status:'async_launched', taskId, taskType:'local_workflow', runId, summary, transcriptDir, scriptPath}`, and the background task completes later.

### Script and meta: the first statement

The script's **first statement** must be `export const meta = { name, description, phases }`, and it must be a pure literal — no variables, function calls, or interpolation. The runtime parses it before executing anything: `name`/`description` drive the task and the UI, `phases` name the progress groups. Bad input raises `WorkflowInputError` outright.

```python
def validate_meta(meta):
    if not meta.get("name") or not meta.get("description"):
        raise WorkflowInputError("meta requires `name` and `description`")
    if "phases" in meta and not isinstance(meta["phases"], list):
        raise WorkflowInputError("meta.phases must be a list")
    return meta
```

> Real Claude Code: `parseWorkflowScript` enforces that meta is the first statement and a pure literal; the teaching version just takes a dict.

### Orchestration primitives: agent / parallel / pipeline / phase / log / workflow

The script runs in a context whose **only** useful globals are these orchestration primitives. The script itself does not read/write files or run a shell — the actual codebase reads and writes are done by **subagents** through their own tool permissions. The primitives are methods on `ExecutionState`:

| Primitive | What it does |
|------|------|
| `agent(prompt, {schema, label, phase})` | fan out a subagent |
| `parallel(thunks)` | **barrier**: run all concurrently, wait for all together |
| `pipeline(items, *stages)` | per-item, staged, **no barrier** |
| `phase(title)` | progress group (upsert) |
| `log(message)` | a progress line |
| `workflow(name, args)` | nested sub-workflow (one level only) |

`pipeline` is the default — each item passes through all stages independently, so item A can be at stage 3 while item B is still at stage 1; reach for the `parallel` barrier only when you genuinely need "all of the previous stage's results at once".

```python
async def pipeline(self, items, *stages):
    async def run_item(item, idx):
        value = item
        for stage in stages:                       # each item runs through all stages independently
            value = await stage(value, item, idx)
        return value
    return await asyncio.gather(*[run_item(it, i) for i, it in enumerate(items)])
```

> Real Claude Code: the same primitives are injected into the script context by the VM; there are also `args`, `budget` (`budget.total/spent/remaining`), an agent-count cap (1000), and a concurrency semaphore.

### Structured output: agent({schema}) + StructuredOutput

`agent({schema})` forces the subagent to return a JSON object that matches the schema (via a single `StructuredOutput` call); the runtime validates it against the schema and retries once on a mismatch. This way downstream code consumes an **object**, not prose it has to parse again.

```python
result = self.runner.run(prompt, schema, label)
if schema is not None:
    ok, err = SimpleJsonSchema(schema).validate(result)
    if not ok:                                       # one nudge retry, then raise
        result = self.runner.run(prompt + "\n\nReturn valid JSON.", schema, label)
        ok, err = SimpleJsonSchema(schema).validate(result)
        if not ok:
            raise WorkflowInputError(f"agent({{schema}}) invalid output: {err}")
```

> Real Claude Code: `SimpleJsonSchema` + the `StructuredOutput` tool + schema retry.

### Background task and progress events

`LocalWorkflowTask` holds the status/usage and emits an SDK-style event stream: `task_started` → a series of `task_progress` (carrying batches of `workflow_phase` / `workflow_agent` / `workflow_log`) → a final `task_notification` (completed / failed / stopped, with the output file, token count, tool-call count, and elapsed time). The main session treats these as events; only the final notification re-enters the loop.

```python
class LocalWorkflowTask:
    def progress_event(self, ptype, **data):         # workflow_phase / workflow_agent / workflow_log
        self.progress.append({"type": ptype, **data})
        print(f"  progress   {ptype} ...")
```

> Real Claude Code: progress is folded into the task status and sent to the UI/SDK as `task_progress.workflow_progress`.

### Storage: snapshot + journal

When a run finishes it writes five things, all under `~/.claude/projects/<project>/<session>/`: a snapshot `<runId>.json`, the output `<runId>.output.json`, the journal `<runId>.journal.jsonl`, the script `scripts/<runId>.js`, and the subagent transcripts `subagents/workflows/<runId>/`. Saved workflows live in `.claude/workflows/` (project) or `~/.claude/workflows/` (user).

The journal is the key to resume — it records the result of every `agent()`, one line at a time:

```python
class WorkflowJournal:
    def record(self, key, value):
        self._f.write(json.dumps({"key": key, "value": value}) + "\n")
        self._f.flush()
        self.cache[key] = value
```

### resume: reuse the cache from a runId

`Workflow({scriptPath, resumeFromRunId, args})` **re-runs the script**, but each `agent()` computes a **deterministic semantic key**: a key already in the journal returns its cached result directly (no re-run), so everything unchanged is a hit; only the changed one and whatever follows it actually runs.

The key here is that the key **must not depend on concurrency order** — inside `parallel`/`pipeline` the completion order of agents is undefined, so the key is computed from a stable hash of the call's content (kind, label, prompt, schema), not from a counter that would race.

```python
def key(self, kind, label, prompt, schema):
    basis = f"{kind}|{label}|{prompt}|{json.dumps(schema, sort_keys=True)}"
    return f"{kind}-{_stable_hash(basis) % 10**10:010d}"

# inside agent():
cached = self.journal.cached(key)
if cached is not MISS:
    self.task.progress_event("workflow_agent", label=label, status="cached")
    return cached
```

> Real Claude Code: the same "deterministic semantic key + journal cache"; within the same session, an `agent()` that completed before resume returns the cache, and what comes after it actually runs.

### Determinism: reproducibility is the prerequisite

For resume to hold, the script has to be reproducible. So the runtime strips `Date.now()`, the argless `new Date()`, and `Math.random()` out of the script context, and gives it no Node API either. The same script + the same args → the same key → a 100% cache hit. The teaching version reaches the same effect by computing the key from a stable hash (the real version runs the whole JS script in a sandbox VM with those non-deterministic sources removed).

### Putting it together

The example workflow `review-changes`: `pipeline` runs each review dimension through "audit → verify" independently — audit uses an `agent()` with a schema to find problems, verify uses `parallel()` to dispatch one adversarial verification subagent per finding, and at the end only the `isReal` ones survive, sorted by severity.

```python
async def sample_workflow(ctx, args):
    ctx.phase("Review")

    async def audit(_v, dimension, _i):
        out = await ctx.agent(f"Review the changed files for {dimension} issues.",
                              schema=FINDINGS_SCHEMA, label=f"audit:{dimension}", phase="Review")
        return {"dimension": dimension, "findings": out["findings"]}

    async def verify(audited, dimension, _i):
        ctx.phase("Verify")
        verdicts = await ctx.parallel([                       # verify each finding adversarially, independently
            (lambda f=f: ctx.agent(f"Adversarially verify ... {f['title']}",
                                   schema=VERDICT_SCHEMA, label=f"verify:{dimension}:{f['title']}"))
            for f in audited["findings"]])
        return {"dimension": dimension,
                "confirmed": [f for f, v in zip(audited["findings"], verdicts) if v and v["isReal"]]}

    results = await ctx.pipeline(DIMENSIONS, audit, verify)
    ...
```

## Changes from s20

| | s20 Comprehensive | s21 Workflow Runtime |
|--|-----------|---------------------|
| Loop | single, model-driven | main loop unchanged; a deterministic orchestration layer on top |
| Who decides the next step | the model, round by round | the script, with the orchestration written ahead of time |
| Multiple agents | s06 subagents, a one-shot fan-out | scripted, reproducible, resumable batch orchestration |
| New mechanisms | — | script DSL, background task, progress events, journal/resume, structured output, deterministic VM |

s21 does not replace the main loop — it exposes `Workflow` at the tool layer, and behind it starts a `local_workflow` runtime: **one workflow deterministically drives N agent loops**. The s06 subagent is the model fanning out once on the spot; s21 is the orchestration written as a replayable script.

## Try it

```bash
python s21_workflow_runtime/code.py          # launch review-changes, watch the event stream
python s21_workflow_runtime/code.py resume   # resume from the last runId, every agent() hits the journal cache
```

Watch: one launch → `async_launched` → background `workflow_phase` / `workflow_agent` progress → `task_notification`; the result stays on the task. On `resume`, `agents=0 tokens=0` (all cache hits), and the result is identical down to the character.

## What's next

Orchestration is one more layer on top of agent capability: **the main loop owns the step, the script owns the whole squad**. Write the work as a deterministic, resumable script and the model turns from a "round-by-round driver" into an "execution unit scheduled by a script" — the same `agent()` can be called on the spot by the model inside the main loop, or orchestrated in batches by a script inside a workflow.

What's next: [s22 Goal Loop](../s22_goal_loop/) — orchestration fans work out, away from the main loop; the next chapter reverses it, with a goal pulling control back in: until it's met, the turn isn't allowed to end.

<!-- translation-sync: zh@v1, en@v1, ja@v1 -->
