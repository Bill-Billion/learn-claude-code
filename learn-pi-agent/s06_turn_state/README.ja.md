# s06 · Harness Turn State

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：`pi-agent-core` の `AgentMessage` 境界、`AgentHarness.createTurnState()`、そしてモデル向け `Message[]` への変換です。

```text
session AgentMessage[] -> TurnState snapshot -> transformContext -> convertToLlm -> model
                                      |
                                      +-> real Tool Loop -> 完了した各 Message を永続化
```

## 問題：豊かな履歴と安定した Turn の両方が必要

s05 までに、Loop は実モデルを呼び出し、`read_file` を実行し、Tool Hook を適用できるようになりました。しかし入力はまだ分散しており、履歴もモデルが理解できる Message に限られています。

Coding Agent には、Shell 実行、Extension Message、Branch Summary、Compaction Summary など、より豊かな内部記録が必要です。それらをそのまま Provider へ送ると `Message` 契約を破ります。一方、複数段階の Turn 中に可変設定を読み続けると、2 回目の Provider Call が 1 回目と異なる Model、Tool Set、Prompt を使う恐れがあります。

## 考え方：AgentMessage、TurnState、モデル Context を分ける

s06 は二つの境界を導入します。

```text
AgentMessage = pi-ai Message
             | BashExecutionMessage
             | CustomMessage
             | BranchSummaryMessage
             | CompactionSummaryMessage

TurnState = messages + resources + streamOptions + sessionId
          + systemPrompt + model + tools + activeTools
```

Session は `AgentMessage[]` を保存します。Turn の開始時に `createTurnState()` がその Turn で使うすべてを snapshot にします。モデル境界に来たときだけ、`createLlmContext()` が `transformContext`、続いて `convertToLlm()` を適用します。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s06
```

1 回の Prompt を直接渡すこともできます。

```bash
npm run s06 -- "read_file で package.json を確認し、pi-ai のバージョンを報告してください。"
```

このコマンドも、前のレッスンと同じ実際の Model-Tool-Model 経路を走ります。回答表現や具体的な Tool Call は変わる場合があります。安定しているのは、Prompt、Assistant Message、Tool Result が Turn の進行に合わせて Session へ順に追加されることです。

## コードの中身

### 1. 内部 Message とモデル向け Message を分ける

`AgentMessage` は、公式 `pi-ai` `Message` Union に四つの Harness 内部 Role を加えます。`cloneAgentMessage()` は各メンバーを深く複製し、Session History と Turn Snapshot が可変 Content を共有しないようにします。

これは二つ目の Provider Protocol ではなく、Harness の保存 Protocol です。

### 2. 一つの Turn を snapshot にする

`createMiniHarness()` は、登録済み Tool Definition、選択された Active Tool Name、Resource、Stream Option、System Prompt 定義を保持します。`createTurnState()` は現在の Session Context と Metadata を読み、動的 System Prompt を解決し、独立したコピーを返します。

```ts
const turnState = await createMiniHarness(options).createTurnState();

turnState.messages;
turnState.model;
turnState.tools;
turnState.activeTools;
turnState.resources;
turnState.streamOptions;
```

`tools` は登録された全体です。`activeTools` は、この Turn でモデルに見せ、実行を許可する部分集合です。

### 3. モデル境界でだけ変換する

`createLlmContext()` は次の順序を守ります。

```ts
const transformed = transformContext
  ? await transformContext(agentMessages)
  : agentMessages;

const messages = convertToLlm(transformed);
```

標準の User、Assistant、Tool Result Message はそのまま通ります。Bash、Custom、Branch Summary、Compaction Summary の記録はモデルが読める User Message になり、`excludeFromContext` を持つ Bash 記録は除外されます。Session 内の豊かな値は変更されません。

### 4. 実際の Turn を走らせ、順に永続化する

`runHarnessTurn()` は snapshot とモデル Context を作り、Active Registry を選び、新しい User Message を追加してから s05 の `runHookedToolLoop()` へ渡します。`message_end` Listener は、完了した各 Assistant または Tool Result Message について `session.appendMessage()` を待ちます。

この順序は重要です。Tool 実行後の Provider Call が失敗しても、それ以前の Assistant Message と Tool Result はすでに Session にあります。Harness は Turn 全体の成功まで履歴保存を待ちません。

## 手を動かす

1. `createMemorySession()` に `CustomMessage` を追加し、`createLlmContext()` を呼びます。保存値を変えずに User Message へ変換されることを確認します。
2. `activeToolNames: []` を設定してモデルにファイル読み取りを依頼し、モデル向け Tool List と完全な `turnState.tools` を比較します。
3. Context Note を追加する `transformContext` を設定し、それがモデル Context に入り、Session へ自動保存されないことを確認します。

## 本線につなぐ

| 境界 | s05 | s06 |
| --- | --- | --- |
| 履歴型 | モデル向け `Message[]` | Session 内の豊かな `AgentMessage[]` |
| Turn 入力 | 個別の Loop 引数 | 一つの `TurnState` snapshot |
| モデル境界 | Message はすでにモデル形式 | `transformContext` の後に `convertToLlm` |
| Tool 公開 | Registry を Loop へ渡す | 全 Tool と Turn ごとの Active Tool |
| 永続化 | Loop 後に返す | Loop 中に完了 Message を順次追加 |
| Provider 経路 | 実モデルと Tool Loop | `runHarnessTurn()` を通る同じ実経路 |

## Pi ソースと照合

`AgentMessage` Role、変換順序、Turn Snapshot は Pi 0.79.1 に対応します。コースはより積極的に深く複製し、`thinkingLevel`、Queue、Provider Request Hook などを省いています。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s07 · Session Tree](../s07_session_tree/) では、メモリ上の Message List を Append-only JSONL Entry、Branch、Summary Entry に置き換え、それらを `AgentMessage[]` へ再び materialize します。
