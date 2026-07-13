"""TodoListMiddleware 挂进 middleware 列表：write_todos 工具、todos 状态和使用提示全部自动注入。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.middleware import TodoListMiddleware
from langchain.chat_models import init_chat_model

from shared.messages import message_text

load_dotenv()


def build_agent(model=None):
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    return create_agent(
        model=model,
        tools=[],
        middleware=[TodoListMiddleware()],
        system_prompt="你是一个做复杂任务前会先规划的 LangChain 助教。",
    )


def answer(query: str, model=None) -> str:
    agent = build_agent(model=model)
    result = agent.invoke({"messages": [{"role": "user", "content": query}]})
    return message_text(result["messages"][-1])


if __name__ == "__main__":
    print(answer(input("s10 >> ").strip()))
