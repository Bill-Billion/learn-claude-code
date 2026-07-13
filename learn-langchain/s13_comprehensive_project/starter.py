import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.middleware import TodoListMiddleware
from langchain.chat_models import init_chat_model
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from s13_comprehensive_project.code import build_retriever

load_dotenv()

SYSTEM_PROMPT = (
    "你是 LangChain 初学者课程助教。"
    "课程内容问题必须先搜索笔记。"
    "资料不足就明确说不知道。"
    "回答时保留 [文件名] 来源标签。"
)

model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
retriever = build_retriever()


@tool
def search_course_notes(question: str) -> str:
    """在本课程笔记中搜索与问题相关的片段。"""
    docs = retriever.invoke(question)
    return "\n\n".join(f"[{doc.metadata.get('source')}] {doc.page_content}" for doc in docs)


assistant = create_agent(
    model=model,
    # 提示：把上面的 search_course_notes 工具交给 agent
    tools=[______________________________],
    system_prompt=SYSTEM_PROMPT,
    # 提示：s10 的规划中间件，实例化后放进列表
    middleware=[______________________________],
    # 提示：s09 的记忆，用 InMemorySaver()
    checkpointer=________________________,
)
