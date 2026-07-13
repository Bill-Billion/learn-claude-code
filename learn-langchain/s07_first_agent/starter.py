import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langchain.tools import tool

load_dotenv()

model = init_chat_model(os.environ["LANGCHAIN_MODEL"])


# 来自 s06（原样搬来）：和 s06 的 count_words 完全一致。
@tool
def count_words(text: str) -> str:
    """统计输入文本中按空白分隔的词数。"""
    words = [word for word in text.split() if word]
    return f"词数：{len(words)}"


agent = create_agent(
    # s01 的 model 和 s06 的工具都不变；只填本课的新机制：把工具交给 agent。
    model=model,
    tools=[______________________________],
    system_prompt="你是一个会在需要时调用工具的助教。",
)
