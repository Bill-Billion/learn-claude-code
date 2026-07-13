"""结课组装：检索包装成工具 + system_prompt 约束 + Todo 规划 + checkpointer 记忆，何时查资料由模型决定。"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.middleware import TodoListMiddleware
from langchain.chat_models import init_chat_model
from langchain.tools import tool
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_openai import OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langgraph.checkpoint.memory import InMemorySaver

from shared.messages import message_text

load_dotenv()

DEFAULT_KNOWLEDGE_DIR = Path(__file__).resolve().parent / "knowledge"

SYSTEM_PROMPT = (
    "你是 LangChain 初学者课程助教。"
    "课程内容问题必须先搜索笔记。"
    "资料不足就明确说不知道。"
    "回答时保留 [文件名] 来源标签。"
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


def build_retriever(folder: str | Path = DEFAULT_KNOWLEDGE_DIR, embeddings=None):
    splitter = RecursiveCharacterTextSplitter(chunk_size=260, chunk_overlap=40, add_start_index=True)
    docs = splitter.split_documents(load_docs(folder))
    if embeddings is None:
        embeddings = OpenAIEmbeddings()
    store = InMemoryVectorStore(embeddings)
    store.add_documents(docs)
    return store.as_retriever(search_kwargs={"k": 3})


def make_search_tool(retriever):
    @tool
    def search_course_notes(question: str) -> str:
        """在本课程笔记中搜索与问题相关的片段。"""
        docs = retriever.invoke(question)
        return "\n\n".join(f"[{doc.metadata.get('source')}] {doc.page_content}" for doc in docs)

    return search_course_notes


def build_assistant(model=None, retriever=None):
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    if retriever is None:
        retriever = build_retriever()
    return create_agent(
        model=model,
        tools=[make_search_tool(retriever)],
        system_prompt=SYSTEM_PROMPT,
        middleware=[TodoListMiddleware()],  # s10：复杂任务前先规划
        checkpointer=InMemorySaver(),  # s09：跨轮记忆
    )


def ask(agent, thread_id: str, question: str):
    return agent.invoke(
        {"messages": [{"role": "user", "content": question}]},
        config={"configurable": {"thread_id": thread_id}},
    )


def final_answer(agent, thread_id: str, question: str) -> str:
    result = ask(agent, thread_id, question)
    return message_text(result["messages"][-1])


if __name__ == "__main__":
    assistant = build_assistant()
    print(final_answer(assistant, "demo", input("s13 >> ").strip()))
