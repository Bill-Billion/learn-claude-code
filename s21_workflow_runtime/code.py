#!/usr/bin/env python3
"""
s21: Workflow Runtime

A workflow moves a stable multi-agent plan out of the conversation and into
code. The main session starts one background task, while the workflow launches
subagents, passes results between steps, reports progress, and records enough
state to resume an interrupted run.

Run:
  python s21_workflow_runtime/code.py
  python s21_workflow_runtime/code.py resume

The course uses Python async functions so the runtime stays readable. Saved
Claude Code workflows use JavaScript; the orchestration ideas are the same.
The live path uses the Anthropic API. Test doubles belong in tests only.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

MAX_AGENTS = 1000
MAX_BATCH_ITEMS = 4096
MAX_GLOB_RESULTS = 200
MAX_GLOB_OUTPUT_CHARS = 8000
MAX_STRUCTURED_OUTPUT_ATTEMPTS = 5
DEFAULT_MAX_TOKENS = 4096
DEFAULT_CONCURRENCY = min(16, max(2, (os.cpu_count() or 4) - 2))
DEFAULT_STORE = Path(__file__).parent / ".runtime"
MISS = object()
WORKFLOW_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class WorkflowError(Exception):
    """Base error for the teaching runtime."""


class WorkflowInputError(WorkflowError):
    """The workflow definition or one of its arguments is invalid."""


class WorkflowPermissionRequired(WorkflowError):
    """The caller must approve this workflow before it can start."""


@dataclass(frozen=True)
class Outcome:
    """One branch result. Failure is data instead of a silent None."""

    ok: bool
    value: Any = None
    error: str | None = None

    @classmethod
    def success(cls, value: Any) -> Outcome:
        return cls(ok=True, value=value)

    @classmethod
    def failure(cls, error: BaseException) -> Outcome:
        return cls(ok=False, error=f"{type(error).__name__}: {error}")


@dataclass(frozen=True)
class AgentRun:
    """A subagent result plus the usage accumulated by its tool loop."""

    value: Any
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0
    model_calls: int = 0


class AgentExecutionError(WorkflowError):
    """An agent failed after consuming part of its usage budget."""

    def __init__(self, message: str, usage: AgentRun):
        super().__init__(message)
        self.usage = usage


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _block_type(block: Any) -> str | None:
    if isinstance(block, dict):
        return block.get("type")
    return getattr(block, "type", None)


def _block_value(block: Any, key: str, default: Any = None) -> Any:
    if isinstance(block, dict):
        return block.get(key, default)
    return getattr(block, key, default)


def _response_usage(response: Any, key: str) -> int:
    usage = getattr(response, "usage", None)
    if usage is None:
        return 0
    return int(getattr(usage, key, 0) or 0)


def _extract_text(content: Any) -> str:
    if not isinstance(content, list):
        return str(content)
    return "\n".join(
        str(_block_value(block, "text", ""))
        for block in content
        if _block_type(block) == "text"
    ).strip()


class SimpleJsonSchema:
    """Small JSON Schema subset used to validate structured subagent results."""

    def __init__(self, schema: dict[str, Any]):
        self.schema = schema

    def validate(
        self, value: Any, schema: dict[str, Any] | None = None
    ) -> tuple[bool, str | None]:
        schema = self.schema if schema is None else schema
        expected = schema.get("type")

        if "enum" in schema and value not in schema["enum"]:
            return False, f"expected one of {schema['enum']}"

        if expected == "object":
            if not isinstance(value, dict):
                return False, "expected object"
            for key in schema.get("required", []):
                if key not in value:
                    return False, f"missing required key '{key}'"
            properties = schema.get("properties", {})
            for key, child_schema in properties.items():
                if key not in value:
                    continue
                ok, error = self.validate(value[key], child_schema)
                if not ok:
                    return False, f"{key}: {error}"
            if schema.get("additionalProperties") is False:
                extra = set(value) - set(properties)
                if extra:
                    return False, f"unexpected key '{min(extra)}'"
            return True, None

        if expected == "array":
            if not isinstance(value, list):
                return False, "expected array"
            child_schema = schema.get("items")
            if child_schema:
                for index, item in enumerate(value):
                    ok, error = self.validate(item, child_schema)
                    if not ok:
                        return False, f"[{index}]: {error}"
            return True, None

        checks = {
            "string": lambda item: isinstance(item, str),
            "boolean": lambda item: isinstance(item, bool),
            "number": lambda item: isinstance(item, (int, float))
            and not isinstance(item, bool),
            "integer": lambda item: isinstance(item, int)
            and not isinstance(item, bool),
            "null": lambda item: item is None,
        }
        if expected in checks and not checks[expected](value):
            return False, f"expected {expected}"
        return True, None


READ_ONLY_TOOLS = [
    {
        "name": "read_file",
        "description": "Read a UTF-8 text file inside the current repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer"},
                "limit": {"type": "integer"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "glob",
        "description": "List repository files matching a glob pattern.",
        "input_schema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}},
            "required": ["pattern"],
        },
    },
    {
        "name": "git_diff",
        "description": "Read the current git diff, optionally for one path.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
        },
    },
]


class AnthropicAgentRunner:
    """Run one focused subagent with read-only repository tools."""

    def __init__(
        self,
        client: Any,
        model: str,
        workdir: Path,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ):
        self.client = client
        self.model = model
        self.workdir = workdir.resolve()
        self.max_tokens = max_tokens

    @classmethod
    def from_env(cls, workdir: Path) -> AnthropicAgentRunner:
        try:
            from anthropic import Anthropic
            from dotenv import load_dotenv
        except ImportError as error:
            raise WorkflowError(
                "Install dependencies first: pip install -r requirements.txt"
            ) from error

        load_dotenv(override=True)
        model = os.getenv("MODEL_ID")
        if not model:
            raise WorkflowError("MODEL_ID is required in the environment or .env")
        if os.getenv("ANTHROPIC_BASE_URL"):
            os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
        client = Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))
        return cls(client=client, model=model, workdir=workdir)

    async def run(
        self,
        prompt: str,
        schema: dict[str, Any] | None = None,
        label: str | None = None,
        model: str | None = None,
    ) -> AgentRun:
        return await asyncio.to_thread(
            self._run_sync, prompt, schema, label, model
        )

    def _run_sync(
        self,
        prompt: str,
        schema: dict[str, Any] | None,
        label: str | None,
        model: str | None,
    ) -> AgentRun:
        messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
        tools = list(READ_ONLY_TOOLS)
        if schema is not None:
            tools.append(
                {
                    "name": "StructuredOutput",
                    "description": (
                        "Submit the final structured result. Call this only when "
                        "the investigation is complete."
                    ),
                    "input_schema": schema,
                }
            )

        system = (
            "You are a focused code-review subagent. Inspect the repository with "
            "the available read-only tools. Do not claim you checked something "
            "you did not inspect. "
        )
        if schema is not None:
            system += (
                "Finish by calling StructuredOutput exactly once with the final "
                "answer. Do not return the final answer as prose."
            )

        input_tokens = 0
        output_tokens = 0
        tool_calls = 0
        model_calls = 0
        structured_failures = 0

        def failure(message: str) -> AgentExecutionError:
            return AgentExecutionError(
                message,
                AgentRun(
                    value=None,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    tool_calls=tool_calls,
                    model_calls=model_calls,
                ),
            )

        for _turn in range(30):
            model_calls += 1
            try:
                response = self.client.messages.create(
                    model=model or self.model,
                    system=system,
                    messages=messages,
                    tools=tools,
                    max_tokens=self.max_tokens,
                )
            except Exception as error:
                raise failure(
                    f"agent '{label or 'unnamed'}' model call failed: "
                    f"{type(error).__name__}: {error}"
                ) from error
            input_tokens += _response_usage(response, "input_tokens")
            output_tokens += _response_usage(response, "output_tokens")
            messages.append({"role": "assistant", "content": response.content})

            tool_results = []
            tool_blocks = [
                block
                for block in response.content
                if _block_type(block) == "tool_use"
            ]
            for block in tool_blocks:
                tool_calls += 1
                name = _block_value(block, "name")
                arguments = _block_value(block, "input", {}) or {}
                tool_use_id = _block_value(block, "id")

                if name == "StructuredOutput":
                    if len(tool_blocks) != 1:
                        structured_failures += 1
                        output = (
                            "StructuredOutput must be the only tool call in "
                            "the final response."
                        )
                    else:
                        ok, error = SimpleJsonSchema(schema or {}).validate(
                            arguments
                        )
                    if len(tool_blocks) == 1 and ok:
                        return AgentRun(
                            value=arguments,
                            input_tokens=input_tokens,
                            output_tokens=output_tokens,
                            tool_calls=tool_calls,
                            model_calls=model_calls,
                        )
                    if len(tool_blocks) == 1:
                        structured_failures += 1
                        output = f"Schema validation failed: {error}"
                else:
                    try:
                        output = self._run_tool(name, arguments)
                    except Exception as error:
                        output = f"{type(error).__name__}: {error}"

                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": str(output),
                    }
                )

            if tool_results:
                if structured_failures >= MAX_STRUCTURED_OUTPUT_ATTEMPTS:
                    raise failure(
                        f"agent '{label or 'unnamed'}' could not produce valid "
                        "structured output"
                    )
                messages.append({"role": "user", "content": tool_results})
                continue

            if schema is None:
                return AgentRun(
                    value=_extract_text(response.content),
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    tool_calls=tool_calls,
                    model_calls=model_calls,
                )

            structured_failures += 1
            if structured_failures >= MAX_STRUCTURED_OUTPUT_ATTEMPTS:
                raise failure(
                    f"agent '{label or 'unnamed'}' did not call StructuredOutput"
                )
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Your answer must be submitted with the StructuredOutput "
                        "tool and must match its schema."
                    ),
                }
            )

        raise failure(f"agent '{label or 'unnamed'}' exceeded 30 turns")

    def _safe_path(self, path: str) -> Path:
        candidate = (self.workdir / path).resolve()
        try:
            candidate.relative_to(self.workdir)
        except ValueError as error:
            raise WorkflowInputError("path escapes the current repository") from error
        return candidate

    def _repository_files(self) -> list[str]:
        result = subprocess.run(
            [
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            cwd=self.workdir,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=30,
            check=False,
        )
        if result.returncode == 0:
            candidates = [item for item in result.stdout.split("\0") if item]
        else:
            candidates = [
                str(path.relative_to(self.workdir))
                for path in self.workdir.rglob("*")
                if path.is_file()
                and ".git" not in path.relative_to(self.workdir).parts
            ]

        files = []
        for relative in candidates:
            path = (self.workdir / relative).resolve()
            if path.is_file() and path.is_relative_to(self.workdir):
                files.append(path.relative_to(self.workdir).as_posix())
        return sorted(set(files))

    @staticmethod
    def _matches_glob(path: str, pattern: str) -> bool:
        candidate = PurePosixPath(path)
        if candidate.match(pattern):
            return True
        return pattern.startswith("**/") and candidate.match(pattern[3:])

    @staticmethod
    def _format_glob_matches(matches: list[str]) -> str:
        visible = []
        size = 0
        content_budget = max(0, MAX_GLOB_OUTPUT_CHARS - 64)
        for match in matches:
            if len(visible) >= MAX_GLOB_RESULTS:
                break
            next_size = size + len(match) + (1 if visible else 0)
            if next_size > content_budget:
                break
            visible.append(match)
            size = next_size

        if not visible:
            if matches:
                return f"[truncated: {len(matches)} matches exceed output limit]"
            return "(no matches)"
        if len(visible) == len(matches):
            return "\n".join(visible)
        remaining = len(matches) - len(visible)
        return "\n".join(
            [*visible, f"[truncated: {remaining} more matches]"]
        )

    def _run_tool(self, name: str, arguments: dict[str, Any]) -> str:
        if name == "read_file":
            path = self._safe_path(str(arguments["path"]))
            offset = max(1, int(arguments.get("offset", 1)))
            limit = min(500, max(1, int(arguments.get("limit", 200))))
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            selected = lines[offset - 1 : offset - 1 + limit]
            return "\n".join(
                f"{line_number}: {line}"
                for line_number, line in enumerate(selected, start=offset)
            )

        if name == "glob":
            pattern = str(arguments["pattern"])
            pattern_path = Path(pattern)
            if pattern_path.is_absolute() or ".." in pattern_path.parts:
                raise WorkflowInputError(
                    "glob pattern must stay inside the current repository"
                )
            matches = [
                path
                for path in self._repository_files()
                if self._matches_glob(path, pattern)
            ]
            return self._format_glob_matches(matches)

        if name == "git_diff":
            command = ["git", "diff", "--no-ext-diff", "--unified=3"]
            path = arguments.get("path")
            if path:
                safe = self._safe_path(str(path))
                command.extend(["--", str(safe.relative_to(self.workdir))])
            result = subprocess.run(
                command,
                cwd=self.workdir,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if result.returncode != 0:
                return result.stderr.strip() or f"git diff exited {result.returncode}"
            return result.stdout[-30000:] or "(no uncommitted diff)"

        raise WorkflowInputError(f"unknown subagent tool '{name}'")


def validate_meta(meta: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(meta, dict):
        raise WorkflowInputError("meta must be an object")
    name = meta.get("name")
    description = meta.get("description")
    if not isinstance(name, str) or not WORKFLOW_NAME.fullmatch(name):
        raise WorkflowInputError(
            "meta.name must contain only letters, numbers, '.', '_' or '-'"
        )
    if not isinstance(description, str) or not description.strip():
        raise WorkflowInputError("meta.description must be a non-empty string")
    phases = meta.get("phases", [])
    if not isinstance(phases, list):
        raise WorkflowInputError("meta.phases must be a list")
    for phase in phases:
        if not isinstance(phase, dict) or not isinstance(phase.get("title"), str):
            raise WorkflowInputError(
                "each meta.phases item must contain a string title"
            )
    return meta


def permission_decision(
    meta: dict[str, Any], settings: dict[str, Any] | None = None
) -> str:
    """Return allow, deny or ask. An unmatched workflow asks by default."""

    settings = settings or {}
    if settings.get("disableWorkflows"):
        return "deny"
    name = meta["name"]
    if name in settings.get("deny", []):
        return "deny"
    if name in settings.get("allow", []):
        return "allow"
    return "ask"


class WorkflowJournal:
    """Append-only agent records used by ordered prefix resume."""

    def __init__(self, run_id: str, resume: bool, store: Path):
        if (
            not isinstance(run_id, str)
            or not WORKFLOW_NAME.fullmatch(run_id)
        ):
            raise WorkflowInputError("journal run id is invalid")
        self.path = store / f"{run_id}.journal.jsonl"
        self.completed: dict[int, dict[str, Any]] = {}
        self._lock = threading.Lock()
        store.mkdir(parents=True, exist_ok=True)

        if resume:
            if not self.path.exists():
                raise WorkflowInputError(f"journal for run '{run_id}' does not exist")
            for line_number, line in enumerate(
                self.path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    raise WorkflowInputError(
                        f"invalid journal JSON on line {line_number}"
                    ) from error
                if record.get("type") == "agent_result":
                    try:
                        sequence = int(record["sequence"])
                    except (KeyError, TypeError, ValueError) as error:
                        raise WorkflowInputError(
                            f"invalid agent result on journal line {line_number}"
                        ) from error
                    if sequence < 0 or not isinstance(record.get("key"), str):
                        raise WorkflowInputError(
                            f"invalid agent result on journal line {line_number}"
                        )
                    self.completed[sequence] = record
            self._file = self.path.open("a", encoding="utf-8")
        else:
            self._file = self.path.open("w", encoding="utf-8")

    def cached(self, sequence: int, key: str) -> Any:
        record = self.completed.get(sequence)
        if record is None or record.get("key") != key:
            return MISS
        return record.get("value")

    def append(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._file.write(json.dumps(record, ensure_ascii=False) + "\n")
            self._file.flush()
        if record.get("type") == "agent_result":
            self.completed[int(record["sequence"])] = record

    def close(self) -> None:
        self._file.close()


@dataclass
class LocalWorkflowTask:
    task_id: str
    run_id: str
    meta: dict[str, Any]
    status: str = "running"
    output: Any = None
    error: str | None = None
    usage: dict[str, int] = field(
        default_factory=lambda: {
            "agents": 0,
            "cached": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "tool_calls": 0,
            "model_calls": 0,
        }
    )
    events: list[dict[str, Any]] = field(default_factory=list)
    _notified: bool = False

    def emit(
        self,
        event_type: str,
        sink: Callable[[dict[str, Any]], None] | None,
        **data: Any,
    ) -> None:
        event = {
            "type": event_type,
            "taskId": self.task_id,
            "runId": self.run_id,
            **data,
        }
        self.events.append(event)
        if sink:
            sink(event)

    def notify_once(
        self, sink: Callable[[dict[str, Any]], None] | None, output_file: Path
    ) -> None:
        if self._notified:
            return
        self._notified = True
        self.emit(
            "task_notification",
            sink,
            status=self.status,
            workflow=self.meta["name"],
            outputFile=str(output_file),
            error=self.error,
            usage=dict(self.usage),
        )


class WorkflowTaskRegistry:
    def __init__(self):
        self.tasks: dict[str, LocalWorkflowTask] = {}
        self.jobs: dict[str, asyncio.Task[None]] = {}

    def register(
        self, task: LocalWorkflowTask, job: asyncio.Task[None]
    ) -> None:
        self.tasks[task.task_id] = task
        self.jobs[task.task_id] = job

    def get(self, task_id: str) -> LocalWorkflowTask:
        if task_id not in self.tasks:
            raise WorkflowInputError(f"unknown workflow task '{task_id}'")
        return self.tasks[task_id]

    async def wait(self, task_id: str) -> LocalWorkflowTask:
        self.get(task_id)
        await self.jobs[task_id]
        return self.tasks[task_id]

    def cancel(self, task_id: str) -> None:
        self.get(task_id)
        self.jobs[task_id].cancel()


class SharedRunState:
    """State shared by the root workflow and every nested workflow."""

    def __init__(
        self,
        task: LocalWorkflowTask,
        journal: WorkflowJournal,
        runner: Any,
        sink: Callable[[dict[str, Any]], None] | None,
        concurrency: int,
        max_agents: int,
        resuming: bool,
    ):
        self.task = task
        self.journal = journal
        self.runner = runner
        self.sink = sink
        self.semaphore = asyncio.Semaphore(concurrency)
        self.max_agents = max_agents
        self.next_sequence = 0
        self.previous_key = ""
        self.resume_enabled = resuming
        self._reservation_lock = asyncio.Lock()
        self._phases_seen: set[str] = set()

    async def reserve_call(
        self,
        prompt: str,
        schema: dict[str, Any] | None,
        label: str,
        model: str | None,
    ) -> tuple[int, str, Any]:
        async with self._reservation_lock:
            if self.next_sequence >= self.max_agents:
                raise WorkflowInputError(
                    f"agent() call limit reached ({self.max_agents})"
                )
            sequence = self.next_sequence
            self.next_sequence += 1
            normalized = _json(
                {
                    "prompt": prompt,
                    "schema": schema,
                    "label": label,
                    "model": model,
                }
            )
            key = hashlib.sha256(
                f"{self.previous_key}\n{normalized}".encode()
            ).hexdigest()
            self.previous_key = key

            cached = MISS
            if self.resume_enabled:
                cached = self.journal.cached(sequence, key)
                if cached is MISS:
                    self.resume_enabled = False
            return sequence, key, cached

    def phase(self, title: str) -> None:
        if title in self._phases_seen:
            return
        self._phases_seen.add(title)
        self.task.emit("workflow_phase", self.sink, title=title)


class WorkflowContext:
    """The small orchestration surface available to a workflow function."""

    def __init__(
        self,
        shared: SharedRunState,
        args: dict[str, Any],
        workflows: dict[str, tuple[dict[str, Any], Callable[..., Awaitable[Any]]]],
        depth: int = 0,
    ):
        self.shared = shared
        self.args = args
        self.workflows = workflows
        self.depth = depth
        self.current_phase: str | None = None

    def phase(self, title: str) -> None:
        self.current_phase = title
        self.shared.phase(title)

    def log(self, message: str) -> None:
        self.shared.task.emit(
            "workflow_log", self.shared.sink, message=str(message)
        )

    async def agent(
        self,
        prompt: str,
        schema: dict[str, Any] | None = None,
        label: str | None = None,
        phase: str | None = None,
        model: str | None = None,
    ) -> Any:
        label = label or prompt[:40]
        sequence, key, cached = await self.shared.reserve_call(
            prompt, schema, label, model
        )
        active_phase = phase or self.current_phase

        if cached is not MISS:
            self.shared.task.usage["cached"] += 1
            self.shared.task.emit(
                "workflow_agent",
                self.shared.sink,
                sequence=sequence,
                label=label,
                phase=active_phase,
                status="cached",
            )
            return cached

        self.shared.journal.append(
            {
                "type": "agent_started",
                "sequence": sequence,
                "key": key,
                "label": label,
            }
        )
        self.shared.task.emit(
            "workflow_agent",
            self.shared.sink,
            sequence=sequence,
            label=label,
            phase=active_phase,
            status="running",
        )

        run: AgentRun | None = None
        try:
            async with self.shared.semaphore:
                run = await self.shared.runner.run(
                    prompt=prompt,
                    schema=schema,
                    label=label,
                    model=model,
                )
            if not isinstance(run, AgentRun):
                run = AgentRun(value=run)
            self.shared.task.usage["input_tokens"] += run.input_tokens
            self.shared.task.usage["output_tokens"] += run.output_tokens
            self.shared.task.usage["tool_calls"] += run.tool_calls
            self.shared.task.usage["model_calls"] += run.model_calls
            if schema is not None:
                ok, error = SimpleJsonSchema(schema).validate(run.value)
                if not ok:
                    raise WorkflowError(
                        f"agent '{label}' returned invalid structured output: {error}"
                    )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if isinstance(error, AgentExecutionError):
                self.shared.task.usage["input_tokens"] += error.usage.input_tokens
                self.shared.task.usage["output_tokens"] += error.usage.output_tokens
                self.shared.task.usage["tool_calls"] += error.usage.tool_calls
                self.shared.task.usage["model_calls"] += error.usage.model_calls
            self.shared.journal.append(
                {
                    "type": "agent_failed",
                    "sequence": sequence,
                    "key": key,
                    "label": label,
                    "error": f"{type(error).__name__}: {error}",
                }
            )
            self.shared.task.emit(
                "workflow_agent",
                self.shared.sink,
                sequence=sequence,
                label=label,
                phase=active_phase,
                status="failed",
                error=str(error),
            )
            raise

        self.shared.task.usage["agents"] += 1
        self.shared.journal.append(
            {
                "type": "agent_result",
                "sequence": sequence,
                "key": key,
                "label": label,
                "value": run.value,
            }
        )
        self.shared.task.emit(
            "workflow_agent",
            self.shared.sink,
            sequence=sequence,
            label=label,
            phase=active_phase,
            status="completed",
        )
        return run.value

    async def parallel(
        self, thunks: list[Callable[[], Awaitable[Any]]]
    ) -> list[Outcome]:
        if not isinstance(thunks, list):
            raise WorkflowInputError("parallel() expects a list")
        if len(thunks) > MAX_BATCH_ITEMS:
            raise WorkflowInputError(
                f"parallel() accepts at most {MAX_BATCH_ITEMS} items"
            )
        if any(not callable(thunk) for thunk in thunks):
            raise WorkflowInputError("every parallel() item must be callable")

        async def run_one(thunk: Callable[[], Awaitable[Any]]) -> Outcome:
            try:
                return Outcome.success(await thunk())
            except asyncio.CancelledError:
                raise
            except Exception as error:
                return Outcome.failure(error)

        return await asyncio.gather(*(run_one(thunk) for thunk in thunks))

    async def pipeline(
        self,
        items: list[Any],
        *stages: Callable[[Any, Any, int], Awaitable[Any]],
    ) -> list[Outcome]:
        if not isinstance(items, list):
            raise WorkflowInputError("pipeline() expects a list")
        if len(items) > MAX_BATCH_ITEMS:
            raise WorkflowInputError(
                f"pipeline() accepts at most {MAX_BATCH_ITEMS} items"
            )
        if not stages or any(not callable(stage) for stage in stages):
            raise WorkflowInputError("pipeline() expects one or more stage functions")

        async def run_item(item: Any, index: int) -> Outcome:
            value = item
            try:
                for stage in stages:
                    value = await stage(value, item, index)
                return Outcome.success(value)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                return Outcome.failure(error)

        return await asyncio.gather(
            *(run_item(item, index) for index, item in enumerate(items))
        )

    async def workflow(self, name: str, args: dict[str, Any] | None = None) -> Any:
        if self.depth >= 1:
            raise WorkflowInputError("nested workflows are limited to one level")
        if name not in self.workflows:
            raise WorkflowInputError(f"unknown workflow '{name}'")
        _meta, function = self.workflows[name]
        child = WorkflowContext(
            shared=self.shared,
            args=args or {},
            workflows=self.workflows,
            depth=self.depth + 1,
        )
        return await function(child, args or {})


class WorkflowTool:
    """Start workflow functions as registered background tasks."""

    def __init__(
        self,
        runner: Any,
        store: Path = DEFAULT_STORE,
        permission: Callable[[dict[str, Any]], str] | None = None,
        sink: Callable[[dict[str, Any]], None] | None = None,
        concurrency: int = DEFAULT_CONCURRENCY,
        max_agents: int = MAX_AGENTS,
        workflows: dict[
            str, tuple[dict[str, Any], Callable[..., Awaitable[Any]]]
        ]
        | None = None,
    ):
        if (
            not isinstance(concurrency, int)
            or isinstance(concurrency, bool)
            or not 1 <= concurrency <= MAX_AGENTS
        ):
            raise WorkflowInputError(
                f"concurrency must be between 1 and {MAX_AGENTS}"
            )
        if (
            not isinstance(max_agents, int)
            or isinstance(max_agents, bool)
            or not 1 <= max_agents <= MAX_AGENTS
        ):
            raise WorkflowInputError(
                f"max_agents must be between 1 and {MAX_AGENTS}"
            )
        self.runner = runner
        self.store = store
        self.permission = permission or (
            lambda meta: permission_decision(meta)
        )
        self.sink = sink
        self.concurrency = concurrency
        self.max_agents = max_agents
        self.workflows = workflows if workflows is not None else WORKFLOWS
        self.registry = WorkflowTaskRegistry()

    async def call(
        self,
        meta: dict[str, Any],
        script_fn: Callable[[WorkflowContext, dict[str, Any]], Awaitable[Any]],
        args: dict[str, Any] | None = None,
        resume_from_run_id: str | None = None,
    ) -> dict[str, Any]:
        validate_meta(meta)
        if (
            resume_from_run_id is not None
            and (
                not isinstance(resume_from_run_id, str)
                or not WORKFLOW_NAME.fullmatch(resume_from_run_id)
            )
        ):
            raise WorkflowInputError("resume run id is invalid")
        decision = self.permission(meta)
        if decision == "deny":
            raise WorkflowInputError(f"workflow '{meta['name']}' is not allowed")
        if decision != "allow":
            raise WorkflowPermissionRequired(
                f"workflow '{meta['name']}' needs approval"
            )

        run_id = resume_from_run_id or f"wf_{uuid.uuid4().hex[:12]}"
        if any(
            item.run_id == run_id and item.status == "running"
            for item in self.registry.tasks.values()
        ):
            raise WorkflowInputError(
                f"workflow run '{run_id}' is already running"
            )
        task_id = f"local_workflow_{uuid.uuid4().hex[:12]}"
        task = LocalWorkflowTask(task_id=task_id, run_id=run_id, meta=meta)
        self.store.mkdir(parents=True, exist_ok=True)
        (self.store / "last_run.txt").write_text(run_id, encoding="utf-8")
        job = asyncio.create_task(
            self._execute(
                task=task,
                script_fn=script_fn,
                args=args or {},
                resuming=resume_from_run_id is not None,
            )
        )
        self.registry.register(task, job)

        launched = {
            "status": "async_launched",
            "taskId": task_id,
            "taskType": "local_workflow",
            "runId": run_id,
            "workflowName": meta["name"],
        }
        task.emit("async_launched", self.sink, **launched)
        return launched

    async def _execute(
        self,
        task: LocalWorkflowTask,
        script_fn: Callable[[WorkflowContext, dict[str, Any]], Awaitable[Any]],
        args: dict[str, Any],
        resuming: bool,
    ) -> None:
        output_file = self.store / f"{task.run_id}.output.json"
        journal: WorkflowJournal | None = None
        try:
            journal = WorkflowJournal(
                run_id=task.run_id, resume=resuming, store=self.store
            )
            task.emit(
                "task_started",
                self.sink,
                workflow=task.meta["name"],
                resume=resuming,
            )
            shared = SharedRunState(
                task=task,
                journal=journal,
                runner=self.runner,
                sink=self.sink,
                concurrency=self.concurrency,
                max_agents=self.max_agents,
                resuming=resuming,
            )
            context = WorkflowContext(
                shared=shared,
                args=args,
                workflows=self.workflows,
            )
            task.output = await script_fn(context, args)
            task.status = "completed"
        except asyncio.CancelledError:
            task.status = "cancelled"
            task.error = "workflow was cancelled"
        except Exception as error:
            task.status = "failed"
            task.error = f"{type(error).__name__}: {error}"
        finally:
            if journal is not None:
                journal.close()
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text(
                json.dumps(
                    {
                        "status": task.status,
                        "output": task.output,
                        "error": task.error,
                        "usage": task.usage,
                    },
                    ensure_ascii=False,
                    indent=2,
                    default=str,
                ),
                encoding="utf-8",
            )
            task.notify_once(self.sink, output_file)

    async def wait(self, task_id: str) -> LocalWorkflowTask:
        return await self.registry.wait(task_id)


FINDINGS_SCHEMA = {
    "type": "object",
    "required": ["findings"],
    "additionalProperties": False,
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["title", "severity", "evidence"],
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "severity": {
                        "type": "string",
                        "enum": ["high", "medium", "low"],
                    },
                    "evidence": {"type": "string"},
                },
            },
        }
    },
}

CONSOLIDATION_SCHEMA = {
    "type": "object",
    "required": ["groups"],
    "additionalProperties": False,
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["source_ids", "title", "evidence"],
                "additionalProperties": False,
                "properties": {
                    "source_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "title": {"type": "string"},
                    "evidence": {"type": "string"},
                },
            },
        }
    },
}

VERDICT_SCHEMA = {
    "type": "object",
    "required": ["confirmed", "reason"],
    "additionalProperties": False,
    "properties": {
        "confirmed": {"type": "boolean"},
        "reason": {"type": "string"},
    },
}

SAMPLE_META = {
    "name": "review-changes",
    "description": "Review a target from several angles and verify every finding",
    "phases": [
        {"title": "Review", "detail": "Inspect the target in parallel"},
        {
            "title": "Consolidate",
            "detail": "Group reports that describe the same underlying issue",
        },
        {"title": "Verify", "detail": "Challenge every reported finding"},
    ],
}

REVIEW_DIMENSIONS = ["correctness", "maintainability"]
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def individual_groups(
    findings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return [
        {
            "source_ids": [finding["source_id"]],
            "dimensions": [finding["dimension"]],
            "title": finding["title"],
            "severity": finding["severity"],
            "evidence": finding["evidence"],
        }
        for finding in findings
    ]


def validate_consolidation(
    findings: list[dict[str, Any]],
    response: dict[str, Any],
) -> list[dict[str, Any]]:
    source_by_id = {finding["source_id"]: finding for finding in findings}
    expected = set(source_by_id)
    seen: set[str] = set()
    consolidated = []

    for index, group in enumerate(response["groups"]):
        source_ids = group["source_ids"]
        if not source_ids:
            raise WorkflowError(
                f"consolidation group {index} has no source_ids"
            )
        if len(source_ids) != len(set(source_ids)):
            raise WorkflowError(
                f"consolidation group {index} repeats a source id"
            )
        unknown = set(source_ids) - expected
        if unknown:
            raise WorkflowError(
                f"consolidation returned unknown source id '{min(unknown)}'"
            )
        overlap = set(source_ids) & seen
        if overlap:
            raise WorkflowError(
                f"consolidation reused source id '{min(overlap)}'"
            )
        title = group["title"].strip()
        evidence = group["evidence"].strip()
        if not title or not evidence:
            raise WorkflowError(
                f"consolidation group {index} needs a title and evidence"
            )

        sources = [source_by_id[source_id] for source_id in source_ids]
        dimensions = sorted(
            {source["dimension"] for source in sources},
            key=lambda item: (
                REVIEW_DIMENSIONS.index(item)
                if item in REVIEW_DIMENSIONS
                else len(REVIEW_DIMENSIONS),
                item,
            ),
        )
        severity = min(
            (source["severity"] for source in sources),
            key=lambda item: SEVERITY_ORDER.get(item, 3),
        )
        consolidated.append(
            {
                "source_ids": source_ids,
                "dimensions": dimensions,
                "title": title,
                "severity": severity,
                "evidence": evidence,
            }
        )
        seen.update(source_ids)

    missing = expected - seen
    if missing:
        raise WorkflowError(
            f"consolidation omitted source id '{min(missing)}'"
        )
    return consolidated


async def review_changes(
    context: WorkflowContext, args: dict[str, Any]
) -> dict[str, Any]:
    target = str(args.get("target") or "s21_workflow_runtime/code.py")
    context.phase("Review")

    async def audit(dimension: str) -> dict[str, Any]:
        return await context.agent(
            (
                f"Review {target} for {dimension} problems. Read the file before "
                "answering. Start from documented behavior and boundary cases. "
                "Report only concrete issues whose violated contract, reachable "
                "impact, or specific maintenance cost is supported by file "
                "evidence. Omit style preferences and speculative risks."
            ),
            schema=FINDINGS_SCHEMA,
            label=f"audit:{dimension}",
            phase="Review",
        )

    audits = await context.parallel(
        [
            lambda dimension=dimension: audit(dimension)
            for dimension in REVIEW_DIMENSIONS
        ]
    )
    findings: list[dict[str, Any]] = []
    incomplete: list[str] = []
    for dimension, result in zip(REVIEW_DIMENSIONS, audits):
        if not result.ok:
            incomplete.append(f"{dimension}: {result.error}")
            continue
        for finding in result.value["findings"]:
            findings.append(
                {
                    "source_id": f"r{len(findings)}",
                    "dimension": dimension,
                    **finding,
                }
            )

    consolidated = individual_groups(findings)
    if len(findings) > 1:
        context.phase("Consolidate")
        try:
            grouping = await context.agent(
                (
                    "Group reports that describe the same underlying code issue. "
                    "Merge only reports with the same root cause and affected "
                    "behavior or location, where one fix would resolve every "
                    "report in the group. If uncertain, keep them separate. "
                    "Every source_id must appear exactly once. Do not decide "
                    "whether the reports are true.\n\nReports: "
                    f"{_json(findings)}"
                ),
                schema=CONSOLIDATION_SCHEMA,
                label="consolidate",
                phase="Consolidate",
            )
            consolidated = validate_consolidation(findings, grouping)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            incomplete.append(
                "consolidate: "
                f"{type(error).__name__}: {error}; "
                "raw findings were verified separately"
            )

    context.phase("Verify")

    async def verify(
        finding: dict[str, Any], _original: dict[str, Any], _index: int
    ) -> dict[str, Any]:
        dimensions = "+".join(finding["dimensions"])
        verdict = await context.agent(
            (
                f"Independently verify this reported issue in {target}. Read the "
                "relevant code and try to disprove it. Confirm only if the exact "
                "root cause and stated impact follow from the code. A nearby real "
                "issue, a merely possible risk, or an overstated impact is not "
                f"enough.\n\nFinding: {_json(finding)}"
            ),
            schema=VERDICT_SCHEMA,
            label=f"verify:{dimensions}:{finding['title'][:24]}",
            phase="Verify",
        )
        if not verdict["confirmed"]:
            return {}
        return {**finding, "verification": verdict["reason"]}

    verdicts = (
        await context.pipeline(consolidated, verify)
        if consolidated
        else []
    )
    confirmed = [
        result.value
        for result in verdicts
        if result.ok and result.value
    ]
    incomplete.extend(
        result.error for result in verdicts if not result.ok and result.error
    )

    ranked = sorted(
        confirmed,
        key=lambda item: (
            SEVERITY_ORDER.get(item["severity"], 3),
            item["title"].lower(),
        ),
    )
    context.log(
        f"confirmed={len(ranked)} incomplete={len(incomplete)} target={target}"
    )
    return {
        "target": target,
        "confirmed": ranked,
        "incomplete": incomplete,
    }


WORKFLOWS: dict[
    str, tuple[dict[str, Any], Callable[..., Awaitable[Any]]]
] = {SAMPLE_META["name"]: (SAMPLE_META, review_changes)}


def print_event(event: dict[str, Any]) -> None:
    ignored = {"type", "taskId", "runId"}
    details = " ".join(
        f"{key}={value}"
        for key, value in event.items()
        if key not in ignored and value not in (None, "")
    )
    print(f"  {event['type']:<18} {details}")


def read_last_run(store: Path) -> str | None:
    path = store / "last_run.txt"
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


async def main(argv: list[str]) -> None:
    store = DEFAULT_STORE
    resume_id = None
    target = "s21_workflow_runtime/code.py"
    if argv and argv[0] == "resume":
        resume_id = read_last_run(store)
        if not resume_id:
            raise WorkflowInputError(
                "nothing to resume; run the workflow once before using resume"
            )
        if len(argv) > 1:
            target = argv[1]
    elif argv:
        target = argv[0]

    runner = AnthropicAgentRunner.from_env(Path.cwd())
    tool = WorkflowTool(
        runner=runner,
        store=store,
        permission=lambda _meta: "allow",
        sink=print_event,
    )
    launched = await tool.call(
        meta=SAMPLE_META,
        script_fn=review_changes,
        args={"target": target},
        resume_from_run_id=resume_id,
    )
    print(
        f"\nworkflow returned immediately: {launched['status']} "
        f"taskId={launched['taskId']}"
    )
    print("the main session is free while the background task continues\n")

    task = await tool.wait(launched["taskId"])
    print(f"\nstatus={task.status} runId={task.run_id}")
    if task.error:
        print(task.error)
        return
    for finding in task.output["confirmed"]:
        print(
            f"  [{finding['severity']:<6}] "
            f"{'+'.join(finding['dimensions'])}: {finding['title']}"
        )
    for failure in task.output["incomplete"]:
        print(f"  [incomplete] {failure}")


if __name__ == "__main__":
    try:
        asyncio.run(main(sys.argv[1:]))
    except WorkflowError as error:
        raise SystemExit(f"error: {error}") from error
