from __future__ import annotations

import importlib.util
import itertools
import json
import os
import subprocess
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
_MODULE_IDS = itertools.count()


def load_course_module(relative_path: str, workdir: Path):
    fake_anthropic = types.ModuleType("anthropic")

    class FakeAnthropic:
        def __init__(self, *args, **kwargs):
            self.messages = SimpleNamespace(create=None)

    fake_dotenv = types.ModuleType("dotenv")
    fake_anthropic.Anthropic = FakeAnthropic
    fake_dotenv.load_dotenv = lambda override=True: None

    old_anthropic = sys.modules.get("anthropic")
    old_dotenv = sys.modules.get("dotenv")
    old_cwd = Path.cwd()
    old_model = os.environ.get("MODEL_ID")
    module_name = f"course_boundary_{next(_MODULE_IDS)}"
    module_path = REPO_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {module_path}")
    module = importlib.util.module_from_spec(spec)

    sys.modules["anthropic"] = fake_anthropic
    sys.modules["dotenv"] = fake_dotenv
    sys.modules[module_name] = module
    os.environ["MODEL_ID"] = "test-model"
    try:
        os.chdir(workdir)
        spec.loader.exec_module(module)
        return module
    finally:
        os.chdir(old_cwd)
        if old_model is None:
            os.environ.pop("MODEL_ID", None)
        else:
            os.environ["MODEL_ID"] = old_model
        if old_anthropic is None:
            sys.modules.pop("anthropic", None)
        else:
            sys.modules["anthropic"] = old_anthropic
        if old_dotenv is None:
            sys.modules.pop("dotenv", None)
        else:
            sys.modules["dotenv"] = old_dotenv


def run_git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    )


def init_repo(repo: Path) -> None:
    repo.mkdir()
    run_git(repo, "init", "-q")
    run_git(repo, "config", "user.name", "Course Test")
    run_git(repo, "config", "user.email", "course@example.com")
    (repo / "seed.txt").write_text("seed\n", encoding="utf-8")
    run_git(repo, "add", "seed.txt")
    run_git(repo, "commit", "-qm", "seed")


def disable_module_sleep(module) -> None:
    """Replace one course module's time binding without patching time globally."""
    real_time = module.time

    class TimeProxy:
        @staticmethod
        def sleep(_seconds):
            return None

        def __getattr__(self, name):
            return getattr(real_time, name)

    module.time = TimeProxy()


def test_memory_admission_rejects_current_session_constraints(
    tmp_path: Path,
) -> None:
    module = load_course_module("s09_memory/code.py", tmp_path)
    candidates = [
        {
            "name": "user-prefers-concise-output",
            "type": "user",
            "scope": "persistent",
            "description": "User prefers concise command output",
            "body": "Keep command summaries concise across future sessions.",
        },
        {
            "name": "project-fact-no-file-creation",
            "type": "project",
            "scope": "persistent",
            "description": "Do not create files in this session",
            "body": "The current task must not create files.",
        },
    ]
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text=json.dumps(candidates))
        ]
    )
    module.client.messages.create = lambda **_kwargs: response

    module.extract_memories([
        {
            "role": "user",
            "content": "Keep replies concise. Do not create files in this session.",
        }
    ])

    stored = module.list_memory_files()
    assert [memory["name"] for memory in stored] == [
        "user-prefers-concise-output"
    ]


def test_memory_admission_rejects_duplicates(tmp_path: Path) -> None:
    module = load_course_module("s09_memory/code.py", tmp_path)
    existing = [{
        "name": "preferred-shell",
        "description": "Use zsh for shell examples",
        "body": "The user prefers zsh.",
    }]
    duplicate = {
        "name": "preferred-shell",
        "type": "user",
        "scope": "persistent",
        "description": "Use zsh for shell examples",
        "body": "The user prefers zsh.",
    }
    assert module.should_store_memory(duplicate, existing) is False


def test_error_text_blocks_are_visible(tmp_path: Path) -> None:
    module = load_course_module("s11_error_recovery/code.py", tmp_path)

    def fail(**_kwargs):
        raise RuntimeError("model unavailable")

    module.client.messages.create = fail
    messages = [{"role": "user", "content": "hello"}]
    module.agent_loop(messages, module.update_context({}, messages))

    block = messages[-1]["content"][0]
    assert module._text_block(block) == "[Error] RuntimeError: model unavailable"


def test_s15_lead_yields_instead_of_polling_forever(
    tmp_path: Path,
) -> None:
    module = load_course_module("s15_agent_teams/code.py", tmp_path)

    class AlwaysPoll:
        def __init__(self):
            self.calls = 0

        def create(self, **_kwargs):
            self.calls += 1
            return SimpleNamespace(
                stop_reason="tool_use",
                content=[
                    SimpleNamespace(
                        type="tool_use",
                        id=f"poll-{self.calls}",
                        name="check_inbox",
                        input={},
                    )
                ],
            )

    messages_api = AlwaysPoll()
    module.client.messages = messages_api
    module.MAX_LEAD_TOOL_ROUNDS = 3
    messages = [{"role": "user", "content": "spawn a reviewer"}]

    status = module.agent_loop(
        messages, module.update_context({}, messages)
    )

    assert status == "yielded"
    assert messages_api.calls == 3


def test_s15_max_rounds_is_not_reported_as_success(
    tmp_path: Path,
) -> None:
    module = load_course_module("s15_agent_teams/code.py", tmp_path)
    report = module.build_teammate_report(
        "max_rounds",
        [{
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Two checks are still unfinished."}
            ],
        }],
        rounds=module.MAX_TEAMMATE_ROUNDS,
    )
    assert report == {
        "status": "max_rounds",
        "rounds": module.MAX_TEAMMATE_ROUNDS,
        "summary": "Two checks are still unfinished.",
    }


def test_plan_approval_wakes_an_idle_s16_teammate(
    tmp_path: Path,
) -> None:
    module = load_course_module("s16_team_protocols/code.py", tmp_path)
    disable_module_sleep(module)
    module.BUS.send(
        "lead",
        "reviewer",
        "Approved",
        "plan_approval_response",
        {"request_id": "req_000001", "approve": True},
    )
    messages = []

    action = module.wait_for_teammate_message("reviewer", messages)

    assert action == "resume"
    assert messages[-1]["content"] == (
        "[Plan approved] Proceed with the task."
    )


@pytest.mark.parametrize(
    "relative_path",
    [
        "s17_autonomous_agents/code.py",
        "s18_worktree_isolation/code.py",
        "s19_mcp_plugin/code.py",
        "s20_comprehensive/code.py",
    ],
)
def test_auto_claim_injects_the_complete_task_contract(
    tmp_path: Path,
    relative_path: str,
) -> None:
    workdir = tmp_path / Path(relative_path).parent.name
    workdir.mkdir()
    module = load_course_module(relative_path, workdir)
    disable_module_sleep(module)
    module.IDLE_POLL_INTERVAL = 1
    module.IDLE_TIMEOUT = 1

    dependency = module.create_task("Prepare inputs", "Create the input set.")
    module.claim_task(dependency.id, "lead")
    module.complete_task(dependency.id)
    task = module.create_task(
        "Write report",
        "Write report.md with evidence from the input set.",
        [dependency.id],
    )

    worktree_context = None
    if hasattr(task, "worktree"):
        task.worktree = "report-wt"
        module.save_task(task)
        (module.WORKTREES_DIR / "report-wt").mkdir(parents=True)
        worktree_context = {"path": None}

    messages = []
    if worktree_context is None:
        action = module.idle_poll(
            "worker", messages, "worker", "writer"
        )
    else:
        action = module.idle_poll(
            "worker",
            messages,
            "worker",
            "writer",
            worktree_context,
        )

    assert action == "work"
    content = messages[-1]["content"]
    payload = json.loads(
        content.removeprefix("<auto-claimed>\n").removesuffix(
            "\n</auto-claimed>"
        )
    )
    assert payload["id"] == task.id
    assert payload["description"] == (
        "Write report.md with evidence from the input set."
    )
    assert payload["blockedBy"] == [dependency.id]
    assert payload["owner"] == "worker"
    assert payload["status"] == "in_progress"
    if worktree_context is not None:
        assert payload["work_directory"] == worktree_context["path"]


@pytest.mark.parametrize(
    "relative_path",
    [
        "s18_worktree_isolation/code.py",
        "s19_mcp_plugin/code.py",
        "s20_comprehensive/code.py",
    ],
)
def test_worktree_removal_refuses_local_commits_without_upstream(
    tmp_path: Path,
    relative_path: str,
) -> None:
    repo = tmp_path / Path(relative_path).parent.name
    init_repo(repo)
    module = load_course_module(relative_path, repo)

    assert "created" in module.create_worktree("review")
    worktree = repo / ".worktrees" / "review"
    (worktree / "result.txt").write_text("important\n", encoding="utf-8")
    run_git(worktree, "add", "result.txt")
    run_git(worktree, "commit", "-qm", "local result")

    refused = module.remove_worktree("review")

    assert "1 new commit(s) since creation" in refused
    assert worktree.exists()
    assert run_git(repo, "rev-parse", "--verify", "wt/review").stdout.strip()

    removed = module.remove_worktree("review", discard_changes=True)
    assert removed == "Worktree 'review' removed"
    assert not worktree.exists()


def test_clean_worktree_can_be_removed_without_force(tmp_path: Path) -> None:
    repo = tmp_path / "clean-repo"
    init_repo(repo)
    module = load_course_module("s18_worktree_isolation/code.py", repo)

    assert "created" in module.create_worktree("clean")
    assert module.remove_worktree("clean") == "Worktree 'clean' removed"
    assert not (repo / ".worktrees" / "clean").exists()


def test_missing_worktree_record_fails_closed(tmp_path: Path) -> None:
    repo = tmp_path / "missing-record"
    init_repo(repo)
    module = load_course_module("s18_worktree_isolation/code.py", repo)
    module.create_worktree("review")
    module._worktree_record_path("review").unlink()

    refused = module.remove_worktree("review")

    assert "creation record is missing" in refused
    assert (repo / ".worktrees" / "review").exists()
    module.remove_worktree("review", discard_changes=True)


def test_mcp_annotations_remain_structured_host_metadata(
    tmp_path: Path,
) -> None:
    module = load_course_module("s19_mcp_plugin/code.py", tmp_path)
    module.connect_mcp("deploy")
    tools, _handlers = module.assemble_tool_pool()

    status_tool = next(
        tool for tool in tools if tool["name"] == "mcp__deploy__status"
    )
    assert "annotations" not in status_tool
    assert module.MCP_TOOL_ANNOTATIONS["mcp__deploy__status"] == {
        "readOnlyHint": True,
        "destructiveHint": False,
    }
    assert module.MCP_TOOL_ANNOTATIONS["mcp__deploy__trigger"] == {
        "readOnlyHint": False,
        "destructiveHint": True,
    }


def test_s20_mcp_permission_uses_annotations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = load_course_module("s20_comprehensive/code.py", tmp_path)
    module.connect_mcp("deploy")
    module.assemble_tool_pool()

    monkeypatch.setattr(
        "builtins.input",
        lambda _prompt: (_ for _ in ()).throw(
            AssertionError("read-only MCP tool prompted")
        ),
    )
    status = SimpleNamespace(name="mcp__deploy__status", input={})
    assert module.permission_hook(status) is None

    monkeypatch.setattr("builtins.input", lambda _prompt: "n")
    trigger = SimpleNamespace(name="mcp__deploy__trigger", input={})
    unknown = SimpleNamespace(name="mcp__other__unknown", input={})
    assert module.permission_hook(trigger) == "Permission denied by user"
    assert module.permission_hook(unknown) == "Permission denied by user"


def test_s20_background_detection_matches_command_entrypoints(
    tmp_path: Path,
) -> None:
    module = load_course_module("s20_comprehensive/code.py", tmp_path)
    cases = [
        ("pytest -q", True),
        ("cd package && python -m pytest tests", True),
        ("npm ci", True),
        ("npm run check", True),
        ("uv sync", True),
        ("cat pytest_out.txt", False),
        ("printf 'build report'", False),
        ("echo deploy status", False),
    ]
    for command, expected in cases:
        assert (
            module.is_slow_operation("bash", {"command": command})
            is expected
        )
