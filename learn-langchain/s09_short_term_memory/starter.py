import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import InMemorySaver

load_dotenv()

agent = create_agent(
    model=init_chat_model(os.environ["LANGCHAIN_MODEL"]),
    tools=[],
    # 提示：给 agent 挂一个 checkpointer——本课用 InMemorySaver()
    checkpointer=________________________,
)

thread_id = ______________________________  # 例如："demo"
config = {"configurable": {"thread_id": thread_id}}

agent.invoke(
    {"messages": [{"role": "user", "content": "记住：我叫浩然。只回答：已记住。"}]},
    config=config,
)
result = agent.invoke(
    {"messages": [{"role": "user", "content": "我叫什么？只回答名字。"}]},
    config=config,
)
print(result["messages"][-1].content)
