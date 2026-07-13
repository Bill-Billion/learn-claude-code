"""with_structured_output 绑定 Pydantic 契约：invoke 直接返回 BookNote 对象，不再是 AIMessage。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from pydantic import BaseModel, Field

load_dotenv()


class BookNote(BaseModel):
    title: str = Field(description="书名或材料标题")
    summary: str = Field(description="一句话摘要")
    tags: list[str] = Field(description="主题标签")


def extract_book_note(text: str, model=None) -> BookNote:
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    structured_model = model.with_structured_output(BookNote)
    return structured_model.invoke(f"请把下面材料整理成结构化读书笔记：\n{text}")


if __name__ == "__main__":
    note = extract_book_note("LangChain 把模型、消息、工具和检索组织成可组合组件。")
    print(note.model_dump_json(indent=2, ensure_ascii=False))
