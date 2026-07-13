import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.middleware import TodoListMiddleware
from langchain.chat_models import init_chat_model

load_dotenv()

model = init_chat_model(os.environ["LANGCHAIN_MODEL"])

agent = create_agent(
    model=model,
    tools=[],
    # 提示：它会注册 write_todos、扩展 todos state，并挂接模型调用前后的规则
    middleware=[________________________],
)
