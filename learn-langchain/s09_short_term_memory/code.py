"""挂上 InMemorySaver 的 agent：每轮只传新消息，同一 thread_id 的历史由 checkpointer 自动补全。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import InMemorySaver

from shared.messages import message_text

load_dotenv()


def build_agent(model=None, checkpointer=None):
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    if checkpointer is None:
        checkpointer = InMemorySaver()
    return create_agent(
        model=model,
        tools=[],
        system_prompt="你是一个会使用同一线程上下文的 LangChain 助教。",
        checkpointer=checkpointer,
    )


def run_turn(agent, thread_id: str, text: str):
    return agent.invoke(
        {"messages": [{"role": "user", "content": text}]},
        config={"configurable": {"thread_id": thread_id}},
    )


def answer_turn(agent, thread_id: str, text: str) -> str:
    result = run_turn(agent, thread_id, text)
    return message_text(result["messages"][-1])


if __name__ == "__main__":
    demo_agent = build_agent()
    print(answer_turn(demo_agent, "demo", "记住：我叫浩然。只回答：已记住。"))
    print(answer_turn(demo_agent, "demo", "我叫什么？只回答名字。"))
