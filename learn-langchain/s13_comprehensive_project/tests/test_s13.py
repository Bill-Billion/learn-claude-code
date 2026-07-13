# 说明：这些测试用 DeterministicFakeEmbedding 只验证**管道正确性**——检索工具能被
# agent 调用、结果能回到消息轨迹。它**不**验证检索质量：DeterministicFakeEmbedding 的
# 向量来自 SHA-256(text)，语义关系被打散，检索排序随机。真实语义检索需用真实 embedding
# 跑 integration 测试。
from pathlib import Path

import pytest
from langchain_core.embeddings.fake import DeterministicFakeEmbedding
from langchain_core.messages import AIMessage, ToolMessage

import s13_comprehensive_project.code as course
from s13_comprehensive_project.code import (
    ask,
    build_assistant,
    build_retriever,
    final_answer,
    make_search_tool,
)
from shared.testing import ToolCallingFakeChatModel


def test_search_tool_wraps_retriever(tmp_path: Path) -> None:
    (tmp_path / "notes.md").write_text("Tools are Python functions with schema.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
    search_tool = make_search_tool(retriever)

    result = search_tool.invoke({"question": "tools schema"})

    assert "notes.md" in result


def test_assistant_can_call_retrieval_tool(tmp_path: Path) -> None:
    (tmp_path / "notes.md").write_text("Tools are Python functions with schema.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
    model = ToolCallingFakeChatModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "search_course_notes",
                            "args": {"question": "tool 是什么？"},
                            "id": "call_1",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="工具就是带 schema 的 Python 函数。"),
            ]
        )
    )
    assistant = build_assistant(model=model, retriever=retriever)

    result = ask(assistant, "thread-1", "tool 是什么？")

    assert any(isinstance(message, ToolMessage) for message in result["messages"])


def test_final_answer_returns_last_message(tmp_path: Path) -> None:
    (tmp_path / "notes.md").write_text("Course path starts from messages.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
    model = ToolCallingFakeChatModel(messages=iter([AIMessage(content="从 messages 开始。")]))
    assistant = build_assistant(model=model, retriever=retriever)

    assert final_answer(assistant, "thread-2", "从哪里开始？") == "从 messages 开始。"


def test_same_thread_accumulates_conversation_history(tmp_path: Path) -> None:
    (tmp_path / "notes.md").write_text("Course path starts from messages.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
    model = ToolCallingFakeChatModel(
        messages=iter(
            [
                AIMessage(content="我记住了。"),
                AIMessage(content="你刚才让我记住课程起点。"),
            ]
        )
    )
    assistant = build_assistant(model=model, retriever=retriever)

    first = ask(assistant, "memory-thread", "记住课程起点。")
    second = ask(assistant, "memory-thread", "我刚才让你记住什么？")

    assert len(first["messages"]) == 2
    assert [message.content for message in second["messages"]] == [
        "记住课程起点。",
        "我记住了。",
        "我刚才让你记住什么？",
        "你刚才让我记住课程起点。",
    ]


def test_assistant_wires_all_mechanisms(tmp_path: Path) -> None:
    # 综合课把前面的零件都焊上：检索工具（s06/s11）+ Todo 规划中间件（s10）。
    (tmp_path / "notes.md").write_text("Course path starts from messages.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
    model = ToolCallingFakeChatModel(messages=iter([AIMessage(content="好的。")]))
    assistant = build_assistant(model=model, retriever=retriever)

    final_answer(assistant, "thread-3", "整理一下课程要点")

    # s11 检索包成的工具 + s10 middleware 注入的 write_todos，都绑到了同一个 agent 上。
    assert "search_course_notes" in model.bound_tool_names
    assert "write_todos" in model.bound_tool_names


def test_assistant_prompt_requires_grounded_course_answers() -> None:
    prompt = getattr(course, "SYSTEM_PROMPT", "")

    assert "课程内容问题必须先搜索笔记" in prompt
    assert "资料不足就明确说不知道" in prompt
    assert "保留 [文件名] 来源标签" in prompt


def test_default_knowledge_path_does_not_depend_on_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    docs = build_retriever(embeddings=DeterministicFakeEmbedding(size=8)).invoke("course path")

    assert docs


def test_missing_knowledge_folder_fails_loudly(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Knowledge folder does not exist"):
        build_retriever(tmp_path / "missing", embeddings=DeterministicFakeEmbedding(size=8))


def test_empty_knowledge_folder_fails_loudly(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Knowledge folder contains no Markdown files"):
        build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
