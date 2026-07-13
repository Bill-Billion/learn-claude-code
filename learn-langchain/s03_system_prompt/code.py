"""规则进 SystemMessage、问题进 HumanMessage：同一个消息列表，两种职责。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.messages import HumanMessage, SystemMessage

from shared.messages import message_text

load_dotenv()


def build_role_messages(question: str, role: str, style: str):
    return [
        SystemMessage(content=f"你是{role}。回答风格：{style}。"),
        HumanMessage(content=question),
    ]


def ask_with_role(question: str, role: str, style: str, model=None) -> str:
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    response = model.invoke(build_role_messages(question, role, style))
    return message_text(response)


if __name__ == "__main__":
    query = input("s03 >> ").strip()
    print(ask_with_role(query, "耐心的 LangChain 助教", "少术语，先给直觉"))
