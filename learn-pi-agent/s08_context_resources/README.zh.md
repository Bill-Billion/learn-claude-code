# 第8课 上下文资源——不是所有东西都要塞进系统提示

[English](README.md) · 中文 · [日本語](README.ja.md)

[← s07](../s07_session_tree/README.zh.md) · [目录](../README.zh.md) · [s09 →](../s09_extension_runtime/README.zh.md)

到上节课为止，我们的Agent已经能跑循环、能分支会话了，但你真拿它干活会发现一个问题：模型对你的项目一无所知。它不知道你们团队的代码规范，不知道有哪些常用操作流程，也不知道你攒了哪些常用提示词模板。

真实项目里一般有这三类东西：
1. AGENTS.md：项目说明、代码规范、约定俗成的规矩
2. Skills：特定任务的操作手册，比如代码评审怎么做、bug怎么排查
3. Prompt templates：常用的提示词模板，比如/fix修复bug、/review评审代码

很多人第一反应是：这还不简单？全部读出来，一股脑塞进system prompt不就行了？
这个思路做个demo可以，真用起来马上就崩。

---

## 先搞懂：所有资源全塞system prompt为什么不行？

第一，**模型背不动**。一个skill可能几百上千字，你有十几个skill，全塞进去system prompt直接爆token，而且绝大多数轮次模型根本用不上这些skill，纯纯浪费上下文窗口。

第二，**时机不对**。prompt template是用户输入命令的时候才用的，比如用户敲/fix README.md才需要展开修复模板，平时每轮都给模型看它干嘛？

第三，**没有刹车**。资源只会越攒越多，一视同仁全塞进去，最后system prompt会臃肿到根本没法用。

所以问题不是"要不要给模型看资源"，而是**不同的资源，应该在什么时候、以什么形式给模型看**。

这个逻辑其实和老师上课带的讲义包一模一样：
- 课堂守则就一页纸，每节课都带，全文印在讲义第一页——这就是AGENTS.md
- 参考书太厚带不动，讲义里只夹一张书单：书名、简介、在哪个书架，学生需要自己去借——这就是skill
- 习题模板锁在讲台抽屉里，根本不放进讲义包，点到哪个题才发哪个题的卷子——这就是prompt template

三类资源，三种待遇，我们一个个说。

---

## 第一类：Context Files（AGENTS.md）——全文进system prompt

AGENTS.md这类项目说明，是模型每一轮都需要遵守的规矩，所以直接全文拼进system prompt。

加载顺序有讲究：
1. 先加载全局的AGENTS.md（用户目录下的.pi/AGENTS.md）
2. 然后从项目根目录开始，一层一层往当前工作目录找，每层目录的AGENTS.md都加载
3. 越靠近当前工作目录的，越靠后拼进prompt——模型最后看到的，是离当前工作最近的规矩，就近覆盖

为什么要这个顺序？因为全局的是通用规矩，子目录的是这个目录特有的规矩，比如src目录下的AGENTS.md可能会说"这个目录下的代码都用TypeScript严格模式"，优先级比根目录的高。

另外Pi还兼容CLAUDE.md，毕竟很多项目已经写了Claude的说明文件，没必要让大家重写一遍。

---

## 第二类：Skills——只给索引，正文自己读

Skill是特定任务的操作手册，比如代码评审、bug排查，不是每轮都用，所以绝对不能把全文塞system prompt。

正确的做法是：system prompt里只放一个skill索引，每个skill只写三样东西：
- 名字
- 一句话描述这个skill是干嘛的
- 这个skill的SKILL.md文件路径

模型看到索引，判断当前任务适合用哪个skill，自己用read工具把对应的SKILL.md读进来用。就像书单只告诉你书名和位置，真要看书自己去书架拿，不用把所有书都塞书包里背着。

这里还有个很重要的细节：**如果这一轮没有给模型read工具，那就干脆连skill索引都不要给**。
为什么？因为索引里全是文件路径，模型连read工具都没有，看得到路径读不了文件，给它索引纯纯浪费token，没有任何意义。就像学生连图书馆都进不去，你给他书单有什么用？

另外还有个标记：如果skill的frontmatter里写了`disable-model-invocation: true`，那这个skill不会出现在给模型的索引里，但用户还是可以显式调用它——相当于内部参考资料，不主动推荐，但你要我还是给你。

---

## 第三类：Prompt Templates——用户调用了才展开

Prompt模板是用户输入斜杠命令的时候才用的，比如用户敲`/fix README.md`，才需要把fix模板展开，把参数替换进去。平时根本不进system prompt，模型连有这个模板都不需要知道。

模板支持三个占位符：
- `$1`、`$2`...：第n个参数
- `$@`或者`$ARGUMENTS`：所有参数拼起来

这里有个非常重要的安全设计：**占位符替换只扫一遍，绝对不递归替换**。
什么意思？就是替换完一次就结束，替换结果里如果还有$1、$ARGUMENTS这些占位符，就原样保留，不会再替换第二次。

为什么要这么设计？防止模板注入。假设模板是"修复$1，然后$ARGUMENTS"，用户故意传个参数"$ARGUMENTS"，如果递归替换，这个参数里的$ARGUMENTS会被再次展开，用户输入就变成了能控制模板的代码，相当于注入攻击。只扫一遍的话，参数里的占位符就是普通字符串，不会被解析，从根源上堵死了这个漏洞。

记住：用户输入永远是数据，不是模板的一部分，不能让用户输入能影响模板结构。

---

## 资源和harness的关系

注意：我们这节课只讲资源怎么整理、怎么进system prompt，**不做文件扫描、不做信任判断、不做动态加载**。
- 哪些AGENTS.md要加载、哪些skill存在，是外层应用的事（后面s11信任、s12包管理、s09扩展会讲）
- harness每轮只拿已经整理好的资源快照，按规则拼进system prompt就行

机制和策略分开：harness提供"怎么把资源放进请求"的机制，"加载哪些资源"是外层的策略，内核不掺和。

---

## 先跑起来看看

```sh
npm run session:s08
```

输出长这样：
```text
Session: demo-session
Context files: AGENTS.md, AGENTS.md
Skills in resources: review
Prompt templates: fix
System prompt has skills: true
Template expansion: Fix README.md and explain the verification.
```

注意看：
- 两个AGENTS.md不是重复，一个是全局的一个是项目的，按顺序拼进prompt
- skill确实在resources里，而且因为这一轮有read工具，所以system prompt里有skill索引
- 最后一行是模板展开结果，$1换成了README.md，$ARGUMENTS换成了后面的"and explain the verification"

---

## 动手试一试

### 实验1：验证单趟替换防注入
把fix模板的内容改成"Fix $1 then $ARGUMENTS."，调用的时候传参数["$ARGUMENTS", "$2"]。
你会看到展开结果是"Fix $ARGUMENTS then $ARGUMENTS $2."——参数里的占位符原样保留，没有被二次替换。
如果你手动把结果再当模板替换一次，就会看到内容又变了，这就是递归替换的注入风险。

### 实验2：加一层目录的AGENTS.md
在父目录加一个AGENTS.md，再跑一次。
你会看到context files变成三个，顺序是全局→父目录→当前目录，越靠近cwd的越靠后。

### 实验3：拿走read工具
把activeToolNames里的read去掉，只留bash。
你会发现skill还在resources里，但system prompt里已经没有skill索引了——没有read工具，给了书单也没用。

跑完三个实验，你应该能回答下面检查点的问题。改完可以用`npm run test:s08`确认没破坏行为约定。

---

## 本节课打下的地基

s08我们把项目上下文资源的加载规则理清楚了，三类资源各有各的进请求方式：

| 这节课立的约定 | 后面会怎么用 |
|----------------|--------------|
| AGENTS.md全文进system prompt，从全局到cwd逐层加载，近的优先 | 项目规范、目录特殊约定都靠这个传递给模型 |
| skill只给索引（名、描述、路径），模型用read现读，无read则不给索引 | 大量skill也不会撑爆上下文，按需加载 |
| prompt template不进system prompt，用户调用才单趟替换展开 | 斜杠命令、常用模板靠这个实现，天然防注入 |
| 资源发现是外层策略，harness只拿整理好的快照 | 扩展、包管理、信任判断都可以在外层动态提供资源 |

**本课引入的核心原语**：`ContextResources` / `loadContextResources` / `buildContextSystemPrompt` / `formatPromptTemplateInvocation`

---

## 检查点

学完这节课，你应该能脱口回答这几个问题：
- 为什么skill不能全文塞进system prompt？没有read工具的时候为什么连索引都不给？
- 模板替换为什么只扫一遍不递归？递归替换有什么风险？
- AGENTS.md的加载顺序是什么？为什么越靠近cwd的越靠后？

---

## 本节课小结

这节课我们其实只讲了一个核心道理：
> 上下文窗口是最贵的资源，好钢用在刀刃上——不同的资源在不同的时机以不同的形式给模型，不要一股脑全塞进去。

看起来只是定了三个加载规则，实际上这是Pi能支持大项目、多扩展而不爆上下文的关键设计。现在资源加载的规则有了，但这些资源从哪来？我们现在都是手动传路径，第三方扩展想注册自己的工具、命令、资源，怎么插进来？下节课我们就讲扩展运行时，把扩展能力开放出来。

进入下一课：[s09 扩展运行时 —— 内核只留插口，功能全靠扩展](../s09_extension_runtime/README.zh.md)
