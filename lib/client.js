/**
 * dsh-safely-quit —— 浏览器半（坞面板入口：关闭 DSH）。
 *
 * 本文件是**手写产物**（本包无构建步骤，`lib/` 即源，与同类手写客户端插件同形态）。
 *
 * ═══ 它做什么 ═══
 *   在 GUIFrame 的入口坞里放一个按钮，它是一台**显示状态机**（五态，真源 = `QUIT_STATES` +
 *   `QUIT_TRANSITIONS`，本文下方有专节）：
 *     关闭 DSH → 再点一次确认关闭 → 立即停止（已等 N 秒）→ DSH 已关闭
 *   任一步请求失败 ⇒ 「重试」。
 *   点一下（二次确认）就开始收尾：宿主让在跑的会话各自跑完**当前一步**后停下、逐个登记，
 *   全部停稳后才关闭宿主；宿主真的退出后轮询会断 ⇒ 界面转成「DSH 已关闭」。
 *   ⚠ 坞那一行**只有一行、键上只有一段文字**：
 *     "已等多久"这种必要补充直接拼进那段文字；其余补充（失败原因、"可以关掉页面了"）进悬停说明。
 *     （"还有几个会话在跑"由右侧角标给出，不在键上重复）。
 *
 *   全部网络行为都打宿主自己的路由（`lib/index.js`），清单见包 README 的接口表：
 *     /state、/close、/force、/continue、/last-pending、/pending、/pending/claim、/pending/clear、/report（GET/POST）。
 *   ⚠ 这些请求只经本文件下方的两条工具函数（`getJson` / `postJson`）发出，端点前缀只有 `ENDPOINT`
 *     一处定义 —— 别在各处理器里自己拼 URL（那正是"同一事实多处定义"的来源）。
 *
 *   **真关闭时随请求上报"界面上开着哪些会话"**（`openSessionIds` / `openSource`）—— **只作诊断**：
 *   待续清单只收**被这次关闭打断的 agent loop**（宿主那一侧的判据），"开着但没在跑"的会话不进卡片。
 *   这份读数进记录的 `scope`，专门回答"我开着的那个为什么没列"（答：它当时没在跑）。
 *   **"开着"= 主视图持有这个会话**（`readOpenSessionIds`），不是"这次运行里翻到过"。
 *   读不出来就如实不带这两个字段。
 *
 * ═══ 它**不**做什么 ═══
 *   · 不自动强杀：卡住的会话只会一直被等，必须由人点「立即停止」才取消。
 *   · 不暴露演练入口：`{"dryRun":true}` 只留给命令行与离线判据（见包 README）。
 *   · **自带任何版本号**：版本的真源是包元数据（宿主半读它、经 `/state` 的 `version` 发下来），
 *     客户端只**读回来**用。两处各写一份字面量就会漂移，而漂移谁也不报错。
 *
 * ═══ 单向依赖（本项目硬约束：只使用 GUIFrame 的服务，绝不改它的代码）═══
 *   本文件不 import / 不读取 / 不修改 GUIFrame 的任何模块，只经**运行时服务**对话：
 *     `ctx.inject(['gui-frame'], cb)` 等 `gui-frame` 服务就位 → `service.register(entry, Component)`。
 *   - **不用**声明式 inject（package.json 的 `dsh.client.inject`）：客户端缺服务会让 fiber 悬置、
 *     外壳 `assertEntriesActive` 直接抛错打死整页（平台实测：声明式 inject 的服务缺席即抛）。
 *   - 服务始终不出现 ⇒ 本插件只是不注册按钮，页面照常。
 *   - 卸下本插件 ⇒ 入口随 fiber 一起撤掉，GUIFrame 侧不留残留。
 *   ⚠ **例外要说清**：除了服务面，本文件还按 `GUI_DOM` 里那 5 个 DOM 属性名去查/量 DOM。
 *     那些名字**不是版本化的公开契约**，GUIFrame 一改就会静默降级（卡片不出现 / 角标不动 /
 *     卡片高度不收敛）；升级 GUIFrame 后必须复验。彻底解要 GUIFrame 侧给公开读数，不是本包能单方面做的。
 *
 * ═══ 坞注册契约（真源：GUIFrame `src/client/service/entries.mjs` 的 normalizeEntry）═══
 *   entry = { id, label, order, group, kind, source, icon, badge }
 *   · `id` 必须带命名空间前缀（ENTRY_ID_PATTERN），且不得占用保留 key（`conversation`）；
 *   · `label` 可为 string 或 thunk；`order` 必须是整数；`kind` 取 `panel` / `action`；
 *   · `kind:'action'` ⇒ 进坞面板，坞**原样渲染插件自己的组件**；
 *   · `source` = 插件自报包名；`icon` 传**组件**（坞用 `el(icon, {size:16})` 渲染它，没给就不画）；
 *   · `register()` 返回 disposer。
 *
 * ═══ 客户端硬纪律（GUIFrame entry.mjs 的实测出处）═══
 *   客户端 `apply` 抛错 ⇒ loader.create 拒绝冒泡 ⇒ 整页停在失败卡片。
 *   所以本文件**全链路 try/catch、绝不 rethrow**；网络失败只落到界面上的错误态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-safely-quit',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const exports = {};

    /** 坞入口 id：带命名空间前缀，不占保留 key。 */
    const ENTRY_ID = 'dsh-safely-quit/quit';
    /** 插件自报包名（坞的 stale 判定用）。 */
    const SOURCE = 'dsh-safely-quit';
    /** 坞内排序：GUIFrame 自己的 demo action 是 20，本入口排在它后面。 */
    const ENTRY_ORDER = 30;
    const CSS_ID = 'dsh-safely-quit/styles';
    /**
     * 宿主路由前缀 —— **必须与 `lib/index.js` 的 `ROUTE_PATH` 逐字一致**。
     * 这条线有两道机检看着：`tools/check-client.mjs` 比对产物里的字面量，
     * `test/client.test.mjs` 直接 import 宿主模块比对常量（两半各自改一处就会变红）。
     */
    const ENDPOINT = '/api/dsh-safely-quit';
    /**
     * ⚠ **GUIFrame 内部 DOM 契约**（不是服务面 —— 这几个名字没有版本化承诺）。
     *
     * 这些属性名是 GUIFrame 自己画坞行 / 浮层时用的标记，本插件"按标记读数"：找那一行（事件归属）、
     * 量浮层层（卡片在不在、盒子多大）、量面板内容区（卡片要多高）。它们**不是公开 API**：
     * GUIFrame 一改，本插件会**静默降级**（卡片不出现 / 角标不动 / 卡片高度不收敛）。
     *
     * 因此三条纪律：① 名字只在这张表里写一遍（不许散落各处）；② 升级 GUIFrame 后必须复验真机；
     * ③ 每个用到它的降级点都要在自报里留下可读字段（`overlayError` / `panelBody` 之类），别只落一个 null。
     */
    const GUI_DOM = Object.freeze({
      /** 坞里"一行"的标记：本插件的键挂在这样一行里（点行也算点键）。 */
      dockAction: 'data-guif-dock-action',
      /** 浮层宿主根（用来区分"外壳还没装配"与"层被摘掉"）。 */
      overlayRoot: 'data-guif-overlay-root',
      /** 浮层层本身（卡片在不在场，看它）。 */
      overlayLayer: 'data-guif-overlay-layer',
      /** 浮层面板的内容区（量卡片"内容装不装得下"）。 */
      panelBody: 'data-guif-panel-body',
      /** ⚠ 只出现在样式表注释里：本插件不查它（角标走 `setBadge` 切片面），留着是为了注释与坞对得上。 */
      badge: 'data-guif-badge',
    });
    /** 按钮里那颗图标的显示尺寸（坞的图标槽按 16 传，两处视觉重量对齐）。 */
    const ICON_SIZE = 16;
    /** 二次确认的有效期：超时自己退回未确认态，避免"半按着"的按钮留在面板上。 */
    const CONFIRM_MS = 5000;
    /** 收尾期间的轮询间隔。 */
    const POLL_MS = 1000;
    /** 轮询连续失败几次就判定「宿主已经关了」（一次抖动不算）。 */
    const OFFLINE_STRIKES = 3;
    /**
     * 开机读「上次的待续清单」的等待上限。
     * 为什么要有：坞入口是在这次读数**之后**才注册的，接口要是挂着不答，按钮就会跟着迟到 ——
     * 宁可没有角标，也不能没有按钮。
     */
    const PENDING_TIMEOUT_MS = 2000;
    /**
     * 平台自己持久化的"当前会话"键 —— 只给 `readOpenSessionIds` 的**退路**用。
     *
     * ⚠ 那是 `ui-workspace` 插件的私有持久化键（它把主视图选中的会话写在这里），**不是公开契约**：
     * 平台升级可能改名 / 改形状。读不到就如实报"读不出来"（宿主退到"只记在跑的"），绝不瞎猜。
     */
    const SELECTION_KEY = 'dsh.sessions.current';
    /**
     * 开机那张续跑卡片的浮层 id（走 GUIFrame 的公开面 `service.overlay.open`）。
     * 带命名空间前缀，且与坞里的面板 id（`…::panel`）不同名 —— 两张卡可以同时在场。
     */
    const OVERLAY_ID = 'dsh-safely-quit/resume';
    /**
     * **认领门槛**：连续这么多拍都看到那一层在场，才算"真的交给了用户"，这时才 `POST /pending/claim`。
     *
     * 为什么不一进 DOM 就认领：本项目出过一次"卡片只闪一下就没了"的事故（装配期清栈）。闪一下不算交付，
     * 认领错了会让这份记录**再也不会被提示**（下一次开机读到"已交付"就回收）。等它稳住了再认领。
     * 判据用"连续几拍"而不是"连续多少毫秒"：心跳本来就是 1 秒一拍（`WATCH_POLL_MS`），
     * 两拍即"至少两秒"，与时间判据等价，还省掉一个时钟依赖（离线判据里因此可复现）。
     */
    const CLAIM_STABLE_TICKS = 2;
    /**
     * **守望心跳**：卡片在场期间一直盯着它（面板一关就把记录清空，见 `clearPendingRecord`）。
     * 一秒一次只查一个 DOM 选择器；面板关掉即收手，不留常驻定时器。
     */
    const WATCH_POLL_MS = 1000;
    /**
     * 交付之后、平台又把层栈清掉时最多补开几次（补弹档另有自己的额度）。
     * 装配期的清栈只发生在开机头几秒，交付之后还遇到，多半就是最后一次。
     */
    const WATCH_REOPENS = 5;
    /**
     * **认领最多试几次**。为什么要有上限：宿主还没重启到带 `/pending/claim` 的那一版时，认领会一直 404 ——
     * 每秒重试一次既没有意义，还会让诊断账（`resumeWatch.log`）无限长大。试几次不成就不试了：
     * 记录仍是"没交出去过"，下次开机会照旧提示（宁可再提示一次，也不在被拒绝的接口上刷）。
     */
    const CLAIM_MAX_TRIES = 5;
    /** 诊断账上限（守望是长跑，账不能无界增长）。 */
    const WATCH_LOG_MAX = 60;
    /**
     * **"这次消失是用户干的"的判据窗口**：消失前这么久之内有过用户交互 ⇒ 认作"用户把面板关掉了"。
     *
     * 为什么要窗口而不是一个布尔位：点外 / Esc / 面板 × 这三条路都会先产生一次用户交互再让层消失
     * （GUIFrame `overlay/dismiss.mjs` 同步摘层，1 秒心跳必然在下一次采样看到），而**平台清栈不会有交互**。
     * 用户点了卡片里的键（交互在卡片内部、层不消失）与"平台稍后清栈"这两件事因此分得开。
     */
    const INTERACTION_WINDOW_MS = 2500;
    /**
     * 交互之后**再过多久复核一次"层还在不在"**（毫秒）。
     *
     * 为什么非要等：面板头部的 × 是 React 的 onClick ⇒ 摘层发生在**点击事件的 React 提交**里，
     * 而交互当场那一看（微任务）层还在 ⇒ 会被判成"这次交互与卡片无关"，守望随后把用户刚关掉的
     * 卡片**又打开**（真机：用户点了 4 次 ×，卡片 4 次自己回来）。120ms 足够跨过 React 提交，
     * 又远短于守望的一拍（1s）⇒ 不会把"用户关的"错判成"平台清栈"。
     */
    const INTERACTION_REVIEW_MS = 120;
    /**
     * 重开之后的**宽限拍数**：`openResumePanel` 到层真的进 DOM 有一段延迟（浮层宿主补装 / React 提交），
     * 宽限期内"层不在场"不算又消失了一次 —— 否则每一拍都会再重开一次，把额度瞬间烧光
     * （真机读数：`reopen` 连发三次，中间一次 `reappeared` 都没有）。
     */
    const REOPEN_GRACE_TICKS = 3;
    /** 浮层卡片的落点与尺寸（无锚点可依，取右上角，四周留边）。 */
    const CARD_SIZE = Object.freeze({ width: 400, height: 300 });
    const CARD_MARGIN = 24;
    /**
     * 开机卡片的「开 → 核验 → 必要时重开」预算（跨过平台服务的**补装窗口**；
     * 真源与理由见 `openResumeCardWhenReady`）：12 ×（160ms 渲染 + 450ms 间隔）≈ 7.3s，
     * 覆盖实测 ~3s 的补装窗口并留余量。外壳完整的实例**第一次就确认收手**（只花 160ms），不白等。
     */
    const OVERLAY_OPEN_TRIES = 12;
    const OVERLAY_RENDER_MS = 160;
    const OVERLAY_RETRY_MS = 450;
    /**
     * **"一次都没弹出来"时的补弹窗口**。
     *
     * 快节奏那 12 次（约 7.3 秒）只够跨过"平台服务补装"；外壳装配得慢时，开机 ~7.3 秒可以全落空，
     * `overlayError` 记的是"层不在 DOM 里"、自报里 `overlayAttempts:12` —— 根因是**浮层宿主还没挂**
     * （外壳还没装配到 `shell.overlay` 那一步）。这一档用慢节奏长窗口继续补：
     * 每秒试一次、最长一分钟，**一旦层出现就转回守望档**。
     * 交付之后平台再清栈也走同一档（额度 `WATCH_REOPENS` 更小），见 `watchResumeCard`。
     */
    const OVERLAY_REOPEN_WINDOW_MS = 60000;
    const OVERLAY_REOPEN_POLL_MS = 1000;
    const OVERLAY_REOPEN_TRIES = 60;
    /**
     * 面板为卡片留的"非内容"高度：头（GUIFrame `kit/surface.mjs:74` 的 `min-height: 32px`）
     * + 内容区底边距（同文件 `body` 的 `padding: '0 8px 8px'`）。
     * 用于把 `rect.height` 调到"刚好放得下"（否则内容区 `overflow:auto`，卡底的键要滚动才够得着）。
     */
    const CARD_CHROME_HEIGHT = 44;
    /** 卡片允许占视口高度的比例（超长清单仍留余量，不顶到屏幕外）。 */
    const CARD_MAX_VIEWPORT_RATIO = 0.72;
    /** "放不下"的容差：差几个像素不值得为它重开一次。 */
    const CARD_FIT_SLACK = 8;
    /** 为"装得下"最多调几轮高度（滚动条宽度会反过来影响内容高度，所以允许收敛两轮）。 */
    const CARD_RESIZE_TRIES = 2;

    /**
     * **全部用户可见文案**（真源：本项目要求"编码前先穷举定稿用户可见文案"，所以集中一处，
     * 改文案只动这张表、不动逻辑）。动态片段写成函数，参数即展示所需的最小事实。
     */
    const TEXT = {
      /** 按钮文字（也是坞入口元数据的 label）。 */
      label: '关闭 DSH',
      /** 悬停说明（按钮上已经写着"关闭 DSH"，所以这里不重复前缀）。读数拿不到时的兜底。 */
      title: '在跑的会话跑完当前一步后停止，全部停稳后关闭',
      /**
       * 悬停说明的**实时读数档**：坞角标那个数（循环中会话数）就是它 ——
       * 要说清的是「如果关闭，需要暂停的总会话数」（设计口径）。
       * 0 个在跑时不画角标，所以这里要把"一个都没有"说清楚，免得人以为数没了是坏了。
       */
      titleRunning: (count) => `现在有 ${count} 个会话在循环中：关闭会让它们各自跑完当前一步再停`,
      titleQuiet: '现在没有会话在循环中：关闭会直接收尾',
      /** 第一次点击后的二次确认（关闭不可逆，必须再点一次）。 */
      confirm: '再点一次确认关闭',
      /**
       * 收尾中那颗键上「已等多久」那半句：**直接拼在「立即停止」后面**，合成一段文字
       * （`立即停止（已等 S 秒）`）—— 不是第二个文字节点、不是第二行。
       *
       * 口径（设计要求）：键上**只有一段文字**（不设"附注"这种东西）；
       * "还有 N 个会话在跑"由右侧角标（循环中会话数）实时给出 ⇒ 不在键上重复。
       */
      elapsed: (seconds) => `（已等 ${seconds} 秒）`,
      /**
       * 停止仍在跑的会话。
       *
       * ⚠ 文案定稿：**不能用「立即终止」** —— 在"正在关闭"的语境里它会被读成
       * "终止关闭流程"（即取消关闭），而它干的是相反的事：停止那些还没停下来的会话。
       */
      force: '立即停止',
      forceTitle: '不再等待：立刻停掉仍在跑的会话',
      /** 宿主已退出（键上就这一句）。 */
      closed: 'DSH 已关闭',
      /** 宿主已退出时的悬停说明（补充信息住悬停，不下键面）。 */
      closedHint: '可以关掉这个页面了',
      /** 请求失败（键上就这一句；原因进悬停说明）。 */
      failed: '关闭没成功',
      retry: '重试',

      // ── 下一次启动：上次关的时候谁被打断（设计规格 §1.1：点「继续」才投消息）──
      /**
       * 卡片标题（正常档）：**只列被这次关闭打断的 agent loop**，条数就是行数。
       * ⚠ 设计口径："我们只继续因为关闭中断的 agent loop" —— 开着但没在跑的不进卡片。
       */
      resumeRunning: (count) => `上次关闭时有 ${count} 个会话在跑`,
      /**
       * 卡片标题（混合档）：**只在读旧记录时出现** —— 旧版本把"开着但没在跑"的会话也写进了清单，
       * 于是行数 > 在跑数。这时标题必须把两个数都说出来（曾出现"标题 2 个在跑、卡片 23 行"）。
       */
      resumeMixed: (total, running) => `上次关闭时有 ${total} 个会话（${running} 个在跑）`,
      /**
       * 单行那颗键：**「继续」= 让这个会话接着跑，就像没中断过一样**。
       *
       * ⚠ 两条口径（设计要求）：
       *  · **一律只给一颗「继续」**：不列「打开」那一档；
       *  · 卡片列的是**被关闭打断的那些会话**（新记录里每一行都是 running），「继续」= 把它们接回来
       *    并让 agent loop 接着跑（有可续目标就 `resume`，没有就 `create` 一个"接着做完"的目标）。
       */
      resumeContinue: '继续',
      /** 卡片上那颗**总键**：一次把这张卡片里的会话都接上。 */
      resumeAll: '一键继续',
      /** 接上了：目标已重新武装 / 已新建，轮次驱动会自己往下跑（不需要任何人再说话）。 */
      resumeAttached: '已接上',
      /** 这条会话本来就已经在跑，不需要再动它。 */
      resumeAlready: '已经在跑',
      /** 会话已经不在（被删了 / 身份对不上）：不给键，只说明。 */
      resumeGone: '这个会话不在了',
      /** 没接上（会话服务缺席 / 宿主拒绝）：键就地变成重试。 */
      resumeFailed: '没接上，再点一次',
      /** 浮层卡片自己的标题栏（坞里那张卡片不用它）。 */
      resumePanelTitle: '上次关闭时的会话',
      /** 总键点完之后的回执（说清"接上几个 / 几个本来就在跑 / 几个没接上"）。 */
      resumeSummary: (attached, already, failed) => `已接上 ${attached} 个${
        already > 0 ? `，${already} 个本来就在跑` : ''
      }${failed > 0 ? `，${failed} 个没接上` : ''}`,
    };

    const CSS = [
      // ── 坞那一行里的控件：**只做内容，不做外壳**（自带 padding/height 就「显示特立独行」）──
      // 行的盒子（`padding:7px 8px` / `gap:8px` / `min-height:36px` / `font-size:14px` /
      // `line-height:22px` / 悬停底色 / `border-radius:8px`）**由坞自己画**（`[data-guif-dock-action]`
      // ＝ DSH 侧栏 `.panelRow` 的逐值照抄）。这里一旦自带 padding/height/font-size，内容就相对
      // 邻居**多缩进一截、行也高出一截** —— 真机实测（`tools/dock-shot.mjs`）：
      //   自带盒子：icon 左内缩 18px、行高 46px、文字 13px、文字色 label-primary；
      //   坞内相邻条目：8px / 36px / 14px / label-secondary ⇒ 一眼就不在一列上。
      // 取值与坞内已对齐的条目同源。
      '.sq-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;width:100%;',
      'padding:0;border:0;border-radius:0;background:transparent;color:inherit;',
      'font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}',
      // 悬停底色归**行**（`[data-guif-dock-action]:hover`）：DSH 侧栏的语义是「整行一个悬停面」。
      // 这里**不自画 hover**：坞的中和规则会按 `!important` 把它抹掉，自画就是死代码；
      // `:active` 的位移也不要 —— 邻居都没有，只有我们有就是"特立独行"。
      // 确认态：只用警示色把「再点一次就真的关了」顶到眼前，**不动盒子尺寸**。
      '.sq-btn-confirm{color:var(--dsw-alias-state-warn-primary,rgba(200,120,0,.95))}',
      // 图标只吃 currentColor：颜色跟随所在行的文字，暗色主题自动跟随，且不写颜色字面量。
      '.sq-icon{flex:none;display:block}',
      // 标签可省略号收缩（`min-width:0` 是 flex 里能真的收到省略号的前提）。
      '.sq-label{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      // 收尾态：就地长成一块卡片（坞原样渲染插件自己的组件，形状不受限）。
      '.sq-card{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:100%;',
      'padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary,rgba(127,127,127,.95));font-size:13px;line-height:1.2}',
      '.sq-row{display:inline-flex;align-items:center;gap:8px}',
      '.sq-hint{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));font-size:12px;line-height:1.5;',
      'white-space:normal;word-break:break-word}',
      // 收尾阶段的键（它就是「立即停止」）：用警示色把它顶到眼前，但形态仍是那**一颗键**。
      '.sq-btn-force{color:var(--dsw-alias-state-warn-primary,rgba(200,120,0,.95))}',
      // 已关闭：这颗键不再做事，视觉上也收掉可点感。
      '.sq-btn-done{opacity:.72;cursor:default}',
      '.sq-failed{color:var(--dsw-alias-state-error-primary,rgba(200,60,60,.95))}',
      // 面板正文：坞把插件交进去的组件直接摆在一行里（行的方向是横的），所以自己竖着排一层。
      // ⚠ 这一层**不许给高度**（高度只能来自里面的内容）：坞那一行是 `min-height:36px` 的横排，
      //   这一层一旦比邻居高，整行就被顶高。
      //   `min-width:0` 是给坞的角标让位：角标 `[data-guif-badge]` 是 `margin-left:auto` 的兄弟节点，
      //   本层是 `width:100%` 的 flex 项，不给收缩下限就会把角标挤出可视区。
      '.sq-stack{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:100%;min-width:0}',
      // 续跑卡片：会话一行 = 名字（占满、超长省略）+ 一颗小键。
      '.sq-session{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%}',
      '.sq-session-label{flex:1 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;',
      'font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.85))}',
      '.sq-open{flex:none;padding:3px 9px;border:0;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-primary,rgba(127,127,127,.95));cursor:pointer;font:inherit;',
      'font-size:12px;line-height:1.4;box-shadow:inset 0 0 0 1px currentColor}',
      '.sq-open:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}',
      // 卡片上那颗总键（「一键继续」）：比行内的小键显眼一档，但仍是"一颗键"。
      '.sq-all{flex:none;padding:4px 12px;border:0;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-primary,rgba(127,127,127,.95));cursor:pointer;font:inherit;',
      'font-size:12px;line-height:1.5;box-shadow:inset 0 0 0 1px currentColor}',
      '.sq-all:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}',
      // 开机那张浮层卡片：外框由 GUIFrame 的面板给，这里只负责内边距与"不要双层底色"。
      '.sq-pop{box-sizing:border-box;padding:4px 12px 12px}',
      '.sq-pop .sq-card{background:transparent;padding:0}',
    ].join('');

    /** 样式注入：幂等（按 CSS_ID 查重），DOM 缺席时静默跳过。 */
    function ensureStyles() {
      try {
        const doc = window.document;
        if (doc === undefined || doc === null) return;
        if (doc.getElementById(CSS_ID) !== null) return;
        const style = doc.createElement('style');
        style.id = CSS_ID;
        style.textContent = CSS;
        const host = doc.head ?? doc.documentElement;
        if (host !== undefined && host !== null) host.appendChild(style);
      } catch {
        // 注入失败不影响注册：按钮仍在，只是没样式
      }
    }

    /** 控制台留痕：诊断只在控制台，绝不进界面、绝不抛（没有 error 对象时只说事由）。 */
    function warn(message, error) {
      try {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          if (error === undefined || error === null) console.warn(`[dsh-safely-quit] ${message}`);
          else console.warn(`[dsh-safely-quit] ${message}：`, error?.message ?? error);
        }
      } catch {
        // 控制台不可用时不追究
      }
    }

    /**
     * 「关闭」语义的图标：**标准电源符号**（开口圆环 + 中心竖线），24×24 视图盒、按 `size` 显示。
     *
     * **同一个组件也交给坞**（`register({icon: PowerIcon})`）：坞会用 `el(icon, {size:16})` 渲染它
     * （`dock/panel-content.mjs` 的图标槽），所以必须接受 `size`。
     * 两条硬约束：零第三方依赖（只用 `h`）、颜色**只走 `currentColor`**。
     *
     * @param {{size?: number}} [props]
     * @returns {object} React 元素（`<svg>`）。
     */
    function PowerIcon(props) {
      const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : ICON_SIZE;
      return h(
        'svg',
        {
          className: 'sq-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // 开口圆环（缺口朝上）
        h('path', { d: 'M18.36 6.64a9 9 0 1 1-12.73 0' }),
        // 中心竖线
        h('line', { x1: 12, y1: 2, x2: 12, y2: 12 }),
      );
    }

    // ── 与宿主对话（纯函数，注入 fetch ⇒ 可离线测；见 test/client.test.mjs）──────────

    /** 取浏览器的 fetch（拿不到就返回 null，调用方会因此进错误态而不是崩）。 */
    function browserFetch() {
      try {
        return typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
      } catch {
        return null;
      }
    }

    /**
     * 取浏览器的 localStorage（隐私模式 / 被禁用 / 无 window ⇒ null）。
     *
     * 只给 `readOpenSessionIds` 的**退路读数**用：那条退路读的是平台自己持久化的"当前会话"。
     * 取不到就是取不到 —— 绝不因为读不到本地存储去猜某个会话。
     */
    function browserStorage() {
      try {
        return typeof window.localStorage === 'object' && window.localStorage !== null ? window.localStorage : null;
      } catch {
        return null;
      }
    }

    /** 从响应里抠一句可读的错误（读不出就 null；绝不抛）。 */
    async function readError(response) {
      try {
        const text = await response.text();
        if (typeof text !== 'string' || text.trim() === '') return null;
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed?.error === 'string') return parsed.error;
        } catch {
          // 不是 JSON 就把原文截断后带出去
        }
        return text.slice(0, 200);
      } catch {
        return null;
      }
    }

    /**
     * **对宿主的唯一出口**：本文件所有请求都从这里走（上面文件头列的七条路由）。
     *
     * 为什么收成一个出口：① 各调用点各拼一次 URL＝把"端点前缀"这件事写了多遍，改一处谁都不报错
     * （接缝漂移正是这么来的）；② 各条包装各抄一遍 `response.ok !== true ⇒ throw`，改一处漏一处。
     * 收在这里之后，接缝面只剩 `ENDPOINT` 一处 —— `tools/check-client.mjs` 与
     * `test/client.test.mjs` 两道机检看着它。
     *
     * 失败一律抛：调用方决定这一次失败是进错误态还是就地吞掉（心跳那条路会吞）。
     *
     * @param {Function} fetchImpl 注入的 fetch（拿不到时调用方传 null ⇒ 这里抛，界面进错误态）
     * @param {string} path 子路径（`/close` / `/state` / …）
     * @param {object|null} body 有体 ⇒ POST + JSON 体；null ⇒ GET
     * @param {{init?:object, parse?:boolean}} [extras] `init` 追加进 fetch 的 init（例如 `signal`）；
     *   `parse:false` ⇒ 只要 2xx 就回 true，不读体（用于"回执无所谓"的自报通道）
     * @returns {Promise<object|boolean>} 宿主回的 JSON；`parse:false` 时是 `true`
     */
    async function callHost(fetchImpl, path, body, extras) {
      const init = body === null
        ? { method: 'GET', ...(extras?.init ?? {}) }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          ...(extras?.init ?? {}),
        };
      const response = await fetchImpl(`${ENDPOINT}${path}`, init);
      if (response === undefined || response === null || response.ok !== true) {
        throw new Error((await readError(response)) ?? `HTTP ${response?.status ?? '?'}`);
      }
      if (extras?.parse === false) return true;
      return response.json();
    }

    /** 读一条只读通道（GET）。 */
    function getJson(fetchImpl, path, extras) {
      return callHost(fetchImpl, path, null, extras);
    }

    /** 发一条改状态的请求（POST + JSON 体）。 */
    function postJson(fetchImpl, path, body, extras) {
      return callHost(fetchImpl, path, body ?? {}, extras);
    }

    /** 发一条"只关心成不成"的请求（不读体；失败一律 false，绝不抛）。 */
    function postQuiet(fetchImpl, path, body) {
      return callHost(fetchImpl, path, body ?? {}, { parse: false }).then(() => true, () => false);
    }

    /**
     * 开始收尾（`POST /close`）。
     *
     * 真关闭必须显式带 `confirm: true` —— 宿主侧也有一道同样的门（见 `lib/index.js` 的 handleRoute），
     * 两道门是刻意的：关闭不可逆。
     *
     * **同时上报"关闭这一刻界面上开着哪些会话"**（`openSessionIds` / `openSource`）—— **只作诊断**：
     * 它进记录的 `scope`，不决定清单内容（清单只收被这次关闭打断的 agent loop）。读不出来
     * （`source:'none'`）时这两项**一律不带**，免得把"没读出来"当成"一个都没开"。
     *
     * @param {Function} fetchImpl 注入的 fetch（测试用假件）
     * @param {{dryRun?: boolean, openSessionIds?: string[]|null, openSource?: string}} [options]
     *   演练（界面上不暴露；只给命令行与离线判据用）+ 界面上开着的会话读数
     * @returns {Promise<object>} 宿主回的 JSON
     */
    function requestClose(fetchImpl, options) {
      const body = options?.dryRun === true ? { dryRun: true } : { confirm: true };
      if (options?.openSessionIds !== null && options?.openSessionIds !== undefined) {
        body.openSessionIds = Array.isArray(options.openSessionIds) ? [...options.openSessionIds] : [];
        if (typeof options?.openSource === 'string' && options.openSource !== '') body.openSource = options.openSource;
      }
      return postJson(fetchImpl, '/close', body);
    }

    /** 请求「立即停止」（`POST /force`）—— 只有用户点了那颗按钮才会走到这里。 */
    function requestForce(fetchImpl) {
      return postJson(fetchImpl, '/force', {});
    }

    /**
     * 请宿主接续一个会话（`POST /continue`）—— 宿主那边投一条「继续」消息并唤醒驱动。
     *
     * **为什么接续不是客户端自己做的**：客户端能发出去的只有用户消息（`session.prompt` 把
     * `source.kind` 写死成 `user`），那就是冒充用户发言；而宿主侧可以用**插件来源**投一条
     * 只唤醒一次的续行消息（`source.kind='safely-quit'`），界面上它会显示成"非人触发的本轮"。
     *
     * @param {Function} fetchImpl 注入的 fetch（测试用假件）
     * @param {string[]} sessionIds 清单里的会话 id（宿主只认清单里的，别的一律不碰）
     * @returns {Promise<object>} 宿主回的 JSON（`{ok, attached, results:[{sessionId, result}]}`）
     */
    function requestContinue(fetchImpl, sessionIds) {
      return postJson(fetchImpl, '/continue', { sessionIds: Array.isArray(sessionIds) ? [...sessionIds] : [] });
    }

    /** 读一次收尾状态（`GET /state`）。 */
    function readState(fetchImpl) {
      return getJson(fetchImpl, '/state');
    }

    // ── 下一次启动：上次关的时候谁在跑（第二半区）────────────────────────────────
    // 口径（设计要求）：**接着跑，不是"打开窗口"** —— 卡片上那颗「继续」= 让被关闭打断的 agent loop
    // 接着跑。动作本身在**宿主**：投一条"继续"消息并唤醒驱动（`agent.followup`），只这一轮。
    // ⚠ 走目标（`remote.goals` 的 `create`/`resume`）是**错**的，本包曾经那样做过、后来撤掉：
    // 目标是一份持久目标，一武装就让轮次驱动在 agent 空闲时**自己**开下一轮（默认上限 256 轮），
    // 那是无人值守的自动续跑（设计规格 §1 明确不做）；被关闭打断的会话也根本没有目标，
    // 建一份等于替用户认定"你还有活要干"。
    // 客户端这里只做两件事：把会话切到眼前（`uiWorkspace.openSession`）+ 请宿主接续（`POST /continue`）。

    /** 目录名的最后一段（`D:\a\b` 与 `D:/a/b/` 都认；取不出 ⇒ null）。 */
    function baseName(path) {
      if (typeof path !== 'string') return null;
      const parts = path.split(/[\\/]+/).filter((part) => part !== '');
      if (parts.length === 0) return null;
      return parts[parts.length - 1];
    }

    /** 会话 id 的短标识（列表里也查不到标题时的兜底）。 */
    function shortId(sessionId) {
      const text = String(sessionId ?? '');
      return text.length > 12 ? `${text.slice(0, 12)}…` : text;
    }

    /**
     * 纯函数：宿主 `/last-pending` 的载荷 ⇒ 续跑卡片要的最小事实。
     * 形状不对 / 没有清单 / 一条可用会话都没有 ⇒ `null`（界面什么都不显示，只留关闭按钮）。
     */
    function parsePending(payload) {
      if (payload === null || typeof payload !== 'object' || payload.available !== true) return null;
      const pending = payload.pending;
      if (pending === null || typeof pending !== 'object') return null;
      const rows = Array.isArray(pending.sessions) ? pending.sessions : [];
      const sessions = [];
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        const sessionId = typeof row.sessionId === 'string' && row.sessionId !== '' ? row.sessionId : null;
        if (sessionId === null) continue;
        const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null;
        const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : null;
        sessions.push({
          sessionId,
          cwd,
          running: row.statusAtClose === 'running',
          label: title ?? baseName(cwd) ?? shortId(sessionId),
        });
      }
      if (sessions.length === 0) return null;
      // 关闭时在跑的排前面：那才是"被打断、最想接着看"的那几个。
      sessions.sort((left, right) => Number(right.running) - Number(left.running));
      return {
        closedAt: typeof pending.closedAt === 'string' ? pending.closedAt : null,
        total: sessions.length,
        running: sessions.filter((item) => item.running).length,
        sessions,
      };
    }

    /**
     * 纯函数：**循环中会话数** —— 会话列表里 `running === true` 的行数。
     *
     * 这就是坞角标那个数，也是用户要的那句话："**如果现在关闭，需要暂停的总会话数**"（设计口径）。
     *
     * 为什么这个数对得上关闭行为：宿主收尾时正是把 **`status === 'running'`** 的会话逐个放到
     * step 边界停下（`lib/index.js` 的 `describeAgent` + `stopIds`），空闲的会话本来就不用等。
     * 数据源是平台的会话列表快照（客户端 `sessions.list`）—— 每行的 `running` 位由宿主经
     * `api-session/status` 帧实时推着走（`dsh-api-session-controller` 的 `SessionSummary.running`
     * + `API_REMOTE_FORWARDED_EVENTS` 里的 `api-session/status`）⇒ 这个数是**实时**的，不是快照。
     *
     * @param {object|null} listState `sessions.list.getSnapshot()` 的快照（拿不到 ⇒ 0）
     * @returns {number} 0 ＝ 现在关闭不用等任何会话
     */
    function countRunning(listState) {
      const byId = listState?.byId;
      if (byId === null || byId === undefined || typeof byId !== 'object') return 0;
      let count = 0;
      for (const id of Object.keys(byId)) {
        if (byId[id]?.running === true) count += 1;
      }
      return count;
    }

    /**
     * 纯函数：角标取值 —— **0 个在跑就不画角标**。
     *
     * 必须给 `null` 而不是 `0`：坞对 `null` 是"没有角标"，但面板行那边 `0 !== null` ⇒ **会画出
     * 一个"0"**（`panel-content.mjs` 的 `row.badge === null ? null : …`）。而坞自绘的角标
     * `normalizeBadge` 又把 `0` 当空（两处口径不一致，从我们这侧统一成 `null` 就都不画）。
     *
     * @param {number} running 循环中会话数
     * @returns {number|null} 要推给坞的值
     */
    function badgeOf(running) {
      return Number.isFinite(running) && running > 0 ? Math.floor(running) : null;
    }

    /** 悬停说明（读数档）：把角标那个数说清楚；读数缺席时退回通用说明。 */
    function runningTitleOf(running) {
      if (!Number.isFinite(running)) return TEXT.title;
      return running > 0 ? TEXT.titleRunning(running) : TEXT.titleQuiet;
    }

    /**
     * 纯函数：开机时该拿什么去注册 / 要弹不弹卡片。
     *
     * ⚠ 角标**不在这里**（设计口径）：角标是"循环中会话数"的**实时**读数，
     * 跟着会话列表走，与"上次关闭的清单"无关。
     *
     * ⚠ "这一次关闭已经看过了"这件事**也不在这里**（设计口径）：它不能记在浏览器 localStorage 里
     * （浏览器换了 / 被清了就失效），而"记录该不该还在"是宿主盘上的事实 —— 归宿主侧的认领
     * （`/pending/claim`）与清空（`/pending/clear`）管，客户端只负责在正确时机调这两条路。
     *
     * @param {object|null} model `parsePending` 的结果
     */
    function planBoot(model) {
      /**
       * 记录里**只要还有会话**就交给界面：新记录里每一行都是"被这次关闭打断的 agent loop"；
       * 一条都没有 ⇒ 没有卡片。每行的键仍是「继续」，不设"打开"这一档。
       */
      return { initialResume: model === null || model === undefined ? null : model };
    }

    /**
     * 读上一轮的待续清单（`GET /last-pending`）。
     *
     * 三种"没有"合并成同一个 `null`：接口说没有（`available:false`）、读失败、超时 ——
     * 对界面而言它们都只是"没有待续"，不该多出任何错误态。
     *
     * @param {Function|null} fetchImpl 注入的 fetch（测试用假件）
     * @param {number} [timeoutMs] 等待上限
     * @returns {Promise<object|null>} 归一化后的清单
     */
    async function readPending(fetchImpl, timeoutMs) {
      if (typeof fetchImpl !== 'function') return null;
      const limit = Number.isFinite(timeoutMs) ? timeoutMs : PENDING_TIMEOUT_MS;
      let timer = null;
      let controller = null;
      try {
        if (typeof AbortController === 'function') {
          controller = new AbortController();
          timer = window.setTimeout(() => controller.abort(), limit);
        }
        const payload = await getJson(fetchImpl, '/last-pending', controller === null ? null : { init: { signal: controller.signal } });
        return parsePending(payload);
      } catch {
        return null;
      } finally {
        if (timer !== null) window.clearTimeout(timer);
      }
    }

    /**
     * **认领 / 清空**待续记录（`POST /pending/claim` / `POST /pending/clear`）。
     *
     * 两条只差子路径与文案，所以共用这一个实现：各写一份必然分叉，改一处漏一处。
     * 判据、失败语义都一样：没有 fetch / 没有时间戳 ⇒ 不发请求；宿主说 ok:false 或抛错 ⇒ false
     * （认领走心跳重试，清空下一次再看）。
     *
     * @param {Function} fetchImpl 注入的 fetch
     * @param {string} path 子路径（`/pending/claim` 或 `/pending/clear`）
     * @param {string} closedAt 客户端看到的记录时间戳（宿主拿它当保险，对不上就拒绝）
     * @returns {Promise<boolean>} 宿主是否认这一笔
     */
    async function postPendingFlag(fetchImpl, path, closedAt) {
      if (typeof fetchImpl !== 'function') return false;
      if (typeof closedAt !== 'string' || closedAt === '') return false;
      try {
        const result = await postJson(fetchImpl, path, { closedAt });
        return result?.ok === true;
      } catch {
        return false;
      }
    }

    /**
     * **认领**这份待续记录（`POST /pending/claim`）：卡片已经在屏幕上站稳了，告诉宿主"交出去了"。
     * 从此这一次开机不会再被当成"没交付"（刷新页面照旧显示，下一次开机则不再提示）。
     *
     * 失败不抛、不改界面状态：返回 false，由下一拍心跳重试（排障看 `__safelyQuit.resumeWatch`）。
     *
     * @returns {Promise<boolean>} 是否真的认领上了（宿主说 already 也算成功）
     */
    function claimPendingRecord(fetchImpl, closedAt) {
      return postPendingFlag(fetchImpl, '/pending/claim', closedAt);
    }

    /**
     * **清空**这份待续记录（`POST /pending/clear`）—— 用户把面板关掉了，这条提示就用完了。
     *
     * 口径（设计要求）："如果用户关闭了面板，那么继续会话的记录自动清空"。
     * 卡片上的每一条关闭路径（点外 / Esc / 面板 × / 点过键之后关掉）都会走到这里，所以
     * **卡片上不设「不用了」那颗键** —— 关掉面板本身就是那个意思。
     *
     * ⚠ 删记录不可逆，所以**只在确证是用户关的**时候才发（判据见 `closedByUser`）：
     * 不确定时倒向"保留"，宁可下次开机会多提示一次，也不要把用户没看见过的提示删掉。
     *
     * @returns {Promise<boolean>} 是否真的清了（宿主说本来就没有也算成功）
     */
    function clearPendingRecord(fetchImpl, closedAt) {
      return postPendingFlag(fetchImpl, '/pending/clear', closedAt);
    }

    /**
     * 服务软探测（客户端不写声明式 `inject`：缺服务会让 fiber 悬置、外壳直接抛错打死整页）。
     *
     * @param {object|null} holder 客户端 ctx（或注入后的 ctx）
     * @param {string} name 服务名
     * @returns {object|null} 服务实例
     */
    function resolveService(holder, name) {
      try {
        if (holder === null || holder === undefined) return null;
        if (typeof holder.get === 'function') return holder.get(name) ?? null;
        return holder[name] ?? null;
      } catch {
        return null;
      }
    }

    /** 会话列表快照（拿不到 ⇒ null；`phase:'pending'` 表示还没拉到，不能据此断定"会话没了"）。 */
    function readListSnapshot(sessions) {
      try {
        if (sessions === null || sessions === undefined) return null;
        const store = sessions.list;
        if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return null;
        return store.getSnapshot() ?? null;
      } catch {
        return null;
      }
    }

    /**
     * 读「界面上此刻开着哪些会话」—— **只作诊断**（进记录的 `scope`，不决定清单内容）。
     *
     * 待续清单只收**被这次关闭打断的 agent loop**（宿主那一侧判据）：开着但没在跑的会话不进卡片，
     * "继续"它等于凭空造一个任务。这份读数留在记录里的用途只有一个 —— 回答
     * "我开着的那个为什么没列"（答：它当时没在跑）。
     *
     * 主路：`sessions.retainInfo(id).getSnapshot().retainedBy.mainView > 0` —— 平台把"主视图正显示
     * 这个会话"记成一条**引用**（`ui-workspace` 的 `replaceMain` 用 `source:'mainView'` 持有它，
     * 切走 / 清空即释放）。**这才是"开着"，不是"这次运行里翻到过"**。
     *
     * 退路：平台自己持久化的"当前会话"（`SELECTION_KEY`）。只有在主路**读不了**（老平台没有
     * `retainInfo` / 拿不到会话列表）时才走它 —— 主路读成功时"0 个"就是真答案，不许拿退路去翻案。
     *
     * 三种返回必须分得开：
     *   · `mainView` —— 主视图读数（`ids` 合法为空：一个都没开）；
     *   · `selection-store` —— 退路读数；
     *   · `none` —— 两路都读不出来（宿主按"没上报"处理）。
     *
     * 这条路**绝不抛**：客户端抛错会打死整页。
     *
     * @param {object|null} sessions 客户端 `sessions` 面（可以是 null）
     * @param {object|null} storage `localStorage` 形状（退路用；可缺席）
     * @returns {{ids: string[], source: 'mainView'|'selection-store'|'none'}}
     */
    function readOpenSessionIds(sessions, storage) {
      try {
        if (sessions !== null && sessions !== undefined && typeof sessions.retainInfo === 'function') {
          const state = readListSnapshot(sessions);
          const ids = Array.isArray(state?.ids)
            ? state.ids
            : (state?.byId !== null && typeof state?.byId === 'object' ? Object.keys(state.byId) : null);
          if (ids !== null) {
            const open = [];
            for (const id of ids) {
              if (typeof id !== 'string' || id === '') continue;
              // ⚠ 这里**不**就地吞错：拿不到引用计数时，"读出来的是一份残缺名单"比"报读不出来"
              // 更糟（少记一个开着的会话 = 开机少一次提示，而且没有任何痕迹）。抛 ⇒ 走退路。
              const info = sessions.retainInfo(id);
              const retained = info !== null && info !== undefined && typeof info.getSnapshot === 'function' ? info.getSnapshot() : null;
              if ((retained?.retainedBy?.mainView ?? 0) > 0) open.push(id);
            }
            return { ids: open, source: 'mainView' };
          }
        }
      } catch {
        // 主路读不了 ⇒ 走退路
      }
      try {
        if (storage !== null && storage !== undefined && typeof storage.getItem === 'function') {
          const raw = storage.getItem(SELECTION_KEY);
          if (typeof raw !== 'string' || raw.trim() === '') return { ids: [], source: 'selection-store' };
          const parsed = JSON.parse(raw);
          const id = typeof parsed?.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : null;
          return { ids: id === null ? [] : [id], source: 'selection-store' };
        }
      } catch {
        // 退路也读不了
      }
      return { ids: [], source: 'none' };
    }

    /**
     * 纯函数：这一帧的续跑卡片长什么样（不该显示 ⇒ null）。
     *
     * 清单里的每一行都是**被这次关闭打断的 agent loop**（`statusAtClose = running`）：标题报它们的
     * 条数，每行一颗「继续」（宿主投一条续行消息，把被打断的那一轮接回去）。
     * **开着但没在跑的会话不会出现**（设计口径："我们只继续因为关闭中断的 agent loop"）。
     * 读旧记录时可能遇到"行数 > 在跑数"（旧版本把开着的也写进了清单）⇒ 标题改报混合档，账仍然对得上。
     *
     * 标签优先取**当前**会话列表里的标题（会话可能被改过名），列表里查不到才退回清单里记的那份；
     * 列表已经拉全却查不到这个 id ⇒ 会话被删了，不给键。
     *
     * @param {object|null} model `parsePending` 的结果
     * @param {object|null} listSnapshot `ctx.sessions.list` 的快照
     * @returns {{title:string, total:number, running:number, rows:Array<object>}|null}
     */
    function describeResume(model, listSnapshot) {
      if (model === null || model === undefined) return null;
      // 形状兜底：模型是"外面给的数据"，缺字段也不许把整页带崩（客户端抛错会打死整页）。
      const items = Array.isArray(model.sessions) ? model.sessions : [];
      const byId = listSnapshot !== null && typeof listSnapshot === 'object'
        && listSnapshot.byId !== null && typeof listSnapshot.byId === 'object'
        ? listSnapshot.byId
        : null;
      // 列表**拉全了**（有 phase 且不是 pending）才敢说"这个会话没了"；否则宁可让用户点了报错。
      const listed = byId !== null && typeof listSnapshot.phase === 'string' && listSnapshot.phase !== 'pending';
      const rows = items.map((item) => {
        const summary = byId === null ? undefined : byId[item?.sessionId];
        const label = typeof summary?.displayTitle === 'string' && summary.displayTitle !== ''
          ? summary.displayTitle
          : (item?.label ?? '');
        return {
          sessionId: item?.sessionId,
          label,
          openable: !(listed && summary === undefined),
          /** 关闭那一刻是不是在跑（标题按它报数；打断与空闲都在这一张卡里）。 */
          interrupted: item?.running === true,
        };
      });
      const running = rows.filter((row) => row.interrupted === true).length;
      return {
        // 标题里的条数**恒等于行数**。新记录每一行都是被打断的 ⇒ 报"N 个会话在跑"；
        // 行数大于在跑数只可能是**旧记录**（它把"开着但没在跑"的也写进了清单），那时两个数都说出来。
        title: running === rows.length ? TEXT.resumeRunning(rows.length) : TEXT.resumeMixed(rows.length, running),
        total: rows.length,
        running,
        rows,
      };
    }

    /**
     * 取一个服务（`get()` 优先，退路是按 `.` 逐级走属性面）；**取不到一律 null，绝不抛**。
     *
     * 为什么要单独一个函数：平台上有一部分服务是**受 inject 守卫**的 —— 没在自己的 fiber 上
     * 声明过它的名字就去取，`ctx.get` 会当场抛 `cannot get property "…" without inject`
     * （真机实测：「继续」恒判"没接上"、`lastError` 就是这一句）。受守卫的服务只能用注入拿到。
     *
     * @param {object|null} holder 注入作用域内的 ctx
     * @param {string} name 服务名（可以是 `remote.session` 这种带命名空间的名字）
     * @returns {object|null} 服务实例
     */
    function readService(holder, name) {
      try {
        if (holder !== null && holder !== undefined && typeof holder.get === 'function') {
          const direct = holder.get(name);
          if (direct !== null && direct !== undefined) return direct;
        }
      } catch {
        // 未声明就取 ⇒ 抛；按"这一档取不到"处理，交给下面的退路
      }
      try {
        let cursor = holder;
        for (const step of String(name).split('.')) {
          if (cursor === null || cursor === undefined) return null;
          cursor = cursor[step];
        }
        return cursor ?? null;
      } catch {
        return null;
      }
    }

    /**
     * **运行时注入捕获的一面**：「切会话」（`uiWorkspace`）。
     *
     * 它是受 inject 守卫的服务（见 `readService` 的注释），只能在注入作用域里取；取到后存这里，
     * 「继续」按需读。为什么不用**声明式**注入：声明式注入在服务缺席时会悬置整条 fiber、外壳直接抛错
     * 打死整页（本包客户端入口的第一条纪律）；运行时注入缺席时回调根本不触发，这一面就一直是 null
     * ⇒ 「继续」照常如实报"没接上"，页面一点事没有。
     */
    const injectedFaces = { workspace: null };

    /**
     * 上面那一面的**注入结果**（`pending` = 回调还没来过 / `ok` / `missing` = 来了但取不到 /
     * `no-openSession:<类型>` = 取到了但形状不对）。这是"服务没来"与"服务改名了"两种静默失败的分界线：
     * 没有这条读数，界面只会说"没接上"，排障只能靠猜。落在 `window.__safelyQuit.injectFaces`。
     */
    const injectedFaceState = { uiWorkspace: 'pending' };

    /**
     * 取客户端 `uiWorkspace` 面 —— **「把某个会话切到前台」这个动作住在这里**
     * （`@deepseek-ai/dsh-client-ui-workspace` 的 `uiWorkspace.openSession(target)`，平台自己的
     * 子代理插件就用它切到子会话）。这里是**软探测**：注入那一路（`injectedFaces.workspace`）优先，
     * 这一路只是没吃到注入时的退路 —— 受守卫的服务走这条路必然取不到（见 `readService`）。
     */
    function resolveUiWorkspace(holder) {
      try {
        const face = resolveService(holder, 'uiWorkspace');
        if (face === null || face === undefined) return null;
        return typeof face.openSession === 'function' ? face : null;
      } catch (error) {
        noteError('取 uiWorkspace 面失败', error);
        return null;
      }
    }

    /**
     * 把一个会话选成当前会话。**两代平台的落点都要试**：
     *
     *  · `uiWorkspace.openSession(sessionId)`（新版平台）：`sessions` 面**已经不再有 `open`**
     *    ——它的自述是"目录与引用分配器，视图选择不归 Controller 管"（`ClientSessions` 的类注释），
     *    真机实测点「继续」恒判"没接上"就是踩在这一条上；切会话的公开面只剩 `uiWorkspace`。
     *  · `sessions.open(sessionId)`（更早的平台）：升级前那条路，留着当退路（本包不锁平台版本）。
     *
     * 先新后旧；两条都没有 / 都抛 ⇒ false（这条路绝不抛：客户端抛错会打死整页）。
     *
     * @param {object|null} sessions `ctx.sessions` 面（可能是 null）
     * @param {string} sessionId 目标会话
     * @param {object|null} [workspace] `ctx.uiWorkspace` 面（缺席 ⇒ 只走老路）
     * @returns {boolean} 是否把"切会话"这件事交出去了
     */
    function openSession(sessions, sessionId, workspace) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      if (workspace !== null && workspace !== undefined && typeof workspace.openSession === 'function') {
        try {
          workspace.openSession(sessionId);
          return true;
        } catch (error) {
          warn('切会话失败（退回落点）', error);
        }
      }
      try {
        if (sessions === null || sessions === undefined || typeof sessions.open !== 'function') return false;
        sessions.open(sessionId);
        return true;
      } catch (error) {
        warn('打开会话失败', error);
        return false;
      }
    }

    // ══ 显示状态机（真源）════════════════════════════════════════════════════════
    // 这颗键长什么样，全部声明在 `QUIT_STATES` 里；组件只查表渲染，不自己按阶段分叉。
    //

    /**
     * **五个显示状态**（未知阶段一律退到 `idle`，界面绝不出现空白键）。
     *
     * 一档的字段（只说"怎么显示"，不说"怎么改状态"）：
     *   · `className` —— 键的 class（阶段色**只改颜色、不动盒子**，盒子尺寸归坞那一行）
     *   · `label(ctx)` —— **键上那一段文字**（唯一一个文字节点）
     *   · `title(ctx)` —— 悬停说明（补充信息住这里，键面上不出现）
     *   · `actionable` —— 此刻点它有没有用（已关闭 ⇒ `false`，点了不做事）
     *   · `action` —— 点它时执行哪个号令（见 `QUIT_COMMANDS`）
     *
     * `ctx` = `{ hostState, running, seconds, errorText }`，全是渲染所需的只读事实。
     * （`hostState` 是宿主那份原样读数，目前只作留档 —— "还有几个在跑"由右侧角标显示。）
     */
    const QUIT_STATES = Object.freeze({
      /** 平常态：还没开始关。 */
      idle: Object.freeze({
        className: 'sq-btn',
        label: () => TEXT.label,
        title: (ctx) => runningTitleOf(ctx.running),
        actionable: true,
        action: 'begin',
      }),
      /** 已按下、等第二次确认（关闭不可逆）。 */
      confirming: Object.freeze({
        className: 'sq-btn sq-btn-confirm',
        label: () => TEXT.confirm,
        title: (ctx) => runningTitleOf(ctx.running),
        actionable: true,
        action: 'confirm',
      }),
      /**
       * 收尾中：这一颗键**就是**「立即停止」，并且**把"已等多久"拼进同一段文字**
       * （`立即停止（已等 S 秒）`）—— 不是第二个节点、不是另一行。
       */
      closing: Object.freeze({
        className: 'sq-btn sq-btn-force',
        label: (ctx) => `${TEXT.force}${TEXT.elapsed(ctx.seconds)}`,
        title: () => TEXT.forceTitle,
        actionable: true,
        action: 'force',
      }),
      /** 宿主已经退了：轮询断掉 ⇒ 到这一档，键不再做事；"可以关掉页面了"进悬停说明。 */
      closed: Object.freeze({
        className: 'sq-btn sq-btn-done',
        label: () => TEXT.closed,
        title: () => TEXT.closedHint,
        actionable: false,
        action: 'none',
      }),
      /** 请求失败：键名变「重试」；失败原因（宿主给的那句）进悬停说明。 */
      failed: Object.freeze({
        className: 'sq-btn sq-failed',
        label: () => TEXT.retry,
        title: (ctx) => `${TEXT.failed}${reasonSuffix(ctx.errorText)}`,
        actionable: true,
        action: 'retry',
      }),
    });

    /** 未知阶段退到哪一档（不显示空白）。 */
    const QUIT_FALLBACK_PHASE = 'idle';

    /** 阶段清单（判据据此机检"每一档都有显示定义、转移表的键与它一一对应"）。 */
    const QUIT_PHASES = Object.freeze(Object.keys(QUIT_STATES));

    /**
     * **转移表**：`from → [允许到达的 to…]`，键集与 `QUIT_STATES` 一一对应。
     *
     * | 边 | 触发（真源 = `createQuitStore`） |
     * |---|---|
     * | `idle → confirming` | 点第一下（`begin`） |
     * | `idle → closing` | 挂载/刷新时 `attach()` 读到宿主正在收尾 |
     * | `confirming → idle` | 5 秒没确认（`CONFIRM_MS` 超时，自己退回） |
     * | `confirming → closing` | 点第二下（`confirm`，先转态再发 `/close`） |
     * | `closing → failed` | `/close` 被拒或网络失败 |
     * | `closing → closed` | 轮询连续失败 `OFFLINE_STRIKES` 次（宿主真的退了），或 `attach()` 发现宿主重启过 |
     * | `failed → idle` | 点「重试」 |
     * | `failed → closing` | `attach()` 读到宿主正在收尾 |
     * | `closed → closing` | 宿主又进了收尾（罕见：`attach()` 时读到） |
     */
    const QUIT_TRANSITIONS = Object.freeze({
      idle: Object.freeze(['confirming', 'closing']),
      confirming: Object.freeze(['idle', 'closing']),
      closing: Object.freeze(['failed', 'closed']),
      closed: Object.freeze(['closing']),
      failed: Object.freeze(['idle', 'closing']),
    });

    /**
     * 点这颗键要执行的号令：键上的 `action` 只报名字，真正的函数在这里
     * （键不需要知道 store 有哪些方法，换阶段只改表、不改组件）。
     */
    const QUIT_COMMANDS = Object.freeze({
      begin: (store) => store.begin(),
      confirm: (store) => { void store.confirm(); },
      force: (store) => { void store.force(); },
      retry: (store) => store.retry(),
      none: () => {},
    });

    /** 纯函数：这条转移在表里声明过吗（判据与运行期对账共用同一份实现）。 */
    function canTransition(from, to) {
      const allowed = QUIT_TRANSITIONS[from];
      return Array.isArray(allowed) && allowed.includes(to);
    }

    /** 失败原因那半句（没有原因 ⇒ 空串，不留一个孤零零的冒号）。 */
    function reasonSuffix(errorText) {
      return errorText === null || errorText === undefined || errorText === '' ? '' : `：${errorText}`;
    }

    /**
     * 执行一个号令（表里没声明的名字一律不做事：界面绝不抛）。
     * @param {object} store `createQuitStore` 的产物
     * @param {string} action `QUIT_COMMANDS` 的键
     */
    function runCommand(store, action) {
      if (store === null || store === undefined) return;
      const command = QUIT_COMMANDS[action];
      if (typeof command !== 'function') return;
      try {
        command(store);
      } catch (error) {
        warn(`号令 ${action} 执行失败（已吞掉）`, error);
      }
    }

    /**
     * 按显示状态机算出**这一帧这颗键**的视图（纯函数，好测）。
     *
     * @param {string} phase `QUIT_STATES` 的键（未知值 ⇒ 退到 `idle` 档）
     * @param {object|null} hostState `GET /state` 的响应（可能是 null）
     * @param {number} elapsedMs 从点下确认到现在经过的毫秒
     * @param {string|null} [errorText] 失败原因（phase=failed 时用）
     * @param {number|null} [running] 循环中会话数（悬停说明那一档用）
     * @returns {{tone:string, className:string, main:string, title:string,
     *   actionable:boolean, action:string}} `main` = 键上那**一段**文字
     */
    function describePhase(phase, hostState, elapsedMs, errorText, running) {
      const tone = Object.prototype.hasOwnProperty.call(QUIT_STATES, phase) ? phase : QUIT_FALLBACK_PHASE;
      const state = QUIT_STATES[tone];
      const ctx = {
        hostState: hostState ?? null,
        running: Number.isFinite(running) ? running : null,
        seconds: Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000)),
        errorText: errorText ?? null,
      };
      return {
        tone,
        className: state.className,
        main: state.label(ctx),
        title: state.title(ctx),
        actionable: state.actionable === true,
        action: state.actionable === true ? state.action : 'none',
      };
    }

    /**
     * 「上次关的时候谁在跑」卡片：标题 + 每个会话一行 + **一颗总键「一键继续」**。
     *
     * ⚠ 三条口径（设计要求）：
     *  · **每行那颗键一律是「继续」**（真的接着跑，不设"打开窗口"），卡底再加一颗总键
     *    「一键继续」（一次把清单里的会话都接上）。键名只说它干的事，**不承诺替你发消息**
     *    （发出去的是插件来源的续行消息，界面把它画成"非人触发的本轮"，不是用户气泡）。
     *  · **列表里已经没有这个会话 ⇒ 换成一句「这个会话不在了」**，不给键。
     *  · ⚠ **不设「不用了」那颗键** —— 关掉面板本身就是"不用了"：
     *    面板一关（点外 / Esc / 面板 ×）客户端就把待续记录清空（见 `clearPendingRecord`）。
     *
     * @param {{model?:object|null, opened?:object, summary?:string|null,
     *          onContinue?:Function, onContinueAll?:Function}} props
     * @returns {object|null} React 元素（没有卡片时返回 null，不留空壳）
     */
    function ResumeCard(props) {
      const model = props?.model ?? null;
      if (model === null) return null;
      const opened = props?.opened ?? {};
      const summary = props?.summary ?? null;
      const rows = model.rows.map((row) => {
        const state = opened[row.sessionId];
        const label = state === 'failed'
          ? TEXT.resumeFailed
          : (state === 'attached'
            ? TEXT.resumeAttached
            : (state === 'already'
              ? TEXT.resumeAlready
              : (state === 'gone' ? TEXT.resumeGone : TEXT.resumeContinue)));
        return h(
          'div',
          { className: 'sq-session', key: row.sessionId, 'data-safely-quit-session': row.sessionId },
          h('span', { className: 'sq-session-label', title: row.label }, row.label),
          row.openable === true
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sq-open',
                  'data-safely-quit-continue': row.sessionId,
                  onClick: () => props?.onContinue?.(row.sessionId),
                },
                label,
              )
            : h('span', { className: 'sq-hint', 'data-safely-quit-gone': row.sessionId }, TEXT.resumeGone),
        );
      });
      return h(
        'div',
        { className: 'sq-card', 'data-safely-quit-resume': 'true' },
        h('div', { className: 'sq-hint', 'data-safely-quit-resume-title': 'true' }, model.title),
        ...rows,
        h(
          'div',
          { className: 'sq-row', 'data-safely-quit-resume-actions': 'true' },
          h(
            'button',
            {
              type: 'button',
              className: 'sq-all',
              'data-safely-quit-continue-all': 'true',
              onClick: () => props?.onContinueAll?.(),
            },
            TEXT.resumeAll,
          ),
        ),
        summary === null ? null : h('div', { className: 'sq-hint', 'data-safely-quit-resume-summary': 'true' }, summary),
      );
    }

    // ── 收尾状态机（**住在模块里，不住在组件里**）────────────────────────────────
    // 为什么必须搬出来：GUIFrame 每次打开坞面板都**现造**内容节点
    // （`dsh-gui-frame/src/client/dock/panels.mjs:113-130` 的 `createPanelContent` + `overlay.open`），
    // 面板一关浮层被移除 ⇒ React 子树卸载 ⇒ 组件里的 `useState` 归零、`useEffect` 里的轮询也跟着死。
    // 现象：收尾中把面板关掉再打开，按钮回到「关闭 DSH」。

    /**
     * 宿主 `/state` 的 stage：`idle`（平常）→ `waiting`（已下令、等各会话跑完当前步）
     * → `done`（**已经把关闭交出去**，即将关闭）/ `failed`（编排在交棒之前中断了）。
     *
     * ⚠ `failed` **不算收尾中**：界面要显示「重试」，不能把一次失败永远说成"正在关闭"。
     */
    function isClosingStage(stage) {
      return stage === 'waiting' || stage === 'done';
    }

    /** 宿主那一趟是不是失败了（新宿主给 `failed` 布尔位；老宿主只看 stage）。 */
    function hostFailed(hostState) {
      if (hostState === null || hostState === undefined) return false;
      return hostState.failed === true || hostState.stage === 'failed';
    }

    /** 宿主报的失败原因（没有 ⇒ null）：进悬停说明，键面上只留「关闭没成功」。 */
    function hostFailureText(hostState) {
      const text = hostState?.lastError;
      return typeof text === 'string' && text !== '' ? text : null;
    }

    /** 宿主报的版本（= 包元数据那份的唯一真源；还没读到 ⇒ null）。 */
    function hostVersionOf(store) {
      try {
        const value = store?.getSnapshot?.()?.hostState?.version;
        return typeof value === 'string' && value !== '' ? value : null;
      } catch {
        return null;
      }
    }

    /** 「已等多少毫秒」优先用宿主给的读数（跨页面重载也算得对），宿主没给才退回本地时钟。 */
    function elapsedOf(hostState, startedAt, nowMs) {
      const fromHost = hostState?.elapsedMs;
      if (Number.isFinite(fromHost) && fromHost >= 0) return fromHost;
      if (Number.isFinite(startedAt)) return Math.max(0, nowMs - startedAt);
      return 0;
    }

    /**
     * 造一个收尾状态机。所有副作用（请求、定时器）都归它，组件只读快照、只发号令。
     *
     * 阶段：`idle` →（`begin`）`confirming` →（`confirm`）`closing` →（宿主退出 / 轮询连续失败）`closed`；
     * 任一步请求失败 ⇒ `failed`（`retry` 回 `idle`）；确认态超时自己退回 `idle`。
     * **每条边都声明在 `QUIT_TRANSITIONS`**（换挡时对账，缺边只留痕不拦，见 `auditTransition`）。
     * `attach()` 是**与宿主对齐**：挂载/重载/热换模块后，宿主说在收尾就接着显示收尾态。
     *
     * @param {{fetch?:Function, now?:Function, schedule?:Function, cancel?:Function,
     *   confirmMs?:number, pollMs?:number, offlineStrikes?:number}} [deps] 全可注入（离线判据用）
     * @returns {object} `{getSnapshot, subscribe, attach, begin, confirm, retry, force, dispose}`
     */
    function createQuitStore(deps) {
      // ⚠ 必须**惰性求值**：`browserFetch` 是个函数，写成 `fetchImpl = browserFetch` 会让"调用 fetchImpl"
      // 变成"调用 browserFetch"（返回一个绑好的 fetch 函数而不是响应），整条请求链静默走错。
      const resolveFetch = typeof deps?.fetch === 'function' ? () => deps.fetch : browserFetch;
      const now = typeof deps?.now === 'function' ? deps.now : () => Date.now();
      const schedule = typeof deps?.schedule === 'function' ? deps.schedule : (fn, ms) => window.setTimeout(fn, ms);
      const cancel = typeof deps?.cancel === 'function' ? deps.cancel : (handle) => window.clearTimeout(handle);
      const confirmMs = Number.isFinite(deps?.confirmMs) ? deps.confirmMs : CONFIRM_MS;
      const pollMs = Number.isFinite(deps?.pollMs) ? deps.pollMs : POLL_MS;
      const offlineStrikes = Number.isFinite(deps?.offlineStrikes) ? deps.offlineStrikes : OFFLINE_STRIKES;
      /**
       * 「关闭这一刻界面上开着哪些会话」的读数口（由装配方注入；缺席 ⇒ 读不出来）。
       * 读数本身住在 `readOpenSessionIds`（纯函数 + 平台服务），状态机只管"什么时候读"——
       * **必须在发 `/close` 之前读**：请求一发出宿主就开始写清单了。
       */
      const openScopeOf = typeof deps?.openSessionIds === 'function' ? deps.openSessionIds : null;

      // `running` = **循环中会话数**（坞角标那个数，见 `watchRunning`）：组件据此渲染悬停说明。
      let snapshot = { phase: 'idle', hostState: null, errorText: null, startedAt: null, elapsedMs: 0, running: 0 };
      const listeners = new Set();
      let confirmHandle = null;
      let pollHandle = null;
      /**
       * 轮询**世代号**：`stopPoll()` 一自增，在飞那一拍回来就发现自己过期 ⇒ 既不落状态也不再续期。
       *
       * 为什么需要它：`tick()` 一进来就把 `pollHandle` 置 null、响应回来才续期 —— 这段时间里
       * `attach()` 再排一拍，两条链就一起活着（失败计数双倍增长，界面可能提前钉死在「已关闭」）。
       */
      let pollGeneration = 0;
      let strikes = 0;
      let disposed = false;

      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // 订阅者自己的错不该打断状态机
          }
        }
      };
      const set = (patch) => {
        const next = { ...snapshot, ...patch };
        if (next.phase !== snapshot.phase) auditTransition(snapshot.phase, next.phase);
        snapshot = next;
        emit();
      };
      /**
       * 换挡时与 `QUIT_TRANSITIONS` 对账：表里没声明的边**只留痕、不拦** ——
       * 界面优先，关闭流程不可逆，绝不能因为"账目不对"把人卡在收尾态；留痕是为了让漏声明的边
       * 在排障时露头（控制台 + `window.__safelyQuit.illegalTransition`）。
       */
      const auditTransition = (from, to) => {
        if (canTransition(from, to)) return;
        warn(`未声明的阶段转移 ${from} → ${to}（显示状态机的 QUIT_TRANSITIONS 缺这条边）`);
        publishDebug({ illegalTransition: { from, to, at: new Date().toISOString() } });
      };
      const stopPoll = () => {
        pollGeneration += 1; // 作废在飞那一拍（它回来时会发现自己过期，不再续期）
        if (pollHandle !== null) {
          cancel(pollHandle);
          pollHandle = null;
        }
      };
      /** 排下一拍（带上世代号：只有最新世代的拍子才会执行与续期）。 */
      const schedulePoll = () => {
        const generation = pollGeneration;
        pollHandle = schedule(() => {
          tick(generation);
        }, pollMs);
      };
      const stopConfirm = () => {
        if (confirmHandle !== null) {
          cancel(confirmHandle);
          confirmHandle = null;
        }
      };
      /**
       * 读一次「关闭这一刻界面上开着哪些会话」。绝不抛：读不出来就是 `source:'none'`，
       * 宿主那边按"没上报"处理（只记在跑的）—— 宁可少记，也不凭空列几行。
       */
      const readOpenScope = () => {
        try {
          const value = openScopeOf === null ? null : openScopeOf();
          if (value !== null && value !== undefined && Array.isArray(value.ids)) {
            return {
              ids: value.ids.filter((id) => typeof id === 'string' && id !== ''),
              source: typeof value.source === 'string' && value.source !== '' ? value.source : 'none',
            };
          }
        } catch {
          // 读数失败 ⇒ 按"不知道"处理
        }
        return { ids: [], source: 'none' };
      };

      /** 一轮问询：拿宿主的收尾进度；连续失败若干次 ⇒ 判定宿主已经走了；宿主报失败 ⇒ 转「重试」。 */
      function tick(generation) {
        pollHandle = null;
        if (disposed || generation !== pollGeneration || snapshot.phase !== 'closing') return;
        const startedAt = snapshot.startedAt;
        readState(resolveFetch())
          .then((next) => {
            if (disposed || generation !== pollGeneration || snapshot.phase !== 'closing') return;
            strikes = 0;
            publishDebug({ hostVersion: next?.version ?? null });
            set({
              hostState: next,
              elapsedMs: elapsedOf(next, startedAt, now()),
              ...(hostFailed(next) ? { phase: 'failed', errorText: hostFailureText(next) } : {}),
            });
          })
          .catch(() => {
            if (disposed || generation !== pollGeneration || snapshot.phase !== 'closing') return;
            strikes += 1;
            if (strikes >= offlineStrikes) set({ phase: 'closed' });
          })
          .then(() => {
            if (!disposed && generation === pollGeneration && snapshot.phase === 'closing') schedulePoll();
          });
      }

      return {
        getSnapshot: () => snapshot,
        /**
         * 记下**循环中会话数**（= 现在关闭要等它跑完当前一步的会话数）。由 `watchRunning` 喂。
         * 只在真的变了才 emit —— 会话列表每次刷新都会重算一遍，别让整行白白重渲染。
         */
        setRunning(next) {
          const value = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
          if (disposed || snapshot.running === value) return;
          set({ running: value });
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /** 与宿主对齐（挂载时调一次；收尾中刷新页面/热换模块也靠它把状态接回来）。 */
        async attach() {
          try {
            const next = await readState(resolveFetch());
            if (disposed) return;
            publishDebug({ hostVersion: next?.version ?? null });
            // 宿主说这一趟收尾失败了 ⇒ 如实显示「重试」（别再装作正在关）。
            if (hostFailed(next)) {
              stopPoll();
              set({ phase: 'failed', hostState: next, errorText: hostFailureText(next) });
              return;
            }
            if (isClosingStage(next?.stage)) {
              set({
                phase: 'closing',
                hostState: next,
                startedAt: snapshot.startedAt ?? now(),
                elapsedMs: elapsedOf(next, snapshot.startedAt, now()),
              });
              stopPoll();
              schedulePoll();
              return;
            }
            // 宿主说自己平常，但我们这边记着"正在关" ⇒ 那是上一次的残留（宿主重启过了）
            if (snapshot.phase === 'closing') set({ phase: 'closed', hostState: next });
            else set({ hostState: next }); // 平常态也把这次读数留下（版本 / pid 等诊断要用）
          } catch {
            if (!disposed && snapshot.phase === 'closing') set({ phase: 'closed' });
          }
        },
        begin() {
          if (snapshot.phase !== 'idle') return;
          set({ phase: 'confirming', errorText: null });
          stopConfirm();
          confirmHandle = schedule(() => {
            confirmHandle = null;
            if (!disposed && snapshot.phase === 'confirming') set({ phase: 'idle' });
          }, confirmMs);
        },
        async confirm() {
          if (snapshot.phase !== 'confirming') return;
          stopConfirm();
          // **先读再发**：宿主收到 /close 就开始写清单了（见 readOpenScope）
          const scope = readOpenScope();
          publishDebug({ openAtClose: scope });
          set({ phase: 'closing', startedAt: now(), elapsedMs: 0, errorText: null });
          stopPoll();
          schedulePoll();
          try {
            await requestClose(resolveFetch(), {
              openSessionIds: scope.source === 'none' ? null : scope.ids,
              openSource: scope.source,
            });
          } catch (error) {
            if (disposed) return;
            stopPoll();
            set({ phase: 'failed', errorText: String(error?.message ?? error) });
          }
        },
        retry() {
          if (snapshot.phase === 'failed') set({ phase: 'idle', errorText: null });
        },
        /** 「立即停止」：只发一次请求，真实进展由下一轮轮询反映（不在前端猜状态）。 */
        async force() {
          try {
            await requestForce(resolveFetch());
          } catch {
            // 忽略：轮询会给出真实状态
          }
        },
        dispose() {
          disposed = true;
          stopPoll();
          stopConfirm();
          listeners.clear();
        },
      };
    }

    /** 没有 store 时的兜底快照（形状与真快照一致；绝不因为取不到状态就把页面带崩）。 */
    const IDLE_SNAPSHOT = Object.freeze({ phase: 'idle', hostState: null, errorText: null, startedAt: null, elapsedMs: 0, running: 0 });

    /** 订阅 store：状态在人不在时也要活着，所以订阅只影响"重绘"，不影响状态机。 */
    function useQuitState(store) {
      const [, bump] = React.useState(0);
      const usable = store !== null && store !== undefined && typeof store.getSnapshot === 'function';
      React.useEffect(() => {
        if (!usable || typeof store.subscribe !== 'function') return undefined;
        return store.subscribe(() => bump((value) => value + 1));
      }, [store, usable]);
      return usable ? store.getSnapshot() : IDLE_SNAPSHOT;
    }

    /**
     * 续跑卡片（**带活的读数**）：会话当前叫什么、还在不在，渲染时现读。
     * **只用在开机那张独立浮层上**（不放进坞的按钮面板里 —— 那条路设计上已否掉）。
     *
     * @param {{sessions:Function, workspace:Function, fetch:Function}} deps
     * @returns {Function} 组件（props：`model`）
     */
    function createResumeCardLive(deps) {
      return function ResumeCardLive(props) {
        const model = props?.model ?? null;
        const [opened, setOpened] = React.useState({});
        const [summary, setSummary] = React.useState(null);
        const card = model === null ? null : describeResume(model, readListSnapshot(deps.sessions()));
        /** 接上一个会话之后的账：只记这一行的结果（记录的去留归宿主的认领/清空管，不在这里）。 */
        const settle = (sessionId, result) => {
          setOpened((prev) => ({ ...prev, [sessionId]: result }));
          return result;
        };
        /** 行内那颗键：只接这一个会话。 */
        const onContinue = (sessionId) => {
          setOpened((prev) => ({ ...prev, [sessionId]: 'working' }));
          void (async () => {
            settle(sessionId, await continueSession(deps, sessionId));
          })();
        };
        /**
         * 总键「一键继续」：把清单里的会话**逐个**接上（串行，免得几个会话同时开跑把机器压住）。
         * 会话已经不在列表里的跳过（`openable !== true`）；结果用一行回执说清，不装成功。
         */
        const onContinueAll = () => {
          const rows = (card?.rows ?? []).filter((row) => row.openable === true);
          void (async () => {
            let attached = 0;
            let already = 0;
            let failed = 0;
            for (const row of rows) {
              setOpened((prev) => ({ ...prev, [row.sessionId]: 'working' }));
              const result = await continueSession(deps, row.sessionId);
              settle(row.sessionId, result);
              if (result === 'attached') attached += 1;
              else if (result === 'already') already += 1;
              else failed += 1;
            }
            setSummary(TEXT.resumeSummary(attached, already, failed));
          })();
        };
        return h(ResumeCard, { model: card, opened, summary, onContinue, onContinueAll });
      };
    }

    /**
     * 坞面板正文：**只有那个「关闭 DSH」按钮**。
     *
     * ⚠ 续跑卡片**不放这里**：坞面板要"点开面板"才看得见，而且设计上已否掉这条落点 ——
     * 它只作为开机时的独立浮层出现（见 `openResumePanel`）。
     *
     * @param {{store:object}} deps
     * @returns {Function} 注册给坞的组件
     */
    function createPanel(deps) {
      // ⚠ 组件类型必须在这里**固定下来**：在 render 里现调工厂会每次产出新类型 ⇒ React 每帧重挂子树。
      const Quit = createQuitButton(deps.store);
      return function SafelyQuitPanel(props) {
        const state = useQuitState(deps.store);
        /**
         * 角标的**退路通道**：坞的切片面拿不到时，用注册面给的那颗"每行能力面"
         * `props.setBadge(value)`（坞注册面传给注册方组件的"每行能力面"`props.setBadge`）。
         * 主通道在模块级的 `watchRunning`（面板关着时也要更新侧栏那一行）——两条都推同一个值，
         * 重复推是幂等的，不冲突。
         */
        React.useEffect(() => {
          if (typeof props?.setBadge !== 'function') return undefined;
          props.setBadge(badgeOf(state.running));
          return undefined;
        }, [state.running]);
        return h('div', { className: 'sq-stack', 'data-safely-quit-panel': 'true' }, h(Quit));
      };
    }

    /**
     * 往上找「坞那一行」——GUIFrame 给每个动作行套的 `<button data-guif-dock-action="…">`
     * （属性名见 `GUI_DOM.dockAction`）。找不到就退回直接父节点（装配细节变了也不至于失联）。
     */
    function dockRowOf(node) {
      try {
        if (node === null || node === undefined) return null;
        if (typeof node.closest === 'function') {
          const row = node.closest(`[${GUI_DOM.dockAction}]`);
          if (row !== null && row !== undefined) return row;
        }
        return node.parentElement ?? null;
      } catch {
        return null;
      }
    }

    /** 事件目标是不是落在我们自己的元素里（是 ⇒ 归我们的 onClick 管，行上的监听让路）。 */
    function insideNode(node, target) {
      try {
        if (node === null || node === undefined || target === null || target === undefined) return false;
        if (node === target) return true;
        return typeof node.contains === 'function' && node.contains(target);
      } catch {
        return false;
      }
    }

    /**
     * 坞面板里**唯一那颗键**（收尾期间不许它变成卡片、更不许往里嵌按钮）。
     *
     * ⚠ 两条硬约束（设计要求）：
     * ① **任何按钮不得相互嵌套** —— 坞那一行本身就是 GUIFrame 造的 `<button data-guif-dock-action>`，
     *    所以这里**不渲染 `<button>`**，只渲染一个可点的元素（div），由它承担动作；
     * ② 既然一行只能有一颗键，**「立即停止」就直接是这颗键**（收尾阶段键名即「立即停止」），
     *    而不是"卡片里再嵌一颗小按钮"。
     *
     * 键盘怎么办：焦点在那一行上、Enter/Space 产生的 click 的 target 是**那一行**（不是我们的元素），
     * 所以挂载时给那一行接一个原生 click 监听，把"点那一行"也算成点这颗键（卸载即摘掉）。
     *
     * @param {object} store `createQuitStore` 的产物
     * @returns {Function} 组件
     */
    function createQuitButton(store) {
      return function QuitButton() {
        const state = useQuitState(store);
        // ★ 显示状态机是**唯一**的渲染真源：那段文字 / 悬停 / class / 可点性 / 点击号令全从它来，
        //   组件里**不许**出现 `if (phase === …)` 这种分叉（换阶段只改 QUIT_STATES）。
        const view = describePhase(state.phase, state.hostState, state.elapsedMs, state.errorText, state.running);
        const nodeRef = React.useRef(null);
        /** 这一颗键此刻做什么：由显示状态机给（`view.action`），组件不自己判阶段。 */
        const act = () => {
          if (view.actionable !== true) return;
          runCommand(store, view.action);
        };
        React.useEffect(() => {
          const node = nodeRef.current;
          const row = dockRowOf(node);
          if (row === null || typeof row.addEventListener !== 'function') return undefined;
          const onRowClick = (event) => {
            // 点在我们的元素上 ⇒ 我们的 onClick 已经在处理（不重复触发）；点/激活在行上 ⇒ 归这里。
            if (insideNode(node, event?.target)) return;
            act();
          };
          row.addEventListener('click', onRowClick);
          return () => {
            try {
              row.removeEventListener('click', onRowClick);
            } catch {
              // 行已经没了就算了
            }
          };
        }, [state.phase, state.hostState, state.errorText]);

        return h(
          'div',
          {
            className: view.className,
            ref: nodeRef,
            'data-safely-quit-entry': ENTRY_ID,
            'data-safely-quit-phase': state.phase,
            'data-safely-quit-tone': view.tone,
            'data-safely-quit-actionable': view.actionable === true ? 'true' : 'false',
            title: view.title,
            onClick: act,
          },
          h(PowerIcon, { size: ICON_SIZE }),
          h('span', { className: 'sq-label' }, view.main),
        );
      };
    }

    // ── 接续 agent loop：请宿主投一条「继续」消息（`POST /continue`）──────────────────
    // 为什么不在客户端做：客户端能发出去的只有**用户消息**（`session.prompt` 把 `source.kind` 写死成
    // `user`）—— 那就成了冒充用户发言。宿主侧可以用**插件来源**（`source.kind='safely-quit'`）
    // 投一条只唤醒一轮的消息（`agent.followup`），界面上它显示成"非人触发的本轮"，不是用户气泡。
    // ⚠ 也不碰目标（`remote.goals`）：目标一武装，轮次驱动就会在 agent 空闲时**自己**开下一轮
    // （默认上限 256 轮）—— 那是无人值守的自动续跑（设计规格 §1 明确不做），而且清单里的会话
    // 根本没有目标，建一份等于替用户认定"你还有活要干"。

    /**
     * 这条链此刻**能拿到哪些面**（纯读数，不参与任何判定）：
     * 客户端服务缺席是「继续」最常见的失败源，而且它是**静默**的 —— 平台升级后服务改名 / 搬家，
     * 界面只会看到键变成「没接上，再点一次」，没人知道缺的是哪一面。所以失败时把这一组读数
     * 记进调试面（`window.__safelyQuit.continueFaces`）：排障不用再靠人复述浏览器里发生了什么。
     *
     * @param {object} deps 卡片依赖面（`sessions` / `workspace` 是取值函数，`fetch` 就是 fetch 本身）
     * @returns {object} 各面是否存在、有没有那个方法
     */
    function probeContinueFaces(deps) {
      const face = (getter) => {
        try {
          return typeof getter === 'function' ? getter() : null;
        } catch {
          return null;
        }
      };
      const sessions = face(deps?.sessions);
      const workspace = face(deps?.workspace);
      return {
        sessions: sessions === null || sessions === undefined ? null : typeof sessions,
        sessionsOpen: typeof sessions?.open === 'function',
        workspace: workspace === null || workspace === undefined ? null : typeof workspace,
        workspaceOpen: typeof workspace?.openSession === 'function',
        fetch: typeof deps?.fetch === 'function',
      };
    }

    /**
     * **一键继续的一个会话**：先切过去（人得看得见），再请宿主接续。
     *
     * 顺序要紧：先 `openSession` 再投消息 —— 切会话这件事必须发生，哪怕接续那一步失败，
     * 用户至少能看到"是哪个会话没接上"。
     *
     * 四档如实回，不做静默替换：`attached`（已接上）/ `already`（本来就在跑）/
     * `gone`（会话真的不在了）/ `failed`（其它失败）。
     *
     * @param {{sessions:Function, workspace:Function, fetch:Function}} deps 卡片依赖面
     * @param {string} sessionId 目标会话
     * @returns {Promise<'attached'|'already'|'gone'|'failed'>}
     */
    async function continueSession(deps, sessionId) {
      const workspace = typeof deps?.workspace === 'function' ? deps.workspace() : null;
      const switched = openSession(typeof deps?.sessions === 'function' ? deps.sessions() : null, sessionId, workspace) === true;
      const fetchImpl = typeof deps?.fetch === 'function' ? deps.fetch : null;
      if (typeof fetchImpl !== 'function') {
        publishDebug({ continueFaces: probeContinueFaces(deps), continueFailedAt: 'no-fetch', continueSwitched: switched });
        return 'failed';
      }
      let payload = null;
      try {
        payload = await requestContinue(fetchImpl, [sessionId]);
      } catch (error) {
        publishDebug({ continueFaces: probeContinueFaces(deps), continueFailedAt: 'host', continueFailure: String(error?.message ?? error), continueSwitched: switched });
        return 'failed';
      }
      const rows = Array.isArray(payload?.results) ? payload.results : [];
      const row = rows.find((item) => item?.sessionId === sessionId) ?? null;
      const result = typeof row?.result === 'string' ? row.result : '';
      if (result === 'attached') return 'attached';
      if (result === 'already') return 'already';
      if (result === 'missing') return 'gone';
      publishDebug({ continueFaces: probeContinueFaces(deps), continueFailedAt: 'host', continueFailure: payload, continueSwitched: switched });
      return 'failed';
    }

    /** 把"浏览器里发生了什么"回传给宿主（`POST /report`，排障通道；发不出去就算了）。 */
    function sendReport(fetchImpl, report) {
      if (typeof fetchImpl !== 'function') return Promise.resolve(false);
      return postQuiet(fetchImpl, '/report', report);
    }

    // ── 开机那张浮层卡片（走 GUIFrame 的公开面 `service.overlay.open`）──────────────
    // 为什么不用坞里那一行代替：坞的行**要点开面板才看得见**（角标也一样），而"下次开工"这件事
    // 需要一眼看到 —— 所以有清单时开机直接把卡片浮出来，用户把它关掉（点外 / Esc / 面板 ×）之后不再出现。

    /** 取 GUIFrame 的 overlay 命名空间（缺席 ⇒ null，一切静默降级）。 */
    function resolveOverlay(gui) {
      try {
        const overlay = gui === null || gui === undefined ? null : gui.overlay;
        if (overlay === null || overlay === undefined || typeof overlay.open !== 'function') return null;
        return overlay;
      } catch (error) {
        warn('取 overlay 命名空间失败', error);
        return null;
      }
    }

    /** 卡片落点：贴右上角（按 GUIFrame 浮层根的真实尺寸量，量不到退回窗口尺寸）。 */
    function cardRect(heightOverride) {
      const width = CARD_SIZE.width;
      const height = Number.isFinite(heightOverride) && heightOverride > 0 ? Math.round(heightOverride) : CARD_SIZE.height;
      let containerWidth = 0;
      let containerHeight = 0;
      try {
        const root = window.document?.querySelector?.(`[${GUI_DOM.overlayRoot}]`);
        const box = typeof root?.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
        if (box !== null && box !== undefined && Number.isFinite(box.width) && box.width > 0) {
          containerWidth = box.width;
          containerHeight = box.height;
        }
      } catch {
        // 量不到就退回窗口尺寸
      }
      if (containerWidth === 0) {
        try {
          containerWidth = Number(window.innerWidth);
          containerHeight = Number(window.innerHeight);
        } catch {
          containerWidth = 0;
          containerHeight = 0;
        }
      }
      // 夹进容器：右边放不下就贴左边，底边放不下就贴顶边 —— 任何窗口尺寸下都在视野里。
      const maxX = containerWidth > width + CARD_MARGIN ? containerWidth - width - CARD_MARGIN : CARD_MARGIN;
      const maxY = containerHeight > height + CARD_MARGIN ? CARD_MARGIN * 3 : CARD_MARGIN;
      return {
        x: Math.max(CARD_MARGIN, Math.round(maxX)),
        y: Math.max(CARD_MARGIN, Math.round(maxY)),
        width,
        height,
      };
    }

    /** 浮层那一层真的进 DOM 了吗（比"接口没抛错"硬：接口成功但没渲染，也是没弹出来）。 */
    function overlayLayerNode() {
      try {
        const doc = window.document;
        if (doc === null || doc === undefined || typeof doc.querySelector !== 'function') return null;
        return doc.querySelector(`[${GUI_DOM.overlayLayer}="${OVERLAY_ID}"]`) ?? null;
      } catch {
        return null;
      }
    }

    /**
     * 量一个元素的盒子；**没有盒子就返回 null**（宽或高为 0 都算没有）。
     * @param {object|null} node
     * @returns {{left:number,top:number,right:number,bottom:number,width:number,height:number}|null}
     */
    function boxOf(node) {
      if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null;
      try {
        const box = node.getBoundingClientRect();
        if (box === null || box === undefined) return null;
        const width = Number(box.width);
        const height = Number(box.height);
        if (!(width > 0) || !(height > 0)) return null;
        return { left: Number(box.left), top: Number(box.top), right: Number(box.right), bottom: Number(box.bottom), width, height };
      } catch {
        return null;
      }
    }

    /**
     * 取**层里真正有盒子的那一块**。
     *
     * ⚠⚠ 层的包裹节点**没有盒子**，按它判"可见吗"必然判错 —— 后果是「卡片只闪一下就没了」：
     * GUIFrame 的层包裹节点 `[data-guif-overlay-layer]` 的样式是 **`display: contents`**
     * （真源 `dsh-gui-frame/src/client/overlay/styles.mjs:39-42`，注释原文「`display: contents`
     * ⇒ **不生成盒子**」——它只是用来把子树的 `pointer-events` 恢复成 `auto`）。
     * ⇒ 对它调 `getBoundingClientRect()` **恒得 0×0**，于是"层可见吗"永远判 false，
     *   开机卡片被自检当成"没弹出来"**当场关掉**（用户看到的就是那 160ms 的一闪）。
     * 正确量法：层自身没盒子就**下沉到子树**，取里面**所有**有盒元素的并集
     * （`panel` 族的真身 `overlay/panel.mjs:70-77` 是 `position:absolute` + 显式 width/height ⇒ 一定有盒子）。
     *
     * @param {object|null} node 层节点
     * @returns {{box:object|null, own:object|null, counted:number}} `box` = 并集（量不到则 null）
     */
    function layerBoxOf(node) {
      const own = boxOf(node);
      if (node === null || node === undefined) return { box: null, own: null, counted: 0 };
      const boxes = own === null ? [] : [own];
      let descendants = [];
      try {
        descendants = typeof node.querySelectorAll === 'function'
          ? Array.from(node.querySelectorAll('*'))
          : Array.from(node.children ?? []);
      } catch {
        descendants = [];
      }
      for (const child of descendants) {
        const box = boxOf(child);
        if (box !== null) boxes.push(box);
      }
      if (boxes.length === 0) return { box: null, own, counted: 0 };
      const union = {
        left: Math.min(...boxes.map((b) => b.left)),
        top: Math.min(...boxes.map((b) => b.top)),
        right: Math.max(...boxes.map((b) => b.right)),
        bottom: Math.max(...boxes.map((b) => b.bottom)),
      };
      return {
        box: { ...union, width: union.right - union.left, height: union.bottom - union.top },
        own,
        counted: boxes.length,
      };
    }

    /**
     * 浮层那一层**现在**长什么样（只读取证：进 DOM 了吗 / 量到几个盒子 / 与视口相交吗）。
     * 这个读数既用来判"卡片到底弹出来了没"，也原样进自报（`POST /report`）——
     * 下次再出问题，`GET /report` 一眼就能看出是"没渲染"还是"判据又错了"，不必再靠人复述。
     *
     * @returns {{layerInDom:boolean, boxes:number, layerBox:object|null, box:object|null,
     *   viewport:{width:number,height:number}, visible:boolean}}
     */
    function overlayProbe() {
      const node = overlayLayerNode();
      const measured = layerBoxOf(node);
      let viewWidth = 0;
      let viewHeight = 0;
      try {
        viewWidth = Number(window.innerWidth);
        viewHeight = Number(window.innerHeight);
      } catch {
        viewWidth = 0;
        viewHeight = 0;
      }
      const box = measured.box;
      const visible = box !== null
        && box.right > 0 && box.bottom > 0
        && box.left < viewWidth && box.top < viewHeight;
      return {
        layerInDom: node !== null,
        /** 宿主根在不在（层没渲染时，用它区分"宿主还没挂"与"记录被清了"）。 */
        rootInDom: overlayRootInDom(),
        boxes: measured.counted,
        layerBox: measured.own,
        box,
        viewport: { width: viewWidth, height: viewHeight },
        visible,
      };
    }

    /**
     * 浮层宿主根在 DOM 里吗。
     *
     * 这是"**我们的层有没有可能被渲染**"的前置条件：GUIFrame 的浮层宿主挂在平台的 `shell.overlay`
     * 座位上（`overlay/index.mjs` 的座位那一段），座位没占到 / 外壳还没装配到那一步时，
     * `overlay.open` 照样返回句柄、记录也进栈，但**没有任何组件去渲染它** ⇒ 层永远不进 DOM
     * （活体实测：开机 12 次重开、~7.3 秒全落空，根因就是宿主还没挂）。
     */
    function overlayRootInDom() {
      try {
        const doc = window.document;
        if (doc === null || doc === undefined || typeof doc.querySelector !== 'function') return false;
        return doc.querySelector(`[${GUI_DOM.overlayRoot}]`) !== null;
      } catch {
        return false;
      }
    }

    /** 浮层那一层在视野里吗（层内有盒子且与视口相交；`display:contents` 的层靠子树量）。 */
    function overlayLayerVisible() {
      return overlayProbe().visible;
    }

    /** 把探针读数压成一行短话（进 `overlayError`，排障时不翻 JSON 也能读）。 */
    function describeProbe(probe) {
      if (probe === null || probe === undefined) return '没有读数';
      if (probe.layerInDom !== true) {
        return `层不在 DOM 里（浮层宿主根${probe.rootInDom === true ? '在，但层没渲染出来' : '**不在**：宿主还没挂上'}）`;
      }
      const size = probe.box === null ? '量不到任何盒子' : `${Math.round(probe.box.width)}×${Math.round(probe.box.height)} @${Math.round(probe.box.left)},${Math.round(probe.box.top)}`;
      return `层在 DOM 里，盒子 ${size}（${probe.boxes} 个有盒元素），视口 ${probe.viewport.width}×${probe.viewport.height}`;
    }

    /**
     * 面板内容区**还差多少放得下**（`scrollHeight - clientHeight`，>0 就是要滚动才够得着）。
     *
     * 为什么优先用它而不是"卡片盒高 + 定值"：真机实测（11 个会话）里第一条路会**差 22px** ——
     * 面板一调高、滚动条消失/出现会改变内容宽度，行内文字随之换行，内容又高了一点。
     * 直接量"还差多少"把这个反馈也算进去，补两轮就收敛。
     *
     * @returns {number|null} 缺的高度；量不到内容区（锚点不在）⇒ null，调用方退回估算
     */
    function cardFitDeficit() {
      const node = (() => {
        try { return window.document?.querySelector?.(`[${GUI_DOM.panelBody}="${OVERLAY_ID}"]`) ?? null; } catch { return null; }
      })();
      if (node === null || node === undefined) return null;
      const scrollHeight = Number(node.scrollHeight);
      const clientHeight = Number(node.clientHeight);
      if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return null;
      return Math.max(0, Math.ceil(scrollHeight - clientHeight));
    }

    /** 关掉一个浮层句柄（关不上就算了）。 */
    function closeHandle(handle) {
      try {
        if (handle !== null && handle !== undefined && typeof handle.close === 'function') handle.close();
      } catch {
        // 它本来也会被 Esc / 点外关掉
      }
    }

    /** 视口高度（量不到算 0；调用方自己决定 0 时怎么办）。 */
    function viewportHeight() {
      try {
        const value = Number(window.innerHeight);
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    }

    /**
     * 面板要放得下这张卡片，得多高（含面板自己的头与内边距）。
     *
     * 为什么需要它：`rect.height` 是**面板容器**的高度（GUIFrame `overlay/panel.mjs:70-77` 把
     * `height` 直接写进 `position:absolute` 的盒子里），而内容区是 `overflow: auto`
     * （`kit/surface.mjs` 的 `body`）⇒ 清单长的时候**卡底那颗总键「一键继续」**
     * 要滚动才够得着**。真机读数（用户那份 11 个会话的清单）：卡片实体高 364.8px 而 rect 只给了 300。
     *
     * @returns {number|null} 需要的总高；量不到卡片 ⇒ null
     */
    function cardNeededHeight() {
      const node = (() => {
        try { return window.document?.querySelector?.('[data-safely-quit-pop]') ?? null; } catch { return null; }
      })();
      const box = boxOf(node);
      if (box === null) return null;
      // 面板头（真源 `kit/surface.mjs:74` 的 header `min-height: 32px`）+ 内容区底边距（`padding: '0 8px 8px'`）
      return Math.ceil(box.height) + CARD_CHROME_HEIGHT;
    }

    /** 让出一小段时间（给 React 渲染用；没有定时器就直接返回）。 */
    function nextTick(ms) {
      return new Promise((resolve) => {
        try {
          window.setTimeout(resolve, ms);
        } catch {
          resolve();
        }
      });
    }

    /** 出错留痕：控制台 + 只读调试面（`window.__safelyQuit.lastError`），绝不抛。 */
    function noteError(message, error) {
      warn(message, error);
      publishDebug({ lastError: `${message}：${error?.message ?? error}` });
    }

    /**
     * 开一张浮层卡片。
     *
     * ⚠ 卡片的去留**全归用户**（点外 / Esc / 面板 ×）—— 插件不主动关掉它：
     * 收起与记账两件事都归"关掉面板"本身（见 `watchResumeCard`）。
     *
     * @param {object} gui `gui-frame` 服务
     * @param {{model:object|null, sessions:Function, workspace:Function, fetch:Function}} deps
     * @param {{rectHeight?:number}} [options] `rectHeight` = 面板高度（清单长时由实测高度给，见 `cardNeededHeight`）
     * @returns {object|null} 浮层句柄；没开成 ⇒ null
     */
    function openResumePanel(gui, deps, options) {
      const overlay = resolveOverlay(gui);
      if (overlay === null || deps?.model === null || deps?.model === undefined) return null;
      // ⚠ 这里要给**活卡片**重建一份 deps，一个面都不能漏：漏一个 ⇒ 那颗键判"没接上"
      // （真机踩过：漏了 `workspace`，「继续」永远切不过去）。
      const Live = createResumeCardLive({
        sessions: deps.sessions,
        workspace: deps.workspace,
        fetch: deps.fetch,
      });
      try {
        return overlay.open({
          id: OVERLAY_ID,
          family: 'panel',
          title: TEXT.resumePanelTitle,
          initialRect: cardRect(options?.rectHeight),
          content: h('div', { className: 'sq-pop', 'data-safely-quit-pop': 'true' }, h(Live, { model: deps.model })),
        });
      } catch (error) {
        noteError('浮层卡片没能打开', error);
        return null;
      }
    }

    /**
     * 开机把卡片**真的**开出来：必须跨过「平台服务补装窗口」。
     *
     * ═══ 为什么不能只 open 一次（实测）═══
     * GUIFrame 真源 `src/client/entry/after-services.mjs:23-29`：`slots` 这类**兄弟插件提供的服务**
     * 晚于本插件 `apply` 就绪（实测 ~3s 内到齐）⇒ overlay 第一遍只装成**降级件**（没占到座位、
     * 不渲染宿主根），等服务真到齐再 **dispose 降级件 + 补装**；而它的 `dispose()`
     * （`overlay/index.mjs:185-190`）会 **`stack.clear()`** —— **在那之前 open 的记录会被整栈清掉，
     * 卡片永远不出现**（实测读数：`layerInDom:false`、层栈 0、时间线空）。
     * 外壳完整时（第一遍就占到座位）一次就成，所以这个坑只在**冷启动**露头。
     *
     * ═══ 所以这里做「开 → 核验 → 必要时重开」═══
     *   · 每轮都重新 open（同 id ⇒ 栈里先摘后加，等价重新打开）；
     *   · **只有在"刚开的那一层压根不在 DOM"时才关句柄**（那是个空句柄，关掉无副作用）；
     *   · 只要层进了 DOM 就立刻收手 —— **判据说它不可见也不重开、更不关掉**：
     *     卡片的去留归用户（「不用了」/ 面板自带 × / Esc），不归自检。
     *
     * @param {object} gui `gui-frame` 服务
     * @param {object} deps 见 `openResumePanel`
     * @returns {Promise<{handle:object|null, probe:object|null, attempts:number, waitedMs:number, overlayError:string|null}>}
     */
    async function openResumeCardWhenReady(gui, deps) {
      const startedAt = Date.now();
      let handle = null;
      let probe = null;
      let attempts = 0;
      let rectHeight = cardRect().height; // 面板高度（清单长时会按实测往上调，最多 `CARD_RESIZE_TRIES` 轮）
      let resizeCount = 0;
      for (let attempt = 0; attempt < OVERLAY_OPEN_TRIES; attempt += 1) {
        handle = openResumePanel(gui, deps, { rectHeight });
        if (handle === null) {
          return { handle: null, probe: null, attempts, waitedMs: Date.now() - startedAt, rectHeight, resized: resizeCount > 0, overlayError: 'open 返回空（多半是 overlay 能力缺席或抛错）' };
        }
        attempts += 1;
        await nextTick(OVERLAY_RENDER_MS); // 给 React 一帧把它挂上去
        probe = overlayProbe();
        if (probe.layerInDom === true) {
          // 层在 DOM ⇒ 就是弹出来了。再看一眼**放得下吗**：清单长的时候内容区会溢出，
          // 卡底那颗总键「一键继续」就得滚动才够得着 ⇒ 往上调高度再开一次
          // （同 id ⇒ 栈里先摘后加，卡片原地变大，不用先关掉，所以不会闪）。
          // 优先按"内容区还差多少"补；拿不到那个读数才退回"卡片盒高 + 面板头与内边距"的估算。
          const deficit = cardFitDeficit();
          const estimated = deficit === null ? cardNeededHeight() : null;
          const cap = Math.floor(viewportHeight() * CARD_MAX_VIEWPORT_RATIO);
          const target = deficit !== null
            ? (deficit > 0 ? rectHeight + deficit + 2 : null)
            : (estimated !== null && estimated > rectHeight + CARD_FIT_SLACK ? estimated : null);
          const canGrow = cap > 0 ? rectHeight < cap : true;
          if (target !== null && resizeCount < CARD_RESIZE_TRIES && canGrow && attempt < OVERLAY_OPEN_TRIES - 1) {
            resizeCount += 1;
            rectHeight = cap > 0 ? Math.min(target, cap) : target;
            continue;
          }
          return {
            handle,
            probe,
            attempts,
            waitedMs: Date.now() - startedAt,
            rectHeight,
            resized: resizeCount > 0,
            overlayError: probe.visible ? null : `卡片开出来了但探针量不到可见盒子（${describeProbe(probe)}）`,
          };
        }
        closeHandle(handle); // 这一层压根不在 DOM（多半刚被补装清栈）⇒ 关的是个空句柄
        if (attempt < OVERLAY_OPEN_TRIES - 1) await nextTick(OVERLAY_RETRY_MS);
      }
      return {
        handle,
        probe,
        attempts,
        waitedMs: Date.now() - startedAt,
        rectHeight,
        resized: resizeCount > 0,
        overlayError: `重开 ${attempts} 次后那一层仍没进 DOM（${describeProbe(probe)}）`,
      };
    }

    /**
     * 盯住"用户什么时候动过"，并**当场核验**这次交互有没有真的把层摘掉。
     *
     * 为什么守望必须知道它：卡片消失有两种成因 —— ① 平台在**服务补装**时清层栈；
     * ② 用户自己关的（点外 / 面板 × / Esc）。两者在 DOM 上长得**一模一样**，但处置相反：
     * ① 要重开（用户根本没来得及看见），② **绝不能**重开（那等于跟用户对着干），而且要把待续记录
     * 清空（"用户关了面板 ⇒ 记录自动清空"）。
     *
     * ⚠ 只记"最近几秒内动过手"是不够的：用户点了页面**别处**、而平台同时把层清掉时，那会被误判成
     * "用户关的" ⇒ 记录被误删、下一次开机再不提示。真正的分界线是**时序** —— GUIFrame 的"用户关掉"
     * 是在**同一次事件里同步摘层**（`overlay/dismiss.mjs`）。所以每次交互都做两件事：
     *   ① 交互发生时看一眼层在不在；
     *   ② 层当时在场 ⇒ 等**一个微任务**回看：当场没了 ⇒ `dismissedByInteraction`（用户关的）；
     *      当场还在 ⇒ `layerSurvivedInteraction`（这次交互与卡片无关，消失另有原因）。
     *
     * @returns {{state:{interacted:boolean, lastAt:number|null,
     *   dismissedByInteraction:boolean, layerSurvivedInteraction:boolean}, stop:Function}}
     */
    function watchUserInteraction(deps) {
      // 延迟复核用的定时器（判据可注入：离线环境里"微任务即回调"的假定时器区分不出"当场"与"稍后"）
      const scheduleTimer = typeof deps?.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => window.setTimeout(fn, ms);
      const cancelTimer = typeof deps?.clearTimeout === 'function' ? deps.clearTimeout : (handle) => window.clearTimeout(handle);
      const state = {
        interacted: false,
        lastAt: null,
        /** 强证据：这次交互**当场**把层摘掉了 ⇒ 是用户关的。 */
        dismissedByInteraction: false,
        /** 明确反证：交互发生时层在场、交互之后一拍仍在 ⇒ 这次交互与卡片无关。 */
        layerSurvivedInteraction: false,
      };
      /**
       * 复核一次"层还在不在"：**层还在** ⇒ 这次交互与卡片无关；**层没了** ⇒ 是这次交互把它关掉的
       * （后一次复核会覆盖前一次：最终事实说了算）。
       */
      const review = () => {
        if (overlayProbe().layerInDom === true) state.layerSurvivedInteraction = true;
        else {
          state.dismissedByInteraction = true;
          state.layerSurvivedInteraction = false;
        }
      };
      /** 延迟复核的句柄（`stop()` 要摘干净：留着定时器会在页面换模块后继续跑）。 */
      const lateReviews = new Set();
      const mark = () => {
        state.interacted = true;
        state.lastAt = Date.now();
        state.dismissedByInteraction = false;
        state.layerSurvivedInteraction = false;
        // 层本来就不在场 ⇒ 没有"关掉"这回事（例如卡片从没弹出来过），不必等下一拍。
        if (overlayProbe().layerInDom !== true) return;
        // ① 当场（微任务）：抓"同一个事件里同步摘层"那两条路（点外 / Esc，GUIFrame dismiss 的时序）
        try {
          Promise.resolve().then(review);
        } catch {
          review();
        }
        // ② 一个短延迟后再看一眼：抓"点击之后才在 React 提交里摘层"那条路（面板头部的 ×）
        try {
          const handle = scheduleTimer(() => {
            lateReviews.delete(handle);
            review();
          }, INTERACTION_REVIEW_MS);
          lateReviews.add(handle);
        } catch {
          // 定时器拿不到也不影响 ① 那一条
        }
      };
      const doc = (() => { try { return window.document ?? null; } catch { return null; } })();
      const on = (type, options) => { try { doc?.addEventListener?.(type, mark, options); } catch { /* 挂不上就算了 */ } };
      const off = (type, options) => { try { doc?.removeEventListener?.(type, mark, options); } catch { /* 摘不掉不追究 */ } };
      on('pointerdown', true);
      on('keydown', true);
      on('wheel', { capture: true, passive: true });
      return {
        state,
        stop() {
          off('pointerdown', true);
          off('keydown', true);
          off('wheel', true);
          for (const handle of [...lateReviews]) {
            try {
              cancelTimer(handle);
            } catch {
              // 定时器已经跑过
            }
            lateReviews.delete(handle);
          }
        },
      };
    }

    /**
     * 纯函数：这次消失是不是"用户刚关的"。
     *
     * 判据次序（越靠前越硬）：
     *   ① `dismissedByInteraction` ⇒ **是**（交互当场把层摘掉 —— 这正是 GUIFrame 的 dismiss 时序）；
     *   ② `layerSurvivedInteraction` ⇒ **不是**（交互时层还在、之后才没 ⇒ 平台清栈，别删记录）；
     *   ③ 两者都没记（离线判据合成的旧形状）⇒ 退回窗口判据 `INTERACTION_WINDOW_MS`。
     *
     * 删记录不可逆，所以判据不确定时**倒向保留**：宁可下一次开机多提示一次，也不删用户没看见过的东西。
     */
    function closedByUser(watch, nowMs) {
      const state = watch?.state ?? null;
      if (state === null || state.interacted !== true) return false;
      if (state.dismissedByInteraction === true) return true;
      if (state.layerSurvivedInteraction === true) return false;
      if (!Number.isFinite(state.lastAt)) return true; // 旧形状（只有布尔位）：保守当成用户关的
      return nowMs - state.lastAt <= INTERACTION_WINDOW_MS;
    }

    /**
     * 卡片开出来之后的**守望**：认领记录 + 盯着面板的去留（关掉就把记录清空）。
     *
     * ═══ 三个阶段（同一套心跳）═══
     *  ① **补弹档**（一次都没进过 DOM）：慢节奏长窗口继续开，直到它真的出现 —— 跨过平台服务的补装窗口
     *     （实测：开机 12 次重开可以全落空，根因是浮层宿主还没挂）。
     *     这一档**不看用户交互**：用户能点页面恰恰说明界面活过来了，那正是该补弹的时候。
     *  ② **认领**：层连续在场 `CLAIM_STABLE_TICKS` 拍**且探针说它可见** ⇒ `POST /pending/claim`
     *     （宿主记下"这一趟已经交付过"）。可见性也要过是因为：层在 DOM 里、盒子整个在视口外，
     *     用户其实没看见 —— 那不算交付（记录下一次开机还得再提示一次）。
     *  ③ **守望**（认领之后一直盯着，1 秒一拍）：
     *      · 层没了 + **当场**被用户摘掉 ⇒ **面板是他关的** ⇒ `POST /pending/clear`（记录自动清空）→ 收手；
     *      · 层没了 + 不是用户关的 ⇒ 平台清栈 ⇒ 补开（额度 `WATCH_REOPENS`），用完收手（记录留着不动）。
     *
     * ⚠ 这是「卡片闪一下就没了」的另一半（前一半是自检自杀，见 `overlayProbe`）：
     *   实测时间线 `t=605ms layers:"0"` → `t=1203ms 卡片出现` → `t=1808ms layers:"0"`（卡片没了），
     *   而宿主根**始终在**（是**层栈被清**，不是重挂）。插件这时什么都不做，用户看到的就是"闪一下"。
     *
     * @param {object} gui `gui-frame` 服务
     * @param {object} deps `openResumePanel` 的注入面（多一个 `fetch` 与 `closedAt`）
     * @param {{state:{interacted:boolean, lastAt:number|null}}} watch 用户交互监视器
     * @param {{rectHeight?:number, everOpened?:boolean, now?:Function}} [options] `now` 可注入（离线判据用）
     * @returns {Promise<{claimed:boolean, cleared:boolean, reopens:number, end:string, log:object[]}>}
     */
    async function watchResumeCard(gui, deps, watch, options) {
      const now = typeof options?.now === 'function' ? options.now : () => Date.now();
      const startedAt = Date.now();
      const log = [];
      let reopens = 0;
      let claimed = false;
      let cleared = false;
      // ⚠ 重开必须沿用**最终那个高度**：否则清单长的时候重开的卡片又退回 300px、键又要滚动才够得着。
      const rectHeight = options?.rectHeight;
      const note = (event) => {
        // ⚠ 诊断账**有上限**：守望是长跑（可能几小时），一秒一条会把内存吃光。
        if (log.length < WATCH_LOG_MAX) log.push({ at: Date.now() - startedAt, event });
      };
      const inDom = () => overlayProbe().layerInDom === true;
      const fetchImpl = typeof deps?.fetch === 'function' ? deps.fetch : null;
      const closedAt = typeof deps?.closedAt === 'string' ? deps.closedAt : null;
      const done = (end) => ({ claimed, cleared, reopens, end, log });

      // ① **补弹档**（一次都没弹出来过）
      if (options?.everOpened !== true) {
        const ticks = Math.ceil(OVERLAY_REOPEN_WINDOW_MS / OVERLAY_REOPEN_POLL_MS);
        for (let tick = 0; tick < ticks; tick += 1) {
          await nextTick(OVERLAY_REOPEN_POLL_MS);
          if (inDom()) {
            note('appeared');
            break;
          }
          if (reopens >= OVERLAY_REOPEN_TRIES) {
            note('gave-up');
            return done('never-appeared');
          }
          reopens += 1;
          openResumePanel(gui, deps, { rectHeight }); // 同 id ⇒ 栈里先摘后加，幂等
          note('reopen');
        }
        if (!inDom()) return done('never-appeared');
      }

      // ②③ 认领 + 守望（一直盯着，直到面板被用户关掉 / 补不回来）
      let stableTicks = inDom() ? 1 : 0;
      let reopenBudget = WATCH_REOPENS;
      let claimTries = 0;
      /** 刚重开过、还在等层出现的宽限拍数（见 `REOPEN_GRACE_TICKS`）。 */
      let graceTicks = 0;
      for (;;) {
        await nextTick(WATCH_POLL_MS);
        // ⚠ 一拍只量一次探针：`overlayProbe()` 每读一次就是一次 DOM 查询，重复量会改变取证节奏。
        const probe = overlayProbe();
        if (probe.layerInDom === true) {
          if (stableTicks === 0) note('reappeared');
          graceTicks = 0;
          stableTicks += 1;
          if (!claimed && claimTries < CLAIM_MAX_TRIES && stableTicks >= CLAIM_STABLE_TICKS && probe.visible === true) {
            claimTries += 1;
            claimed = await claimPendingRecord(fetchImpl, closedAt);
            // 只在第一次失败时记一笔：宿主没这版接口时会一直失败，每秒刷一条没有信息量
            if (claimed || claimTries === 1) note(claimed ? 'claimed' : 'claim-failed');
          }
          continue;
        }
        stableTicks = 0;
        // ★ 顺序要紧：先判"用户关的"（最硬的事实：交互之后层才没），再判宽限（刚重开、层还在路上）。
        //   反过来会让"用户关掉 → 立刻重开 → 宽限期还没过"变成又一次重开，用户看到的就是"关不掉"。
        if (closedByUser(watch, now())) {
          // 用户把面板关掉了 ⇒ 记录自动清空
          cleared = await clearPendingRecord(fetchImpl, closedAt);
          note(cleared ? 'closed-by-user' : 'clear-failed');
          return done('closed-by-user');
        }
        if (graceTicks > 0) {
          graceTicks -= 1;
          note('reopen-wait');
          continue;
        }
        if (reopenBudget <= 0) {
          note('gave-up');
          return done('gave-up');
        }
        reopenBudget -= 1;
        reopens += 1;
        graceTicks = REOPEN_GRACE_TICKS;
        openResumePanel(gui, deps, { rectHeight });
        note('reopen');
      }
    }

    /** 只读调试面（`window.__safelyQuit`）：排障时不用猜"到底加载了没、读到了什么"。 */
    function publishDebug(patch) {
      try {
        const current = typeof window.__safelyQuit === 'object' && window.__safelyQuit !== null ? window.__safelyQuit : {};
        window.__safelyQuit = { ...current, ...patch };
      } catch {
        // 没有 window / 被禁 ⇒ 静默跳过
      }
    }

    /**
     * 取服务 → 注册入口 → 把 disposer 挂到调用方 fiber。
     *
     * @param {object} serviceCtx 注入了 `gui-frame` 的 ctx
     * @param {object} ownerCtx 本插件的 ctx（disposer 要挂在它上面）
     * @param {{store:object, initialResume:object|null, sessions:Function, storage:Function}} deps 面板的注入面
     * @param {{running:number}} [plan] 开机读数：角标 = **循环中会话数**（0 ⇒ 不画角标）
     * @returns {object|null} `gui-frame` 服务（没注册成 ⇒ null）
     */
    function registerInto(serviceCtx, ownerCtx, deps, plan) {
      try {
        const gui = typeof serviceCtx.get === 'function'
          ? serviceCtx.get('gui-frame')
          : serviceCtx['gui-frame'];
        if (gui === undefined || gui === null || typeof gui.register !== 'function') return null;

        const Panel = createPanel(deps);
        // 注册那一刻就把当下的读数画上（之后由 `watchRunning` 实时推着走）。
        const badge = badgeOf(plan?.running);

        let off = null;
        try {
          off = gui.register({
            id: ENTRY_ID,
            label: () => TEXT.label,
            order: ENTRY_ORDER,
            kind: 'action',
            source: SOURCE,
            icon: PowerIcon,
            ...(badge === null ? {} : { badge }),
          }, Panel);
        } catch (error) {
          warn('坞注册失败（GUIFrame 侧会给出 GUIF-E-ENTRY-* 错误码）', error);
          return null;
        }
        if (typeof off !== 'function') return null;

        if (ownerCtx !== null && typeof ownerCtx.effect === 'function') {
          // 挂到调用方 fiber：本插件卸载 ⇒ 坞入口一并撤掉，GUIFrame 侧不留残留。
          ownerCtx.effect(() => () => {
            try {
              off();
            } catch {
              // 卸载期失败不再往上抛
            }
          });
        }
        return gui;
      } catch (error) {
        warn('注册链路失败（已吞掉）', error);
        return null;
      }
    }

    /**
     * 把角标推给坞（实时改某一行右侧那个数）。
     *
     * ⚠ **切片面的签名是三参**：`service.__slice('dock').setBadge(callerCtx, id, badge)`
     * （切片就是 `api`，真源 `dsh-gui-frame/src/client/dock/core.mjs` 的 `api.setBadge(callerCtx, id, badge)`）
     * —— 坞实例自己那个 `dock.setBadge(id, badge)` 是**两参**包装，外部拿不到。按两参调会
     * `registry.get(id)` 拿到一个 ctx 对象 ⇒ **静默返回 false**（GUIFrame 侧也栽过同一个坑）。
     *
     * @param {object|null} gui `gui-frame` 服务面
     * @param {object} callerCtx 调用方 ctx（切片约定：第一个参数恒为它；坞侧当前不读）
     * @param {number|null} value 要显示的值（`null` ＝ 不画角标）
     * @returns {boolean} 是否真的推上去了（能力缺席 ⇒ false，界面只是不显示那个数）
     */
    function setDockBadge(gui, callerCtx, value) {
      try {
        if (gui === null || gui === undefined || typeof gui.__slice !== 'function') return false;
        const slice = gui.__slice('dock');
        if (slice === null || slice === undefined || typeof slice.setBadge !== 'function') return false;
        slice.setBadge(callerCtx, ENTRY_ID, value);
        return true;
      } catch (error) {
        warn('角标没推上去（已吞）', error);
        return false;
      }
    }

    /**
     * 盯住**循环中会话数**，有变化就送到两处：① 坞入口的角标（面板行 + 侧栏行读的是同一份
     * `row.badge`）；② 收尾 store（面板里那颗键的悬停说明据此说清"现在关要等几个"）。
     *
     * 为什么住在**模块级**而不是组件里：坞面板关着时组件是卸载的，而侧栏那一行的角标一直都在 ——
     * 订阅挂在这儿，面板不开也照样实时。订阅随本插件 fiber 一起拆（`ownerCtx.effect`）。
     *
     * @param {object} serviceCtx 注入了 `gui-frame` 的 ctx
     * @param {object|null} gui `gui-frame` 服务面（null ⇒ 只更新 store，不推角标）
     * @param {object} store 收尾状态机
     * @param {object} ownerCtx 本插件的 ctx（disposer 挂在它上面）
     * @returns {boolean} 是否真的盯上了（会话服务/列表不可订阅 ⇒ false：角标只是不动）
     */
    function watchRunning(serviceCtx, gui, store, ownerCtx) {
      const sessions = resolveService(serviceCtx, 'sessions');
      const list = sessions === null || sessions === undefined ? null : sessions.list;
      if (list === null || list === undefined || typeof list.getSnapshot !== 'function') return false;
      const push = () => {
        const running = countRunning(list.getSnapshot());
        store.setRunning(running);
        setDockBadge(gui, serviceCtx, badgeOf(running));
      };
      push(); // 先给一次当下的读数（别等第一次变化才显示）
      if (typeof list.subscribe !== 'function') return true;
      let off = null;
      try {
        off = list.subscribe(push);
      } catch (error) {
        warn('订阅会话列表失败（角标不再实时，已吞）', error);
        return true;
      }
      if (typeof off === 'function' && ownerCtx !== null && ownerCtx !== undefined && typeof ownerCtx.effect === 'function') {
        ownerCtx.effect(() => () => {
          try {
            off();
          } catch {
            // 已经拆了
          }
        });
      }
      return true;
    }

    /**
     * 注册前的**一次读数**：上次关的时候谁在跑。
     *
     * 顺序是刻意的（先读后注册）：角标只能在 `register` 那一刻给，晚了坞那一行不会自己变；
     * 读不到就照旧注册（没有角标、没有卡片），一条路都不抛。
     *
     * 有清单且没"看过" ⇒ 顺带把卡片**浮出来**（坞那一行仍照常，两条路互相独立）。
     *
     * @param {object} serviceCtx 注入了 `gui-frame` 的 ctx
     * @param {object} ownerCtx 本插件的 ctx
     */
    async function bootInto(serviceCtx, ownerCtx) {
      const sessionsOf = () => resolveService(serviceCtx, 'sessions');
      // 收尾时随 /close 报上"界面上开着哪些会话"（待续清单的本义，见 readOpenSessionIds）
      const store = createQuitStore({ openSessionIds: () => readOpenSessionIds(sessionsOf(), browserStorage()) });
      try {
        if (ownerCtx !== null && ownerCtx !== undefined && typeof ownerCtx.effect === 'function') {
          ownerCtx.effect(() => () => store.dispose());
        }
      } catch {
        // fiber 已经拆了就算了：状态机自己也会被页面带走
      }
      // 与宿主对齐：收尾中刷新页面 / 热换模块后，界面要接着显示收尾态而不是「关闭 DSH」。
      void store.attach();

      const fetchImpl = browserFetch();
      const model = await readPending(fetchImpl);
      const plan = planBoot(model);
      // 两面都优先用**运行时注入**捕获的那一份（受守卫的服务只有注入拿得到，见 injectedFaces）；
      // 软探测只是退路，覆盖"平台没有这道守卫"的情形。
      const workspaceOf = () => injectedFaces.workspace ?? resolveUiWorkspace(serviceCtx);
      const deps = {
        store,
        initialResume: plan.initialResume,
        sessions: sessionsOf,
      };
      const gui = registerInto(serviceCtx, ownerCtx, deps, { running: countRunning(readListSnapshot(sessionsOf())) });

      // 角标 = **循环中会话数**的实时读数：订阅会话列表，有变化就同时更新坞角标与面板里的悬停说明。
      // 放在注册之后：先按当下读数画上第一帧，再交给订阅接管（模块级 ⇒ 面板关着也照样更新）。
      const watching = watchRunning(serviceCtx, gui, store, ownerCtx);

      // 有清单（清单里有会话）⇒ 把卡片**独立**浮出来（不进坞的按钮面板：那条落点设计上已否掉）。
      //
      // ⚠⚠ 三条纪律都写在这两个调用里（真源与实测见 `openResumeCardWhenReady` 与 `watchResumeCard`）：
      //   ① 冷启动时平台服务晚到、overlay 会"降级件 → dispose → 补装"，**dispose 会清空层栈** ⇒
      //      开机那一下 open 的记录会被清掉 ⇒ 必须"开 → 核验层在不在 DOM → 必要时重开"；
      //   ② 自检（探针）**只用来如实记账，绝不据此关卡片**（判据判错会把用户看得见的卡片当场关掉，
      //      用户看到的就是"闪一下就没了"）；
      //   ③ 卡片的**生死契约**：站稳了就 `claim`（记录从此算交付过），用户把它关掉就
      //      `clear`（记录自动清空）—— 面板是提示的唯一去处，记录只在"还用得上"时存在。
      const cardDeps = {
        model: deps.initialResume,
        sessions: sessionsOf,
        workspace: workspaceOf,
        closedAt: deps.initialResume?.closedAt ?? null,
        fetch: fetchImpl,
      };
      let resumePath = 'none';
      let overlayError = null;
      let overlayProbeData = null;
      let overlayAttempts = 0;
      let overlayWaitMs = 0;
      let overlayRectHeight = cardRect().height;
      let overlayResized = false;
      if (gui !== null && deps.initialResume !== null) {
        const opened = await openResumeCardWhenReady(gui, cardDeps);
        overlayProbeData = opened.probe;
        overlayAttempts = opened.attempts;
        overlayWaitMs = opened.waitedMs;
        overlayRectHeight = opened.rectHeight;
        overlayResized = opened.resized;
        overlayError = opened.overlayError;
        if (opened.handle === null) {
          resumePath = 'none';
        } else if (opened.probe?.layerInDom === true) {
          resumePath = opened.probe.visible ? 'overlay' : 'overlay-unverified';
        } else {
          resumePath = 'none'; // 重开若干次仍没进 DOM：如实说"没弹出来"，不假装
        }
      }

      const report = {
        /**
         * 版本 —— **从宿主读数里取**（宿主那份来自包元数据，见 `lib/index.js` 的 readPackageVersion）。
         * 客户端**不写任何版本字面量**：本包没有构建步骤，两处各写一遍必然漂移（实测中发生过）。
         * 开机第一份自报可能还没读到 `/state`（读数是异步的）⇒ 如实留 `null`，守望结束后那份会带上。
         */
        version: hostVersionOf(store),
        loadedAt: new Date().toISOString(),
        pending: model === null ? null : { closedAt: model.closedAt, total: model.total, running: model.running },
        /** 坞角标此刻显示的读数 = **循环中会话数**（0 ⇒ 没画角标）；`watching` 说它是不是实时的。 */
        badge: badgeOf(store.getSnapshot().running),
        runningNow: store.getSnapshot().running,
        watchingRunning: watching,
        dockRegistered: gui !== null,
        resumePath,
        overlayError,
        /** 浮层探针的**原始读数**（层在不在 DOM / 量到几个盒子 / 盒子与视口多大）——排障时不用再靠人复述。 */
        overlayProbe: overlayProbeData,
        /** 卡片开成之前试了几次、总共花了多久（跨"服务补装窗口"的读数；外壳完整时是 1 次 / ~160ms）。 */
        overlayAttempts,
        overlayWaitMs,
        /** 面板最终用的高度，以及它是不是"因为装不下而按实测调大过"（清单长时才为 true）。 */
        overlayRectHeight,
        overlayResized,
        /** 这张卡片/这条链此刻拿得到哪些面（只读诊断，失败时进 `__safelyQuit.continueFaces`）。 */
        continueFaces: probeContinueFaces(cardDeps),
        lastError: null,
      };
      publishDebug(report);
      // 回传给宿主（`POST /report`）：这条通道让排障不用再靠人复述浏览器里看到了什么。
      void sendReport(fetchImpl, report).then((sent) => publishDebug({ reportSent: sent }));

      // 守望（**刻意不 await**：自报不该被它拖住）：认领记录 + 盯着面板的去留（关掉就清空记录）。
      //  · 已经弹出来过 ⇒ 从"认领"开始，之后一直盯着（面板一关就把记录清空，见 `watchResumeCard`）；
      //  · **一次都没弹出来**（宿主还没挂 / 补装窗口比 7.3s 更长）⇒ 走慢节奏长窗口继续补，
      //    直到它真的出现（外壳迟装时 12 次重开可以全落空，就是这个情形）。
      if (gui !== null && deps.initialResume !== null) {
        const watch = watchUserInteraction();
        const everOpened = resumePath === 'overlay' || resumePath === 'overlay-unverified';
        void watchResumeCard(gui, cardDeps, watch, { rectHeight: overlayRectHeight, everOpened })
          .then((watchResult) => {
            watch.stop();
            const stillInDom = overlayProbe().layerInDom === true;
            const afterWatch = stillInDom ? 'overlay' : 'none';
            publishDebug({ resumeWatch: watchResult, resumePathAfterWatch: afterWatch });
            // 第二次自报：守望的结论（认领了没 / 是不是用户关的 / 重开了几次）也进宿主那份 report。
            void sendReport(fetchImpl, { ...report, resumeWatch: watchResult, resumePathAfterWatch: afterWatch });
          })
          .catch((error) => warn('守望卡片失败（已吞掉）', error));
      }
      try {
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info(
            `[dsh-safely-quit] 客户端半区已加载（版本 ${hostVersionOf(store) ?? '未读到（宿主 /state 还没回来）'}）：循环中会话 ${store.getSnapshot().running} 个`
            + `（角标${watching ? '实时' : '**不实时**：拿不到 sessions 列表'}）；`
            + `待续清单 ${model === null ? '无' : `${model.total} 个会话`}；`
            + `坞入口 ${gui === null ? '未注册' : '已注册'}；卡片路径 ${resumePath}`
            + `（试了 ${overlayAttempts} 次 / ${overlayWaitMs}ms）${overlayError === null ? '' : `（${overlayError}）`}`
            + `；浮层探针 ${overlayProbeData === null ? '没测（这次没弹）' : describeProbe(overlayProbeData)}`,
          );
        }
      } catch {
        // 控制台不可用不追究
      }
    }

    /**
     * 装配：等 `gui-frame` 服务就位 → 读上次的待续清单 → 注册坞入口。
     *
     * 全链路 try/catch：客户端 apply 抛错会打死整页（见文件头），所以这里绝不 rethrow。
     *
     * @param {object} ctx - 客户端 cordis 上下文。
     * @returns {undefined} 恒为 undefined。
     */
    exports.apply = (ctx) => {
      try {
        if (ctx === undefined || ctx === null) return undefined;
        ensureStyles();
        const boot = (target) => {
          void bootInto(target, ctx).catch((error) => warn('启动读数失败（已吞掉）', error));
        };
        if (typeof ctx.inject === 'function') {
          // 运行时注入：服务缺席时不悬置、不抛错，就绪后才回调（本项目的唯一接入口径）。
          ctx.inject(['gui-frame'], (injected) => {
            boot(injected ?? ctx);
          });
          // 「切会话」这一面**只能靠注入拿**（受守卫，见 readService）：平台自己的插件也都把这个
          // 名字写在声明里。用运行时注入 ⇒ 拿不到就一直是 null，「继续」如实报"没接上"；
          // 注入结果同时记进调试面（`window.__safelyQuit.injectFaces`），"服务没来 / 名字变了 /
          // 形状不对"三种静默失败一眼分得开。
          ctx.inject(['uiWorkspace'], (scoped) => {
            const face = readService(scoped, 'uiWorkspace');
            injectedFaces.workspace = typeof face?.openSession === 'function' ? face : null;
            injectedFaceState.uiWorkspace = face === null
              ? 'missing'
              : (injectedFaces.workspace === null ? `no-openSession:${typeof face}` : 'ok');
            publishDebug({ injectFaces: { ...injectedFaceState } });
          });
        } else if (typeof ctx.get === 'function') {
          boot(ctx); // 退路：无 inject 时做一次性探测
        }
      } catch (error) {
        warn('apply 失败（已吞掉，不影响整页）', error);
      }
      return undefined;
    };

    /**
     * 测试缝：离线判据直接调这些成员（`__` 前缀不会被坞读走）。
     *
     * **两组，请按组使用**（这样内部重命名不会让判据成片变红）：
     *   A. **行为面**：纯函数、组件、状态机入口、两条网络出口 —— 判据应该只认这些。
     *   B. **状态/读数面**：只读常量、探针、调试面 —— 判据用来断言"读数长什么样"。
     */
    exports.__test = {
      // ── A. 行为面（纯件 + 入口）──
      CARD_SIZE,
      ENDPOINT,
      OVERLAY_ID,
      PowerIcon,
      QUIT_COMMANDS,
      QUIT_FALLBACK_PHASE,
      QUIT_PHASES,
      QUIT_STATES,
      QUIT_TRANSITIONS,
      ResumeCard,
      TEXT,
      baseName,
      badgeOf,
      bootInto,
      callHost,
      canTransition,
      cardRect,
      claimPendingRecord,
      clearPendingRecord,
      closedByUser,
      continueSession,
      countRunning,
      createPanel,
      createQuitButton,
      createQuitStore,
      createResumeCardLive,
      describePhase,
      describeResume,
      dockRowOf,
      elapsedOf,
      getJson,
      hostVersionOf,
      insideNode,
      isClosingStage,
      noteError,
      nextTick,
      openResumePanel,
      openResumeCardWhenReady,
      openSession,
      parsePending,
      planBoot,
      postJson,
      postQuiet,
      probeContinueFaces,
      publishDebug,
      readOpenSessionIds,
      readPending,
      readService,
      readState,
      reasonSuffix,
      registerInto,
      requestClose,
      requestContinue,
      requestForce,
      resolveUiWorkspace,
      runCommand,
      runningTitleOf,
      sendReport,
      setDockBadge,
      shortId,
      watchResumeCard,
      watchUserInteraction,
      watchRunning,

      // ── B. 状态 / 读数面（只读常量、探针、降级判据）──
      CARD_CHROME_HEIGHT,
      CARD_FIT_SLACK,
      CARD_MAX_VIEWPORT_RATIO,
      CARD_RESIZE_TRIES,
      CLAIM_MAX_TRIES,
      CLAIM_STABLE_TICKS,
      CONFIRM_MS,
      GUI_DOM,
      INTERACTION_REVIEW_MS,
      INTERACTION_WINDOW_MS,
      OFFLINE_STRIKES,
      OVERLAY_OPEN_TRIES,
      OVERLAY_REOPEN_WINDOW_MS,
      OVERLAY_REOPEN_TRIES,
      PENDING_TIMEOUT_MS,
      POLL_MS,
      WATCH_LOG_MAX,
      WATCH_POLL_MS,
      WATCH_REOPENS,
      REOPEN_GRACE_TICKS,
      boxOf,
      cardFitDeficit,
      cardNeededHeight,
      describeProbe,
      hostFailed,
      layerBoxOf,
      overlayLayerNode,
      overlayLayerVisible,
      overlayProbe,
      overlayRootInDom,
      viewportHeight,
    };

    return exports;
  },
});
