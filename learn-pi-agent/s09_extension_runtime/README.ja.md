# s09 · Extension Runtime

[English](README.md) · [中文](README.zh.md) · 日本語

[← s08](../s08_context_resources/README.ja.md) · [目次](../README.ja.md) · [s10 →](../s10_runtime_modes/README.ja.md)

> ひとことで：extension はロード時に tool・command・イベント handler を runner に登録し、イベントが起きて初めて呼び出されます——workflow は登録でつながるのであって、コアを書き換えるのではありません。
>
> Pi の中での位置：`@earendil-works/pi-coding-agent` の `core/extensions`。loader が `pi` オブジェクトを作り、runner がイベントごとに dispatch します。

→ Pi の README には三つの No が並んでいます：no sub-agents、no plan mode、no built-in to-dos——作れないのではなく、全員の workflow を代わりに決めることを拒んでいるのです
→ コア入りを断られた機能は extension として生きています：`examples/extensions/` の todo.ts と subagent/ がその現物証拠です
→ 登録 ≠ 即実行：factory が走り終えて残るのは登録記録だけで、イベントが起きたとき runner がロード順に handler を呼び出します
→ extension は agent が走り出す前にカスタムメッセージを注入することもできます——内部メッセージの種類はモデルが知っているものより多く、その分層がここで初めて役に立ちます

---

## 問題

s08 までで、コアに必要なものは揃いました：tool schema、イベントストリーム、hook 付きの tool loop、turn state、session tree、context resources。次に湧いてくる自然な衝動は、さらに機能を足し込むことです——他の coding agent には plan mode があり、sub-agent があり、todo パネルがある。Pi にも一式内蔵するべきでは？

まず、ユーザーが何を欲しがるかを見てみます：

```text
危険な bash コマンドを止めたい人がいる
モデルに内部 tool をひとつ足したい人がいる
毎ターンのリクエスト前にプロジェクトルールを差し込みたい人がいる
todo が欲しい人がいる：todo tool を登録して、状態を session の分岐に追従させたい
sub-agent が欲しい人がいる：独立した pi 子プロセスを立てて、scout・planner・reviewer にそれぞれ働いてほしい
```

前の三つは「ちょっと止める・ひとつ足す」程度の小さな話です。後の二つは丸ごとの workflow で、厄介なのはここです：sub-agent は並列か直列か、コンテキストをどう隔離するか、結果をどう返すか？todo はファイルに置くか、session の分岐に追従させるか？plan は人間向けに書くか、モデル向けに書くか？どの問いにも、全員に合う答えはありません。コアに焼き込めば全員の代わりに決めることになり、間違えても簡単には外せません。

Pi の答えは README の Philosophy 節（[`packages/coding-agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/README.md)）に直接書いてあります：

> **No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way.
>
> **No plan mode.** Write plans to files, or build it with extensions, or install a package.
>
> **No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with extensions.

三つの No は機能の削除ではなく、置き場所の変更です：これらの workflow はすべて実現できますが、extension 層で作るので、対立点が「コアが代わりに選ぶ」から「自分で選ぶ」に変わります。口だけでもありません——`examples/extensions/todo.ts` は todo tool と `/todos` command を登録し、状態を session entry に保存するので、分岐すれば todo も一緒に分岐します。`examples/extensions/subagent/` はひとつの tool で独立した pi 子プロセスを立ち上げ、agent 定義一式と `/implement` workflow まで付いてきます。コア入りを断られた機能はどれも extension の形で生きていて、コアのコードは一行も変わっていません。

というわけで本節の問題はこうです：コマンドを止める小さな話も sub-agent のような大きな workflow も外から接続できるように、コアはどんな差し込み口を開けるべきか。

## 考え方

extension はひとつのファイルで、default export は factory です。ロード時に factory は `pi` オブジェクトを受け取り、能力を登記します。runner は登記を預かり、イベントが起きたときに呼び出します：

| 登録口 | 何を登記するか | いつ呼ばれるか |
| --- | --- | --- |
| `pi.registerTool` | モデル向けの新しい tool | モデルが toolCall を出したとき |
| `pi.registerCommand` | ユーザーの slash command | ユーザーが `/name` を打ったとき |
| `pi.on("tool_call")` | tool 実行前のチェック | 毎回の tool 実行前 |
| `pi.on("before_agent_start")` | system prompt の変更、カスタムメッセージの注入 | agent が走り出す前 |
| `pi.on("resources_discover")` | skill / prompt パスの動的追加 | 起動時と reload 時 |

仕組み全体を貫く線は一本だけです：登録 ≠ 即実行。factory の実行中に tool はひとつも動かず、リクエストもひとつも飛びません。handler・tool・command を extension record に書き込むだけです。先ほどの todo も sub-agent も、すべてこの数個の登録口の組み合わせです。

本節では、実際の runtime にはある UI コンポーネント、キーボードショートカット、renderer、provider 登録は作りません。残すのは三本の主線だけです：能力を登録する、イベントで dispatch する、結果を既存の turn state につなぎ戻す。

## まず動かす

```sh
npm run session:s09
```

出力はこんな具合です：

```text
Tools: read, bash, note
Command notification: hello Pi
System prompt has extension note: true
Blocked bash: Dangerous shell command
```

四行が四つの事実に対応します：extension が登録した `note` tool が tool 一覧に入った。`/hello` command が通った。`before_agent_start` が system prompt に一行追記した。`tool_call` が `rm -rf` を含む bash を止めた。

## コードの中身

### factory が残すのは登録記録だけ

本物の Pi では、extension ファイルは関数を default export します：

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(/* ... */);
  pi.registerCommand(/* ... */);
  pi.on("tool_call", /* ... */);
}
```

mini も同じ形です：

```ts
export type MiniExtensionFactory = (pi: MiniExtensionAPI) => void | Promise<void>;
```

factory が受け取る `pi` オブジェクトがやることはひとつだけ——登記です：

```ts
function createExtensionApi(extension: LoadedExtension): MiniExtensionAPI {
  return {
    on(event, handler) {
      extension.handlers[event].push(handler as never);
    },
    registerTool(tool) {
      extension.tools.push(cloneTool(tool));
    },
    registerCommand(name, command) {
      extension.commands.push({ name, ...command });
    },
  };
}
```

三つのメソッドはどれも extension record への push です。factory が走り終えても、handler はひとつも呼ばれず、tool もひとつも実行されていません。ではいつ実行されるのか？runner の三つの emit を見ます。

### before_agent_start は一本のチェーンになる

```ts
async emitBeforeAgentStart(event: BeforeAgentStartEvent): Promise<{
  systemPrompt: string;
  messages: MiniCustomMessage[];
}> {
  let currentSystemPrompt = event.systemPrompt;
  const messages: MiniCustomMessage[] = [];

  for (const extension of this.extensions) {
    for (const handler of extension.handlers.before_agent_start) {
      const ui = createMiniUi();
      const result = await handler(
        { ...event, systemPrompt: currentSystemPrompt },
        createContext(ui, currentSystemPrompt),
      );

      if (result?.message) {
        messages.push({ ...result.message });
      }
      if (result?.systemPrompt !== undefined) {
        currentSystemPrompt = result.systemPrompt;
      }
    }
  }

  return {
    systemPrompt: currentSystemPrompt,
    messages,
  };
}
```

runner は extension をロード順にたどります。前の handler が system prompt を変更すると、後の handler はイベントの中で変更後の版を見ます——テストでは二つの extension が順に `[first]`、`[second]` を追記し、最終的に `base\n[first]\n[second]` になります。extension は外側の workflow なので、複数の workflow が同席するとき、runner は安定した実行順序を与えなければなりません。さもないと、どれがどれを上書きするかは運まかせです。

### extension はカスタムメッセージも差し込める

上のコードにはもうひとつ `messages.push` があり、handler の戻り値の別フィールドから来ています：

```ts
export type BeforeAgentStartResult = {
  systemPrompt?: string;
  message?: MiniCustomMessage;
};
```

```ts
export type MiniCustomMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
```

これは agent が走り出す前に、extension がこのターンへメッセージを注入する口です。s06 で見たとおり、Pi 内部のメッセージ種類はモデルが知っているものより多い——AgentMessage と LLM message は別の層で、custom message はその隙間に住んでいます：独自の `customType` と任意の `details` を持ち、ユーザーに見せるかどうかは `display` が決め、モデルのコンテキストに入るかどうかは変換層が決めます。plan-mode extension ならここで現在の plan をこのターンに注入できますし、統計 extension なら UI にだけ見せる通知を差し込めます。mini は集めたメッセージを `ExtensionTurnState.beforeAgentStartMessages` に入れます。

### tool_call は実行前の門

```ts
async emitToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined> {
  for (const extension of this.extensions) {
    for (const handler of extension.handlers.tool_call) {
      const result = await handler(event, createContext(createMiniUi(), ""));
      if (result?.block) {
        return { block: true, reason: result.reason };
      }
    }
  }

  return undefined;
}
```

毎回の tool 実行前に、runner は extension をひと回り訊いて回ります：`{ block: true }` を返した extension があれば止め、誰も止めなければ `undefined` を返して通します。demo で止めるのは `rm -rf` を含む bash です。Pi が permission popup を内蔵しない自信もここにあります——確認フローそのものが workflow だからです。すべての bash を止めてもいいし、`.env` への書き込みだけ止めてもいい。それぞれが自分の extension を書けばいいのです。

### resources_discover はリソースパスを s08 に渡す

s08 では skill と prompt のパスは呼び出し側がハードコードしていました。s09 はもうひとつの供給源を開きます。`emitResourcesDiscover()` の核心はこの部分です：

```ts
for (const extension of this.extensions) {
  for (const handler of extension.handlers.resources_discover) {
    const result = await handler({ cwd, reason }, createContext(createMiniUi(), ""));
    for (const path of result?.skillPaths ?? []) {
      discovered.skillPaths.push({ path, extensionPath: extension.path });
    }
    for (const path of result?.promptPaths ?? []) {
      discovered.promptPaths.push({ path, extensionPath: extension.path });
    }
    for (const path of result?.themePaths ?? []) {
      discovered.themePaths.push({ path, extensionPath: extension.path });
    }
  }
}
```

どのパスにも `extensionPath` が付きます——このリソースをどの extension が報告したかの記録です。本物の Pi はこの出所を resource loader まで渡し、診断・表示・衝突処理に使います。

### すべてを turn state につなぎ戻す

```ts
export async function createExtensionTurnState(
  options: Omit<CreateContextResourceTurnStateOptions, "registry"> & {
    runner: MiniExtensionRunner;
    registry: ToolRegistry;
    prompt?: string;
  },
): Promise<ExtensionTurnState> {
  const discovered = await options.runner.emitResourcesDiscover(options.cwd, "startup");
  const registry = mergeExtensionTools(options.registry, options.runner);
  const turnState = await createContextResourceTurnState({
    ...options,
    registry,
    skillFiles: [...(options.skillFiles ?? []), ...discovered.skillPaths.map((entry) => entry.path)],
    promptTemplateFiles: [...(options.promptTemplateFiles ?? []), ...discovered.promptPaths.map((entry) => entry.path)],
  });
  const beforeAgentStart = await options.runner.emitBeforeAgentStart({
    prompt: options.prompt ?? "",
    systemPrompt: turnState.systemPrompt,
    systemPromptOptions: { cwd: options.cwd },
  });

  return {
    ...turnState,
    systemPrompt: beforeAgentStart.systemPrompt,
    beforeAgentStartMessages: beforeAgentStart.messages,
  };
}
```

順序に意味があります：まず `resources_discover` を発火します——extension が報告するパスは、s08 がリソースを読み込む前に `skillFiles` と `promptTemplateFiles` に合流していなければなりません。次に extension の tool を s02 のレジストリにマージし、それから s08 に turn state を作らせ、最後に `before_agent_start` が組み上がった system prompt に最後の一手を入れ、ついでに custom message を回収します。

extension は既存の構造を何も置き換えていません：bash を止める、tool を足す、slash command を作る、ルールを補う、todo 一式を組む——全部この数個の登録口経由で、コアの変更ではありません。s02 のレジストリ、s06 のスナップショット、s08 のリソース経路はそのまま残り、各段にコンセントがひとつ増えただけです。

## 手を動かす

demo はすべて `runDemo()` の中にあります。変更したら `npm run session:s09` を再実行してください：

1. mini-todo extension を自分の手で書いて、「workflow はコアに入れなくていい」を体験します。`loadMiniExtensions` の配列に一項目追加：

   ```ts
   {
     path: "todo.ts",
     factory(pi) {
       const todos: string[] = [];
       pi.registerTool({
         name: "todo",
         label: "todo",
         description: "Add a todo and list all todos.",
         parameters: {
           type: "object",
           properties: { text: { type: "string" } },
           required: ["text"],
         },
         handler(input) {
           todos.push(String(input.text));
           return { toolName: "todo", content: todos.map((text, i) => `${i + 1}. ${text}`).join("\n") };
         },
       });
     },
   },
   ```

   再実行すると一行目が `Tools: read, bash, note, todo` に変わります。これが Pi の `examples/extensions/todo.ts` の骨格です——本物は状態を session entry に保存し、分岐すれば todo も一緒に分岐しますが、コアのコードに一行も触れない点は同じです。

2. `note` を止める門を書きます：demo の extension にもうひとつ `tool_call` handler を登録し、`event.toolName === "note"` のとき `{ block: true, reason: "notes are frozen" }` を返すようにして、demo の末尾に `await runner.emitToolCall({ toolName: "note", input: { text: "x" } })` の結果を出力する `console.log` を一行足します。さらに `emitToolCall` に渡す bash コマンドを `rm -rf tmp` から `ls` に変えて、`undefined` が返るのを観察してください——誰も止めなければ通る、です。

変更後は `npm run test:s09` で本節の挙動契約を壊していないか確認できます。

## 本線につなぐ

s09 は本線の各段にコンセントを取り付けます：

| コンポーネント | 前節（s08） | 本節（s09） |
| --- | --- | --- |
| tool レジストリ | アプリ起動時にハードコード | 基本レジストリと extension 登録の tool をマージ |
| skill / prompt パス | 呼び出し側の引数で明示 | 引数に加えて `resources_discover` が動的に補える |
| system prompt | context files + activeTools を組んだ時点で確定 | 組み上げ後に `before_agent_start` が最後の一手を入れられる |
| tool 実行前 | s05 の hook はアプリコードにハードコード | `tool_call` イベントを任意の extension に開放 |
| turn state | `ContextResourceTurnState` | `ExtensionTurnState`、`beforeAgentStartMessages` が増える |

## Pi ソースと照合

本節を読み終えたら [pi-source.md](pi-source.md) へ。

対応関係をひとことで：`loadMiniExtensions()` は `loader.ts` の `createExtensionAPI()` に対応します——あちらでも `pi.on`・`pi.registerTool`・`pi.registerCommand` が extension record への書き込みでしかないことを確認できます。`MiniExtensionRunner` の三つの emit は `runner.ts` の `emitBeforeAgentStart()`・`emitResourcesDiscover()`・`emitToolCall()` に対応します。本物の runtime には UI コンポーネント、ショートカット、renderer、provider 登録という一層まるごとの能力もありますが、本節はどれも作っていません——アンカーと簡略化の一覧は pi-source を見てください。

## 次の節

コアに拡張口はできましたが、いまのところ使い方はひとつだけ：コードから直接関数を呼ぶことです。本物の Pi はターミナルで対話し、CI で JSON を出力し、他のプログラムから RPC サービスとして呼ばれ、SDK として組み込まれます——そしてこれらは四組の agent ではありません。

[s10 Runtime Modes](../s10_runtime_modes/README.ja.md)：同じ core と extension runtime に、interactive・print/json・rpc・sdk という四種類の外殻を接続します。
