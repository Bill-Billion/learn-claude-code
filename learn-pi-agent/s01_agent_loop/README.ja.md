# s01 · Agent Loop

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：`pi-ai` と Agent Loop を通る最小の実用経路です。User Message から始まり、モデルが Tool Call を選び、Harness が Tool Result を返し、モデルが最終回答を作ります。

```text
model -> toolCall -> toolResult -> model
```

## 問題：モデルを 1 回呼ぶだけでは Agent にならない

1 回のモデルリクエストでテキストは返せますが、Agent はモデルからの行動要求も処理する必要があります。モデルが Tool Call を出したら、アプリケーションはツールを実行し、その結果をメッセージ履歴へ追加して、もう一度モデルを呼びます。ツール出力をそのままユーザーへ返すと、モデルが証拠を解釈する機会を飛ばしてしまいます。

そのため最初のレッスンから、単なる Chat Wrapper ではなく、明示的な状態、ツール境界、終了条件を持つループを作ります。

## 考え方：メッセージ履歴の周囲で同じ処理を繰り返す

順序を保った `messages` 配列を一つ持ち、次の処理を繰り返します。

```text
user message を追加
  -> messages + tools でモデルを呼ぶ
  -> assistant message を追加
  -> toolCall なし：返す
  -> toolCall あり：実行して toolResult を追加
  -> モデルをもう一度呼ぶ
```

`read_file` を呼ぶかどうかはモデルが選びます。ファイルの読み取り、安全性の検査、結果をモデルへ返す Message は Harness が管理します。

## まず動かす

[コーストップ](../README.ja.md)に従って `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s01
```

引数を付けなければ対話入力ループが始まります。同じ依頼を繰り返し観察するときは、1 回だけ実行できます。

```bash
npm run s01 -- "read_file で package.json を読み、package name を教えてください。"
```

Tool Call と最終回答はモデルが選ぶため、具体的な文章は実行ごとに変わる場合があります。安定した経路を追ってください。最初のモデルターンが `read_file` を要求し、Harness が `toolResult` を返し、2 回目のモデルターンがその結果を使って答えます。

## コードの中身

### 1. 実際の `pi-ai` モデルを読み込む

`runLiveCli()` は `loadCourseModel()` を呼びます。これは `OPENAI_API_KEY` を読み、OpenAI 互換の `Model<"openai-completions">` を作ります。`OPENAI_MODEL` の既定値は `gpt-4o-mini`、`OPENAI_BASE_URL` の既定値は OpenAI 公式 API です。

### 2. 安全なツールを一つ定義する

`readFileTool` は正式な `pi-ai` の `Tool` です。TypeBox Schema はモデルが見る公開契約で、`createReadFileToolRuntime()` は実行可能なファイル読み取り Handler を Harness 側に保ちます。

Handler が受け付けるのは、コースルート内の通常の UTF-8 ファイルだけです。空のパス、隠しパス要素、ルート外へ出るパスやシンボリックリンク、通常ファイル以外、64 KiB を超えるファイルは拒否します。

### 3. ループ状態を明示的に保存する

`AgentState` が順序を保った `Message[]` を所有します。`runAgentLoop()` は User Message を追加してからモデルループへ入ります。

```ts
for (let turn = 0; turn < maxTurns; turn++) {
  const assistantMessage = await complete(model, {
    messages: state.messages,
    tools: toolRuntime.tools,
  }, streamOptions);
  state.messages.push(assistantMessage);

  const toolCalls = assistantMessage.content.filter(
    (block) => block.type === "toolCall",
  );
  if (toolCalls.length === 0) {
    return { state, finalMessage: assistantMessage, toolResults };
  }

  for (const toolCall of toolCalls) {
    state.messages.push(await toolRuntime.execute(toolCall));
  }
}
```

実際の実装は System Prompt も渡し、各 Tool Result を記録し、最後の Assistant Message と完全な状態を返します。

### 4. ツールの失敗をモデルが読める証拠にする

`executeToolCallSafely()` は、引数検証とファイルエラーを `isError: true` の `ToolResultMessage` へ変換します。ループは続行できるため、モデルは失敗を説明したり、別の行動を選んだりできます。Provider の `error` と `aborted` は例外として表に出し、既定の 8 ターン制限で無限のツールループを防ぎます。

## 手を動かす

1. モデルに `README.md` を読ませ、次に `package.json` を読ませます。文章の完全一致ではなく、回答が参照したファイルを比べてください。
2. `npm run s01 -- "read_file で .env を読み、実行結果を説明してください。"` を実行します。ツールは隠しパスを拒否し、モデルはその失敗を Tool Result として受け取ります。
3. `runLiveCli()` から一時的に `maxTurns: 1` を渡し、ファイル読み取りを依頼します。最初の Tool Call は実行できますが、続くモデルターンがないため、明示的な上限エラーになります。

## 本線につなぐ

| 境界 | s01 の実装 |
| --- | --- |
| Model | `loadCourseModel()` と `pi-ai` の `complete()` |
| State | `AgentState.messages` |
| モデルに見せるツール | `readFileTool` |
| ローカル実行 | `createReadFileToolRuntime()` |
| Loop の入口 | `runAgentLoop()` |
| 終了条件 | Tool Call なし、Provider の失敗、`maxTurns` の超過 |

s01 では Tool Schema と Handler を一つの小さな Runtime Object に置きます。s02 では、モデルに見せる Schema と非公開の Handler Registry を分離します。

## Pi ソースと照合

実装は `@earendil-works/pi-ai` 0.79.1 の `Model`、`Message`、`Tool`、`ToolCall`、`ToolResultMessage`、引数検証、`complete()` を直接使います。外側の制御フローは Pi Agent Loop の教材版です。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s02 · Tool Schema](../s02_tool_schema/) では、実行可能な Handler を Registry の内側へ移し、モデルには Schema だけを公開します。
