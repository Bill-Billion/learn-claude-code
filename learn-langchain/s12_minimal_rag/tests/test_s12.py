# 说明：这些测试用 DeterministicFakeEmbedding 只验证**管道正确性**（检索结果被
# 拼进 context、传给模型、模型的回答被返回）。它**不**验证检索质量——
# DeterministicFakeEmbedding 的向量来自 SHA-256(text)，语义关系被打散，检索排序随机。
# 要验证 RAG 真的"找对了片段再回答"，需要用真实 embedding 跑 integration 测试。
from pathlib import Path

import pytest
from langchain_core.embeddings.fake import DeterministicFakeEmbedding
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from s12_minimal_rag.code import answer_question, build_retriever, format_context


def test_format_context_keeps_sources(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("Streaming shows partial output.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))

    context = format_context(retriever.invoke("streaming"))

    assert "[a.md]" in context


def test_answer_question_passes_context_to_model(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("Short-term memory uses checkpointer.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
    model = GenericFakeChatModel(messages=iter(["根据资料，答案是 checkpointer。"]))

    assert answer_question("memory 依赖什么？", retriever, model=model) == "根据资料，答案是 checkpointer。"


class RecordingModel:
    def __init__(self) -> None:
        self.received_messages = []

    def invoke(self, messages):
        self.received_messages = messages
        return AIMessage(content="根据 [a.md]，答案是 checkpointer。")


def test_rag_prompt_passes_context_and_requires_source_labels(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("Short-term memory uses checkpointer.", encoding="utf-8")
    retriever = build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
    model = RecordingModel()

    answer_question("memory 依赖什么？", retriever, model=model)

    prompt_text = "\n".join(str(message.content) for message in model.received_messages)
    assert "Short-term memory uses checkpointer." in prompt_text
    assert "回答时保留 [文件名] 来源标签" in prompt_text


def test_default_knowledge_path_does_not_depend_on_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    docs = build_retriever(embeddings=DeterministicFakeEmbedding(size=8), k=1).invoke("LangChain")

    assert docs


def test_missing_knowledge_folder_fails_loudly(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Knowledge folder does not exist"):
        build_retriever(tmp_path / "missing", embeddings=DeterministicFakeEmbedding(size=8))


def test_empty_knowledge_folder_fails_loudly(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Knowledge folder contains no Markdown files"):
        build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8))
