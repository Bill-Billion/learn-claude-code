# s08 · Context Resources

[English](README.md) · [中文](README.zh.md) · 日本語

[← s07](../s07_session_tree/README.ja.md) · [目次](../README.ja.md) · [s09 →](../s09_extension_runtime/README.ja.md)

> ひとことで：ターンを始める前に、Pi はまずプロジェクトの説明書を取り込みます——AGENTS.md・skill・prompt template の 3 種類のリソースに、3 通りのリクエストへの入り方があります。
>
> Pi の中での位置：`@earendil-works/pi-coding-agent` のリソース読み込み層。resource loader と system prompt が、harness の `createTurnState()` の手前に置かれています。

→ AGENTS.md は全文が system prompt に入り、skill は名前・説明・パスだけを見せ、prompt template はそもそも入らない——ユーザーが `/name` を打つまで展開を待つ
→ このターンに read tool がなければ、skill リストはモデルに渡さない。リストの中身は、モデルが自分で読みに行くべきファイルパスばかりだから
→ プレースホルダの置換はワンパスのみ。引数値の中の `$1` や `$ARGUMENTS` はそのまま残る——再帰展開すると、ユーザー入力が template への注入口になってしまう
→ リソースの発見は外側のアプリケーションの仕事。harness は毎ターン、整理済みのスナップショットを一枚受け取るだけ

---

## 問題

s06 の turn state で、ターンの入力をスナップショットに焼き付けられるようになりました。s07 では messages の出どころ——session tree の現在の branch——にも答えました。でもそれだけでは、モデルはプロジェクトについて何も知りません。このリポジトリの約束事も、用意されている手順書も、ユーザーが貯めてきた prompt template も知らないままです。

現実のリポジトリには、たいていこういうものがあります：

```text
AGENTS.md                  プロジェクトの説明と約束事
.pi/skills/review/SKILL.md ある種のタスク向けの手順書
.pi/prompts/fix.md         ユーザーが手動で展開する prompt template
```

いちばん楽なのは全部同じに扱うこと。全部読み出して、全文を system prompt に詰め込む。問題はすぐにやってきます——skill は数百行あるかもしれないのに、モデルは毎ターンそれを背負わされる。prompt template はユーザーが `/fix` を打つときのためのもので、モデルが毎ターン眺めて何になるのか。リソースが増えるほど、system prompt はただ肥大化していきます。

つまり本当の問題はこうです。3 種類のリソースは、それぞれどんな形で、どのタイミングでターンに入るべきか。

## 考え方

Pi は 3 種類のリソースに 3 通りの扱いを与えます：

| リソース | 入り方 | 本文を読むのは誰か |
| --- | --- | --- |
| context files（AGENTS.md / CLAUDE.md） | 全文が system prompt に連結される | モデルが毎ターン見る |
| skills | 名前 + 説明 + パスが system prompt に入る | タスクが合うとモデルが判断したら read でその場で読む |
| prompt templates | resources に保存されるだけで、system prompt には入らない | ユーザーが `/fix README.md` を打ったときに展開 |

さらに連動ルールがひとつ。skill リストは、現在のターンに `read` tool があるときにしか現れません。リストの中身はファイルパスばかりなので、モデルがファイルを読めないなら、リストを渡しても意味がないのです。

この節では、本物のファイルスキャンも、project trust や pi package も、extension によるリソースの動的登録も扱いません——それぞれ s11・s12・s09 の担当です。リソースのパスは呼び出し側が明示的に渡し、ファイルシステムはメモリ上のオブジェクトで模擬します。

## まず動かす

```sh
npm run session:s08
```

出力はだいたいこうなります：

```text
Session: demo-session
Context files: AGENTS.md, AGENTS.md
Skills in resources: review
Prompt templates: fix
System prompt has skills: true
Template expansion: Fix README.md and explain the verification.
```

2 行目の `AGENTS.md` が 2 つあるのは二重読み込みではなく、2 つの別ファイルです。demo は basename しか表示しません。片方はグローバルの agent ディレクトリ `/home/me/.pi/agent/AGENTS.md` から、もう片方はプロジェクトルート `/work/pi/AGENTS.md` から来ています。

`System prompt has skills: true` になっているのは、このターンの activeTools に `read` があるからです。最後の行は `/fix README.md` の展開結果——template の `$1` が `README.md` に置き換わりました。

## コードの中身

### 3 種類のリソースを別々に格納する

```ts
export function loadContextResources(options: LoadContextResourcesOptions): ContextResources {
  return {
    contextFiles: loadProjectContextFiles(options.files, options.cwd, options.agentDir),
    skills: (options.skillFiles ?? []).map((filePath) => loadSkill(options.files, filePath)),
    promptTemplates: (options.promptTemplateFiles ?? []).map((filePath) => loadPromptTemplate(options.files, filePath)),
  };
}
```

skill と prompt template のパスは呼び出し側が渡し、context files はディレクトリのルールで探します。`MemoryFiles` はただの `Record<string, string>` です——本物の Pi はローカルのファイルシステムと settings/package manager をスキャンしますが、教材コードは入力を固定して、リソースの流れが見えるようにしています。

### AGENTS.md はグローバルが先、プロジェクトが後

```ts
function loadProjectContextFiles(files: MemoryFiles, cwd: string, agentDir: string): ContextFile[] {
  const result: ContextFile[] = [];
  const seen = new Set<string>();

  const globalFile = findContextFile(files, agentDir);
  if (globalFile) {
    result.push(globalFile);
    seen.add(globalFile.path);
  }

  for (const dir of ancestorDirs(cwd)) {
    const file = findContextFile(files, dir);
    if (file && !seen.has(file.path)) {
      result.push(file);
      seen.add(file.path);
    }
  }

  return result;
}
```

まずグローバルの一枚を取り、次にルートディレクトリから cwd まで下りながら、各階層で一枚ずつ探します。プロジェクトに近い説明ほど prompt の後ろに連結されます——モデルが最後に読むのは、現在の作業ディレクトリにいちばん近い一枚です。

`findContextFile` が認識する名前は 4 つ：

```ts
for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
```

`CLAUDE.md` も認識します。既存プロジェクトの慣習に対する Pi の互換対応です。

### skill は名前・説明・パスしか見せない

```ts
if (options.activeToolNames.includes("read")) {
  const skillsBlock = formatSkillsForSystemPrompt(options.skills);
  if (skillsBlock) {
    lines.push("", skillsBlock);
  }
}
```

system prompt に skill の本文は置かず、`<available_skills>` という索引——名前・説明・ファイルパス——だけを置きます。モデルは `review` という skill があること、どこを読めばいいかを知っていますが、毎ターン中身全体を背負う必要はありません。外側の `read` 判定が先ほどの連動ルールです。モデルに read tool がないとき、パスだらけのこの索引には意味がないので、いっそ渡しません。

`formatSkillsForSystemPrompt()` の冒頭にはフィルタも一枚あります：

```ts
const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
```

frontmatter に `disable-model-invocation: true` と書かれた skill はモデル可視のリストに入りませんが、明示的な呼び出しは引き続き可能です。

### プレースホルダの置換はワンパスだけ

```ts
export function formatPromptTemplateInvocation(template: ContextPromptTemplate, args: string[] = []): string {
  const allArgs = args.join(" ");
  // Single pass over the template, like Pi: argument values that contain
  // $1, $@, or $ARGUMENTS are NOT recursively substituted.
  return template.content.replace(/\$(ARGUMENTS|@|\d+)/g, (_match, token: string) => {
    if (token === "ARGUMENTS" || token === "@") return allArgs;
    return args[Number(token) - 1] ?? "";
  });
}
```

プレースホルダは 3 つ。`$1` は 1 番目の引数、`$@` と `$ARGUMENTS` は全引数です。

肝心なのはワンパスであること。`replace` のコールバックが返したものがそのまま結果に落ち、戻り値が正規表現にもう一度スキャンされることはありません。だから引数値の中の `$1` や `$ARGUMENTS` は、手つかずのまま結果に残ります。この性質は守る価値があります——template が `Fix $1 then $ARGUMENTS.` で、ユーザーが渡した引数がたまたま `$ARGUMENTS` と `$2` だったとしましょう。ワンパス置換の結果は `Fix $ARGUMENTS then $ARGUMENTS $2.` になり、引数はそのまま本文に入ります。奇妙ですが無害です。もし置換が再帰的だったら、この結果の中の `$ARGUMENTS` はさらに展開され、`$2` はさらに置き換えられ、文字列はパスを通るたびに形を変えます——ユーザーが何気なく渡した文字列が、template の他の場所を書き換えられる注入口になってしまう。Pi は `prompt-templates.ts` のコメントで再帰しないことを明言しており、mini も同じワンパスの `replace` でこの線を守っています。

### s06 の harness に組み戻す

```ts
const harness = createMiniHarness({
  session: options.session,
  model: options.model,
  registry: options.registry,
  activeToolNames: options.activeToolNames,
  resources: {
    skills: contextResources.skills.map(({ name, description }) => ({ name, description })),
    promptTemplates: contextResources.promptTemplates.map(({ name, description, content }) => ({
      name,
      description,
      content,
    })),
  },
  systemPrompt({ activeTools }) {
    return buildContextSystemPrompt({
      cwd: options.cwd,
      activeToolNames: activeTools.map((tool) => tool.name),
      contextFiles: contextResources.contextFiles,
      skills: contextResources.skills,
    });
  },
} satisfies MiniHarnessOptions);
```

s08 は harness を書き直していません。skill は resources に渡す前に name と description だけに剥がされます——s06 の `MiniSkill` はこの 2 フィールドしか持たず、本文とパスは s08 自身の手元に残ります。prompt template は name・description・content の 3 フィールドで入ります。context files は resources を通りません。`systemPrompt` callback を通り、そのターンの activeTools と一緒に最終的な prompt に組み上がります。

リソースの発見——ファイルをスキャンし、AGENTS.md を読み、skill の frontmatter を解析する——は外側のアプリケーションの仕事で、harness は整理済みの resources を一式受け取るだけです。3 種類のリソースのリクエストへの入り方はそれぞれ違います。AGENTS.md は全文、skill は入口だけ、template はユーザーの展開待ち。でもすべて同じ turn state のスナップショットから入ってきます。これが Pi のメカニズムとポリシーを分ける境界線です。harness はメカニズムを提供し、リソースをどう探すか、モデルに何を見せるかは外側のポリシーなのです。

## 手を動かす

demo の入力はすべて `runDemo()` に書かれています。変更したらそのまま `npm run session:s08` を再実行してください：

1. プレースホルダで遊んでみます。`files` の `/work/pi/.pi/prompts/fix.md` の本文を `Fix $1 then $ARGUMENTS.` に変え、demo で展開時に渡している `["README.md"]` を `["$ARGUMENTS", "$2"]` に差し替えます。出力は `Fix $ARGUMENTS then $ARGUMENTS $2.` になるはずです——引数の中のプレースホルダはそのまま残ります。次に再帰の反例を作ります。1 パス目の結果を template としてもう一度展開する、つまり `formatPromptTemplateInvocation({ ...promptTemplate, content: 1パス目の結果 }, 同じ引数)` を呼ぶと、文字列がまた形を変えるのが見えます。ワンパス置換が防いでいるのはこれです。
2. `files` に `"/work/AGENTS.md": "Workspace instruction."` を一枚追加します——demo の cwd は `/work/pi` で、`/work` はその親ディレクトリです。再実行すると `Context files` は 3 つの `AGENTS.md` になり、順序はグローバル → `/work` → `/work/pi` です。
3. `activeToolNames: ["read", "bash"]` を `["bash"]` に変えます。`System prompt has skills` が `false` になります——skill は resources に残ったまま、このターンはモデルに見せない、というだけです。

変更したら `npm run test:s08` で、この節の振る舞いの約束を壊していないか確認できます。

## 本線につなぐ

s08 は s06 の harness につながり、ずっと空いていた resources を埋めます：

| コンポーネント | 前節（s07） | 本節（s08） |
| --- | --- | --- |
| messages | session tree の現在の branch を `buildContext()` が供給 | 変わらず、session がこれまで通り提供 |
| system prompt | s06 の固定デフォルト | context files と activeTools から毎ターン動的に組み上げ |
| resources | 空のまま | skills と prompt templates がスナップショットに入る |
| turn state | s06 の `TurnState` | `ContextResourceTurnState`。`contextFiles` フィールドが増える |

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) へ。

対応関係をひとことで：`loadContextResources()` は `DefaultResourceLoader.reload()` に、`buildContextSystemPrompt()` は `system-prompt.ts` の `buildSystemPrompt()` に、`createContextResourceTurnState()` は `AgentHarness.createTurnState()` に対応します——つなげれば、プロジェクトのリソースから現在のリクエストまでの Pi の最短経路です。知っておくべき振る舞いの違いが 2 つ。skill に description がないとき、mini はその場で throw しますが、Pi は warning の diagnostic を 1 件記録してその skill をスキップし、読み込みを続けます。また coding-agent 層の `Skill` 型には content フィールドがなく、skill の本文はモデルがその場でファイルを読みます。mini の `ContextSkill` は content を持っていますが、harness に渡す前に剥がします。

## 次の節

いまはリソースのパスをすべて呼び出し側が決め打ちし、tool の一覧も起動時に固定されています。次の節でその口を開きます。extension が tool やコマンドを登録し、リソースパスを動的に提供し、agent が走り出す前に prompt を書き換えられるようにする——そして Pi がなぜ plan mode・sub-agent・todo といった workflow をすべてこの層に置いておくのか。

[s09 Extension Runtime](../s09_extension_runtime/README.ja.md)：カーネルは登録口だけを提供し、workflow は差し込むものです。
