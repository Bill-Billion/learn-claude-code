[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# Learn Agent Harness：モデルを動かす周辺システムを組み立てる

十分な能力を持つモデルは、依頼を理解し、次の行動を選べます。ただし、リポジトリを読み、コマンドを実行し、セッションを保存し、承認ルールを適用するには、モデルを取り巻くコードが必要です。Agent Harness はモデルに環境とツールを提示し、許可された操作を実行して、その結果と状態を次のターンへ渡します。

Learn Agent Harness は、この仕組みを 3 つの独立した実行可能なコースで学ぶリポジトリです。Python で Agent Loop を直接実装するコース、同じ処理を TypeScript のイベント駆動ランタイムとして追うコース、LangChain の抽象化を使ってアプリケーションを組み立てるコースがあります。実装方法が変わっても、考えるべき問いは共通です。モデルに何を見せるのか、どの操作を許すのか、どの状態を残すのか、アプリケーションは続行と終了をどう判断するのかを、実際のコードで確かめます。

## モデルが選び、Harness が実行可能な形にする

Agent 製品は、学習済みモデルと運用環境の組み合わせです。

```text
Agent product = trained model + harness

Harness = model adapter
        + tools and action interfaces
        + context and knowledge
        + state and memory
        + permissions and trust boundaries
        + runtime, observation, and recovery
```

モデルは初めて見る依頼を解釈し、次に何をするか判断します。Harness はプロバイダーの応答を変換し、ツール呼び出しを振り分け、実行結果を記録し、アクセス範囲を制限して、次のモデル呼び出しに必要な入力を組み立てます。

プロンプトチェーン、状態グラフ、ワークフローエンジンは Harness 側の仕組みです。明示的なルーティング、永続化、再試行、承認が必要な処理で役立ちます。これらは学習済みモデルの使い方を整理するものであり、未知の状況に対するモデルの判断を置き換えるものではありません。

| 責務 | モデル | Harness |
| --- | --- | --- |
| 意図と不足した情報を読み取る | 主に担当 | 関連するコンテキストを渡す |
| 回答またはツール呼び出しを選ぶ | 主に担当 | 利用可能な操作を定義する |
| コマンドまたは API 呼び出しを実行する | 実行を要求する | ポリシーに従って実行する |
| セッションと長期タスクを維持する | 渡された履歴を使う | 状態を保存、圧縮、復元する |
| 権限を適用する | 信頼境界にはなれない | 検証、承認要求、実行分離を行う |
| 失敗を観察して続行する | 失敗を解釈する | エラーを記録し、安全に再試行して根拠を返す |

## 1 つの Agent Loop を 3 つの実装から見る

どのコースも、モデルとツールの間にある同じループに戻ります。

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

ストリーミング、フック、メモリ、タスクキュー、グラフ、マルチエージェント連携は、このループの周囲に接続されます。変わるのは、アプリケーションが 1 ターンを観察し管理する方法です。意味のある次の行動はモデルが選び、実行とポリシーは Harness が管理します。

### 各コースで見えるもの

| 見方 | コース | コードに現れるもの | 理解する設計判断 |
| --- | --- | --- | --- |
| 直接実装 | [Learn Claude Code](./learn-claude-code/) | ループ、ハンドラーマップ、コンテキスト、永続化、チーム、目標確認 | Coding Harness に仕組みを一つずつ加える方法 |
| イベント駆動ランタイム | [Learn Pi Agent](./learn-pi-agent/) | 型付きプロバイダーイベント、ターン状態、セッション、拡張機能、信頼判定 | ランタイムをプロトコル層、コア、製品シェルに分ける方法 |
| フレームワークによる抽象化 | [Learn LangChain](./learn-langchain/) | モデル、メッセージ、プロンプト、ツール、Agent、ミドルウェア、検索、RAG | フレームワークが受け取り、返し、内部で組み立てるもの |

3 コースを比較すると、一つの学び方だけでは見落としやすい部分を補えます。フレームワークだけを使うと、デバッグに必要な状態遷移が隠れがちです。すべてを自作すると、すでに安定している抽象まで作り直すことになります。両方を知ることで、仕組みを明示すべき場所とフレームワークに任せる場所を選べます。

## コースを選ぶ

| コース | 最初に選ぶとよい人 | 技術スタック | レッスン数 | 言語 | 実モデルへの接続 |
| --- | --- | --- | ---: | --- | --- |
| [Learn Claude Code](./learn-claude-code/) | Harness Engineering と Coding Agent のアーキテクチャを基礎から学びたい人 | Python 3.11 | 22 | 英語、中国語、日本語 | Anthropic 互換 API |
| [Learn Pi Agent](./learn-pi-agent/) | プロトコルとイベント駆動ランタイムを学びたい TypeScript 開発者 | Node.js 25 + TypeScript | 14 | 英語、中国語、日本語 | s14 で任意に OpenAI 互換 API へ接続 |
| [Learn LangChain](./learn-langchain/) | LangChain で実装しながらコンポーネントの契約も理解したい Python 開発者 | Python 3.11 + uv | 13 | 中国語 | 既定は OpenAI |

ランタイムの依存関係はコースごとに独立しています。学習するコースだけをセットアップしてください。

## クイックスタート

リポジトリを一度クローンし、学習するコースへ移動します。続く 3 つのコースで示すコマンドは、すべてリポジトリのルートから実行してください。

```bash
git clone https://github.com/Bill-Billion/learn-claude-code.git learn-agent-harness
cd learn-agent-harness
```

## コース 1：Learn Claude Code

[Learn Claude Code](./learn-claude-code/) は、Coding Harness を 22 の Python レッスンで段階的に再構築します。最小のモデル・ツールループから始め、中心となるループを追える状態を保ったまま、長期タスク、安全な実行、複数 Agent の共同作業に必要な仕組みを加えます。

### 想定読者

フレームワークに主要な制御フローを委ねる前に、Agent の内部を自分で追いたい人向けです。Python 開発者、Coding Agent の画面の裏で何が起きているか知りたい利用者、別の領域向けに Harness を設計するエンジニアに適しています。

修了後は、モデルの判断とランタイムの責務を分け、ループを書き換えずにツールを追加し、有限のコンテキストを管理できるようになります。タスクの永続化、Subagent の連携、信頼できる根拠による完了判定までを一続きで扱えます。

### 22 レッスンの構成

| レッスン | Harness に加える層 |
| --- | --- |
| s01-s04 | Agent Loop、ツールの振り分け、権限、フック |
| s05-s11 | 計画、Subagent、Skill、コンテキスト圧縮、メモリ、プロンプト、障害復旧 |
| s12-s14 | 永続タスク、バックグラウンド処理、スケジューリング |
| s15-s18 | チーム、連携プロトコル、タスクの自動取得、Worktree による分離 |
| s19-s22 | MCP、全体統合、ワークフローランタイム、目標に基づく自動続行 |

初めて読む場合は、現在の 22 レッスンの学習ルートを進めてください。既存読者と過去のリンクのために旧 12 レッスン版も残してあり、[コースディレクトリ](./learn-claude-code/) 内のガイドに対応関係を記載しています。

### 実行方法

```bash
cd learn-claude-code
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt pytest
cp .env.example .env
# .env を編集し、実モデルを動かす前に ANTHROPIC_API_KEY を設定します。
python s01_agent_loop/code.py
python -m pytest -q
```

実行可能な章は `.env` のプロバイダー設定を読み込みます。テストスイートはローカルのテストダブルを使うため、モデルの API キーは不要です。コースガイドには、コース内容から生成する Web 学習画面の手順もあります。

- [English course guide](./learn-claude-code/README.md)
- [中文课程指南](./learn-claude-code/README.zh.md)
- [日本語コースガイド](./learn-claude-code/README.ja.md)

## コース 2：Learn Pi Agent

[Learn Pi Agent](./learn-pi-agent/) は、小さな Pi 風ランタイムを 14 の累積的な TypeScript レッスンで組み立てます。1 回のリクエストが、プロバイダーイベント、ツールループ、ターン状態、セッション、コンテキストリソース、拡張機能、実行モード、信頼判定、パッケージ解決を通る様子を追えます。s13 でオフラインの仕組みを統合し、s14 で同じ Harness を実際のプロバイダーにつなぎます。

### 想定読者

型の境界とランタイムイベントを手掛かりにシステムを理解したい人向けです。TypeScript 開発者、CLI や SDK の作者、プロトコル層、Agent コア、製品シェルを分離する方法を知りたい読者に適しています。

修了後は、差し替え可能なプロバイダー契約、ストリーミングイベントの正規化、コアループを変えずに追加できるライフサイクルフックを設計できます。セッションの分岐を保持し、実行ポリシーをモデル出力の外側に置く理由も、コードに沿って説明できるようになります。

### 14 レッスンの構成

| レッスン | Harness に加える層 |
| --- | --- |
| s01-s03 | 最小ループ、Tool Schema、正規化したプロバイダーイベント |
| s04-s06 | イベント駆動のツール実行、フック、ターン状態 |
| s07-s09 | セッションツリー、コンテキストリソース、拡張機能ランタイム |
| s10-s12 | 実行モード、信頼された実行環境、パッケージ解決 |
| s13 | 決定的に動く統合済み Harness |
| s14 | OpenAI 互換ストリーミングと実際のモデル・ツール・モデル往復 |

s01-s13 は決定的なプロバイダーを使うため、ネットワークリクエストを送らずにイベントと状態遷移を確認できます。s14 は任意で進める実モデルの章であり、オフラインの本編を置き換えるものではありません。

### 実行方法

```bash
cd learn-pi-agent
npm ci
npm run session:s01
npm run test:s01
npm run check
```

実モデルの章では、OpenAI 互換の Chat Completions エンドポイントを使用します。`OPENAI_BASE_URL` は省略でき、既定値は `https://api.openai.com/v1` です。

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="your-model"
export OPENAI_BASE_URL="https://api.openai.com/v1"
npm run session:s14 -- "Read README.md and summarize it."
```

プロバイダーへのネットワークリクエストを送るのは `session:s14` だけです。`npm run test:s14` はメモリ上の SSE フィクスチャを使い、`npm run check` は API キーなしでコース全体を検証します。

- [English course guide](./learn-pi-agent/README.md)
- [中文课程指南](./learn-pi-agent/README.zh.md)
- [日本語コースガイド](./learn-pi-agent/README.ja.md)

## コース 3：Learn LangChain

[Learn LangChain](./learn-langchain/README.md) は、現在公開されている LangChain API に沿った全 13 回の中国語コースです。レッスンごとに抽象を一つ追加し、入力型と戻り値をコード上で確認できる形にしています。直接のモデル呼び出しからメッセージ、プロンプト、構造化出力、ツール、Agent、メモリ、検索へ進み、最後に小さな RAG アプリケーションを完成させます。

### 想定読者

LangChain アプリケーションを作りたい一方で、フレームワークをブラックボックスとして扱いたくない人向けです。Python の基礎を学んだ初学者と、Agent や RAG の実装を始めたいアプリケーション開発者に適しています。

修了後は、用途に合う LangChain コンポーネントを選び、その入力型と戻り値の型を予測できるようになります。メッセージ状態が Agent 内をどう流れるか追い、RAG の各処理を検索、ツール、モデルのコンテキストのどこに置くか判断できます。

### 13 レッスンの構成

| レッスン | アプリケーションに加える層 |
| --- | --- |
| s01-s05 | モデル呼び出し、メッセージ、システムプロンプト、テンプレート、構造化出力 |
| s06-s10 | ツール、Agent、ストリーミング、短期メモリ、Todo ミドルウェア |
| s11-s13 | 検索の基礎、最小 RAG、統合したコースアシスタント |

本編は LangChain の基礎に範囲を絞っています。LangGraph による高度なオーケストレーション、MCP、マルチエージェントシステム、本番向けの外部ベクトルデータベースは次の学習項目であり、最初の 13 レッスンの前提ではありません。

### 実行方法

```bash
cd learn-langchain
uv sync --locked --extra dev
cp .env.example .env
# .env を編集し、実モデルを動かす前に OPENAI_API_KEY を設定します。
uv run python -m s01_first_model.code
uv run pytest -q
```

実モデルの例は `.env` から `LANGCHAIN_MODEL` とプロバイダーの認証情報を読みます。既定の構成は OpenAI です。別の Embedding 実装を注入しない限り、s11-s13 も OpenAI Embeddings を使います。テストはテスト用モデル、テスト用 Embedding、小さなローカル代替実装を使い、プロバイダーを呼び出しません。

- [中文课程指南](./learn-langchain/README.md)

## 学習ルートを選ぶ

### アーキテクチャを基礎から理解する

Claude Code、Pi Agent、LangChain の順に進めます。直接実装を理解してからイベントプロトコルとフレームワークの抽象化を比較できるため、リポジトリ全体を最も広く学べるルートです。

### TypeScript ランタイムを構築する

Pi Agent から始めます。イベントの正規化と直接的なリクエストループを比べるときは、Pi Agent の s03-s06 と Claude Code の s01-s04 を並べて読んでください。ランタイムが長期タスクを扱う段階で、Claude Code のコンテキスト、タスク、チームに関する章へ進みます。

### Agent または RAG アプリケーションをすぐ作る

LangChain の 13 レッスンを完走してから、どちらかの実装コースの最初の 4 レッスンを読みます。2 回目の比較によって、`create_agent` が内部で管理する状態とコードパスを具体的に把握できます。

### 1 つの設計課題を横断して比べる

同じ設計課題に対する 3 つの実装として比較できます。

| 課題 | Learn Claude Code | Learn Pi Agent | Learn LangChain |
| --- | --- | --- | --- |
| モデル境界 | Anthropic の Content Block と `stop_reason` | プロバイダー契約と正規化イベント | `init_chat_model` とメッセージオブジェクト |
| ツール境界 | JSON Schema とハンドラーの振り分け | 型付き Schema、イベント、実行フック | `@tool` と Agent が管理する ToolMessage |
| ターン状態 | `messages` と明示的なランタイム状態 | イベントストリームと `TurnState` | Agent の状態とメッセージ履歴 |
| 拡張 | フック、Skill、MCP | フック、拡張機能、パッケージ | ミドルウェアと組み合わせ可能なコンポーネント |
| コンテキスト | Skill、メモリ、圧縮 | コンテキストリソースとセッション分岐 | プロンプト、Checkpointer、検索 |
| 制御 | 権限、タスク、ワークフロー、目標 | 信頼判定と実行モード | Agent のオーケストレーションとミドルウェア |

## コースの進め方

1. コースガイドを読み、コードを変更する前にオフラインチェックを一度すべて実行します。
2. レッスンディレクトリを順に進み、前のレッスンから追加された仕組みを確認します。
3. 章のエントリーポイントを実行し、出力される状態またはイベントを調べます。
4. ツールの追加、操作の拒否、セッションの分岐、テストダブルの差し替えなど、境界を一つ変更します。
5. 章ごとのテストを実行してから、次のレッスンの実装と比較します。

実モデルへの接続では、プロバイダーの挙動とモデル・ツール間のやり取りを確認します。オフラインテストは契約、状態遷移、エラー処理を検証します。目的が異なるため、両方を実行することでコースの意図をつかめます。

## モデルへの接続と検証範囲

| コース | 実モデルでの実行 | オフライン検証 | ネットワーク境界 |
| --- | --- | --- | --- |
| Learn Claude Code | 各章のスクリプトは `ANTHROPIC_API_KEY`、`MODEL_ID`、任意の `ANTHROPIC_BASE_URL` を使用 | `python -m pytest -q` | テストはプロバイダーを呼ばない |
| Learn Pi Agent | s14 だけが `OPENAI_API_KEY`、`OPENAI_MODEL`、任意の `OPENAI_BASE_URL` を使用 | `npm run check` と各レッスンのテスト | s01-s13 と全テストはオフライン |
| Learn LangChain | 実行例は `LANGCHAIN_MODEL` とプロバイダーの認証情報を使用し、既定は OpenAI | `uv run pytest -q` | テストはローカルのテストダブルを使い、実行例だけがプロバイダーを呼ぶ場合がある |

3 コースは別々の環境とロックファイルを使うため、リポジトリのルートに共通のインストールコマンドはありません。CI もコース単位で実行します。

## リポジトリ構成

```text
learn-agent-harness/
├── README.md
├── README-zh.md
├── README-ja.md
├── CONTRIBUTING.md
├── LICENSE
├── .github/workflows/       # independent course checks and repository hygiene
├── learn-claude-code/       # 22 Python lessons, trilingual
├── learn-pi-agent/          # 14 TypeScript lessons, trilingual
└── learn-langchain/         # 13 Python lessons, Chinese
```

依存関係のディレクトリ、生成されたサイト、キャッシュ、ローカルのソースクローン、内部計画、モデル用ワークスペースファイルは公開ツリーに含めません。

## リポジトリの境界

- 各レッスンは一度に一つの仕組みを見せます。教育用の実装であり、本番用 SDK ではありません。
- 後のレッスンが前のコードを統合する場合も、各コースは依存関係と検証を独立して管理します。
- 実モデルの実行例には、有料のプロバイダーアカウントが必要な場合があります。自動テストは決定的かつオフラインに保ちます。
- Claude Code と Pi Agent は英語、中国語、日本語を同期します。Learn LangChain は現在、中国語版だけを公開しています。
- 簡略化した権限、ストレージ、プロバイダーアダプターには範囲を明記し、本番運用向けとして扱いません。

## コントリビューション

Pull Request を開く前に [CONTRIBUTING.md](./CONTRIBUTING.md) を読んでください。レッスン数、コマンド、プロバイダーの挙動、コース範囲を変える場合は、ルートの 3 つの README を同時に更新します。三言語対応コースの変更では、コースディレクトリ内の 3 つのガイドも揃えてください。

変更したすべてのコースで検証を実行し、生成物、依存関係のディレクトリ、ローカル参照、下書き、内部計画資料をコミットに含めないでください。

## ライセンス

[MIT](./LICENSE)
