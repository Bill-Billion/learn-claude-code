"""同一次 invoke 里带上历史：HumanMessage / AIMessage 列表就是模型看到的全部上下文。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.messages import AIMessage, HumanMessage

from shared.messages import message_text

load_dotenv()


def build_messages(question: str):
    return [
        HumanMessage(content="我正在学习 LangChain。"),
        AIMessage(content="很好，我们一次只学一个机制。"),
        HumanMessage(content=question),
    ]


def continue_conversation(question: str, model=None) -> str:
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    response = model.invoke(build_messages(question))
    return message_text(response)


if __name__ == "__main__":
    user_query = input("s02 >> ").strip()
    print(continue_conversation(user_query))
