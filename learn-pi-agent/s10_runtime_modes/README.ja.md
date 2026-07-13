# s10 · Runtime Modes

[English](README.md) · [中文](README.zh.md) · 日本語

[← s09](../s09_extension_runtime/README.ja.md) · [目次](../README.ja.md) · [s11 →](../s11_trust_execution_env/README.ja.md)

> ひとことで：runtime mode は agent を何組も作ることではなく、同じ core にかぶせる別々の I/O の外殻です——外殻が依存するのは `prompt()` と `getState()` の二つのメソッドだけです。
>
> Pi の中での位置：`@earendil-works/pi-coding-agent` の `main.ts` にある mode 分岐と、`modes/` の外殻層です。

→ Pi の runtime mode は四つだけです：interactive、print、rpc、sdk——json は五つ目ではなく、print mode のもうひとつの出力分岐です
→ 外殻五つの関数は合計でも百行足らず：手抜きではなく、状態と履歴がインターフェースによって core 側に閉じ込められていて、外殻に書けるのは I/O しか残らないからです
→ 本節の core はわざと echo stub にしてあり、前の九節から何も import しません——見せたい不変条件はインターフェースだけに依存し、core の中身には依存しないからです
→ core を差し替えても外殻は変えません：インターフェースを満たすだけのオブジェクトを手書きすれば、五つの外殻はそのまま動きます。s13 はまさにこの契約を使って本物の core を差し戻します

---

## 問題

s09 を終えた時点で、mini Pi には tool、イベントストリーム、hook、turn state、session tree、context resources、extension runtime が揃っています。しかしこの仕組みの山は、いまのところテストと demo が直接関数を呼んでいるだけ——プロダクトとしての入口がまだありません。

入口と聞いて直感的に浮かぶのは、用途別に一式ずつ書く案です：ターミナル対話にはループをひとつ、スクリプト呼び出しには一回きりの関数をひとつ、プロセス統合にはさらにコマンドサービスをひとつ。それぞれが自分のメッセージ履歴を持つ。入口が四つ、状態も四つ——すぐに「RPC で聞いたことが interactive では見えない」という亀裂が走ります。

Pi はそうしません。`main.ts` はまず `AgentSessionRuntime` を作り、それからどの mode に渡すかを決めます：interactive はターミナル対話を受け持ち、print は最後のテキストを取り（`--mode json` ならイベントストリーム出力に切り替わり）、RPC は prompt や get_state といった操作を JSONL のコマンドプロトコルにし、SDK は外部プログラムに `AgentSession` を直接渡します。runtime を作るのは一度だけで、外殻は出入りの仕方が違うだけです。

## 考え方

入口の問題を最小まで圧縮します：core は二メソッドのインターフェースを実装し、外殻はこのインターフェースだけに依存します。

```ts
export interface MiniRuntime {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
}
```

五つの外殻がそれぞれ一種類の出入りを受け持ちます：

| 外殻 | 誰のためか | 入 / 出 |
| --- | --- | --- |
| `runInteractiveMode()` | ターミナルの前の人間 | ターミナル入力 / 対話 transcript |
| `runPrintMode()` | スクリプトの一回きりの質問 | prompt 一句 / 最終テキスト |
| `runJsonMode()` | パイプとログ | prompt 一句 / JSONL イベントストリーム |
| `runRpcMode()` | 他のプロセス | JSONL コマンド / JSONL レスポンス |
| `createSdkSession()` | Node/TS プログラム | メソッド呼び出し / 戻り値 + イベント購読 |

数えると外殻は五つですが、Pi の公式な数え方は四 mode です。矛盾ではありません——Pi では print と json はどちらも print-mode に属し、ひとつの mode の二つの出力分岐です（text は最後の回答を取り、json はイベントを一行ずつ出す）。本節が二つの関数に分けたのは、両者の差がちょうど出力層だけにあり、分けたほうが見やすいからです。

もうひとつ、先に種明かしをしておきます：本節の `MiniCoreRuntime` はわざと空っぽにした echo stub です。前の九節からは何も import せず、`prompt()` は入力を `mini pi: <入力>` に整形するだけ。手抜きではありません——本節が見せたい不変条件は「mode の外殻は独立した agent 状態を持たない」であり、この不変条件は `prompt()`/`getState()` というインターフェースだけに依存し、core の中身がエコーか本物の agent loop かには依存しないのです。s13 では `IntegratedHarnessRuntime` が同じ `MiniRuntime` インターフェースを実装し、s01–s09 で組み上げた本物の core をこの外殻たちに差し込みます——「境界の設計が正しいからこそ外殻を差し替えられる」という話が本当に効いてくるのはそこです。

## まず動かす

```sh
npm run session:s10
```

出力はこうなります：

```text
Print: mini pi: hello print
JSON event types: session, agent_start, message, agent_end
RPC turns: 2
```

三行は同じ `MiniCoreRuntime` から来ています：print が一ターン走り、json がもう一ターン走り、最後に RPC の `get_state` が同じ runtime を照会します——だから `turns` は 2 で、外殻ごとにゼロから数え直しにはなりません。

## コードの中身

### 状態は core の中にしか住まない

`MiniCoreRuntime.prompt()` は本節で唯一、状態を変更する場所です：

```ts
async prompt(prompt: string): Promise<MiniRunResult> {
  const runId = `${this.sessionId}:${this.runs.length + 1}`;
  const finalText = `${this.answerPrefix}: ${prompt}`;
  const userMessage: MiniRuntimeMessage = { role: "user", content: prompt };
  const assistantMessage: MiniRuntimeMessage = { role: "assistant", content: finalText };

  this.messages.push(userMessage, assistantMessage);

  const events: MiniRuntimeEvent[] = [
    { type: "session", sessionId: this.sessionId, runId },
    { type: "agent_start", sessionId: this.sessionId, runId, prompt },
    { type: "message", sessionId: this.sessionId, runId, role: "assistant", content: finalText },
    { type: "agent_end", sessionId: this.sessionId, runId, finalText },
  ];
  const result: MiniRunResult = {
    sessionId: this.sessionId,
    runId,
    finalText,
    events: cloneEvents(events),
    messages: this.getMessages(),
  };

  this.runs.push({ ...result, prompt });
  return cloneRunResult(result);
}
```

毎ターン `runId` をひとつ発行し、メッセージを二件追加し、イベントを一組生成し、最後に events と messages を複製してから渡します——外殻が受け取るのはスナップショットで、core の内部には手が届きません。mode は表示の仕方、コマンドの受け方、シリアライズの仕方を決められますが、自前の会話履歴を持つことはできません。本物の Pi でこれに当たるのは `AgentSession.prompt()` で、それを保持する `AgentSessionRuntime` は session の切り替え、fork、resume も受け持ちます。

### print は最後の一言だけほしい

```ts
export async function runPrintMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  const result = await runtime.prompt(prompt);
  return result.finalText;
}
```

スクリプトから一回だけ聞くときに使います：イベントは購読せず、状態も持たず、`finalText` を受け取ったら退場です。本物の Pi の text 分岐も同じ流儀です——`session.prompt()` を呼び、session state から最後の assistant テキストを取って stdout に書きます。

### json はイベントストリームをそのまま流し出す

```ts
export async function runJsonMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  const result = await runtime.prompt(prompt);
  return `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}
```

json は新しい戻り値の構造を発明しません。core が生んだイベントを一行ずつ JSONL にシリアライズし、`agent_end` を拾うか `message` を拾うかは下流が決めます。上の print と見比べてください：二つの関数の違いは return の行だけ——「print と json は同じ mode の二つの出力分岐」がコードに落ちるとこうなります。

### rpc は操作をコマンドにする

```ts
switch (command.type) {
  case "prompt":
    return {
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: await runtime.prompt(command.message),
    };
```

`get_state` 分岐も同じ形で、`data` が `runtime.getState()` に変わるだけです。未知のコマンドには `success: false` を返します（完全な switch は code.ts を参照）。rpc はプロセス統合向けです：外部プログラムは TUI を解析したくないし、一回きりのテキストでは足りません。`id` 付きのコマンドを送り、`id` でレスポンスと突き合わせます。本節は単一ファイルの読みやすさを優先して、prompt コマンドが完全な `MiniRunResult` を同期で返すようにしていますが、本物の Pi の RPC では prompt の response は「リクエストを受け付けた」ことしか意味せず、中身はイベントストリームから流れ続けます。コマンド表もずっと長い——steer、follow_up、abort、fork、set_model などなど。

### sdk は最薄の層：オブジェクトを直接受け取る

```ts
const listeners = new Set<(event: MiniRuntimeEvent) => void>();

return {
  async prompt(prompt: string): Promise<MiniRunResult> {
    const result = await runtime.prompt(prompt);
    for (const event of result.events) {
      for (const listener of listeners) {
        listener({ ...event });
      }
    }
    return result;
  },
  getState(): MiniRuntimeState {
    return runtime.getState();
  },
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
```

sdk にプロセス間プロトコルはありません：ホストプログラムが直接 session を作り、イベントを購読し、`prompt()` を呼びます。自前の UI を作るなら、たいてい rpc より sdk のほうが手に馴染みます。本物の Pi の `createAgentSession()` は model、tools、resourceLoader、sessionManager といったオプションも受け取ります。

### interactive はターミナルを貼り付けるだけ

```ts
export async function runInteractiveMode(runtime: MiniRuntime, prompts: string[]): Promise<string[]> {
  const transcript: string[] = [];

  for (const prompt of prompts) {
    transcript.push(`user> ${prompt}`);
    const result = await runtime.prompt(prompt);
    transcript.push(`assistant> ${result.finalText}`);
  }

  return transcript;
}
```

本節は TUI を作らず transcript を返すだけですが、そのぶん interactive の立ち位置がよく見えます：入力を core に送り、出力をターミナルに戻す、それだけです。本物の Pi の interactive mode にはエディタ、footer、tree selector、ショートカットがあります——そうした UI を一層ずつ積み上げられるのは、下の session/runtime の境界が先に安定しているからです。

### core を替えても外殻はそのまま走る

code.test.ts にはテストが五つあります。最初の四つは外殻をひとつずつ見張り、五つ目が本節の哲学のいちばん強いテストです：`MiniRuntime` インターフェースを満たすだけのオブジェクトを手書きし——継承もせず、`MiniCoreRuntime` も使わず——全部の外殻に食わせても、いつもどおり動きます。

```text
print・json・rpc・sdk が同じ core を駆動し、getState() の turns/messageCount が一致する
json mode は session、agent_start、message、agent_end の順にイベントを一行ずつ出力する
rpc の prompt の後、get_state が見るのは同じ状態
interactive の transcript は prompt() のターミナル包装にすぎない
どの外殻も手書きの最小 MiniRuntime オブジェクトを受け付け、MiniCoreRuntime を要求しない
```

五つ目が試しているのは何かの機能ではなく、外殻と core の間の契約そのものです。s13 が本物の core を差し戻せるのは、この契約があるからです。

## 手を動かす

一度 s13 になったつもりで：新しい `MiniRuntime` 実装を書いて外殻に食わせます。code.ts の `demo()` に大文字エコーの runtime を追加：

```ts
const shout: MiniRuntime = {
  async prompt(prompt) {
    const finalText = prompt.toUpperCase();
    return {
      sessionId: "shout",
      runId: "shout:1",
      finalText,
      events: [{ type: "agent_end", sessionId: "shout", runId: "shout:1", finalText }],
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: finalText },
      ],
    };
  },
  getState() {
    return { sessionId: "shout", turns: 1, messageCount: 2 };
  },
};
console.log(await runPrintMode(shout, "hello shout"));
```

`npm run session:s10` を再実行すると `HELLO SHOUT` の行が増えます。続けて `shout` を `runJsonMode`、`runRpcMode`、`runInteractiveMode` に順番に食わせてください——外殻は一行も変えていないのに、全部受け付けます。いま自分の手で確かめたのが、五つ目のテストが守っているあの契約です：外殻はインターフェースしか見ていません。

二つ目の遊び方（マシンに jq があれば）：`demo()` の中で JSON を出力している `console.log` を `process.stdout.write(jsonText);` に置き換え、他の `console.log` をいったんコメントアウトしてから：

```sh
node s10_runtime_modes/code.ts --demo | jq -r 'select(.type == "message") | .content'
```

JSONL の利点がその場で姿を現します：core は jq のために何もしていないのに、イベントストリーム自体が機械可読なインターフェースになっているのです。

遊び終わったら元に戻し、`npm run test:s10` で外殻の挙動契約を壊していないか確認してください。

## 本線につなぐ

| コンポーネント | 前節（s09） | 本節 |
| --- | --- | --- |
| 入口 | 入口層はなく、テストと demo が直接関数を呼ぶ | interactive / print / json / rpc / sdk の五外殻が I/O を一種類ずつ受け持つ |
| core の露出面 | runner、registry、turn state という内部オブジェクトの山 | `prompt()` + `getState()` の二メソッドに収束 |
| イベントストリーム | プロセス内で extension handler が消費 | json は JSONL に、sdk は subscribe を開放——プロセス外の消費者に向き始める |
| セッション状態 | 各節の仕組みに分散 | runtime の中にだけ住み、外殻は一律ステートレス |

s13 の `IntegratedHarnessRuntime` はこの外殻の列をそのまま使い回します——そのとき差分表で入れ替わる行は core だけです。

## Pi ソースと照合

本節を読み終えたら [pi-source.md](pi-source.md) へ。本物の入口は `main.ts` です：`resolveAppMode()` が mode を決め、`AgentSessionRuntime` は一度だけ作られ、`runRpcMode()`、`InteractiveMode`、`runPrintMode()` のいずれかに渡されます。本節の `runPrintMode()`/`runJsonMode()` は `modes/print-mode.ts` の text/json 二分岐に対応し、「json は print mode の出力分岐」という話の出典もここです。もうひとつ注意：本節のイベント語彙（session / agent_start / message / agent_end）は mini の自作で、s04 のものでも Pi のものでもありません。差分の明細は pi-source.md にあります。

## 次の節

同じ core に五つの外殻を接続できるようになると、外殻には答えられない問いがひとつ残ります：clone してきたリポジトリに `.pi/settings.json` と `.pi/extensions/` が転がっているとき、runtime は起動時にそれを読み込むべきか？読み込みを断ったあと、tool には何ができるのか？この話には mode がもう一度登場します——非対話の外殻は確認ダイアログを出せないのです。

[s11 Trust And Execution Env](../s11_trust_execution_env/README.ja.md)：trust が受け持つのは入力の読み込みで、実行の境界はまた別の話です。
