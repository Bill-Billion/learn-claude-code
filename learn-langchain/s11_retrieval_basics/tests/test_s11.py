# 说明：这些测试用 DeterministicFakeEmbedding 只验证**管道正确性**——
# 文档能被加载、切分、存储、检索回来，且带上了 source metadata。
# 它**不**验证检索质量：DeterministicFakeEmbedding 用 SHA-256(text) 当随机种子生成
# 向量，语义关系被完全打散，不同文本之间的余弦相似度接近 0，检索排序本质上是随机的。
# 要验证"语义相关的片段排在前面"，需要用真实 embedding（如 OpenAIEmbeddings）跑
# integration 测试。code.py 里的默认 embedding 就是 OpenAIEmbeddings。
from pathlib import Path

import pytest
from langchain_core.embeddings.fake import DeterministicFakeEmbedding

from s11_retrieval_basics.code import build_retriever, load_markdown_docs, search_notes, split_docs


def test_load_and_split_markdown_docs(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("LangChain memory uses a checkpointer.", encoding="utf-8")

    docs = load_markdown_docs(tmp_path)
    splits = split_docs(docs)

    assert docs[0].metadata["source"] == "a.md"
    assert splits


def test_search_notes_uses_in_memory_vector_store(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("Short-term memory uses a checkpointer.", encoding="utf-8")
    (tmp_path / "b.md").write_text("Tools let agents call functions.", encoding="utf-8")

    docs = search_notes("memory checkpointer", folder=tmp_path, embeddings=DeterministicFakeEmbedding(size=8))

    assert docs
    assert all("source" in doc.metadata for doc in docs)
    assert build_retriever(tmp_path, embeddings=DeterministicFakeEmbedding(size=8), k=1).invoke("tools")


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
