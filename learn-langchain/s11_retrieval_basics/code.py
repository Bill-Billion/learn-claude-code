"""离线建索引（读 Markdown → 切块 → 向量化 → 入库），在线 retriever.invoke 返回相关 Document。"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_openai import OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()

DEFAULT_KNOWLEDGE_DIR = Path(__file__).resolve().parent / "knowledge"


def _markdown_paths(folder: str | Path) -> list[Path]:
    folder_path = Path(folder)
    if not folder_path.exists():
        raise FileNotFoundError(f"Knowledge folder does not exist: {folder_path}")
    if not folder_path.is_dir():
        raise NotADirectoryError(f"Knowledge folder is not a directory: {folder_path}")

    paths = sorted(folder_path.glob("*.md"))
    if not paths:
        raise ValueError(f"Knowledge folder contains no Markdown files: {folder_path}")
    return paths


def load_markdown_docs(folder: str | Path) -> list[Document]:
    docs: list[Document] = []
    for path in _markdown_paths(folder):
        docs.append(
            Document(
                page_content=path.read_text(encoding="utf-8"),
                metadata={"source": path.name},
            )
        )
    return docs


def split_docs(docs: list[Document]) -> list[Document]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=220,
        chunk_overlap=40,
        add_start_index=True,
    )
    return splitter.split_documents(docs)


def build_retriever(folder: str | Path = DEFAULT_KNOWLEDGE_DIR, embeddings=None, k: int = 2):
    docs = load_markdown_docs(folder)
    splits = split_docs(docs)
    if embeddings is None:
        embeddings = OpenAIEmbeddings()
    store = InMemoryVectorStore(embeddings)
    store.add_documents(splits)
    return store.as_retriever(search_kwargs={"k": k})


def search_notes(
    query: str, folder: str | Path = DEFAULT_KNOWLEDGE_DIR, embeddings=None
) -> list[Document]:
    retriever = build_retriever(folder=folder, embeddings=embeddings)
    return retriever.invoke(query)


if __name__ == "__main__":
    for doc in search_notes(input("s11 query >> ").strip()):
        print(f"[{doc.metadata.get('source')}] {doc.page_content}")
