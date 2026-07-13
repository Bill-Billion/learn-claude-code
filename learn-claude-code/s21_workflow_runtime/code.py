"""
s21_workflow_runtime — Dynamic Workflow runtime (teaching version)

Clean-room behavioral reconstruction of Claude Code's `Workflow` tool / dynamic
workflow runtime. Grounded in @anthropic-ai/claude-code@2.1.177 observed
behavior (reverse-research/cc_workflow), NOT leaked source.

Idea:
  s01-s20 build a single, model-driven agent loop. s21 adds a deterministic
  orchestration LAYER on top: the main loop exposes a `Workflow` tool that
  launches a background runtime; a script written with agent()/parallel()/
  pipeline()/phase() drives many subagents deterministically, reports progress,
  persists a journal, and can resume from a runId.

Run:
  python code.py          # run the sample workflow, print the event stream
  python code.py resume   # resume the last run; unchanged agent() calls hit cache

Teaching simplifications (vs real runtime.mjs):
  - The "subagent" is a deterministic MockAgentRunner, not a real LLM.
  - A workflow is a plain async Python function, not a sandboxed JS script
    string. The real runtime runs the script in an isolated JS VM with
    Date.now()/Math.random() removed so resume is reproducible.
  - Storage is a local .runtime/ dir instead of ~/.claude/projects/.../workflows/.
"""

import asyncio
import hashlib
import json
import sys
from pathlib import Path

# ---- knobs that mirror the real runtime's guards ----
AGENT_CAP = 1000                       # hard cap on agent() calls per run
CONCURRENCY = 8                        # parallelism cap (semaphore)
STORE = Path(__file__).parent / ".runtime"   # snapshots + journals live here
MISS = object()                        # journal cache miss sentinel


def _stable_hash(s: str) -> int:
    """Process-stable hash (Python's hash() is salted per process, which would
    break resume keys across `run` and `resume`)."""
    return int(hashlib.sha256(s.encode()).hexdigest(), 16)


def create_run_id(meta) -> str:
    # Deterministic in the teaching version so the journal path is predictable
    # and `resume` lands on the same file. The real runtime mints a random id.
    return f"wf_{meta['name']}_{_stable_hash(meta['name']) % 10000:04d}"


def create_task_id(run_id) -> str:
    return f"local_workflow_{run_id}"


# ============================================================
# Errors
# ============================================================
class WorkflowInputError(Exception):
    """Bad script / meta / schema input (mirrors WorkflowInputError)."""


# ============================================================
# meta validation
# ============================================================
def validate_meta(meta):
    """Real runtime requires `export const meta = {...}` as the FIRST statement,
    a pure literal, with name + description (+ optional phases). We take a dict."""
    if not isinstance(meta, dict):
        raise WorkflowInputError("meta must be an object literal")
    if not meta.get("name") or not meta.get("description"):
        raise WorkflowInputError("meta requires `name` and `description`")
    if "phases" in meta and not isinstance(meta["phases"], list):
        raise WorkflowInputError("meta.phases must be a list")
    return meta


def check_permission(meta, settings=None):
    """allow / deny / ask gate before launch (s03 permission system, applied to
    Workflow). Teaching version allows by default; a deny rule blocks."""
    settings = settings or {}
    if meta["name"] in settings.get("deny", []):
        raise WorkflowInputError(f"workflow '{meta['name']}' denied by settings")
    return "allow"


# ============================================================
# Minimal JSON-schema for structured output (SimpleJsonSchema)
# ============================================================
class SimpleJsonSchema:
    """Tiny validator backing agent({schema}). Just enough for teaching:
    object/array/string/boolean/number + required keys."""

    def __init__(self, schema):
        self.schema = schema

    def validate(self, value, schema=None):
        schema = self.schema if schema is None else schema
        t = schema.get("type")
        if t == "object":
            if not isinstance(value, dict):
                return False, "expected object"
            for key in schema.get("required", []):
                if key not in value:
                    return False, f"missing required key '{key}'"
            for key, sub in schema.get("properties", {}).items():
                if key in value:
                    ok, err = self.validate(value[key], sub)
                    if not ok:
                        return False, f"{key}: {err}"
            return True, None
        if t == "array":
            if not isinstance(value, list):
                return False, "expected array"
            items = schema.get("items")
            if items:
                for i, el in enumerate(value):
                    ok, err = self.validate(el, items)
                    if not ok:
                        return False, f"[{i}]: {err}"
            return True, None
        if t == "string":
            return (isinstance(value, str), None if isinstance(value, str) else "expected string")
        if t == "boolean":
            return (isinstance(value, bool), None if isinstance(value, bool) else "expected boolean")
        if t in ("number", "integer"):
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
            return (ok, None if ok else "expected number")
        return True, None


def _fill_schema(schema, seed):
    """Deterministic generic filler used for schemas the mock doesn't special-case."""
    t = schema.get("type")
    if t == "object":
        keys = schema.get("required") or list(schema.get("properties", {}))
        return {k: _fill_schema(schema["properties"][k], f"{seed}/{k}") for k in keys}
    if t == "array":
        return [_fill_schema(schema["items"], f"{seed}/0")]
    if t == "boolean":
        return _stable_hash(seed) % 4 != 0
    if t in ("number", "integer"):
        return _stable_hash(seed) % 5
    return seed.rsplit("/", 1)[-1]


# ============================================================
# Subagent runner (mock for teaching; real path = an LLM tool loop)
# ============================================================
class MockAgentRunner:
    """Stands in for a spawned subagent. Deterministic so resume is reproducible.
    A real runner would run an isolated agent loop that calls repo tools and is
    forced to emit StructuredOutput when a schema is present."""

    def run(self, prompt, schema=None, label=None):
        if schema is None:
            return f"[mock] {(label or prompt)[:60]}"
        props = schema.get("properties", {})
        if "findings" in props:                       # an audit agent
            n = 1 + (_stable_hash(prompt) % 2)        # 1-2 findings
            sev = ["high", "medium", "low"]
            return {"findings": [
                {"title": f"{label or 'audit'} #{i + 1}",
                 "severity": sev[_stable_hash(prompt + str(i)) % 3]}
                for i in range(n)
            ]}
        if "isReal" in props:                         # a verifier agent
            real = _stable_hash(prompt) % 4 != 0      # ~75% confirmed
            return {"isReal": real,
                    "reason": "reproduced" if real else "could not reproduce"}
        return _fill_schema(schema, prompt)

    @staticmethod
    def tokens(prompt, result):
        return len(prompt) // 4 + len(json.dumps(result, default=str)) // 4


# ============================================================
# Journal (resume cache): started/result per agent under a semantic key
# ============================================================
class WorkflowJournal:
    """Append-only <runId>.journal.jsonl. On resume, agent() calls whose
    semantic key is already present are replayed from cache instead of re-run."""

    def __init__(self, run_id, resume, store=STORE):
        store.mkdir(parents=True, exist_ok=True)
        self.path = store / f"{run_id}.journal.jsonl"
        self.resume = resume
        self.cache = {}
        if resume and self.path.exists():
            for line in self.path.read_text().splitlines():
                rec = json.loads(line)
                self.cache[rec["key"]] = rec["value"]
            self._f = self.path.open("a")
        else:
            self._f = self.path.open("w")             # fresh run truncates

    def key(self, kind, label, prompt, schema):
        # Deterministic semantic key — independent of concurrency order, so a
        # parallel/pipeline call gets the same key on resume.
        basis = f"{kind}|{label}|{prompt}|{json.dumps(schema, sort_keys=True)}"
        return f"{kind}-{_stable_hash(basis) % 10**10:010d}"

    def cached(self, key):
        return self.cache.get(key, MISS)

    def record(self, key, value):
        self._f.write(json.dumps({"key": key, "value": value}) + "\n")
        self._f.flush()
        self.cache[key] = value

    def close(self):
        self._f.close()


# ============================================================
# Token budget
# ============================================================
class Budget:
    """budget.total / spent() / remaining(). Once spent reaches total, agent()
    calls raise (the real runtime enforces the same ceiling)."""

    def __init__(self, total=None):
        self.total = total
        self._spent = 0

    def add(self, n):
        self._spent += n

    def spent(self):
        return self._spent

    def remaining(self):
        return float("inf") if self.total is None else max(0, self.total - self._spent)


# ============================================================
# Background task state + progress events (the outer event stream)
# ============================================================
class LocalWorkflowTask:
    """type local_workflow. Holds status/usage and emits the SDK-like event
    stream: task_started, task_progress (workflow_phase/agent/log), task_notification."""

    def __init__(self, task_id, run_id, meta):
        self.task_id = task_id
        self.run_id = run_id
        self.meta = meta
        self.status = "running"
        self.usage = {"agents": 0, "tokens": 0}
        self.progress = []

    def event(self, name, **data):
        line = " ".join(f"{k}={v}" for k, v in data.items())
        print(f"  event      {name:<18} {line}")

    def progress_event(self, ptype, **data):
        self.progress.append({"type": ptype, **data})
        line = " ".join(f"{k}={v}" for k, v in data.items())
        print(f"  progress   {ptype:<16} {line}")


# ============================================================
# ExecutionState: the DSL the workflow script sees as `ctx`
# ============================================================
class ExecutionState:
    """Injected into the workflow script. Provides the orchestration primitives.
    Mirrors ExecutionState in runtime.mjs."""

    def __init__(self, task, journal, runner, budget, args, depth=0):
        self.task = task
        self.journal = journal
        self.runner = runner
        self.budget = budget
        self.args = args
        self._depth = depth
        self._phase = None
        self._phases_seen = set()
        self._agents = 0
        self._sem = asyncio.Semaphore(CONCURRENCY)

    def phase(self, title):
        """Start a phase; subsequent agent()s group under it. Upsert: emitting the
        same phase again (e.g. from each pipeline item) does not re-announce it."""
        self._phase = title
        if title not in self._phases_seen:
            self._phases_seen.add(title)
            self.task.progress_event("workflow_phase", title=title)

    def log(self, message):
        """Emit a workflow_log progress line."""
        self.task.progress_event("workflow_log", message=message)

    async def agent(self, prompt, schema=None, label=None, phase=None):
        """Spawn one subagent. With a schema, force StructuredOutput + validate
        (retry once). On resume, a cached key short-circuits the run."""
        label = label or (prompt[:24] + "…")
        self._agents += 1
        if self._agents > AGENT_CAP:
            raise WorkflowInputError(f"agent() cap reached ({AGENT_CAP})")
        if self.budget.remaining() <= 0:
            raise WorkflowInputError("token budget exceeded")

        key = self.journal.key("agent", label, prompt, schema)
        cached = self.journal.cached(key)
        if cached is not MISS:
            self.task.progress_event("workflow_agent", label=label,
                                     phase=phase or self._phase, status="cached")
            return cached

        async with self._sem:
            await asyncio.sleep(0)                      # yield: real subagents are async
            result = self.runner.run(prompt, schema, label)

        if schema is not None:
            ok, err = SimpleJsonSchema(schema).validate(result)
            if not ok:                                  # one nudge/retry, then fail
                result = self.runner.run(prompt + "\n\nReturn valid JSON.", schema, label)
                ok, err = SimpleJsonSchema(schema).validate(result)
                if not ok:
                    raise WorkflowInputError(f"agent({{schema}}) invalid output: {err}")

        toks = self.runner.tokens(prompt, result)
        self.budget.add(toks)
        self.task.usage["agents"] += 1
        self.task.usage["tokens"] += toks
        self.journal.record(key, result)
        self.task.progress_event("workflow_agent", label=label,
                                 phase=phase or self._phase, status="done")
        return result

    async def parallel(self, thunks):
        """BARRIER: run all thunks concurrently, await all. A thunk that throws
        resolves to None (filter before use)."""
        async def safe(t):
            try:
                return await t()
            except Exception:
                return None
        return await asyncio.gather(*[safe(t) for t in thunks])

    async def pipeline(self, items, *stages):
        """Per-item staged flow, NO barrier between stages: item A can be in
        stage 3 while item B is still in stage 1. Each stage gets
        (prev_result, original_item, index). A throwing stage drops that item."""
        async def run_item(item, idx):
            value = item
            for stage in stages:
                try:
                    value = await stage(value, item, idx)
                except Exception:
                    return None
            return value
        return await asyncio.gather(*[run_item(it, i) for i, it in enumerate(items)])

    async def workflow(self, name, args=None):
        """Run a saved workflow inline as a child (one level), sharing this run's
        journal + budget + agent counter."""
        if self._depth >= 1:
            raise WorkflowInputError("workflow() nesting is one level only")
        if name not in WORKFLOWS:
            raise WorkflowInputError(f"unknown workflow '{name}'")
        meta, fn = WORKFLOWS[name]
        child = ExecutionState(self.task, self.journal, self.runner, self.budget,
                               args or {}, depth=self._depth + 1)
        return await fn(child, args or {})


# ============================================================
# WorkflowTool: the tool entry (WorkflowTool.call)
# ============================================================
class WorkflowTool:
    """The Workflow tool. .call() validates meta, runs the permission check,
    creates runId/taskId, registers a LocalWorkflowTask, and runs the script in
    the background — driving progress, persisting the journal, returning the
    final result. Supports resumeFromRunId. Mirrors WorkflowTool.call in runtime.mjs."""

    async def call(self, meta, script_fn, args=None, resume_from_run_id=None):
        validate_meta(meta)
        check_permission(meta)
        args = args or {}
        run_id = resume_from_run_id or create_run_id(meta)
        task_id = create_task_id(run_id)
        resuming = resume_from_run_id is not None
        journal = WorkflowJournal(run_id, resume=resuming)

        task = LocalWorkflowTask(task_id, run_id, meta)
        # The real tool returns this immediately and runs the rest in background.
        launched = {"status": "async_launched", "taskId": task_id,
                    "taskType": "local_workflow", "runId": run_id,
                    "workflowName": meta["name"]}
        task.event("async_launched", runId=run_id, taskId=task_id)
        task.event("task_started", workflow=meta["name"],
                   phases=",".join(meta.get("phases", [])) or "-",
                   resume=resuming)

        ctx = ExecutionState(task, journal, MockAgentRunner(), Budget(args.get("budget")), args)
        try:
            result = await script_fn(ctx, args)
            task.status = "completed"
        except Exception as e:                          # failed / stopped close the loop too
            task.status = "failed"
            result = {"error": str(e)}
        finally:
            journal.close()

        _write_json(STORE / f"{run_id}.output.json", result)
        _save_last_run(run_id)
        task.event("task_notification", status=task.status,
                   agents=task.usage["agents"], tokens=task.usage["tokens"],
                   outputFile=f".runtime/{run_id}.output.json")
        return {"launched": launched, "result": result, "task": task}


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, default=str))


def _save_last_run(run_id):
    (STORE / "last_run.txt").write_text(run_id)


def _read_last_run():
    p = STORE / "last_run.txt"
    return p.read_text().strip() if p.exists() else None


# ============================================================
# Sample workflow: review changed code across dimensions, verify each finding.
# Mirrors cc_workflow/runtime/workflows/review_workflow.js (pipeline + parallel).
# ============================================================
FINDINGS_SCHEMA = {
    "type": "object", "required": ["findings"],
    "properties": {"findings": {"type": "array", "items": {
        "type": "object", "required": ["title", "severity"],
        "properties": {"title": {"type": "string"}, "severity": {"type": "string"}}}}},
}
VERDICT_SCHEMA = {
    "type": "object", "required": ["isReal", "reason"],
    "properties": {"isReal": {"type": "boolean"}, "reason": {"type": "string"}},
}

SAMPLE_META = {
    "name": "review-changes",
    "description": "Review changed files across dimensions, verify each finding",
    "phases": ["Review", "Verify"],
}

DIMENSIONS = ["correctness", "security", "performance", "style"]


async def sample_workflow(ctx, args):
    """pipeline over review dimensions (audit -> verify-each), then keep only the
    findings a verifier confirms. The plan is code, not a chat turn."""
    ctx.phase("Review")

    async def audit(_value, dimension, _idx):
        out = await ctx.agent(
            f"Review the changed files for {dimension} issues.",
            schema=FINDINGS_SCHEMA, label=f"audit:{dimension}", phase="Review")
        return {"dimension": dimension, "findings": out["findings"]}

    async def verify(audited, dimension, _idx):
        ctx.phase("Verify")
        # Each finding is verified by its own adversarial subagent, concurrently.
        verdicts = await ctx.parallel([
            (lambda f=f: ctx.agent(
                f"Adversarially verify this {dimension} finding — is it real? {f['title']}",
                schema=VERDICT_SCHEMA, label=f"verify:{dimension}:{f['title']}", phase="Verify"))
            for f in audited["findings"]])
        confirmed = [f for f, v in zip(audited["findings"], verdicts)
                     if v and v.get("isReal")]
        return {"dimension": dimension, "confirmed": confirmed}

    results = await ctx.pipeline(DIMENSIONS, audit, verify)
    confirmed = [{"dimension": r["dimension"], **f}
                 for r in results if r for f in r["confirmed"]]
    confirmed.sort(key=lambda f: {"high": 0, "medium": 1, "low": 2}.get(f["severity"], 3))
    ctx.log(f"confirmed {len(confirmed)} real finding(s)")
    return {"confirmed": confirmed}


# saved workflow registry (.claude/workflows/ analogue)
WORKFLOWS = {SAMPLE_META["name"]: (SAMPLE_META, sample_workflow)}


# ============================================================
# Demo
# ============================================================
async def main(argv):
    resume_id = None
    if argv and argv[0] == "resume":
        resume_id = _read_last_run()
        if not resume_id:
            print("nothing to resume — run `python code.py` first.")
            return
        print(f"resuming {resume_id} — unchanged agent() calls hit the journal cache\n")
    else:
        print("launching workflow `review-changes`\n")

    tool = WorkflowTool()
    out = await tool.call(SAMPLE_META, sample_workflow,
                          args={"budget": None}, resume_from_run_id=resume_id)

    print("\nresult:")
    for f in out["result"].get("confirmed", []):
        print(f"  [{f['severity']:<6}] {f['dimension']}: {f['title']}")
    t = out["task"]
    print(f"\nstatus={t.status}  agents={t.usage['agents']}  tokens={t.usage['tokens']}"
          f"  journal=.runtime/{t.run_id}.journal.jsonl")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
