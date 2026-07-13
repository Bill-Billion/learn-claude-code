# Contributing

这个仓库欢迎补课、修错和补测试，但贡献必须服务于初学者学习路径。

## 新课程准入

- 一课只引入一个新的主概念。
- 必须有 `README.md`、`starter.py`、`code.py` 和至少一个无 API 单测。
- README 必须写清楚：本课新增什么、为什么需要它、如何运行、如何自测、下一课为什么自然出现。
- 示例代码必须使用 LangChain 真实公开 API；测试替身只能放在测试或 `shared/testing.py` 中。
- 不要在前 13 课主线加入 LangGraph 深层编排、MCP、多智能体、Deep Agents 或外部向量数据库。

## 验证

```bash
uv run python scripts/check_lessons.py
uv run pytest -q
uv run ruff check .
uv run mypy .
```

真实 API 集成测试只能作为可选测试，必须用 `pytest.mark.integration` 标记，并在缺少环境变量时跳过。
