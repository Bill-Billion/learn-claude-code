from pathlib import Path

from dotenv import load_dotenv
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_openai import OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()

knowledge_dir = Path(__file__).resolve().parent / "knowledge"
docs = [
    Document(page_content=path.read_text(encoding="utf-8"), metadata={"source": path.name})
    for path in sorted(knowledge_dir.glob("*.md"))
]
embeddings = OpenAIEmbeddings()

splitter = RecursiveCharacterTextSplitter(
    # 提示：每块的最大字符数。小的知识文件用 200-300 才看得到切分效果
    chunk_size=______________________________,
    # 提示：相邻块重复的边界字符数，用来保留切分处附近的上下文（如 40）
    chunk_overlap=___________________________,
)
# 提示：docs 和 embeddings 已准备好，只填写本课的 indexing 链路
splits = splitter.split_documents(______________________________)
store = InMemoryVectorStore(______________________________)
# 提示：把切好的 splits 存进向量库
store.add_documents(______________________________)
# 提示：k 是返回最相关的几个片段
retriever = store.as_retriever(search_kwargs={"k": __________________})

query = "短期记忆依赖什么？"
# retriever 内部会用建索引时的同一个 embeddings 向量化 query，再做 top-k 搜索
results = retriever.invoke(______________________________)
