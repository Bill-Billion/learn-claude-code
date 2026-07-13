"""手动串起最小 RAG：检索 → 格式化上下文 → 填 RAG_PROMPT → 模型按资料作答，何时检索由代码写死。"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_openai import OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from shared.messages import message_text

load_dotenv()

DEFAULT_KNOWLEDGE_DIR = Path(__file__).resolve().parent / "knowledge"

RAG_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "你是课程助教。只能根据给定上下文回答；如果上下文没有答案，就说不知道。"
            "回答时保留 [文件名] 来源标签。",
        ),
        ("human", "问题：{question}\n\n上下文：\n{context}"),
    ]
)


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


def load_docs(folder: str | Path) -> list[Document]:
    return [
        Document(page_content=path.read_text(encoding="utf-8"), metadata={"source": path.name})
        for path in _markdown_paths(folder)
    ]


def build_retriever(folder: str | Path = DEFAULT_KNOWLEDGE_DIR, embeddings=None, k: int = 3):
    splitter = RecursiveCharacterTextSplitter(chunk_size=260, chunk_overlap=60, add_start_index=True)
    docs = splitter.split_documents(load_docs(folder))
    if embeddings is None:
        embeddings = OpenAIEmbeddings()
    store = InMemoryVectorStore(embeddings)
    store.add_documents(docs)
    return store.as_retriever(search_kwargs={"k": k})


def format_context(docs: list[Document]) -> str:
    return "\n\n".join(f"[{doc.metadata.get('source')}] {doc.page_content}" for doc in docs)


def answer_question(question: str, retriever, model=None) -> str:
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    docs = retriever.invoke(question)
    messages = RAG_PROMPT.invoke({"question": question, "context": format_context(docs)}).to_messages()
    response = model.invoke(messages)
    return message_text(response)


if __name__ == "__main__":
    rag_retriever = build_retriever()
    print(answer_question(input("s12 question >> ").strip(), rag_retriever))
