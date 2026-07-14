# Learn Pi Agent -- 小さく拡張可能な Agent Harness を作る

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

## モデルが判断し、Harness がその判断を実行可能にする

LLM は判断力を提供します。状況を読み、直接答えるかツールを使うかを選び、結果を確認して次の一手を決めます。Agent Harness は、その判断を動かすための条件を提供します。メッセージ、ツール、イベント、セッション状態、拡張機能、信頼境界、実行モードがそれに当たります。

このコースでは [Pi](https://github.com/earendil-works/pi) を設計の題材にして、それらの条件をゼロから組み直します。Pi はカーネルを小さく保ち、製品固有のワークフローをループの外側へ出します。そのため、モデルの知能と Harness の仕組みの境界を観察しやすい題材です。

```text
モデルの判断
     |
     v
messages -> provider events -> tool loop -> tool results -> messages
                 |              |
                 v              v
             turn state     hooks / extensions
                  \             /
                   runtime + trust
```

13 レッスンを終えると、実モデルとツールのループ、正規化されたプロバイダーイベント、ライフサイクルを観察できるツール実行、分岐可能なセッション、必要に応じて読み込むコンテキスト、拡張機能、信頼制御、パッケージ探索、4 種類の実行モードを備えた mini Pi が完成します。最初のレッスンから実モデルを呼び出し、安全な読み取り専用ツールを使わせます。後のレッスンも同じ経路を発展させます。

これは Pi CLI の使い方ガイドでも、ソースを一行ずつたどる解説でもありません。各レッスンで設計判断を一つだけ切り出し、その判断が見える最小実装を作り、固定された Pi ソースへ対応づけるコースです。

## なぜ Pi を組み直すのか

Pi は Agent 製品で混ざりやすい三つの責務を分離します。

```text
pi-ai            モデル、メッセージ、ツール、プロバイダーストリームを正規化する
pi-agent-core    メッセージ状態、Agent Loop、ライフサイクルイベントを管理する
pi-coding-agent  セッション、リソース、拡張機能、パッケージ、信頼制御、実行シェルを加える
```

この分離は製品方針にもつながります。コアは汎用のままにし、ワークフローは拡張機能と外部環境に任せます。Sub-agent、計画機能、権限確認、Todo システム、MCP をループへ直書きする必要はなく、ループの周囲に組み合わせられます。

教訓は Pi をコピーすることではありません。何がモデルアダプターに属し、何がループに属し、何がその両方の外に留まるべきかを見分けることです。

## 13 レッスン、13 の不変条件

> **s01** *「ツール結果はモデルの次の判断材料になる」*：実モデルが `read_file` を要求し、Harness が実行し、その結果を使ってモデルが応答を続ける。
>
> **s02** *「ツールは公開契約と非公開ハンドラーでできている」*：モデルが見るのは JSON Schema、実行コードを見るのは Harness だけ。
>
> **s03** *「テキストだけでなく状態をストリーミングする」*：テキストとツール呼び出しを、途中まで組み立てた Assistant Message を保つイベントとして受け取る。
>
> **s04** *「ツール実行にはライフサイクルがある」*：呼び出し、結果、次のモデルターンを別々のイベントとして観察できる。
>
> **s05** *「方針は各ツールの内部ではなく実行の周囲に置く」*：フックはハンドラーを汚さずに、呼び出しの拒否、入力の書き換え、処理の終了を行える。
>
> **s06** *「ターンはスナップショットであり、グローバル変数の寄せ集めではない」*：メッセージ、ツール、リソース、モデル、システムプロンプトを一つの明示的な状態にする。
>
> **s07** *「履歴は分岐できてこそ役に立つ」*：追記専用のエントリーと親 ID が、過去を上書きせず選択肢を保存する。
>
> **s08** *「コンテキストは投入するのではなく選択する」*：プロジェクト指示、Skill、プロンプトテンプレートは、リソース境界を通してだけ取り込む。
>
> **s09** *「カーネルは小さく、ワークフローは拡張機能に任せる」*：イベント、ツール、コマンド、カスタムメッセージを安定したインターフェースへ接続する。
>
> **s10** *「一つのランタイム、複数の実行シェル」*：対話、Print/JSON、RPC、SDK の各モードが同じセッション状態を共有する。
>
> **s11** *「Project Trust は読み込みを制御し、実行を制限するものではない」*：プロジェクト設定、Extension、Prompt、Package は信頼判定の対象にする。Sandbox が必要なら Pi の外側に置く。
>
> **s12** *「能力はパッケージとして移動する」*：マニフェスト、規約、フィルター、スコープが、ローカルリソースを配布単位に変える。
>
> **s13** *「統合は境界を検証する」*：完成した Harness は、以前のモジュールの非公開状態へ踏み込まず、同じ実プロバイダー経路で動く。

## コアパターン

```ts
while (true) {
  const assistant = await provider.complete({ messages, tools });
  messages.push(assistant);

  const calls = assistant.content.filter(isToolCall);
  if (calls.length === 0) break;

  for (const call of calls) {
    messages.push(await executeTool(call));
  }
}
```

s01 から s13 まで、このループは同じ形で見え続けます。後のレッスンは入力、出力、永続化、境界の質を高めますが、モデルの判断を決め打ちのワークフローに置き換えることはありません。

## s01 から実際のプロバイダーを使う

`npm run s01` から `npm run s13` は、OpenAI 互換プロバイダーを呼び出します。回答の表現やモデルが選ぶツールは実行ごとに変わる場合があります。学習時には安定した構造を追ってください。ユーザーメッセージが入り、プロバイダーイベントが応答を表し、ツール呼び出しが Harness を通り、ツール結果がモデルへ戻ります。

## クイックスタート

Node.js 22.19 以上が必要です。

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness/learn-pi-agent
npm install
cp .env.example .env
# .env を編集し、OPENAI_API_KEY を設定します。

npm run s01
```

`OPENAI_MODEL` の既定値は `gpt-4o-mini`、`OPENAI_BASE_URL` の既定値は OpenAI 公式 API です。典型的な実行は次の形になりますが、具体的な文章とツールの選択は異なる場合があります。

```text
user -> model tool call -> read_file result -> model answer
```

続けて `npm run s02` から `npm run s13` まで実行します。各コマンドは、同じ実プロバイダー経路でそのレッスンを動かします。

| 環境変数 | 必須 | 意味 |
| --- | --- | --- |
| `OPENAI_API_KEY` | はい | 選択したエンドポイントが受け付ける認証情報 |
| `OPENAI_MODEL` | いいえ | Chat Completions モデル。既定値は `gpt-4o-mini` |
| `OPENAI_BASE_URL` | いいえ | OpenAI 互換ベース URL。既定値は `https://api.openai.com/v1` |

s01 がモデルへ公開するのは、コースのワークスペース内だけを読める `read_file` ツール一つです。シェルコマンドは実行できず、ルート外のファイルも読めません。API キーは、バージョン管理の対象外である `.env` に保存します。

## 学習ルート

```text
フェーズ 1：プロトコルを確立する
  s01 Agent Loop -> s02 Tool Schema -> s03 Provider Events

フェーズ 2：観察可能なターンを動かす
  s04 Evented Tool Loop -> s05 Tool Hooks -> s06 Turn State

フェーズ 3：Coding Agent 製品へ育てる
  s07 Session Tree -> s08 Context Resources -> s09 Extension Runtime

フェーズ 4：実行シェルと読み込み境界を加える
  s10 Runtime Modes -> s11 Project Trust -> s12 Pi Package

フェーズ 5：Harness を統合する
  s13 Integrated Harness
```

最初は順番に読んでください。後のレッスンは前の公開 Export を直接インポートします。この依存関係自体が教材です。インターフェースが次の要求に耐えられるかを確認できます。

## 全レッスン

| 章 | テーマ | 追加されるもの |
| --- | --- | --- |
| [s01](s01_agent_loop/) | Agent Loop | 実モデルが安全な読み取り専用ツールを呼び、結果を使って応答を続ける |
| [s02](s02_tool_schema/) | Tool Schema | モデルに見せる定義とローカルハンドラーを分ける |
| [s03](s03_provider_events/) | Provider Events | テキストとツール呼び出しの差分を一つのイベントプロトコルに正規化する |
| [s04](s04_evented_tool_loop/) | Evented Tool Loop | ツール呼び出し、結果、モデルの続行がライフサイクルイベントを発行する |
| [s05](s05_tool_hooks/) | Tool Hooks | 実行前後のポリシーで振り分け処理を囲む |
| [s06](s06_turn_state/) | Harness Turn State | セッション、リソース、ツール、モデル、プロンプトがスナップショットを作る |
| [s07](s07_session_tree/) | Session Tree | 追記専用の JSONL 履歴が分岐を持つ |
| [s08](s08_context_resources/) | Context Resources | 指示、Skill、プロンプト、使用中のツールを探索する |
| [s09](s09_extension_runtime/) | Extension Runtime | 拡張機能がフック、ツール、コマンド、メッセージを登録する |
| [s10](s10_runtime_modes/) | Runtime Modes | Print/JSON、RPC、SDK、対話シェルが一つのコアを共有する |
| [s11](s11_project_trust/) | Project Trust | プロジェクト入力の読み込みを制御し、実行 Sandbox とは区別する |
| [s12](s12_pi_package/) | Pi Package | マニフェスト、規約、フィルター、スコープからリソースを解決する |
| [s13](s13_integrated_harness/) | Integrated Harness | 最初の 12 レッスンを同じ実プロバイダー経路で一つの Harness にまとめる |

## 各レッスンの学び方

各レッスンは同じ簡潔な構成です。

```text
sNN_topic/
  README.md        完全な英語レッスン
  README.zh.md     完全な中国語レッスン
  README.ja.md     完全な日本語レッスン
  code.ts          最小の実行可能実装
  code.test.ts     振る舞いの不変条件とエッジケース
  pi-source.md     固定版 Pi ソースとの対応
  pi-source.zh.md  中国語のソース対応
```

各関数を読む前に `npm run sNN` を実行してください。モデルとツールの経路、その章で追加されたイベントや状態を観察します。次に Prompt、Tool、または境界を一つ変えてもう一度実行し、次のレッスンの実装と比較します。

## ソース根拠とスコープ

Pi のソース追跡リンクはすべて [`earendil-works/pi` のコミット `2f5066d7`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/) に固定されています。これは、コース執筆時に参照した Pi 0.79.1 のソーススナップショットです。ゼロから積み上げる教材構成については、[`shareAI-lab/claw0` のコミット `0090e863`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/) も参照元として明記しています。ローカルに参照用リポジトリをクローンする必要はありません。

実行可能なレッスンは、実際のプロバイダーとモデルプロトコルに `@earendil-works/pi-ai` 0.79.1 を使い、Harness の振る舞いに学習範囲を絞ります。ターミナル UI、拡張機能の動的インポート、パッケージのインストール、コンテキスト圧縮の自動トリガー、保持境界の選択、要約生成、ホットリロード、マルチモーダルメッセージ、自動再試行、プロセスやコンテナによるサンドボックスは意図的に実装しません。これは Harness Engineering のコースであり、完全な Pi CLI の再実装ではありません。

## プロジェクト構成

```text
learn-pi-agent/
  README.md / README.zh.md / README.ja.md
  .env.example
  package.json
  shared/
  s01_agent_loop/
  ...
  s13_integrated_harness/
```

## 修了時に説明できるべきこと

- ストリーミングされるプロバイダーイベントが、完成した文字列より多くの不変条件を持つ理由。
- Tool Schema、Handler、Hook、Project Trust が別の境界である理由。
- 追記専用で分岐可能なセッションが、復旧性と監査可能性をどう変えるか。
- プロジェクトへの信頼判定がサンドボックスではない理由。
- 実行モードが表示方法を担っても、Agent の状態を持つべきではない理由。
- 同じ実プロバイダー経路が 13 の層を通して保たれる仕組み。

目標は、モデル、プロバイダー、ループ、ツール、セッション、実行シェルの各境界を指し、その境界を動かすと何が壊れるか説明できることです。

このコースには、リポジトリのルートにある [MIT License](../LICENSE) が適用されます。

**カーネルは小さく、イベントは読みやすく。モデルに判断を任せ、Harness のすべての境界を明確にする。**
