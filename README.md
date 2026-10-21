# dsh-safely-quit

给 DSH 一个**体面的关闭入口**：在跑的会话各自跑完**当前一步**后停止并登记，全部停稳后关闭宿主；
下次启动按清单提示被打断的会话，点一下接续（**只跑这一轮**：不发用户消息、不自动续跑、不设目标）。

> **当前形态：关闭编排 + 客户端两个半区都已落地 —— 离线 1022 条判据全绿（宿主 396 / 客户端 626），
> 「关闭 → 记录 → 重启 → 卡片 → 点继续 → 会话接着跑」整条链已在隔离实例里端到端走通。**
> 关：点坞里的「关闭 DSH」→（5 秒内再点一次确认）→ 开始收尾；收尾中**同一行就地变状态** ——
> 这一行的键同时就是「立即停止」，键上就是**一段拼好的文字**「立即停止（已等 S 秒）」
> （"还有几个在跑"已由右侧角标给出；**键上只有一段文字**，"附注"这个概念整块删掉，
> 失败原因与「可以关掉这个页面了」住悬停说明）。
> 那颗键是一台**显示状态机**（五档 = 关闭 DSH / 再点一次确认关闭 / 立即停止（已等 S 秒）/ DSH 已关闭 / 重试；
> 真源是客户端产物里的状态表与转移表，规格见 §1.8），组件不自己判阶段。
> **行是 `<div>`，0 个 `<button>`** —— 项目硬约束「按钮不得相互嵌套」：
> GUIFrame 已给每个坞条目套了 `<button>`，我们的行再放按钮就成了嵌套按钮）。
> 开：进 DSH 后读一次上一轮的清单 ⇒ **有就在右上角弹一张独立浮层卡片**，每行一颗「继续」、卡底一颗「一键继续」；
> 「继续」= 宿主投一条**插件来源**的续行消息并唤醒驱动（`followup` + `flush`，只这一轮）
> ⇒ **接续中断的 agent loop，不发用户消息、也不给会话设目标**；**没有"打开"这一档**（2026-10-05 已否掉）；
> 坞入口右侧挂**角标 = 循环中会话数**（＝"如果现在关闭，需要暂停的总会话数"：会话列表里在跑的那些，
> 平台经会话状态帧实时推着走 ⇒ 面板关着也在更新；0 个在跑就不画角标），
> **卡片不进坞按钮面板**，也没有任何"打开面板兜底"。
> `dryRun` 演练只在命令行与离线判据里用，界面上不暴露。
> 真源文档在本仓库 `docs/`：`docs/设计规格.md`（关闭时序 / 清单契约 / 验收口径）、
> `docs/复验与修正-关闭续跑论证.md`（平台那套关闭流程实读结论）、
> `docs/DSH关闭续跑插件可行性论证.md`（第一版可行性研判；其中两条结论已被上面的复验推翻）。

## 宿主侧接口（人类入口，**不注册任何模型可见工具**）

前缀 `/api/dsh-safely-quit`，两个门：只服务回环连接 + 改状态的请求必须同源。

**前缀的唯一真源是本包宿主入口里的那个常量**：客户端半与开发工作区的真机装置都必须与它一致，
两道机检看住这条线（形态门比对客户端产物里的前缀；客户端判据直接读宿主模块比对），谁单独改一处都会变红。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 收尾进度（阶段、还要等哪些会话、被丢弃的输入条数、已等待毫秒数、**关机拓展进度 `hooks`**） |
| POST | `/close` | 开始收尾。真关闭要 `{"confirm":true}`；**演练用 `{"dryRun":true}`**（只快照落盘，不下停止令、不关宿主、不跑关机拓展）。界面可附带上报**这一刻开着哪些会话**：`{"openSessionIds":["…"],"openSource":"mainView"}` —— **只作诊断**（进记录的 `scope`），不决定清单内容 |
| POST | `/force` | 用户点「立即停止」：对仍未静默的会话发取消 |
| GET | `/last-pending` | **开机读数**：能提示就返回待续记录；四类不能提示的（坏 / 非计划内 / 空 / 过时）**当场回收**并在回执里说明原因 |
| GET | `/pending` | **只读诊断**：记录原样 + `interrupted` + `deliveredByThisRun`（**不回收**） |
| POST | `/pending/claim` | 认领（卡片站稳后由界面调）：记录写上"本次运行交付过" ⇒ 下一次开机不再提示 |
| POST | `/pending/clear` | 清空（**用户关掉面板**时由界面调）：删掉记录文件 |
| POST | `/continue` | **「继续」的唯一动作**：对清单里的会话逐条恢复（冷会话在这一步被拉起来）并投一条**插件来源**的续行消息，然后等落盘。回执逐会话给结论：`attached` / `already` / `missing` / `failed`（服务缺席时整条回 503） |
| POST | `/report` | **客户端自报通道**：把浏览器侧实际装配结果（继续路径、浮层报错、守望账、接续面读数）写进宿主，排障不必让人口述浏览器 |
| GET | `/report` | 读回最近一次客户端自报（配合 `~/.dsh/storages/safely-quit/client-report.json`） |

收尾顺序：快照**被这次关闭打断的 agent loop**（在跑的，含子代理）→ 把在跑的放进停止集 → **等它们各自跑完当前 step**（在 step 边界喂入拒绝决策）
→ 全停后跑**关机拓展**（其它插件登记的动作）→ 落清单与标记 → **交棒给平台退出**
（优先请平台的关停控制器接管；拿不到就**在进程内派发关闭信号事件**；两条都不接住才有上限兜底自退）。

⚠ **绝不用"把终止信号发给本进程"当交棒**：Windows 上那是进程级强杀，
进程当场死、平台注册的处理器不跑 ⇒ **持久化落盘与其它插件挂在拆卸上的收尾全被静默跳过**。
真机读数（2026-10-12）：强杀那跑 `exit=1`、监听从未被回调；走平台关停控制器那跑 **285ms 自行退出**、
dispose 真的跑完。

落地物：`~/.dsh/storages/safely-quit/pending-resume.json`（待续记录）与 `intentional-shutdown.json`（计划内关闭标记，用来和崩溃区分）。

### 待续记录的生死（2026-10-07 定稿）

**记录存在 ⟺ 有一份"还没交给人"的待续清单。**

- **只有用本插件的按钮关闭**才会写它（关终端 / Ctrl+C / 断电 / 平台自己的优雅关闭都不写）；
- 卡片**站稳**（连续两拍都在屏幕上）⇒ 界面认领；之后**下一次开机**读到"已交付"⇒ 判定过时、当场删掉
  —— 这就是"不是用插件关的 DSH，下次开机不该再看到过时记录"的落点（同一次运行里刷新页面仍会显示）；
- **用户关掉面板**（点外 / Esc / 面板 × 任一）⇒ 界面清空记录
  （所以卡片上**没有「不用了」那颗键**：关掉面板本身就是那个意思）。⚠ 面板 × 是 React 的 onClick，
  摘层发生在点击之后的 React 提交里 ⇒ 交互之后要**延迟复核一次**（120ms）才能判成"用户关的"，
  否则守望会把刚关掉的卡片又打开（真机：点 4 次 ×，卡片 4 次自己回来）；重开之后还有 3 拍宽限
  （层不会立刻出现，不宽限就每拍重开一次、额度瞬间烧光）；
- 记录里**一个会话都没有** ⇒ 开机不弹面板，文件也在开机读取时回收；
- **清单里的会话 = 被这次关闭打断的 agent loop**（设计口径：「我们只继续因为关闭中断的 agent loop」）：
  只有**关闭那一刻在跑**的进清单；**界面开着但当时空闲的不进、也不继续**（没有被打断的 loop）。
  子代理在跑也算 —— 但记的是**它所属的顶层会话**（子代理会话平台拒绝独立 resume、跑完还会被回收，
  列出来就是死链）；等停集合同样覆盖子代理。**本次运行里翻到过、关闭时并没在跑的会话一律不记** ——
  注册表里活着的会话是"这次运行里打开过的全部"（切走不摘除），拿它当范围就会把几天前的会话列进卡片
  （真机事故：界面 0 个会话、卡片列了 16 行）。界面"开着哪些会话"仍随 `/close` 上报，但**只进 `scope`
  作诊断**（回答"我开着的那个为什么没列"）；
- **卡片标题的条数恒等于行数**：新记录里每行都是被打断的 ⇒「上次关闭时有 N 个会话在跑」；读到旧记录
  （把开着的也写进了清单）时才是「N 个会话（M 个在跑）」—— 曾经标题报"2 个在跑"而卡片列了 23 行；
- 关闭编排**中途失败**时，这一趟写下的记录会被标成"关闭失败"：它并不代表真关过机，
  下一次开机按"非计划内"当场回收，不误导用户。

## 下一次开机做什么（启动半区）

口径（2026-10-05 修订，2026-10-18 补两条）：**接着跑，不是"打开窗口"** —— 读清单、弹卡片、一键继续；
卡片列**清单里的全部会话**（都是被这次关闭打断的）。接续 = 宿主对那个会话
**投一条插件来源的续行消息并唤醒驱动**（`resolveAgent` → `agent.followup` → `sessions.flush`），
**只跑这一轮**：不发用户消息（`source.kind='safely-quit'`，界面画成"非人触发的本轮"）、
**不建目标**（目标一武装就会在 agent 空闲时自己开下一轮，那是无人值守的自动续跑）。

- 开机读一次待续记录（有 2 秒上限：读不到就照常注册入口，**按钮不许迟到**）；
- 有清单（清单里有会话 = 有被打断的 loop）⇒ **在右上角弹一张独立浮层卡片**（走 GUIFrame 的公开浮层面）；
  卡片**只存在这一处**，坞按钮面板里不放卡片、也没有"打开面板"兜底；
  （坞入口那个角标与卡片无关：它是**循环中会话数**的实时读数，见上一节）
- **弹出后要核对它真的落地**（查那张浮层的层标记在不在 DOM、与视口相不相交）：
  没落地或落在视野外 ⇒ **如实记"没有继续路径" + 浮层报错**（写调试面、并把自报发给宿主），
  **不悄悄换成别的东西** —— "接口返回句柄、界面没见到卡片"就是靠这条机检暴露的；
  落点按浮层根的真实尺寸量（量不到退回窗口），并夹进容器 —— 任何窗口尺寸下都在视野里；
- 点键 → 先把该会话切到当前会话（界面切到它，人看着它跑），再 `POST /continue` 请宿主接续；
  宿主逐条给结论：`attached`（已接上）/ `already`（本来就在跑）/ `missing`（这个会话不在了）/
  `failed`（没接上，键变重试）。客户端自己**不构造任何消息**（它能发的只有用户消息，那是冒充用户）。
  卡底那颗总键「一键继续」把清单里的会话**串行**接一遍，完事回一行「已接上 N 个…」；
  接口/服务缺席或 id 已不在列表里 ⇒ 键就地变成「没接上，再点一次」，**绝不抛**（客户端抛错会打死整页）；
- **平台接缝（升级后必须复验的两处，都踩过）**：
  ① **切会话**走 `uiWorkspace.openSession(sessionId)` —— `sessions` 面**已经不再有 `open`**
  （它的自述是"目录与引用分配器，视图选择不归 Controller 管"），旧的 `sessions.open` 只作退路；
  ② `uiWorkspace` 是**受 inject 守卫**的服务：不在自己的 fiber 上声明名字就取，
  `ctx.get` 会当场抛 `cannot get property "…" without inject` ⇒ 只能用**运行时注入**拿到
  （声明式注入在服务缺席时会悬置 fiber、打死整页，这条路本包不走）。
  宿主侧那条接续路同理：`sessionController` / `sessions` 单独一道注入，缺席时只有 `/continue` 回 503，
  **关闭入口照常可用**（并进同一道注入的话，服务一缺席整个路由都挂不上）。
- 卡片开出来之后进**守望循环**（1 秒一拍）：站稳两拍 ⇒ 认领；之后一旦发现它没了 ——
  **刚有用户交互**（点外 / Esc / 面板 ×）就不抢回来，改为清空记录并收手；
  **没人动过**却被平台清栈 ⇒ 补开（额度 5 次），用完收手（记录留着不动）。
  一次都没弹出来时走**补弹档**（1 秒一次、最长 60 秒）。
  ⇒ 「不用了」这颗键因此被删掉，浏览器里那份"看过了"的本地标记也整条删除。

**收尾态住在模块里，不住在组件里**（这一条是被真机 bug 教出来的）：GUIFrame 每次打开坞面板都**现造**内容节点，
面板一关组件就卸载 —— 状态若住在组件里，收尾中把面板关掉再打开就会回到「关闭 DSH」，
而且组件里的轮询会跟着一起死。现在：状态机 + 轮询 + 确认态全在一个模块级 store 里，
组件只订阅渲染；组件每次挂载还会向宿主对齐一次 ⇒ **收尾中刷新页面 / 热换模块也不会丢状态**。

## 排障

浏览器控制台里看一眼就知道这一半到底加载没加载、读到了什么：

```js
window.__safelyQuit   // { version, loadedAt, pending:{closedAt,total,running}|null, badge, runningNow, watchingRunning, dockRegistered, resumePath, overlayError, overlayProbe, overlayAttempts, overlayRectHeight, overlayResized, resumeWatch, lastError }
// badge = 坞角标此刻显示的值（= runningNow，0 ⇒ null 即没画）；watchingRunning=false 说明没拿到会话列表（角标就不实时了）
// resumeWatch = 守望账（认领了没 / 是不是用户关的 / 重开了几次）—— 记录生死的现场读数
// injectFaces = 那面受守卫的服务拿到了没（{uiWorkspace} ∈ pending/ok/missing/no-openSession:类型）——
//   "服务没来"与"名字变了"就靠这条分；pending = 注入回调压根没触发
// continueFaces / continueFailedAt / continueFailure = 点「继续」失败时的现场：
//   各面在不在（sessions/sessions.open / workspace/workspace.openSession / fetch）、
//   卡在哪一步（no-fetch / host）、宿主回的**原始回执**
```

开机还会打一行 `[dsh-safely-quit] 客户端半区已加载：…`（诊断只进控制台，绝不进界面）。
宿主侧同样好读：`GET /api/dsh-safely-quit/pending`（记录原样 + 是不是本次已认领）、
`GET /api/dsh-safely-quit/state`（收尾进度 + 关机拓展进度 + **`lastPending`= 最近一次开机读数的裁决**：
记录被回收后盘上就没证据了，"为什么这次没弹卡片"的答案只剩这一处 —— `why` 取 `stale`/`empty`/
`not-intentional`/`unreadable`），每条动作的开始/结束/失败还会写一行 stderr。

## 它长在哪

不自己占侧边栏座位，而是把按钮**交给 GUIFrame 的入口坞面板**（那个收纳别的插件按钮的面板）。

**单向依赖 —— 只使用 GUIFrame 的服务，不改它的代码**：

- 本包不引入 / 不读取 / 不修改 `dsh-gui-frame` 的任何模块；
- 只用运行时服务注入：等 `gui-frame` 服务就位再注册入口与组件；
- GUIFrame 不在场 ⇒ 本插件不注册按钮，页面照常（不悬置、不抛错、不占座位）；
- 卸下本插件 ⇒ 入口随 fiber 撤掉，GUIFrame 侧不留残留。

⚠ **例外要说清**：除了服务面，客户端还按 5 个**非契约** DOM 属性名去查/量 DOM（收在一张常量表里）。
那些名字不是版本化的公开契约，GUIFrame 一改就会静默降级（卡片不出现 / 角标不动 / 卡片高度不收敛）；
**升级 GUIFrame 后必须复验**。彻底解要 GUIFrame 侧给公开读数，不是本包能单方面做的。

## 包结构

| 路径 | 说明 |
| --- | --- |
| `lib/index.js` | 宿主半区：关闭编排（快照 → 一步后停 → 等全停 → **关机拓展** → 落清单+标记 → **交棒退出**）+ 待续记录生死 + HTTP 接口 + 对外服务装配 |
| `lib/shutdown-hooks.js` | 宿主半区：**关机拓展**的注册表与执行器（排序 / 限时 / 隔离失败 / 命令式动作；零依赖、spawn 可注入 ⇒ 可离线判真）；两档预算与数值兜底的**唯一真源** |
| `lib/client.js` | 浏览器半区（**手写产物，本包无构建步骤**）：往坞里注册一个入口（关闭行）+ 开机那张续跑浮层卡片 + 守望（认领 / 关掉面板即清空） |
| `cordis.patch.yml` | bundle 层补丁：`- insert: { id: safely-quit, name: dsh-safely-quit }` |
| `package.json` | 清单：bundle 补丁 + 客户端平台声明；**版本号的唯一真源**（客户端不自带版本字面量，读宿主下发的值） |
| `tools/check-client.mjs` | 形态门：经典脚本可加载、模块 id、**接缝单一真源**（路由前缀两半一致 / 零版本字面量 / 网络出口一处 / 预算不是字面量 / 装置前缀一致） |

## 对外服务：关机拓展（`safelyQuit`）

别的插件要「DSH 关闭时执行某个动作（常常是一条命令）」时，登记到本插件，由它统一排序、限时、隔离失败地执行。
平台本身**没有**这类服务；⚠ 注意框架那类"拆卸事件"在本平台**不是真实事件**（写了不报错、永不触发）——
清理只能登记成"随组件一起撤下的收尾动作"。

```js
ctx.inject(['safelyQuit'], (sqCtx) => {
  const sq = sqCtx['safelyQuit'];
  // ① 函数式（收尾自己的东西）
  sqCtx.effect(() => sq.onShutdown(async () => { /* … */ },
    { id: 'dsh-xxx/stop-watcher', label: '停掉守卫进程', order: 10, timeoutMs: 3000 }));
  // ② 命令式（默认**不经 shell**：参数数组，与生态惯例一致；要 shell 就 shell:true）
  sqCtx.effect(() => sq.onShutdown(
    { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', 'restore.ps1'], cwd: 'D:/x' },
    { id: 'dsh-xxx/restore', order: 5 }));
});
```

- 成员：`onShutdown(action, opts) → 摘除器`、`off(id)`、`list()`、`lastRun()`、`budgets()`、`runNow()`（手动跑一趟，排障用）。
- 时机：**主动关闭**在"会话全停之后、交棒退出之前"（预算 30s / 单条缺省 5s）；**被动关闭**（Ctrl+C / 外部信号 /
  关控制台）借平台关闭流程的 5 秒 grace 补跑还没跑过的（预算 2.5s）；**热重载 / 卸载不跑**（只有信号标记放行）。
- 一条动作**一次进程里至多执行一次**；失败（抛错 / 超时 / 非 0 退出码）只记在它自己头上，后面的照跑。
- `config`（都可省）：`hooks: { budgetMs: 30000, timeoutMs: 5000, disposeBudgetMs: 2500 }`。
  **两档预算只在内核里定义一份**（宿主半引用它），形态门钉住"不许再写一个字面量数字"。

名字的三层区分（别混）：

- loader 行 id `safely-quit` ← `cordis.patch.yml` 的 `- id:`
- loader 行 name / 浏览器半模块 id `dsh-safely-quit` ← `cordis.patch.yml` 的 `name:`，**同时**是
  `window.__ModuleLoader__.load({ id })` 用的那个 id
- cordis 运行时名 `safely-quit` ← 宿主入口里的 `name`

## 挂载（两条通道二选一，同时用会让同一 id 被插两次 ⇒ 启动失败）

**A · dev 通道（免重启，看效果用这条）** —— 把 insert 行写进 profile **用户层**
`~/.dsh/profiles/web/cordis.patch.yml`（该 profile 是 `patchReload: live`，改完即时重载）：

```yaml
- insert:
    - id: safely-quit
      name: 'dsh-safely-quit'
```

**B · bundle 通道（正式形态，需重启 dsh web）** —— 把包名 `dsh-safely-quit` 加进 profile 的
`package.json` 的 `dsh.profile.bundles`，由本包自己的 `cordis.patch.yml` 贡献 insert 行。

两条路都需要 profile 的 `node_modules/dsh-safely-quit` 能解析到本包（`link:` 或目录 junction）。

**任何 profile 改动后必须复算**（只读，市场自己的尺子）：

```bash
node --input-type=module -e "import('file:///<DSH_HOME>/profiles/web/node_modules/dshmarket/lib/check.js').then(async m => console.log(JSON.stringify((await m.analyzeProfile('<DSH_HOME>/profiles/web')).summary)))"
```

要求 `summary.ok === true` 且 `summary.errors === []`。

## 卸载

- dev 通道：从 profile 用户层删掉那段 `- insert:`；
- bundle 通道：从 `dsh.profile.bundles` 删掉包名；
- 再删 `~/.dsh/profiles/web/node_modules/dsh-safely-quit` 这个 junction。

## 为什么这样接线

三条都是从平台实测来的约束，写在代码文件头里（改动前先读）：

1. **不用声明式客户端 inject**：客户端缺服务会让 fiber 悬置、外壳直接抛错**打死整页**；
   改用运行时注入，缺席即静默不注册。
2. **客户端入口绝不抛错**：抛错会让 loader 拒绝冒泡、应用挂载永不执行 ⇒ 整页停在失败卡片。
3. **宿主半区入口恒返回 `undefined`**：返回值会被框架当成 effect 解释，返回普通对象会让
   `dsh web` 起不来。

## 判据与形态门（改完先跑这三条）

```bash
cd dsh-safely-quit
node test/host.test.mjs        # 宿主 396 条离线判据
node test/client.test.mjs      # 客户端 626 条离线判据（真加载产物 + 真调用组件）
node tools/check-client.mjs    # 形态门 + 接缝单一真源（exit 0 = 通过）
```

判据只增不减是这条链的硬约束：**改动里不许删断言、不许把断言改成恒真、不许删用例名、不许降阈值**。
真机装置在开发工作区的 `tools/`（**不在本仓库内**；隔离实例）：

```bash
# 真机装置（隔离实例 ×2 + headless 浏览器）由开发工作区维护，不在本仓库分发：
#   record-lifecycle.mjs —— 待续记录生死的真机读数
#   dock-shot.mjs        —— 坞内几何对齐 + 卡片存活时间线
```

**「继续」那条链的真机复验（在隔离实例里整条走过；依赖 DSH 沙箱工具，外部读者可跳过）**：

1. 起一个专属实例（`sandbox start`，`deps=link`）：**真凭据要在宿主起来之后再拷一次**
   （拷到 `$env:DSH_HOME\.credentials.yaml`）—— 起服那一下宿主会把它改写成没有 `refs` 的版本，
   拷完不用重启：凭据服务有 chokidar 热重载（`watch` 默认开）；
2. 造一个"正在跑"的会话（界面里发一条长文请求即可），盘上留一份待续记录：
   `POST /close {"dryRun":true}` 验"宿主当场把 `statusAtClose` 记成 running"；
   要验**整条链**就用真关闭 `POST /close {"confirm":true}`（宿主会自己退出，记录与标记一起落盘）；
3. 重开实例 → 界面右上角应浮出卡片（层标记 `[data-guif-overlay-layer="dsh-safely-quit/resume"]`）；
4. 点「继续」→ 键应显示「已接上」，**轮次计数 +1**（那一轮由插件投的消息唤醒），
   会话里出现一条**"非人触发的本轮"**通知（来源标成插件、可展开看正文），**不出现任何用户消息**，
   **也不出现目标栏**（接续不建目标）；
5. ⚠ 真关闭会跑关机拓展，而 `dsh-sandbox/stop-instances` 是**按"谁在跑"枚举整个实例根**的：
   同机别的窗口正在用的实例会被一起停掉。要隔离就给这个实例的宿主换一个**只含本实例的影子实例根**——
   建 `shadow-sq\sq` 指向该实例目录的 junction，用 `DSH_SANDBOX_DATA=<影子根>` 起守护进程：
   Node 把 junction 当符号链接（`isDirectory()` 为 false），钩子的 `list()` 自然数不到它，
   关闭时只会看到一句「没有运行中的沙箱实例，无需处理」，别的窗口毫发无损。

**清单范围（只记"被打断的 agent loop"）怎么单独验**——不用碰界面：

```bash
# A. 没有任何会话在跑（哪怕界面开着会话）：记录必须是空的（开机按 empty 回收、不弹卡片）
curl -X POST -H "content-type: application/json" -H "sec-fetch-site: same-origin" \
     -d '{"dryRun":true,"openSessionIds":["<随便一个会话id>"],"openSource":"mainView"}' http://127.0.0.1:<端口>/api/dsh-safely-quit/close
curl -s http://127.0.0.1:<端口>/api/dsh-safely-quit/pending
#   ⇒ sessions: []；scope = {open:1, source:"mainView", running:0, recorded:0}
#   （open 只是诊断：界面开着 1 个，但没在跑 ⇒ 不记）

# B. 有会话在跑（界面里发一条长文请求）：同一份记录里只出现"在跑"的那几个，
#    每行 statusAtClose 必须是 running，stop.kind 只会是 step-boundary / delegated。
```

真界面上验"界面到底报了什么"：关一次之后读 `GET /report`（或盘上的 `client-report.json`）里的
`openAtClose`，以及核对 `/state` 的 `scope`——把"列多了 / 该列的没列"两类错分开。
