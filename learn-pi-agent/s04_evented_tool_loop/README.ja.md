# s04 · Evented Tool Loop

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：正式な `pi-ai` Provider Stream の外側を囲む Agent、Turn、Message、Tool Execution のライフサイクルです。

```text
Agent lifecycle
  -> Turn lifecycle
     -> Message lifecycle
     -> Tool Execution lifecycle
```

## 問題：Provider Event だけでは足りない

s03 は一つの Assistant Message が生成される間の変化をすべて公開します。しかし、一つの Agent Run は一回の Provider Response より広い処理です。複数のモデル Turn、Tool Call、Tool Result、エラー、最終回答を含む場合があります。

Runtime が Provider Event だけを転送すると、Consumer は外側の問いに確実に答えられません。Agent Run の開始と終了、同じ Turn に属する Event、Tool が実際に実行された時点、Tool Result が Message として追加された時点を区別する必要があります。

## 考え方：同じループの外側にもう一層のイベントを加える

モデルとツールの往復を保ち、外側に二つ目の Event 層を加えます。

```text
agent_start
  turn_start
    message_start / message_update / message_end   assistant
    tool_execution_start / tool_execution_end
    message_start / message_end                    toolResult
  turn_end
  ... next turn ...
agent_end
```

Provider Event は `message_update` の中に残ります。Agent Event は、Provider Protocol を変えずに、より広い Runtime ライフサイクルを表します。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s04
```

次の 1 回だけの依頼は二つのモデル Turn を通ります。

```bash
npm run s04 -- "read_file で README.md を読み、Learning Path の節を要約してください。"
```

最終回答と Provider Delta の数は変わる場合があります。安定しているのはライフサイクルの入れ子です。一つの Agent Run が一つ以上の Turn を含み、Assistant と Tool Result Message に明確な境界があり、完了した既定の Tool Execution に開始と終了の Event があります。

CLI は最終テキストを表示します。戻り値の `events` 配列と任意の `onEvent` Callback は、別の実行シェルや Observer にライフサイクルを公開します。

## コードの中身

### 1. Runtime レベルの Event を定義する

`AgentEvent` は四つの関心事を分けます。

```text
agent_start / agent_end
turn_start / turn_end
message_start / message_update / message_end
tool_execution_start / tool_execution_end
```

各 Event は Turn Number、Partial または Final Message、Provider Event、Tool Call、Tool Result など、対応するデータを持ちます。Consumer は生のテキストから Runtime の段階を推測する必要がありません。

### 2. Agent ライフサイクルを一度だけ開閉する

`runEventedToolLoop()` は User Message を追加し、`agent_start` を発行して `try` Block へ入ります。`closeLifecycle()` は何度呼んでも一度だけ動くため、正常終了、明示的な終了、Provider の失敗、Turn 上限の超過は、すべて一つの `agent_end` で閉じます。

### 3. 一つの Provider Stream を Message Event へ変換する

各 Turn は s03 の `collectAssistantStream()` を呼びます。Callback は正式な Event を次のように対応づけます。

```ts
if (providerEvent.type === "start") {
  emit({ type: "message_start", turn, message: providerEvent.partial });
} else if (providerEvent.type !== "done" && providerEvent.type !== "error") {
  emit({
    type: "message_update",
    turn,
    message: providerEvent.partial,
    providerEvent,
  });
}
```

収集が終わると、終端 Assistant Message を State へ追加し、`message_end` として発行します。

### 4. Tool Execution に独立したライフサイクルを持たせる

既定の実行経路では、各 Tool Call が `tool_execution_start` を発行し、Registry Handler を実行し、Tool Result を追加して `tool_execution_end` を発行します。続けて、Loop はその Tool Result Message に対する `message_start` と `message_end` も発行します。注入した Executor が例外を投げた場合は外側の Agent ライフサイクルが処理するため、Execution End Event より前に `agent_end` で閉じます。

複数の Tool Call は Assistant Message 内の順番で一つずつ実行します。未知のツールや Handler の失敗も Error Tool Result になり、次のモデル Turn が処理できます。

### 5. 結果を記録してから Turn を終了する

`turn_end` は、終端 Assistant Message とその Turn で生成した Tool Result を含みます。Tool Call がなければ Agent は正常終了し、あれば Tool Result が次の Turn の Context になります。

任意の `executeToolCall` 境界は、`ToolExecutionContext` と `executeDefault()` 関数を受け取ります。s05 はこの拡張点を使い、Loop を書き直さずに実行の周囲へ Policy を加えます。

## 手を動かす

1. `runLiveCli()` から `onEvent: (event) => console.log(event.type)` を渡します。直接的な質問とファイル読み取りを実行し、Turn 数を比較してください。
2. モデルに二つの指定ファイルを読ませます。各 Tool Call に独自の実行 Event があり、Tool Result がモデルの順番を保つことを確認します。
3. 一時的に `maxTurns: 1` を設定してファイル読み取りを依頼します。明示的な上限エラーの後でも、最後のライフサイクル Event が `agent_end` であることを確認してください。

## 本線につなぐ

| 境界 | s03 | s04 |
| --- | --- | --- |
| Provider Event | 正式な `AssistantMessageEvent` | `message_update` 内に保持 |
| Runtime Event | なし | `AgentEvent` ライフサイクル |
| Loop の入口 | `runStreamingAgentLoop()` | `runEventedToolLoop()` |
| Tool Execution | Registry Runtime | 同じ実行を Start/End Event で囲む |
| 拡張点 | `onEvent` が Provider Output を観察 | `onEvent` が Runtime を観察し、`executeToolCall` が実行を囲む |
| 完了 | 最終 Assistant Message | 最終メッセージと閉じた Agent ライフサイクル |

## Pi ソースと照合

s04 は同じ正式な `pi-ai` Stream の外側に、`pi-agent-core` の主なライフサイクル構造を再構築します。コースの Event Payload は小さいものの、Agent、Turn、Message、Tool Execution は独立した境界のままです。

固定版 Pi 0.79.1 ソースとの対応は、英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s05 · Tool Hooks](../s05_tool_hooks/) は実行の拡張点を使い、`beforeToolCall` と `afterToolCall` の Policy を加えます。
