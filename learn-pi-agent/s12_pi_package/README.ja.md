# s12 · Pi Package

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：Resource の読み込み前に、設定済み Package Source を Enabled Extension、Skill、Prompt Template、Theme へ変換する Resolver です。

```text
package entries + installed file map + projectTrusted
  -> resolvePiPackages()
  -> enabled paths
       +-> Extension path -> explicit factory -> Extension runner
       +-> Skill path -------------------------> Context Resources
       +-> Prompt path ------------------------> explicit invocation catalog
       +-> Theme path -------------------------> selection only in s12
  -> the same MiniCoreRuntime
```

## 問題：Package が解決するのは配布であり、新しい Agent 機構ではない

s11 までに、Harness は既知の Path から Extension、Skill、Prompt Template を読み込めるようになりました。Workflow を共有するには、さらに配布 Contract が必要です。Package Source のどの File が Resource なのか、どれが Disabled なのか、同じ Package が二つの Scope にあるときどちらが勝つのかを決めなければなりません。

Package は新しい Agent 機構を作りません。既存の Resource Loader と Extension Runtime が File を見る前に、Resource Path を選択してまとめるものです。ここでは三つの Authority を分けます。

| Authority | 決めること |
| --- | --- |
| Package Author | `pi` Manifest が Export する Resource |
| Directory Convention | Manifest Rule が許す場合の Fallback Discovery |
| Installer Configuration | Candidate のうち Enabled のまま残す Resource |

これは選択 Authority であって、File System や実行の Security Boundary ではありません。Manifest Entry は Package Directory の外へ解決でき、選択された Extension は Host Process と同じ権限で動きます。

## 考え方：Path の解決と Resource の有効化を分ける

s12 は Package Resolution と Runtime Activation を分離します。

`resolvePiPackages()` は正規化した File Map、User/Project Package Entry、Project Trust Decision、Host がすでに Package Source を配置した Root を受け取り、四種類の `ResolvedResource` を返します。各 Object は Path、Scope Metadata、Source、`enabled` Flag を保持します。

`createPackageRuntime()` は Enabled Resource だけを有効化します。

| Resource | s12 での扱い |
| --- | --- |
| Extension | 一致する明示的 `MiniExtensionSource` Factory を要求し、Extension Runner へ読み込む |
| Skill | Path を実 Context Resource Turn へ追加する |
| Prompt | Catalog Metadata を読み、`invokePromptTemplate()` の呼び出し時だけ Template を展開する |
| Theme | Enabled Path を `selection.themePaths` に返す。本レッスンには適用する TUI がない |

`projectTrusted` が true のときだけ Project Package が Resolution に入ります。同じ npm または Git Identity が重複した場合は、Project Entry が User Entry より優先されます。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s12 -- "read_file で package.json を確認し、このレッスンの依存関係を要約してください。"
```

このレッスンは Package を Install しません。すでに存在する Package Resource を解決し、実 Runtime を構成する方法を扱います。CLI は空の Package List と File Map を渡しながら、これまでの実 Model、Session Tree、Extension Turn、Tool Loop を動かします。

Package の動作を確認するには、Host が持つ File Map と Package Entry を `resolvePiPackages()` に渡し、同じ Input を `createPackageRuntime()` へ渡します。戻り値の `selection` は有効な Resource Path を示し、Runtime と Session はそれらの Resource が Turn へ与える影響を示します。

## コードの中身

### 1. Package Source と Scope を解決する

`resolvePackageSourcePath()` は、設定 Source を Host がすでに File を配置した場所へ対応付けます。

| Source | User Scope | Project Scope |
| --- | --- | --- |
| `npm:name` | `~/.pi/agent/npm/node_modules/name` | `.pi/npm/node_modules/name` |
| Git Source | `~/.pi/agent/git/host/path` | `.pi/git/host/path` |
| Relative Local Path | Agent Directory からの相対 Path | Project `.pi/` からの相対 Path |
| Absolute Local File | File 自体 | File 自体 |

Local File は単一 Extension として扱い、Directory は Package Rule へ進みます。s12 は Install も Fetch も行わないため、存在しない Root は Skip します。

Project Package を先に処理し、その後で User Package を処理します。`dedupePackageEntries()` は Scope をまたいで npm と Git Source を識別するため、Project 版が勝ちます。Local Identity は Scope を保持します。

### 2. Manifest、Convention、Filter を合成する

正確な Rule は Package Entry の形式で変わります。

String Entry では、`pi` Manifest が存在すると Resource Selection の Authority になります。欠けた Key や空の Key は、その種類を何も Export しません。Manifest がない場合だけ、`extensions/`、`skills/`、`prompts/`、`themes/` Convention を使います。

Installer Filter を持つ Object Entry では次の順序です。

- Filter Key がない場合、Manifest Key があれば空 Array を含めて使い、なければ Convention が Candidate を提供する。
- Filter Key がある場合、非空の Manifest Key が Candidate を提供し、Key がないか空なら Convention へ戻ってから Filter する。
- Include と `!` Pattern が Candidate を選択・除外し、その後に正確な `+` と `-` Override を順番に適用する。
- Force-include は既知の Candidate を再度有効化できるだけで、Candidate Set 外の Path は作れない。

Resolver は Disabled Candidate も Result に残します。Runtime Activation 前の境界が `getEnabledPaths()` です。

### 3. Extension Entry Point を発見し、Factory を要求する

Extension Discovery は、入れ子になったすべての `.ts` や `.js` を Extension とみなしません。Top-level File、Child Directory の `index.ts`/`index.js`、または Child Directory の Manifest にある明示 Entry だけを選びます。Entry から import される Helper は Helper のままです。

Resolution が返すのは Path であり、実行可能 Module ではありません。`createPackageRuntime()` は `extensionSources[].path` と Factory の Map を作ります。Enabled Package Extension に一致する Factory がなければ構築は失敗します。

```ts
const source = extensionByPath.get(normalizePath(path));
if (!source) {
  throw new Error("Missing extension factory for resolved package path: " + path);
}
```

この明示 Factory Map はレッスンの Host Contract です。実行 Eligibility を見える形にしますが、Sandbox ではありません。s12 は任意の TypeScript を動的 import しません。

### 4. Enabled Resource を実 Turn へ接続する

選択後、`createPackageRuntime()` は s10 から続く同じ Runtime を構成します。

```ts
const prepared = await createPackageRuntime({
  files,
  userPackages: ["/packages/review"],
  projectPackages: [],
  projectTrusted: true,
  extensionSources: [{ path: extensionPath, factory: reviewExtension }],
  runtimeOptions,
});

await runPrintMode(prepared.runtime, "この変更をレビューしてください");
```

Enabled Extension は実 Tool と Hook を登録します。Enabled Skill は s08 を通じて System Prompt に入ります。Enabled Prompt File は `prepared.promptTemplates` の Catalog Entry になりますが、通常の Turn は Template Body を System Prompt に入れません。`prepared.invokePromptTemplate(name, args)` を呼んだときだけ s08 の `formatPromptTemplateInvocation()` が Text を展開し、その Turn の User Prompt として送ります。通常の Turn では Model Context に Skill と Tool が含まれ、Package Tool が実行され、実 AgentMessage Session に Tool Call と Tool Result が記録されます。

Theme は Presentation Resource のままです。Enabled Path は `selection.themePaths` で確認できますが、本レッスンに Theme Renderer はありません。

## 手を動かす

1. String Package の `pi` Manifest から `prompts` を省き、Conventional Prompt File を追加します。Export されないことを確認します。
2. 同じ Source を明示 Prompt Filter 付き Object Form にし、Convention が Candidate Set になる条件と Filter が Path を Disabled にする条件を比べます。
3. Child Extension の `index.ts` の隣に `helper.ts` を置きます。`discoverExtensionEntries()` は Entry Point だけを選びます。
4. Enabled Extension を解決し、`extensionSources` には追加しません。暗黙に import せず、構築が失敗することを確認します。
5. `prepared.runtime` へ通常の Prompt を送り、Model の Tool List、System Prompt、AgentMessage Session を確認します。Extension と Skill はその Turn に影響しますが、Prompt Body は `invokePromptTemplate()` が User Input として送るまで現れてはいけません。Theme は Selection Data のままです。
6. `projectTrusted` を false にし、User Package は残り、Project Package は消えることを確認します。

## 本線につなぐ

| 境界 | s11 | s12 |
| --- | --- | --- |
| Trust | Project Input の参加を決定 | Project Package List 全体を Gate |
| Resource Path | 直接の Project Path | Package Source から選択した Path |
| Extension | Trusted な Direct Extension Path | Enabled Package Path と明示 Factory |
| Skill と Prompt | Trusted な Direct Path | Enabled Path を Load。Prompt Text は明示 Invocation 時だけ Turn に入る |
| Theme | 未使用 | Resolve して報告するが Render しない |
| Core と Session | 一つの実累積 Runtime | 変更なし |

## Pi ソースと照合

Pi 0.79.1 も同じ Resolver Model を使います。npm、Git、Local Source から Package Root を得て、`package.json#pi` と Convention Directory から Resource Candidate を作り、Filter で Enabled State を決めます。Project Trust は Project Package を Gate し、Project Scope が重複 Identity に勝ち、`ResourceLoader` が Enabled Path を消費します。

実 Pi はさらに Package の Install と Update、Extension Module の動的 Load、すべての対応 Resource Type の Parse、Diagnostic、UI での Theme 適用を行います。s12 は File Map がすでに埋まっていることを前提に、明示 Factory Map を使い、Theme を Selection Data のまま残します。

どちらの実装も Package Root を Containment Boundary として扱いません。Manifest Entry は Resource Selection Instruction であって Sandbox Rule ではありません。読み込み前に Package Content を確認し、強い分離には外部 Container、VM、micro-VM、Remote Sandbox、または OS Policy を使います。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s13 · Integrated Harness](../s13_integrated_harness/) は Project Trust、Direct/Packaged Resource、Extension、実 Model、AgentMessage Session、すべての Runtime Shell を一つの Host-facing API にまとめます。
