[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# Learn Agent Harness

動作する最小レイヤーから始め、モデルの周囲にあるシステムを一つずつ構築します。

Learn Agent Harness は、Agent 製品がどのように組み立てられるかを学ぶための 3 コース構成の monorepo です。大きなフレームワークの裏に挙動を隠すのではなく、Loop、Tool、State、Context、Permission、Runtime の判断を段階的に見える形にします。

## コースを選ぶ

| コース | 構築するもの | Stack | Lessons | 言語 | Model access |
| --- | --- | --- | ---: | --- | --- |
| [Learn Claude Code](./learn-claude-code/) | 1 つの Loop から Goal と Multi-Agent Workflow まで育てる Claude Code 風 Coding Harness | Python | 22 | 英語、中国語、日本語 | 実例は Anthropic API を使用、Test は offline |
| [Learn Pi Agent](./learn-pi-agent/) | Session、Extension、Trust Boundary、Package を持つ小さな Event-driven Pi 風 Harness | TypeScript | 13 | 英語、中国語、日本語 | 完全に deterministic かつ offline |
| [Learn LangChain](./learn-langchain/) | Model、Prompt、Tool、Agent、Memory、LangGraph、RAG を段階的に学ぶコース | Python | 13 | 中国語 | 実例は OpenAI を使用、Test は offline |

各コースは独立しています。1 つのコースを学ぶために、他の 2 コースの依存関係を入れる必要はありません。

## 学習ルートを選ぶ

### First principles から学ぶ

まず **Learn Claude Code** で、最小 Agent Loop が完全な Coding Harness に成長する過程を追います。次に **Learn Pi Agent** で Event-driven な TypeScript 設計と比較し、最後に **Learn LangChain** で同じ仕組みを Framework の抽象へ対応付けます。

### TypeScript と Runtime 設計

**Learn Pi Agent** から始めます。Deterministic Provider によって、すべての Event と State transition を観察できます。Permission、Compaction、Task、Multi-Agent coordination を深く学ぶときは、Claude Code の直接的な Python 実装と比較してください。

### Framework、Graph、RAG

すぐに Application を作ることが目的なら **Learn LangChain** から始めます。その後、実装中心のコースを読み、Framework が内部で何を orchestration しているかを理解します。

### Architecture を比較する

3 コースで同じ関心事を横断的に読みます。Model adaptation、Tool dispatch、Turn state、Persistence、Context control、Extension point、Trust boundary です。名前は違っても、Engineering の問いは繰り返されます。

## Agent Harness とは何か

実用的な Agent 製品は、異なる 2 種類のものを組み合わせます。

```text
Agent product = trained model + harness

Harness = model adapter
        + tools
        + context and knowledge
        + state and memory
        + permissions
        + runtime and observation
```

Model は学習によって得た能力を提供します。Harness は、その能力が働く場所を提供します。Observation を提示し、Action を公開し、State を記録し、Boundary を強制し、各 Model call の前後で何が起きるかを決めます。

Prompt chain、Orchestration library、State graph は、いずれも有効な Harness tool になり得ます。Control flow と Application state を整理するものですが、それ自体が Agency を生むわけではありません。学習済み Model の使い方を組織します。

## 共通する Core Loop

3 コースは最終的に、同じ Provider-neutral loop に戻ります。

```text
messages = [user_request]

while true:
    response = model(messages, tools)
    messages += response

    if response has no tool calls:
        break

    for call in response.tool_calls:
        result = run_tool_with_policy(call)
        messages += result
```

実際の製品は Streaming、Hook、Retry、Compaction、Persistence、Scheduling、Team、Graph を追加します。それでも、この Loop が Model の意図と Harness の挙動が出会う場所です。

## 3 つのコース

### Learn Claude Code

22 の段階的な Python lesson で、最小 Loop から Coding Agent を再構築します。Tool use、Permission、Hook、Subagent、Skill loading、Context compaction、Memory、Recovery、Task、Scheduling、Agent team、Worktree isolation、MCP、Workflow runtime、Persistent goal を扱います。

- [English course guide](./learn-claude-code/README.md)
- [中文课程指南](./learn-claude-code/README.zh.md)
- [日本語コースガイド](./learn-claude-code/README.ja.md)

### Learn Pi Agent

13 の TypeScript lesson で、Provider を交換できる mini Pi 風 Harness を構築します。Event stream、Session tree、Context resource、Extension、Trust boundary、Package resolution、Integration を重視します。すべての Example と Test は Model key なしで動きます。

- [English course guide](./learn-pi-agent/README.md)
- [中文课程指南](./learn-pi-agent/README.zh.md)
- [日本語コースガイド](./learn-pi-agent/README.ja.md)

### Learn LangChain

13 の中国語 Python lesson で、直接の Model call から Prompt、Structured output、Tool、Agent、Middleware、Memory、Retrieval、LangGraph、総合 Project へ進みます。Starter、完成実装、Offline test によって抽象を具体的な Code に落とします。

- [中文课程指南](./learn-langchain/README.md)

## Repository Layout

```text
learn-agent-harness/
├── README.md
├── README-zh.md
├── README-ja.md
├── CONTRIBUTING.md
├── LICENSE
├── learn-claude-code/
├── learn-pi-agent/
└── learn-langchain/
```

Course dependency、生成 Site、Local source clone、内部 Planning material は意図的に Commit しません。

## はじめる

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness
```

次に 1 つのコースへ移動し、その Guide に従います。

```bash
cd learn-claude-code   # Python, 22 lessons
cd learn-pi-agent      # TypeScript, 13 lessons
cd learn-langchain     # Python, 13 lessons
```

上の 3 つの `cd` は Repository root から選ぶ別々の選択肢であり、連続した手順ではありません。

## Repository Principles

- **仕組みを見せる。** Teaching code は重要な State transition を見える形にします。
- **一度に 1 つの考えを追加する。** Lesson は積み上げますが、各 Chapter を Production framework にはしません。
- **Boundary を Test する。** Course check は deterministic で、有料 Model call を必要としません。
- **単純化を正直に示す。** Teaching shortcut と Production behavior を区別します。
- **Translation を同期する。** Trilingual lesson を変えるときは、Code block と技術的主張も同時に更新します。

Pull Request を開く前に [CONTRIBUTING.md](./CONTRIBUTING.md) を読んでください。

## License

[MIT](./LICENSE)
