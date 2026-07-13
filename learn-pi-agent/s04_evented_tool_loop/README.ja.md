# s04 · Evented Tool Loop

[English](README.md) · [中文](README.zh.md) · 日本語

[← s03](../s03_provider_events/README.ja.md) · [目次](../README.ja.md) · [s05 →](../s05_tool_hooks/README.ja.md)

> ひとことで：assistant が toolCall を出し、agent-core がローカルで tool を実行し、結果を toolResult message に包んで context に戻し、次の provider 呼び出しに渡します。
>
> Pi の中での位置：`@earendil-works/pi-agent-core` の `agent-loop.ts`、tool 実行のメインパスです。

→ `tool_execution_end` は toolResult の `message_start` より先に発行されます——「tool が走り終わった」と「結果が 1 通のメッセージになる」は、順序の決まった別々の 2 ステップです
→ 未知の tool でもループは止まりません。エラーは `isError: true` の toolResult になり、次のターンでどう方針を変えるかはモデル自身が決めます
→ 1 バッチに複数の toolCall がある場合、toolResult は assistant メッセージ内での出現順を厳密に守ります——Pi は parallel 実行時でさえこれを保証します
→ ループの終了条件は「このターンに toolCall がないこと」で、maxTurns は防御的な保険にすぎません

---

## 問題

s02 は tool の契約だけ、s03 は provider の event stream だけを扱いました。2 本の線はそれぞれ通っていますが、tool はまだ一度も本当に走っていません。モデルはどの tool が使えるかを知っていて、呼び出しの意図を一文字ずつ流すこともできます。それでも s01 が残した信号——`stopReason=toolUse` がメッセージに記録されて終わり——を受け取る者がまだいないのです。

これをつなぐには 3 つの問いに答える必要があります。誰が tool を実行するのか、いつ実行するのか、そして実行結果はどうやって会話に戻り、モデルが話を続けられるのか。この節では真ん中にループを 1 つ置きます。2 本の線はそこで合流します。s02 の契約は実行として着地し、s03 のイベントストリームは agent のライフサイクルへ昇格します。

## 考え方

provider が `toolcall_end` を出した時点で、assistant message の中にはすでに完全な tool 呼び出しがあります。agent-core は続けて 3 つのことをします：

```text
tool_execution_start を発行
ローカル tool を実行
tool_execution_end を発行
```

実行結果はそのまま最終回答にはなりません。まず 1 通の `toolResult` message になり、context に追記され、それから次の provider 呼び出しへ入ります。実際のモデルも同じ動き方です。tool の結果を見て初めて、モデルは次に何を言うべきかが分かります。

この過程をループに入れたものが、この節の `runEventedToolLoop()` です。各ターンでストリーミングにより assistant message を受け取りきり、すべての toolCall を拾い出し、1 つずつ実行して結果を messages に追記します。toolCall が 1 つもないターンが来たら、そこでループは終わります。

イベントも 1 層上がります。s03 の provider イベントが記述するのは「1 通の assistant message がどう育つか」だけでした。この節ではそれを agent イベントに包みます：

| provider イベント（s03） | agent イベントに包む（この節） |
|------|------|
| `start` | `message_start` |
| `text_*` / `toolcall_*` | `message_update`（元のイベントは `providerEvent` フィールドにぶら下がる） |
| `done` / `error` | `message_end` |

この層の上にさらに `agent_start/end`、`turn_start/end`、`tool_execution_start/end` を加えます。これらが Pi における 1 turn の境界を囲います：

```text
assistant response
  + tool executions
  + toolResult messages
```

## まず動かす

```sh
npm run session:s04
```

出力はこうなります：

```text
Events: agent_start -> turn_start -> message_start -> message_update -> message_update -> message_update -> message_end -> tool_execution_start -> tool_execution_end -> message_start -> message_end -> turn_end -> turn_start -> message_start -> message_update -> message_update -> message_update -> message_end -> turn_end -> agent_end
Messages: assistant -> toolResult -> assistant
Tool result: read: README.md
Final text: I saw the tool result.
```

イベント列には `turn_start` が 2 つあります。最初のターンで assistant は `read` を呼んだので、`message_end` の後に `tool_execution_start -> tool_execution_end` が続き、さらにもう 1 組の `message_start -> message_end` が現れます——これは toolResult が 1 通のメッセージとして自ら発行するイベントです。順序に注目してください。`tool_execution_end` が先、toolResult の `message_start` が後です。tool 実行のライフサイクルとメッセージのライフサイクルは別々の 2 系統のイベントで、Pi はその前後関係を固定しています。

2 ターン目の assistant は toolResult を見て最終テキストを出し、toolCall はもう出さないので、ループはここで終わります。

もう 1 点はっきりさせておきます。`Messages` に user がいません。この mini ループは空の context から走り出し、fake provider が直接 toolCall を吐きます。Pi の `runAgentLoop()` は prompts を受け取り、最初の turn で prompt message のイベントを発行します。差分の詳細は [pi-source.md](pi-source.md) にあります。

## コードの中身

4 ステップに分けます。

**ステップ 1**：ループの骨格。この関数がこの節の主役なので、丸ごと貼る価値があります：

```ts
export async function runEventedToolLoop(
  provider: EventProvider,
  registry: ToolRegistry,
  options: { maxTurns?: number } = {},
): Promise<RunEventedToolLoopResult> {
  const maxTurns = options.maxTurns ?? 4;
  const messages: LoopMessage[] = [];
  const events: AgentEvent[] = [];
  const allToolResults: ToolResultMessage[] = [];

  const emit = (event: AgentEvent) => events.push(event);
  emit({ type: "agent_start" });

  for (let turn = 0; turn < maxTurns; turn++) {
    emit({ type: "turn_start" });
    const assistantMessage = await streamAssistant(provider, registry, messages, emit);
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.content.filter((block): block is ToolCall => block.type === "toolCall");
    const turnToolResults: ToolResultMessage[] = [];

    for (const toolCall of toolCalls) {
      const result = await executeToolCall(registry, toolCall, emit);
      messages.push(result);
      turnToolResults.push(result);
      allToolResults.push(result);
    }

    emit({ type: "turn_end", message: assistantMessage, toolResults: turnToolResults });

    if (toolCalls.length === 0) {
      break;
    }
  }

  emit({ type: "agent_end", messages });

  return {
    messages,
    events,
    eventTypes: events.map((event) => event.type),
    toolResults: allToolResults,
  };
}
```

終了条件はループの底に書いてあります。このターンに toolCall がなかったときだけ `break` します。`maxTurns` のデフォルトは 4 で、ただの保険です——fake provider が暴走することはありませんが、実際のモデルは理論上いくらでも tool を連鎖できます。Pi は「toolCall がまだあるか」で自然に収束するのでこの上限を持ちません。mini は簡単な防御を 1 枚足しているだけです。

内側の `for...of` は assistant content 内の出現順どおりに toolCall を 1 つずつ実行し、toolResult も同じ順で messages に入ります。これは手癖で書いたものではありません。Pi は toolResult message が assistant の source order を保つことを明文で約束していて、parallel 実行モードでもそうです。`code.test.ts` には、この不変条件だけを守るテストが 1 本あります。

**ステップ 2**：`streamAssistant()` が s03 の provider イベントを agent イベントに包みます。分岐は 3 つ。`start` は `message_start` に、途中の増分は `message_update` に、`done` または `error` は `message_end` になります。真ん中の分岐はこうです：

```ts
if (isAssistantUpdate(event)) {
  emit({
    type: "message_update",
    message: cloneAssistantMessage(event.partial),
    providerEvent: event,
  });
  continue;
}
```

元の provider イベントは捨てられず、`providerEvent` フィールドに載って一緒に出ていきます。上位層は、粗い粒度でよければ `message_update` の回数だけを見ればよく、細かい粒度がほしければ中の delta を開けばよいのです。

**ステップ 3**：`executeToolCall()` が実際に tool を実行します。ここで s02 の `dispatchTool()` が戻ってきます：

```ts
let message: ToolResultMessage;
try {
  const result = await dispatchTool(registry, toolCall.name, toolCall.arguments);
  message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: result.content }],
    isError: false,
    timestamp: Date.now(),
  };
} catch (error) {
  message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
    timestamp: Date.now(),
  };
}
```

provider には handler が見えませんが、agent-core は `toolCall.name` で見つけて実行できます——s02 で決めた「契約はモデルに見せ、実装はローカルに残す」が、ここで初めて本当に着地します。`catch` 分岐も同じくらい重要です。未知の tool でも handler の例外でもループは中断せず、エラーテキストは `isError: true` の toolResult に包まれます。モデルは次のターンで失敗の理由を見て、別のやり方を選べます。

関数の冒頭で `tool_execution_start` を発行し、末尾では決まった順序で 3 つのイベントを出します——まず実行終了を宣言し、それから toolResult をメッセージとして登場させます：

```ts
emit({
  type: "tool_execution_end",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  result: message,
  isError: message.isError,
});
emit({ type: "message_start", message });
emit({ type: "message_end", message });
```

**ステップ 4**：fake provider。`createToolLoopProvider()` がする判断は 1 つだけです：

```ts
const hasToolResult = context.messages.some((message) => {
  return typeof message === "object" && message !== null && (message as { role?: string }).role === "toolResult";
});

if (hasToolResult) {
  return createTextProvider([options.finalText]).stream(context);
}
```

context にまだ toolResult がなければ、まず tool 呼び出しを出します。すでにあれば、最終テキストを返します。すぐ隣には `createMultiToolCallProvider(calls, finalText)` もあり、1 通の assistant message に複数の toolCall を詰めて「tool のバッチ」という場面を再現できます——「手を動かす」で使います。

## 手を動かす

`s04_evented_tool_loop/code.ts` を開き、`runDemo()` を書き換えて `npm run session:s04` を再実行してください：

1. `runEventedToolLoop()` の第 3 引数に `{ maxTurns: 1 }` を渡します。`Messages` は `assistant -> toolResult` で止まり、`Final text` は空になります——最初のターンの tool 実行が終わった時点で、保険の上限が follow-up turn を切り落としたのです。2 に変えると元の挙動に戻ります。
2. provider を複数 tool のバッチに差し替えて、メッセージの順序を観察します：

   ```ts
   const result = await runEventedToolLoop(
     createMultiToolCallProvider(
       [
         { toolName: "read", args: { path: "README.md" } },
         { toolName: "bash", args: { command: "ls" } },
       ],
       "I saw both results.",
     ),
     createDemoToolRegistry(),
   );
   ```

   `Messages` は `assistant -> toolResult -> toolResult -> assistant` になり、2 通の toolResult の順序は assistant content 内の toolCall の順序と一致します。配列の中で 2 つの tool を入れ替えると toolResult の順序も一緒に変わります——これが source order の不変条件です。
3. 未知の tool を作ります：`createToolLoopProvider({ toolName: "missing", args: {}, finalText: "I can see the error.", allowUnknownTool: true })`。`Tool result` は `Unknown tool: missing` になりますが、`Final text` はいつもどおり現れます——エラーは context に入り、ループは切れていません。

変更後は `npm run test:s04` で、この節の振る舞いの約束を壊していないことを確認できます。

## 本線につなぐ

| コンポーネント | 前の節 | この節 |
| --- | --- | --- |
| Provider | 一連のイベントを流し終えたら終了。1 通の assistant message が育つ様子を見せるだけ | ループの中で繰り返し呼ばれ、毎ターン全量の messages を受け取る |
| tool | schema と handler は登録済みだが、呼ぶ者がいない | `dispatchTool()` が toolCall.name で実際に実行 |
| メッセージ | user / assistant の 2 ロール | toolResult が加わる：`LoopMessage` は assistant と toolResult の両方を収容 |
| イベント | provider レベル：`text_delta`、`toolcall_end`…… | agent レベル：`turn_*`、`tool_execution_*`。provider イベントは `message_update` に包まれる |

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) を見てください。

対応関係をひとことで言うと：`runEventedToolLoop()` は Pi の `agent-loop.ts` にある `runLoop()` の tool メインパスに、`streamAssistant()` は `streamAssistantResponse()` に対応し、`executeToolCall()` は `executeToolCallsSequential()` の教材版です。Pi の実際のループはさらに prompts、parallel 実行、引数検証、hook を備えています——hook は次の節の主題で、残りの差分は pi-source.md に一覧があります。

## 次の節

いまはすべての toolCall が無条件に実行されます。機密ファイルの読み取り、危険なコマンドの実行、結果への監査マーク付け——こうした判断を差し込む場所が、ループにはまだ 1 つもありません。

[s05 Tool Hooks](../s05_tool_hooks/README.ja.md)：Pi は tool 実行の前後に hook を 1 つずつ残しています。インターセプトも、書き換えも、早期停止も、すべてそこから入ります。
