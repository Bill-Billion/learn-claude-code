# s21: Workflow Runtime: The Model Decides Each Step, the Script Decides the Orchestration

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s19 → s20 → `s21`

> *"Let the model decide how to do one piece of work; let the script decide how a batch of work is arranged."*
>
> **Harness layer: orchestration.** Put stable, repeatable, parallel-friendly multi-agent processes into code.

---

![Workflow Runtime overview](images/workflow-runtime-overview.svg)

From s01 through s20, the model has always decided what happens next. It reads the context, chooses a tool, observes the result, and then chooses again. That is still the right approach for open-ended work.

Some tasks, however, already have a clear execution order. Consider reviewing a large change:

1. Find the files that need review.
2. Inspect different concerns in parallel.
3. Consolidate reports that describe the same root cause.
4. Independently verify each consolidated issue.
5. Rank the results and produce one report.

The model is needed to judge whether the code is wrong and whether a finding is real. It does not need to rediscover when to fan work out, who verifies each result, or how the final list is assembled on every turn.

A Workflow moves that arrangement into a script.

## Put the arrangement in code

Saved Claude Code workflows are JavaScript. The script uses ordinary conditions, loops, and variables, and delegates steps that require judgment to `agent()`:

```javascript
export const meta = {
  name: "review-changes",
  description: "Review changed files and verify every finding",
}

const audits = await pipeline(args.files, file =>
  agent(`Review ${file} for correctness problems.`, { label: file })
)

return audits.filter(Boolean)
```

This lesson reconstructs the runtime in Python so that background execution, concurrency, failure, and resume behavior remain easy to inspect. Its example has the same control structure:

```python
async def review_changes(context, args):
    context.phase("Review")

    audits = await context.parallel([
        lambda dimension=dimension: context.agent(
            f"Review the target for {dimension} problems",
            schema=FINDINGS_SCHEMA,
            label=f"audit:{dimension}",
        )
        for dimension in REVIEW_DIMENSIONS
    ])

    findings = []
    for dimension, result in zip(REVIEW_DIMENSIONS, audits):
        if not result.ok:
            continue
        for finding in result.value["findings"]:
            findings.append({
                "source_id": f"r{len(findings)}",
                "dimension": dimension,
                **finding,
            })

    context.phase("Consolidate")
    grouping = await context.agent(
        f"Group reports with the same root cause: {findings}",
        schema=CONSOLIDATION_SCHEMA,
        label="consolidate",
    )
    consolidated = validate_consolidation(findings, grouping)

    async def verify(finding, _original, _index):
        verdict = await context.agent(
            f"Independently verify this finding: {finding}",
            schema=VERDICT_SCHEMA,
            label=f"verify:{finding['title']}",
        )
        return finding if verdict["confirmed"] else {}

    context.phase("Verify")
    verdicts = await context.pipeline(consolidated, verify)

    return [
        result.value for result in verdicts
        if result.ok and result.value
    ]
```

The language changes, but the division of responsibility does not: the model handles judgment; the script starts work, waits, passes results, and finishes the run.

## Launch once, finish in the background

Workflow is one tool in the main agent's tool pool. When the model calls it, the tool registers a local task and returns immediately:

```python
job = asyncio.create_task(self._execute(...))
self.registry.register(task, job)

return {
    "status": "async_launched",
    "taskId": task_id,
    "runId": run_id,
}
```

The main session receives a task receipt instead of waiting for the whole process. The background task keeps running and emits phase, agent, and final completion events.

## agent() starts a complete subagent

`agent()` is not a single text-completion call. Each subagent has its own messages and tool loop. It can read files, inspect the diff, and decide whether another tool call is needed:

```python
for _turn in range(30):
    response = client.messages.create(
        model=model,
        messages=messages,
        tools=READ_ONLY_TOOLS,
    )
    messages.append({"role": "assistant", "content": response.content})

    tool_results = []
    for block in response.content:
        if _block_type(block) != "tool_use":
            continue
        output = self._run_tool(
            _block_value(block, "name"),
            _block_value(block, "input", {}),
        )
        tool_results.append({
            "type": "tool_result",
            "tool_use_id": _block_value(block, "id"),
            "content": output,
        })

    if tool_results:
        messages.append({"role": "user", "content": tool_results})
        continue

    return AgentRun(value=_extract_text(response.content))
```

The sample reviewer exposes read-only tools. `read_file` includes stable line numbers so later findings can point back to exact evidence. `glob` matches Git-tracked and unignored files, then limits both result count and character count so a broad search does not send `.worktrees` or generated files back to the model. A workflow that edits files should still use the permission checks and worktree isolation introduced in earlier lessons rather than letting several writers share one directory.

## parallel() and pipeline()

Use `parallel()` for independent work that must be collected together:

```python
audits = await context.parallel([
    lambda: audit("correctness"),
    lambda: audit("maintainability"),
])
```

All branches start concurrently, and results come back in input order after every branch settles.

Use `pipeline()` when every item must pass through several stages:

```python
results = await context.pipeline(
    findings,
    verify,
)
```

Stages stay ordered within one item, while different items can keep moving concurrently. One finding may finish verification while another is still reading the relevant code.

## First guarantee shape, then judge content

Workflow results flow into more code, so their fields must be stable. `agent(schema=...)` requires the subagent to finish with a structured value that matches the schema:

```python
{
    "findings": [
        {
            "title": "...",
            "severity": "high",
            "evidence": "..."
        }
    ]
}
```

A schema answers only whether downstream code can consume the value. It does not prove that the value is correct.

A valid `findings` array means the fields are present. A second agent still has to verify whether each finding is real, including whether the stated cause and impact follow from the code. Shape validation and semantic verification solve different problems; valid JSON is not trustworthy evidence by itself.

## Verify one issue once

Different review dimensions can report the same issue, but their titles rarely match exactly. A title is display text, not a reliable deduplication key.

The script assigns each raw report a source ID such as `r0` or `r1`. A Consolidate agent then decides which reports describe the same root cause:

```json
{
  "groups": [
    {
      "source_ids": ["r0", "r1"],
      "title": "percentage() does not handle a zero total",
      "evidence": "both reports point to the same missing zero guard"
    }
  ]
}
```

The model handles semantic grouping, but it merges reports only when one fix would resolve every report in the group; uncertain cases stay separate. The script checks that every source ID appears exactly once, keeps the strongest reported severity and all review dimensions, and starts one Verify agent for each consolidated issue.

If a grouping omits, repeats, or invents a source ID, the workflow records the error in `incomplete` and verifies the raw reports separately. A failed consolidation cannot silently drop a finding.

Even when every branch completes, the report does not prove that every defect was found. Parallel review improves coverage; it does not turn model judgment into an exhaustive check.

## Failure must not disappear

Parallel work can hit timeouts, rate limits, invalid output, or tool errors. Turning every exception into `None` makes two very different states indistinguishable:

- the branch completed and found nothing;
- the branch never completed its review.

`parallel()` and `pipeline()` therefore return explicit `Outcome` values:

```python
Outcome(ok=True, value=result)
Outcome(ok=False, error="RuntimeError: request timed out")
```

Verified findings can still enter the report, while unfinished review, consolidation, or verification branches are listed under `incomplete`. Partial results remain useful, but a failure is never reported as "no issue."

## Where resume begins

The runtime records every `agent()` call in start order together with its input and result. Resume compares calls from the beginning:

```text
old run: A → B → C  → D
new run: A → B → C' → D

resume:  reuse A and B
         run C' again
         run D again
```

After the first incomplete or changed step, every later step runs live. This prevents results from the old tail of a workflow from being attached to a new execution path.

Concurrent agents may finish in a different order, so the journal follows start order, not completion order.

The journal compares `agent()` call inputs; it does not detect changes in the files those agents inspect. Use `resume` to continue the same run. Start a new run after the code or input data changes.

## One run shares one set of limits

The concurrency semaphore, agent-call count, and usage belong to the whole run rather than one step. Usage tracks agents, model API calls, tokens, and tool calls separately. Nested workflows share those limits, so nesting cannot bypass them.

Permission is checked before launch. A workflow with no matching allow rule should ask the user. Running this lesson's script directly is itself explicit approval for its built-in example.

## Try it

Install dependencies and prepare `.env`:

```bash
pip install -r requirements.txt

# .env
ANTHROPIC_API_KEY=...
MODEL_ID=...
```

Run the built-in review:

```bash
python s21_workflow_runtime/code.py
```

Or choose a target file:

```bash
python s21_workflow_runtime/code.py s20_comprehensive/code.py
```

Resume the most recent run:

```bash
python s21_workflow_runtime/code.py resume
```

The event stream includes:

```text
async_launched
task_started
workflow_phase
workflow_agent
task_notification
```

Output and journal files live under `s21_workflow_runtime/.runtime/`. They are local runtime state and are not committed.

## What changed from s20

| | s20 comprehensive harness | s21 Workflow Runtime |
|---|---|---|
| Who decides what comes next | The model, turn by turn | A script executes an already-known arrangement |
| Multi-agent work | The model spawns subagents or teammates as needed | The script starts and collects a batch of subagents |
| Intermediate results | Return to the message history | Stay in script variables |
| Execution | Advances inside the current session | Advances as a local background task |
| Resume | Depends on session and task state | Reuses the completed prefix in agent start order |

Every `agent()` still runs the original agent loop. The script arranges the execution order across agents.

Not every task belongs in a Workflow. Keep using the ordinary agent loop when requirements are changing or the next step depends on what the model discovers. Move the arrangement into code only when the process is stable and worth repeating.

Next: [s22 Goal Loop](../s22_goal_loop/) checks a completion condition whenever a turn wants to stop. A Workflow finishing means that its script ended; it does not necessarily mean the user's final goal is satisfied.

<!-- translation-sync: zh@v4, en@v4, ja@v4 -->
