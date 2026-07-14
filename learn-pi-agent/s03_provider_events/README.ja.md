# s03 · Provider Events

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：`@earendil-works/pi-ai` が正式に提供する `AssistantMessageEvent` Stream です。Agent Runtime 独自のライフサイクルイベントは次のレッスンで外側に加えます。

```text
provider bytes -> pi-ai events -> partial message -> final AssistantMessage
```

## 問題：完成した回答を待つだけでは足りない

呼び出し側が最終的な `AssistantMessage` だけを必要とするなら、`complete()` は便利です。しかし Runtime は処理の途中も観察する必要があります。テキストの到着、Tool Call 引数の組み立て、応答の完了、Stream の失敗を扱うためです。

テキストだけの Callback でも不十分です。テキストと Tool Call は別々の Content Block に入り、複数の Block が交互に進む場合があります。また、すべての Consumer が同じ終端メッセージを必要とします。プロトコルは表示文字だけでなく、Assistant Message 全体を表す必要があります。

## 考え方：`pi-ai` のイベントプロトコルをそのまま使う

`pi-ai` は次の Event Family を提供します。

```text
start
  -> text_start / text_delta / text_end
  -> toolcall_start / toolcall_delta / toolcall_end
  -> done or error
```

各増分 Event は `contentIndex` と Partial Assistant Message を持ちます。`done.message` または `error.error` が終端メッセージです。UI 描画、ログ、Agent Loop は、それぞれの目的で同じ Stream を消費できます。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s03
```

次の 1 回だけの依頼では、Tool Call Event と Text Event の両方が現れやすくなります。

```bash
npm run s03 -- "read_file で package.json を読み、scripts を二文で説明してください。"
```

具体的な Delta、Tool Call 引数、回答は変わる場合があります。CLI は `text_delta` を到着時に書き出し、その後、組み立て済みの最終テキストを返します。安定した契約はイベントの順序と最終 Assistant Message であり、特定の分割位置ではありません。

## コードの中身

### 1. 正式な Stream を消費する

`collectAssistantStream()` は `@earendil-works/pi-ai` から導入した `stream()` を呼びます。

```ts
for await (const event of streamModel(model, context, streamOptions)) {
  events.push(event);
  onEvent?.(event);
  if (event.type === "done") message = event.message;
  if (event.type === "error") message = event.error;
}
```

このレッスンは Provider の Wire Data を独自に変換しません。導入済みの `pi-ai` Provider が変換を行い、`AssistantMessageEvent` を生成します。

### 2. Event と終端メッセージを両方残す

`CollectedAssistantStream` は、一つの応答を三つの形で返します。

```text
events      すべての AssistantMessageEvent を順番に保持
eventTypes  観察しやすい簡潔な型一覧
message     最終 AssistantMessage
```

Async Iterable が `done` または `error` なしで終わった場合、`collectAssistantStream()` は例外を投げます。終端メッセージのない Stream を、完了したモデルターンとして扱うことはできません。

### 3. Content Block を指定可能に保つ

Text と Tool Call の Delta は `contentIndex` を持ちます。Consumer は、すべての出力を一つの文字列だと仮定せず、各 Delta を対応する Content Block へ適用します。`partial` スナップショットを使えば、その時点の Assistant Message を描画できます。

### 4. 同じループですべてのモデルターンをストリーミングする

`runStreamingAgentLoop()` は s02 の Registry とモデル・ツール・モデルの経路を保ちます。モデル境界で変わるのは、各 Turn が `collectAssistantStream()` を通ることだけです。

```ts
const streamed = await collectAssistantStream({
  model,
  context: { messages: state.messages, tools: runtime.tools },
  streamOptions,
  onEvent,
});
```

終端 Assistant Message が届いたら、Loop はそれを追加し、Registry で Tool Call を実行し、Tool Result を追加して、次のモデルターンをストリーミングします。全 Turn の Event を一つの順序付き配列として返します。

### 5. 表示する内容を Consumer に選ばせる

CLI の `onEvent` は `text_delta` だけを表示します。別の Consumer は Tool Call Delta を記録したり、進捗表示を描いたり、Event Object 全体を転送したりできます。`readTextBlocks()` は終端メッセージから完成した Text Block を取り出しますが、Streaming Protocol そのものではありません。

## 手を動かす

1. `runLiveCli()` の `onEvent` で `event.type` を出力します。直接的な質問を実行し、一つの Text Block の周囲にある Event の順序を並べてください。
2. 上の 1 回だけのファイル依頼を実行し、2 回目のモデルターンより前に `toolcall_start`、一つ以上の `toolcall_delta`、`toolcall_end` があることを確認します。
3. Text と Tool Call の各 Event で `contentIndex` を出力します。到着時刻や分割サイズに頼らず Block を区別できることを確認してください。

## 本線につなぐ

| 境界 | s02 | s03 |
| --- | --- | --- |
| Model Call | s01 Loop 内の `complete()` | `collectAssistantStream()` 経由の `pi-ai` `stream()` |
| Provider Output | 最終 Assistant Message | 順序付き `AssistantMessageEvent[]` と最終メッセージ |
| Tool Boundary | Registry | 同じ Registry |
| Loop の入口 | `runToolRegistryAgentLoop()` | `runStreamingAgentLoop()` |
| Consumer Hook | 最終結果だけ | 各モデル Turn の `onEvent(event)` |

## Pi ソースと照合

`AssistantMessageEvent`、`Context`、`stream()`、終端メッセージの意味は `@earendil-works/pi-ai` 0.79.1 から直接得ています。s03 が加えるのは収集処理とコースの外側の Loop だけで、別の Provider Protocol は定義しません。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s04 · Evented Tool Loop](../s04_evented_tool_loop/) は、これらの Provider Event の外側に Agent、Turn、Message、Tool Execution のライフサイクルイベントを加えます。
