from __future__ import annotations

import asyncio
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "s21_workflow_runtime" / "code.py"
MODULE_NAME = "s21_workflow_runtime_under_test"
SPEC = importlib.util.spec_from_file_location(MODULE_NAME, MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {MODULE_PATH}")
workflow = importlib.util.module_from_spec(SPEC)
sys.modules[MODULE_NAME] = workflow
SPEC.loader.exec_module(workflow)

META = {
    "name": "test-workflow",
    "description": "Exercise the teaching runtime",
    "phases": [{"title": "Test"}],
}


class RecordingRunner:
    def __init__(self, gate: asyncio.Event | None = None, delay: float = 0):
        self.gate = gate
        self.delay = delay
        self.calls: list[str] = []
        self.active = 0
        self.max_active = 0

    async def run(self, prompt, schema=None, label=None, model=None):
        self.calls.append(prompt)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.gate is not None:
                await self.gate.wait()
            if self.delay:
                await asyncio.sleep(self.delay)
            return workflow.AgentRun(
                value={"prompt": prompt},
                model_calls=1,
            )
        finally:
            self.active -= 1


class ReviewRunner:
    def __init__(self, audits, grouping):
        self.audits = audits
        self.grouping = grouping
        self.labels = []

    async def run(self, prompt, schema=None, label=None, model=None):
        self.labels.append(label)
        if label and label.startswith("audit:"):
            value = self.audits[label.removeprefix("audit:")]
        elif label == "consolidate":
            value = self.grouping
        elif label and label.startswith("verify:"):
            value = {"confirmed": True, "reason": "confirmed by test runner"}
        else:
            raise AssertionError(f"unexpected label: {label}")
        return workflow.AgentRun(value=value, model_calls=1)


class FakeMessages:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("unexpected model call")
        return self.responses.pop(0)


class FakeClient:
    def __init__(self, responses):
        self.messages = FakeMessages(responses)


def api_response(*blocks):
    return SimpleNamespace(
        content=list(blocks),
        usage=SimpleNamespace(input_tokens=3, output_tokens=2),
    )


async def launch(
    tmp_path: Path,
    runner,
    script,
    *,
    run_id: str | None = None,
    max_agents: int = workflow.MAX_AGENTS,
    concurrency: int = 4,
    workflows=None,
):
    events = []
    tool = workflow.WorkflowTool(
        runner=runner,
        store=tmp_path,
        permission=lambda _meta: "allow",
        sink=events.append,
        max_agents=max_agents,
        concurrency=concurrency,
        workflows=workflows or {},
    )
    ticket = await tool.call(
        META,
        script,
        resume_from_run_id=run_id,
    )
    return tool, ticket, events


def test_call_returns_before_background_agent_finishes(tmp_path: Path) -> None:
    async def scenario() -> None:
        gate = asyncio.Event()
        runner = RecordingRunner(gate=gate)

        async def script(ctx, _args):
            return await ctx.agent("slow")

        tool, ticket, events = await launch(tmp_path, runner, script)

        assert ticket["status"] == "async_launched"
        assert not tool.registry.jobs[ticket["taskId"]].done()
        assert tool.registry.get(ticket["taskId"]).status == "running"

        gate.set()
        task = await tool.wait(ticket["taskId"])

        assert task.status == "completed"
        assert task.output == {"prompt": "slow"}
        assert task.usage["model_calls"] == 1
        assert [event["type"] for event in events].count("task_notification") == 1

    asyncio.run(scenario())


def test_structured_output_must_be_the_only_final_tool_call(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        schema = {
            "type": "object",
            "required": ["answer"],
            "properties": {"answer": {"type": "string"}},
        }
        client = FakeClient(
            [
                api_response(
                    SimpleNamespace(
                        type="tool_use",
                        id="structured-1",
                        name="StructuredOutput",
                        input={"answer": "too early"},
                    ),
                    SimpleNamespace(
                        type="tool_use",
                        id="read-1",
                        name="read_file",
                        input={"path": "sample.txt"},
                    ),
                ),
                api_response(
                    SimpleNamespace(
                        type="tool_use",
                        id="structured-2",
                        name="StructuredOutput",
                        input={"answer": "checked"},
                    )
                ),
            ]
        )
        (tmp_path / "sample.txt").write_text("evidence", encoding="utf-8")
        runner = workflow.AnthropicAgentRunner(
            client=client,
            model="test-model",
            workdir=tmp_path,
        )

        result = await runner.run("inspect the sample", schema=schema)

        assert result.value == {"answer": "checked"}
        assert result.model_calls == 2
        assert len(client.messages.calls) == 2
        follow_up = client.messages.calls[1]["messages"][-2]["content"]
        assert any(
            "must be the only tool call" in item["content"]
            for item in follow_up
        )

    asyncio.run(scenario())


def test_failed_agent_still_records_model_usage(tmp_path: Path) -> None:
    async def scenario() -> None:
        prose = SimpleNamespace(type="text", text="I forgot the output tool.")
        client = FakeClient(
            [
                api_response(prose)
                for _ in range(workflow.MAX_STRUCTURED_OUTPUT_ATTEMPTS)
            ]
        )
        runner = workflow.AnthropicAgentRunner(
            client=client,
            model="test-model",
            workdir=tmp_path,
        )

        async def script(ctx, _args):
            return await ctx.agent(
                "Return one answer.",
                schema={
                    "type": "object",
                    "required": ["answer"],
                    "properties": {"answer": {"type": "string"}},
                },
            )

        tool, ticket, _events = await launch(tmp_path, runner, script)
        task = await tool.wait(ticket["taskId"])

        assert task.status == "failed"
        assert task.usage["model_calls"] == (
            workflow.MAX_STRUCTURED_OUTPUT_ATTEMPTS
        )
        assert task.usage["input_tokens"] == (
            3 * workflow.MAX_STRUCTURED_OUTPUT_ATTEMPTS
        )
        assert task.usage["output_tokens"] == (
            2 * workflow.MAX_STRUCTURED_OUTPUT_ATTEMPTS
        )

    asyncio.run(scenario())


def test_review_consolidates_same_issue_before_verification(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        runner = ReviewRunner(
            audits={
                "correctness": {
                    "findings": [
                        {
                            "title": "Division by zero violates the contract",
                            "severity": "high",
                            "evidence": "percentage() divides by total without a guard",
                        }
                    ]
                },
                "maintainability": {
                    "findings": [
                        {
                            "title": "Documented zero guard is missing",
                            "severity": "medium",
                            "evidence": "the docstring and implementation disagree",
                        }
                    ]
                },
            },
            grouping={
                "groups": [
                    {
                        "source_ids": ["r0", "r1"],
                        "title": "percentage() does not handle a zero total",
                        "evidence": "both reports describe the missing zero guard",
                    }
                ]
            },
        )

        tool, ticket, _events = await launch(
            tmp_path,
            runner,
            workflow.review_changes,
        )
        task = await tool.wait(ticket["taskId"])

        assert task.status == "completed"
        assert task.output["incomplete"] == []
        assert len(task.output["confirmed"]) == 1
        finding = task.output["confirmed"][0]
        assert finding["source_ids"] == ["r0", "r1"]
        assert finding["dimensions"] == [
            "correctness",
            "maintainability",
        ]
        assert finding["severity"] == "high"
        assert runner.labels.count("consolidate") == 1
        assert sum(
            label.startswith("verify:")
            for label in runner.labels
            if label
        ) == 1
        assert task.usage["model_calls"] == 4

    asyncio.run(scenario())


def test_invalid_consolidation_falls_back_without_losing_findings(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        runner = ReviewRunner(
            audits={
                "correctness": {
                    "findings": [
                        {
                            "title": "Issue A",
                            "severity": "high",
                            "evidence": "evidence A",
                        }
                    ]
                },
                "maintainability": {
                    "findings": [
                        {
                            "title": "Issue B",
                            "severity": "low",
                            "evidence": "evidence B",
                        }
                    ]
                },
            },
            grouping={
                "groups": [
                    {
                        "source_ids": ["r0"],
                        "title": "Issue A",
                        "evidence": "evidence A",
                    }
                ]
            },
        )

        tool, ticket, _events = await launch(
            tmp_path,
            runner,
            workflow.review_changes,
        )
        task = await tool.wait(ticket["taskId"])

        assert task.status == "completed"
        assert len(task.output["confirmed"]) == 2
        assert "omitted source id 'r1'" in task.output["incomplete"][0]
        source_ids = {
            source_id
            for finding in task.output["confirmed"]
            for source_id in finding["source_ids"]
        }
        assert source_ids == {"r0", "r1"}
        assert sum(
            label.startswith("verify:")
            for label in runner.labels
            if label
        ) == 2

    asyncio.run(scenario())


def test_consolidation_keeps_distinct_issues_separate(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        runner = ReviewRunner(
            audits={
                "correctness": {
                    "findings": [
                        {
                            "title": "Retries skip the final attempt",
                            "severity": "medium",
                            "evidence": "the loop stops one iteration early",
                        }
                    ]
                },
                "maintainability": {
                    "findings": [
                        {
                            "title": "Cache entries leak between tenants",
                            "severity": "high",
                            "evidence": "the cache key omits tenant_id",
                        }
                    ]
                },
            },
            grouping={
                "groups": [
                    {
                        "source_ids": ["r0"],
                        "title": "Retries skip the final attempt",
                        "evidence": "the retry loop has an off-by-one error",
                    },
                    {
                        "source_ids": ["r1"],
                        "title": "Cache entries leak between tenants",
                        "evidence": "the cache key omits tenant_id",
                    },
                ]
            },
        )

        tool, ticket, _events = await launch(
            tmp_path,
            runner,
            workflow.review_changes,
        )
        task = await tool.wait(ticket["taskId"])

        assert task.status == "completed"
        assert len(task.output["confirmed"]) == 2
        assert {
            tuple(finding["source_ids"])
            for finding in task.output["confirmed"]
        } == {("r0",), ("r1",)}
        assert sum(
            label.startswith("verify:")
            for label in runner.labels
            if label
        ) == 2
        assert task.usage["model_calls"] == 5

    asyncio.run(scenario())


def test_parallel_limits_concurrency_and_keeps_failures(tmp_path: Path) -> None:
    async def scenario() -> None:
        runner = RecordingRunner(delay=0.01)

        async def script(ctx, _args):
            async def fail():
                raise RuntimeError("branch failed")

            thunks = [
                lambda index=index: ctx.agent(f"agent-{index}")
                for index in range(4)
            ]
            thunks.insert(2, fail)
            return await ctx.parallel(thunks)

        tool, ticket, _events = await launch(
            tmp_path, runner, script, concurrency=2
        )
        task = await tool.wait(ticket["taskId"])

        assert task.status == "completed"
        assert [result.ok for result in task.output] == [
            True,
            True,
            False,
            True,
            True,
        ]
        assert "branch failed" in task.output[2].error
        assert runner.max_active == 2

    asyncio.run(scenario())


def test_resume_reuses_only_the_unchanged_prefix(tmp_path: Path) -> None:
    async def scenario() -> None:
        first_runner = RecordingRunner()

        async def first_script(ctx, _args):
            return [
                await ctx.agent("A"),
                await ctx.agent("B"),
                await ctx.agent("C"),
            ]

        first_tool, first_ticket, _events = await launch(
            tmp_path, first_runner, first_script
        )
        first_task = await first_tool.wait(first_ticket["taskId"])
        assert first_task.status == "completed"
        assert first_runner.calls == ["A", "B", "C"]

        resumed_runner = RecordingRunner()

        async def changed_script(ctx, _args):
            return [
                await ctx.agent("A"),
                await ctx.agent("B changed"),
                await ctx.agent("C"),
            ]

        resumed_tool, resumed_ticket, _events = await launch(
            tmp_path,
            resumed_runner,
            changed_script,
            run_id=first_ticket["runId"],
        )
        resumed_task = await resumed_tool.wait(resumed_ticket["taskId"])

        assert resumed_task.status == "completed"
        assert resumed_runner.calls == ["B changed", "C"]
        assert resumed_task.usage["cached"] == 1
        assert resumed_task.usage["agents"] == 2

    asyncio.run(scenario())


def test_nested_workflow_shares_the_agent_limit(tmp_path: Path) -> None:
    async def scenario() -> None:
        runner = RecordingRunner()

        async def child(ctx, _args):
            return await ctx.agent("child")

        workflows = {
            "child": (
                {"name": "child", "description": "child", "phases": []},
                child,
            )
        }

        async def parent(ctx, _args):
            await ctx.agent("parent")
            return await ctx.workflow("child")

        tool, ticket, _events = await launch(
            tmp_path,
            runner,
            parent,
            max_agents=1,
            workflows=workflows,
        )
        task = await tool.wait(ticket["taskId"])

        assert task.status == "failed"
        assert "agent() call limit reached" in task.error
        assert runner.calls == ["parent"]

    asyncio.run(scenario())


def test_pipeline_rejects_invalid_inputs(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def script(ctx, _args):
            with pytest.raises(workflow.WorkflowInputError):
                await ctx.parallel([None])
            with pytest.raises(workflow.WorkflowInputError):
                await ctx.pipeline([], None)
            return "checked"

        tool, ticket, _events = await launch(
            tmp_path, RecordingRunner(), script
        )
        task = await tool.wait(ticket["taskId"])
        assert task.status == "completed"

    asyncio.run(scenario())


@pytest.mark.parametrize("name", ["../escape", "nested/name", "", "name with spaces"])
def test_meta_rejects_unsafe_names(name: str) -> None:
    with pytest.raises(workflow.WorkflowInputError):
        workflow.validate_meta(
            {"name": name, "description": "unsafe", "phases": []}
        )


def test_unmatched_permission_requires_approval(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def script(_ctx, _args):
            return None

        tool = workflow.WorkflowTool(
            runner=RecordingRunner(),
            store=tmp_path,
        )
        with pytest.raises(workflow.WorkflowPermissionRequired):
            await tool.call(META, script)

    asyncio.run(scenario())


def test_resume_rejects_unsafe_run_id(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def script(_ctx, _args):
            return None

        tool = workflow.WorkflowTool(
            runner=RecordingRunner(),
            store=tmp_path,
            permission=lambda _meta: "allow",
        )
        with pytest.raises(workflow.WorkflowInputError, match="run id"):
            await tool.call(
                META,
                script,
                resume_from_run_id="../outside",
            )

    asyncio.run(scenario())


def test_same_run_cannot_resume_while_it_is_active(tmp_path: Path) -> None:
    async def scenario() -> None:
        gate = asyncio.Event()

        async def script(ctx, _args):
            return await ctx.agent("wait")

        tool = workflow.WorkflowTool(
            runner=RecordingRunner(gate=gate),
            store=tmp_path,
            permission=lambda _meta: "allow",
        )
        launched = await tool.call(META, script)

        with pytest.raises(workflow.WorkflowInputError, match="already running"):
            await tool.call(
                META,
                script,
                resume_from_run_id=launched["runId"],
            )

        gate.set()
        await tool.wait(launched["taskId"])

    asyncio.run(scenario())


def test_glob_cannot_escape_the_workdir(tmp_path: Path) -> None:
    runner = workflow.AnthropicAgentRunner(
        client=None,
        model="unused",
        workdir=tmp_path,
    )

    with pytest.raises(workflow.WorkflowInputError, match="current repository"):
        runner._run_tool("glob", {"pattern": "../*.txt"})


def test_read_file_returns_stable_line_numbers(tmp_path: Path) -> None:
    (tmp_path / "sample.py").write_text(
        "first = 1\nsecond = 2\nthird = 3\n",
        encoding="utf-8",
    )
    runner = workflow.AnthropicAgentRunner(
        client=None,
        model="unused",
        workdir=tmp_path,
    )

    result = runner._run_tool(
        "read_file",
        {"path": "sample.py", "offset": 2, "limit": 2},
    )

    assert result == "2: second = 2\n3: third = 3"


def test_glob_uses_git_visible_files_and_skips_ignored_worktrees(
    tmp_path: Path,
) -> None:
    subprocess.run(
        ["git", "init", "-q"],
        cwd=tmp_path,
        check=True,
    )
    (tmp_path / ".gitignore").write_text(
        ".worktrees/\nignored.py\n",
        encoding="utf-8",
    )
    (tmp_path / "tracked.py").write_text("tracked = True\n", encoding="utf-8")
    (tmp_path / "untracked.py").write_text(
        "untracked = True\n",
        encoding="utf-8",
    )
    (tmp_path / "ignored.py").write_text("ignored = True\n", encoding="utf-8")
    worktree = tmp_path / ".worktrees" / "other"
    worktree.mkdir(parents=True)
    (worktree / "hidden.py").write_text("hidden = True\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", ".gitignore", "tracked.py"],
        cwd=tmp_path,
        check=True,
    )
    runner = workflow.AnthropicAgentRunner(
        client=None,
        model="unused",
        workdir=tmp_path,
    )

    result = runner._run_tool("glob", {"pattern": "**/*.py"})

    assert result.splitlines() == ["tracked.py", "untracked.py"]


def test_glob_reports_when_the_result_is_truncated(tmp_path: Path) -> None:
    subprocess.run(
        ["git", "init", "-q"],
        cwd=tmp_path,
        check=True,
    )
    for index in range(workflow.MAX_GLOB_RESULTS + 5):
        (tmp_path / f"file_{index:03d}.py").write_text(
            "value = 1\n",
            encoding="utf-8",
        )
    runner = workflow.AnthropicAgentRunner(
        client=None,
        model="unused",
        workdir=tmp_path,
    )

    result = runner._run_tool("glob", {"pattern": "*.py"})

    lines = result.splitlines()
    assert len(lines) == workflow.MAX_GLOB_RESULTS + 1
    assert lines[-1] == "[truncated: 5 more matches]"
    assert len(result) <= workflow.MAX_GLOB_OUTPUT_CHARS


@pytest.mark.parametrize(
    ("concurrency", "max_agents"),
    [(0, 1), (1, 0), (workflow.MAX_AGENTS + 1, 1)],
)
def test_runtime_limits_are_bounded(
    tmp_path: Path, concurrency: int, max_agents: int
) -> None:
    with pytest.raises(workflow.WorkflowInputError):
        workflow.WorkflowTool(
            runner=RecordingRunner(),
            store=tmp_path,
            concurrency=concurrency,
            max_agents=max_agents,
        )


def test_corrupt_resume_journal_fails_cleanly(tmp_path: Path) -> None:
    run_id = "wf_corrupt"
    (tmp_path / f"{run_id}.journal.jsonl").write_text(
        "{not-json}\n", encoding="utf-8"
    )
    with pytest.raises(workflow.WorkflowInputError, match="line 1"):
        workflow.WorkflowJournal(run_id, resume=True, store=tmp_path)


def test_journal_rejects_a_path_like_run_id(tmp_path: Path) -> None:
    with pytest.raises(workflow.WorkflowInputError, match="run id"):
        workflow.WorkflowJournal("../outside", resume=False, store=tmp_path)
