"""最小的一问一答：init_chat_model 拿模型，invoke 返回的是 AIMessage 而不是字符串。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model

from shared.messages import message_text

load_dotenv()


def build_model():
    model_name = os.environ["LANGCHAIN_MODEL"]
    return init_chat_model(model_name)


def ask_once(query: str, model=None) -> str:
    if model is None:
        model = build_model()
    response = model.invoke(query)
    return message_text(response)


if __name__ == "__main__":
    user_query = input("s01 >> ").strip()
    print(ask_once(user_query))

