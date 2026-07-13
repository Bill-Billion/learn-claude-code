# s11 · Trust And Execution Env

[English](README.md) · [中文](README.zh.md) · 日本語

[← s10](../s10_runtime_modes/README.ja.md) · [目次](../README.ja.md) · [s12 →](../s12_pi_package/README.ja.md)

> ひとことで：project trust はプロジェクト入力を読み込むかどうかのスイッチで、execution env は tool 実行のバックエンド差し込み口です——二つの境界は互いの肩代わりをしません。
>
> Pi の中での位置：`@earendil-works/pi-coding-agent` の `project-trust.ts` と `trust-manager.ts`、それに read/write/bash tool の operations 差し込み口。セキュリティモデルの正式な説明は `docs/security.md` にあります。

→ trust を断っても、agent は変わらず secret を読め、ファイルを書け、shell を実行できます——trust は最初から権限システムではありません
→ AGENTS.md は trust 入力に数えられず、trust なしでも読み込まれます：未 trust リポジトリの AGENTS.md はそのまま prompt injection の面であり、Pi はこれを想定内のリスクだと明言しています
→ 本節の contained env はプレフィックス検査で bash を止めますが、`npm test; rm -rf /` は素通りします——見せているのは operations 差し込み口であって、第三のセキュリティ機構ではありません
→ 本物の隔離の源はひとつだけ：OS か仮想化/コンテナの境界で、それは常に差し込み口の向こう側にあります

---

## 問題

s10 までで、mini Pi は同じ runtime を異なる入口につなげるようになりました。すると次の二つの問いが自然に浮かびます：見知らぬリポジトリを clone したら、中に `.pi/settings.json`、`.pi/extensions/`、プロジェクト skill が入っていた。Pi はそれをそのまま読み込むのか？そして：trust を断ったら、Pi はファイルの読み書きも shell の実行もできなくなるのか？

一つ目の答えは「先にあなたに訊く」。二つ目の答えは「変わらず全部できる」。二つの答えは、互いの肩代わりをしない二つの仕組みから来ています——これをひとつの「セキュリティスイッチ」に混ぜてしまう誤解こそ、本節が解体するものです。

## 考え方

Pi はこの二件を二つの境界に分けます：

| 境界 | 何に答えるか | 何を管轄しないか |
| --- | --- | --- |
| project trust | `.pi/settings.json`、プロジェクト extension、prompt、package という Pi の挙動を変える入力を読み込むかどうか | ファイル読み書き、shell、モデル出力が安全かどうか |
| execution env | read / write / bash がどのバックエンドに落ちるか | 隔離の強度——それはバックエンドがプロセスの外か中かで決まる |

trust が防ぐことは具体的です：リポジトリがあなたの承認前に Pi の設定を勝手に書き換えたり、extension のコードを紛れ込ませたりできないこと。管轄は入力の読み込みで、答えは一回きりの yes/no です。

実行の権限は別の話です。Pi はローカルの coding agent であり、read、write、bash、extension のコードはすべて Pi を起動したユーザーの権限で動きます。Pi はプロセス内 sandbox をあえて作りません。`docs/security.md` が挙げる理由はこうです：不完全なプロセス内サンドボックスはセキュリティ境界だと誤認されやすく、しかもホストの shell・ファイルシステム・パッケージマネージャ・クレデンシャルに依存したままです——本物の隔離は OS か仮想化/コンテナの境界から来なければなりません。

本節はこのモデルどおりに三つの部品を書きます：trust の決定器（`resolveProjectTrusted()` + `MiniTrustStore`）、入力の装填器（`loadProjectInputs()`）、そして二つの execution env（local と contained）。contained env は、Pi が警告しているまさにあのプロセス内検査としてわざと作ってあります——最後に自分の手で種を明かします。

## まず動かす

```sh
npm run session:s11
```

出力はこうなります：

```text
Project trusted: false
Context files: /repo/AGENTS.md
Extensions loaded: 0
Local read still works: token
Contained bash: contained:/repo$ npm test
```

demo は print mode で起動し、`defaultProjectTrust: "ask"` です——非対話モードでは人に訊けないので trust は false に落ち、プロジェクト extension はひとつも読み込まれません。ただし後の行に注目してください：AGENTS.md は変わらず context files に入り、local env は変わらず secret.txt の中身 `token` を読み出しています。最後の行の contained env はまた別の層のポリシーで、trust が false であることとは何の関係もありません。

## コードの中身

### どれが trust 入力に数えられるか

```ts
export function hasProjectTrustInputs(files: MiniFiles, cwd: string): boolean {
  const normalizedCwd = normalizePath(cwd);
  if (hasDirectory(files, joinPath(normalizedCwd, ".pi"))) {
    return true;
  }

  let current = normalizedCwd;
  while (true) {
    if (hasDirectory(files, joinPath(current, ".agents", "skills"))) {
      return true;
    }

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
```

本物の Pi と同じ基準です：カレントディレクトリに `.pi/` があるか、カレントか祖先ディレクトリに `.agents/skills` があれば、trust を要するプロジェクト入力があると見なします。リストに AGENTS.md がないことに注意してください——この不在は見落としではありません。後で戻ってきます。

### trust の決定はひとつの yes/no にしか答えない

```ts
export async function resolveProjectTrusted(options: ResolveProjectTrustOptions): Promise<boolean> {
  if (options.trustOverride !== undefined) {
    return options.trustOverride;
  }

  if (!hasProjectTrustInputs(options.files, options.cwd)) {
    return true;
  }

  if (options.extensionDecision && options.extensionDecision.trusted !== "undecided") {
    const trusted = options.extensionDecision.trusted === "yes";
    if (options.extensionDecision.remember === true) {
      options.trustStore.set(options.cwd, trusted);
    }
    return trusted;
  }

  const storedDecision = options.trustStore.get(options.cwd);
  if (storedDecision !== null) {
    return storedDecision;
  }

  switch (options.defaultProjectTrust ?? "ask") {
    case "always":
      return true;
    case "never":
      return false;
    case "ask":
      break;
  }

  if (options.mode !== "interactive") {
    return false;
  }
  return options.promptDecision === true;
}
```

上から順に読めばそれが決定順序で、本物の Pi と一致します：

```text
--approve / --no-approve が一発で決める（trustOverride）
trust 入力がなければそのまま通す
project_trust extension の決定。remember で trust store に保存できる
trust store にあるカレントか直近の親ディレクトリの保存済み決定
defaultProjectTrust：always / never / ask
ask かつ非対話：人に訊けないので false を返す
ask かつ interactive：ユーザーがその場で選ぶ（promptDecision）
```

下から二番目の規則が、demo が `Project trusted: false` を出す理由です：`-p`、`--mode json`、`--mode rpc` には UI がなく、ask に出会っても立ち止まって人を待ちません。s10 の mode がここで再登場します——外殻の形態が、確認ダイアログを出せるかどうかを決めるのです。

### trust を断ったあとも読み込まれるもの

```ts
export function loadProjectInputs(files: MiniFiles, cwd: string, projectTrusted: boolean): LoadedProjectInputs {
  const normalizedCwd = normalizePath(cwd);
  const contextFiles = [joinPath(normalizedCwd, "AGENTS.md"), joinPath(normalizedCwd, "CLAUDE.md")].filter((path) =>
    hasFile(files, path),
  );

  if (!projectTrusted) {
    return {
      contextFiles,
      projectSettingsLoaded: false,
      extensionPaths: [],
      promptPaths: [],
    };
  }

  return {
    contextFiles,
    projectSettingsLoaded: hasFile(files, joinPath(normalizedCwd, ".pi", "settings.json")),
    extensionPaths: listFilesUnder(files, joinPath(normalizedCwd, ".pi", "extensions")),
    promptPaths: listFilesUnder(files, joinPath(normalizedCwd, ".pi", "prompts")),
  };
}
```

入力は二種類に分かれます：AGENTS.md と CLAUDE.md は普通の context files で、trust の門を通りません。`.pi/settings.json`、`.pi/extensions`、`.pi/prompts` は trust-gated な入力で、断れば読み飛ばされます。本物の Pi のリソース読み込みはもっと細かいですが、本線は同じです：trust の前に読み込まれるのは context files、user/global の extension、CLI の `-e` extension だけで、プロジェクトローカルのものは trust の通過を待ちます。

「AGENTS.md は門を通らない」という仕組み上の事実を、セキュリティの意味に翻訳するとこうなります：見知らぬリポジトリを clone し、慎重に trust を断っても、その AGENTS.md は一字残らずモデルのコンテキストに入ります——未 trust リポジトリの AGENTS.md は prompt injection の面そのものです。Pi の security.md はこれを隠しません：trust が止めるのは設定と extension コードの読み込みであって、untrusted な prompt や untrusted なモデル出力を安全にはできない。リポジトリ内ファイルからの prompt injection はローカル agent の想定内のリスク（expected local-agent risk）であり、Pi は確実な遮断を約束しない、と。

### local env：trust を断っても変わらず何でもできる

```ts
export function createLocalExecutionEnv(files: MiniFiles): ExecutionEnv {
  const state = cloneFiles(files);

  return {
    async readFile(path: string): Promise<string> {
      return readFromState(state, path);
    },
    async writeFile(path: string, content: string): Promise<void> {
      state[normalizePath(path)] = content;
    },
    async runBash(command: string, cwd: string): Promise<string> {
      return `local:${normalizePath(cwd)}$ ${command}`;
    },
  };
}
```

demo ではこの部分をわざと trust 拒否の後に走らせています：trust は false なのに、`readFile("/repo/secret.txt")` は変わらず `token` を返します。project trust は権限システムではありません——断って起きるのはプロジェクトローカルの `.pi` 入力を読み込まないことだけで、ファイルシステムが読み取り専用になるわけでも、shell が遮断されるわけでもありません。本物の Pi もまったく同じです：組み込み tool はデフォルトでローカルのファイルシステムとローカルの shell を使い、権限は Pi を起動したユーザーの権限そのものです。本当に制限したければ実行環境ごと差し替える——それが次の部品の差し込み口です。

### contained env：まず何を止めるか、次に何を止められないか

```ts
export function createContainedExecutionEnv(files: MiniFiles, options: ContainedExecutionEnvOptions): ExecutionEnv {
  const state = cloneFiles(files);
  const root = normalizePath(options.root);

  return {
    async readFile(path: string): Promise<string> {
      assertInsideRoot(path, root);
      return readFromState(state, path);
    },
    async writeFile(path: string, content: string): Promise<void> {
      assertInsideRoot(path, root);
      state[normalizePath(path)] = content;
    },
    async runBash(command: string, cwd: string): Promise<string> {
      assertInsideRoot(cwd, root);
      if (!options.allowedBashPrefixes.some((prefix) => command.startsWith(prefix))) {
        throw new Error(`command blocked by contained env: ${command}`);
      }
      return `contained:${normalizePath(cwd)}$ ${command}`;
    },
  };
}
```

demo が渡すパラメータはこれです：

```ts
const containedEnv = createContainedExecutionEnv(files, { root: "/repo", allowedBashPrefixes: ["npm "] });
```

読み書きは `/repo` の中に限定され、bash は `npm ` で始まるコマンドしか通しません。sandbox に見えますか？ではここで自分の手で種を明かします：`startsWith` のプレフィックス検査は、security.md が警告するまさにあの「プロセス内の部分的サンドボックス」です——`npm test; rm -rf /` は `npm ` で始まるので、素通りです。だからこの contained env を、trust と local env に並ぶ第三のセキュリティ機構として覚えないでください。これが本当に見せているのは Pi の tool の operations 差し込み口です：read、write、bash のバックエンドは丸ごと差し替え可能で、管理されたマシンへの SSH、Docker コンテナ、Gondolin micro-VM にもできます。本物の隔離は差し込み口の向こう側で起き、OS か仮想化の境界が提供します。差し込み口そのものは、ポリシーを掛けるためのフックにすぎません。

## 手を動かす

1. trust を反転させる：`demo()` の `mode: "print"` を `mode: "interactive"` に変え、`promptDecision: true,` を一行追加します。`npm run session:s11` を再実行すると `Project trusted` が true に、`Extensions loaded` が 1 になります——同じリポジトリでも、人に訊けるかどうかが extension の読み込みを直接左右するのです。

2. プレフィックス検査を自分の手で突破する：`demo()` の末尾に一行追加

   ```ts
   console.log(await containedEnv.runBash("npm test; rm -rf /tmp/x", "/repo"));
   ```

   再実行して `contained:/repo$ npm test; rm -rf /tmp/x` が出力されるのを見てください——通ってしまいました。（env はメモリ内の demo で、`runBash` はコマンドをエコーするだけで実際には実行しません。安心して遊んでください。）次に `npm ` で始まらない書き方に変えて、`command blocked` で止まることを確認します。結論は自分の手から出てきます：プレフィックス検査は行儀のよいコマンドは止められても、セミコロンひとつを止められない——これはセキュリティ境界ではありません。

3. contained env に write の許可リストを足す：`ContainedExecutionEnvOptions` に `allowedWritePrefixes` を追加し、`writeFile` で検査して、`/repo/src/` の外への書き込みが拒否されるのを観察します。終わったら考えてみてください：この許可リストも bash プレフィックスと同じくプロセス内の検査です——ポリシーは差し込み口の上にいくらでも積めますが、隔離の強度はそれで一段も上がりません。

変更後は `npm run test:s11` で本節の挙動契約を壊していないか確認してください。

## 本線につなぐ

| コンポーネント | 前節（s10） | 本節 |
| --- | --- | --- |
| プロジェクト入力 | runtime のデフォルトリソースが揃っていて、「読み込んでいいか」を誰も問わない | `resolveProjectTrusted()` + `loadProjectInputs()`：`.pi` 入力は trust の門を通り、context files は通らない |
| mode | 五つの外殻はただの I/O 形態 | mode が trust の決定に参加：非対話では人に訊けず、ask はそのまま「読み込まない」に落ちる |
| tool の実行 | core は echo stub でファイルに触れない | `ExecutionEnv` インターフェース：read / write / bash が差し替え可能なバックエンドになる |
| セキュリティ境界 | 未討論 | trust は入力を、env は実行を受け持ち、強い隔離はプロセスの外にある |

## Pi ソースと照合

本節を読み終えたら [pi-source.md](pi-source.md) へ。この節はソースよりも先にドキュメントから入るのがおすすめです：`docs/security.md` の Project Trust、No Built-in Sandbox、Running Untrusted or Unmonitored Work の三節が、Pi のセキュリティモデルを直接語り切っています。次に `project-trust.ts` の `resolveProjectTrusted()`——決定順序は本節と一致しますが、非対話の判定で Pi が実際に見るのは hasUI です——そして read/write/bash の operations インターフェース：Pi は sandbox をコアに書き込まず、実行バックエンドを差し替え可能にしました。行単位のアンカーは pi-source.md にあります。

## 次の節

trust はどのプロジェクト入力を読み込むかを決め、execution env は tool がどのバックエンドに落ちるかを決めました。外層の能力に残るピースはあとひとつ：extension、skill、prompt、theme を、どうやってまとめて配布し、他人に使ってもらうかです。

[s12 Pi Package](../s12_pi_package/README.ja.md)：package は新しい能力ではなく、ただの配布単位です——そしてプロジェクトの package も同じ trust の門を通ります。
