/**
 * dsh-safely-quit —— 宿主半：关闭编排 + 待续清单 + 关机拓展服务。
 *
 * 职责：给「关闭 DSH」这件事一个**人类专属**的入口与一套**有序收尾**流程：
 *   点一下 → 在跑的会话各自跑完**当前一步**后停止并**登记** → 全部停稳 → 关闭宿主。
 *
 * ═══ 为什么是这个形状（真源 = 本仓库 `docs/` 下的「复验与修正」与「设计规格」两份）═══
 *   ⚠ 本注释不写死档名与期号：文档改名后这里仍然成立。
 *   平台**自带**优雅关闭：`SIGTERM → interrupt(0) → await fiber.dispose() + await disposeProxy()`，
 *   之后才退出（`dsh/lib/profile-boot-*.js:286-300` 的 `createProcessShutdown`），dispose 会带到
 *   持久化后端那层的逐会话 flush。所以本插件**不绕开**这套流程、也不自己造落盘屏障 ——
 *   它只做平台不做的两件事：**① 让在飞的工作停在安全边界；② 把「谁在跑」记下来**。
 *
 *   ⚠ **不许用 `process.kill(process.pid,'SIGTERM')` 当交棒**：在 Windows 上它是 `TerminateProcess`
 *   —— 进程当场死、平台注册的 SIGTERM 处理器（启动引导段那条）**不会跑**，于是 dispose 期的
 *   最后一次落盘 flush 与其它插件挂在 dispose 上的收尾全被静默跳过。Windows 真子进程实测：
 *   真子进程里 `kill` 后监听从未被回调、exit=1；对照 `emit` 能触发。交棒见 `resignToPlatform`：
 *   **优先请平台自己关**（`ctx.appExit`），其次在进程内派发信号事件，两者都不接才走有上限的兜底自退。
 *
 *   安全边界 = **step 边界**（不是工具调用中间）：`dsh-agent-loop/lib/index.js:492-514` 的 `preStep()`
 *   在每次 step 之前跑瀑布，返回 `{kind:'reject'}` 时 `:538-541` 直接以 `turnEnds={kind:'blocked'}`
 *   退出回合 —— 不抛错、不触发 turn-stopping、**当前 step 已经正常跑完**。因此续跑时不会遇到
 *   "工具结果未知"（`TOOL_OUTCOME_UNKNOWN`）那种"要不要重做"的歧义。
 *
 *   被 reject 的输入**不会归还 inbox**（`:496` 已 claim，reject 也不还），所以清单里必须记下
 *   `droppedInputs` —— 否则用户会以为那些输入执行过了。
 *
 * ═══ 收尾状态机（对外读数，客户端据此选档）═══
 *   `idle` → `waiting` → `done`：**`done` 只在"已经把关闭交出去"（appExit / 信号事件已送达平台）之后才置**；
 *   编排在交棒之前意外失败 ⇒ `failed`（界面显示「重试」，而不是假装正在关）。
 *   ⚠ `failed` **不算这一次进程的关闭名额用完**：用户点「重试」会重新受理一次真关闭（见 handleRoute 的 /close）。
 *   演练（`dryRun`）只快照 + 落清单，**不占这一次进程的关闭名额**（判据见 handleRoute 的 /close）。
 *
 * ═══ 本插件**不做**的事（用户级硬约束）═══
 *   - **不注册任何模型可见工具**：关闭入口只经本文件的 HTTP 路由（人类点击），
 *     与「禁止 AI 自行重启或关闭 DSH」同源（用户级硬约束）。
 *   - **不自动强杀**：卡住时只等待，强杀必须由人在界面上点「立即停止」。
 *     自动超时强杀＝擅自中断在飞 agent 工作，正是那两条规则要防的。
 *   - 不改任何系统配置（计划任务/启动项一律不碰）。
 *
 * ═══ 安全面（本文件自己设门，不依赖任何其它插件）═══
 *   已注册路由绕过页面静态服务那道 token 门，所以本文件自己设门：
 *   ① 只接受回环连接；② 改状态的请求必须同源（GET 另挡 `sec-fetch-site: cross-site`）。
 *   这两道门挡的是**浏览器跨站/跨源**请求；同机的其它进程本来就能直接杀掉 DSH，不在本门的威胁模型里
 *   （详见 `isSameOriginMutation` 的注释 —— 别把这里读成"能挡同机其他进程"）。
 *   另外：`/close` 是**不可逆**动作，因此它还要过 `confirm` 字段一道（见 handleRoute）。
 *
 * ═══ 名字的三层区分（别混，见 cordis.patch.yml）═══
 *   行 id `safely-quit` / 行 name `dsh-safely-quit`（= 浏览器半模块 id）/ 本文件 `name = 'safely-quit'`。
 *
 * ═══ HTTP 接缝的唯一真源 ═══
 *   `ROUTE_PATH` 是本插件路由前缀的**唯一出处**：客户端半（`lib/client.js` 的 `ENDPOINT`）与真机装置
 *   （开发工作区的 `tools/record-lifecycle.mjs`，不在本仓库）都必须与它一致。两道机检看住这条线：`tools/check-client.mjs`
 *   比对客户端产物里的前缀，`test/client.test.mjs` 直接 import 本模块比对常量 —— 谁单独改一处都会变红。
 *
 * ═══ 待续记录的生死契约（设计口径）═══
 *   记录（`pending-resume.json`）**存在 ⟺ 有一份「还没交给过人」的待续清单**。四条规则：
 *    ① **只有本插件的按钮关闭会写**（`POST /close` → beginClose 的两处 writePending）；其它任何关闭方式
 *       （关终端 / Ctrl+C / 断电 / 平台自己的优雅关闭）一律不写 ⇒ 那种情况下不会凭空多出一份记录。
 *    ② **交给过界面就作废**：客户端把卡片显示到屏幕上之后 `POST /pending/claim` 认领 ⇒ 记录写上
 *       `deliveredBy = 本次运行的 RUN_ID`。**下一次开机**（新 RUN_ID）读到它 ⇒ 判定过期、**直接回收**
 *       （`GET /last-pending` 返回 `available:false` + `reaped:true`）。
 *       这一条正是「如果不是通过本插件关闭了 DSH，下次开机不该再看到过时记录」的落点。
 *       同一次运行内刷新页面（F5）仍然算"没交出去过"（`deliveredBy === RUN_ID`）⇒ 卡片照旧出现。
 *    ③ **用户关掉面板就清空**（`POST /pending/clear`）：卡片的每一条关闭路径（点外 / Esc / 面板 × /
 *       点过键之后）都会清掉记录文件 —— 界面上不设「不用了」那颗键：关面板本身就是那个意思。
 *       客户端只在**确证是用户关的**时候才发这条（删记录不可逆，判据不确定时倒向保留）。
 *    ④ **空记录不显示**：记录里**一个会话都没有**（这一刻没有任何 agent loop 被打断）⇒ 面板没有可列的
 *       行，文件也在开机读取时回收。`reason !== 'user-requested'`（例如演练 `dry-run`）同样**不作为待续
 *       提示**（规格 §5）。
 *
 *   **清单里的会话 =「被这次关闭打断的 agent loop」**（设计口径，2026-10-18 明确："我们只继续因为关闭
 *   中断的 agent loop"）：
 *     · **在跑**的 ⇒ 记（`statusAtClose` 一律 `running`）；子代理折算成它所属的顶层会话；
 *     · 界面**开着但空闲**的 ⇒ **不记**：它没有被打断的 loop，把「继续」给它等于凭空造一个任务；
 *     · 本次运行里**翻到过**、关闭时并没在跑的 ⇒ 不记（真机事故：拿"活着的 agent"当范围，卡片列出
 *       16 行几天前就关掉的会话）。
 *   客户端上报的"界面开着哪些会话"（`openSessionIds`）**只进 `scope` 作诊断**，不影响清单内容 ——
 *   "我开着的那个为什么没列？"的答案就是"它当时没在跑"。
 *
 *   **子代理（subagent / AgentTeams 成员）怎么算**（两件事分开）：
 *     · **等停**：算 —— 用 `agents.list()`（全部存活 agent），任何在跑 step 的 agent 都拦在边界上。
 *       只按顶层会话等停会把成员会话 SIGTERM 在 step 中途（真机：日志末尾只有 `step/start`）。
 *     · **清单**：不单列 —— 折算成它**所属的顶层会话**（`topLevelSessionIdOf`）。子代理会话平台拒绝
 *       独立 resume（`ApiSessionSubagentOwnership`）、跑完还会被回收，记它等于在卡片上放一行死链。
 *       "顶层会话自己空闲、名下的子代理在跑"也算这个会话被打断（`stop.kind = delegated`）。
 *
 * ═══ 对外服务：关机拓展（`safelyQuit`）═══
 *   其它插件经 `ctx.inject(['safelyQuit'], …)` 登记「DSH 关闭时要执行的动作（函数或命令）」，由本插件统一
 *   排序、限时、隔离失败地执行（内核见 lib/shutdown-hooks.js）。两条执行入口：插件关闭流程（交棒之前，
 *   预算充足）与宿主 dispose 兜底（Ctrl+C / 外部 SIGTERM；预算受平台 5 秒 grace 约束）。
 *   **本服务不提供"关闭 DSH"的触发口** —— 人类专属入口这条约束不变。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BUDGET_MS, DEFAULT_DISPOSE_BUDGET_MS, HOOK_ERROR_CODE, SERVICE_NAME, createShutdownHooks, positiveOf,
} from './shutdown-hooks.js';

/** cordis 运行时名（与 loader 行 id / 包名都不同）。 */
export const name = 'safely-quit';

/** 本插件路由前缀（浏览器半同源常量；**唯一真源**，见文件头「HTTP 接缝」一节）。 */
export const ROUTE_PATH = '/api/dsh-safely-quit';

/** 本包根目录（`lib/` 的上一层）：版本号的唯一真源 `package.json` 就在这里。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 读包元数据里的版本 —— **版本的唯一真源**。
 *
 * 为什么在这儿读：本仓库没有构建步骤，客户端半是手写产物；版本一旦在两处各写一遍就必然漂移
 * （实测中发生过：包元数据与客户端日志里各写着一个不同的版号，谁也不报错）。现在客户端半不自带任何
 * 版本字面量，它经
 * `GET /state` 的 `version` 字段读回这里 ⇒「这个包装的是哪一版」全链路只有一个答案。
 *
 * 读不动（文件缺失 / 不是 JSON）⇒ null：诊断面如实留空，绝不拿猜的值充数。
 */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const version = pkg?.version;
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : null;
  } catch {
    return null;
  }
}

/** 本插件的版本（= 包元数据那一处；读不动为 null）。 */
export const PLUGIN_VERSION = readPackageVersion();

/** 收尾等待的轮询间隔：只决定状态刷新与落清单的时机，不决定响应性。 */
const POLL_MS = 250;

/** 请求体上限（`/close` 只收一个小 JSON；不设上限的读体会被一个不结束的请求顶住）。 */
const BODY_MAX_BYTES = 4096;

/**
 * 客户端上报「界面开着的会话」的条数上限。
 *
 * 请求体已经限过大小，这里再防一次**形状**：本平台一个主视图 ⇒ 正常 0 或 1 个，给到 32 只为
 * "多标签页 / 平台以后支持并列视图"留余量。超出的部分直接丢 —— 一张几十行的清单多半是发错了。
 */
const MAX_OPEN_SESSION_IDS = 32;

/** 用户点「立即停止」后，再给多少毫秒让被取消的 agent 真正静默下来。 */
const FORCE_GRACE_MS = 10000;

/**
 * **本次宿主运行**的标识（进程启动时生成一次）。
 *
 * 用途只有一处但很关键：判断一份待续记录是不是"已经在更早的某次开机里交给过界面了"。
 * 用随机 id 而不是 pid：Windows 的 pid 会被复用，用 pid 会把"上一次运行的记录"误判成"本次运行已认领"。
 */
const RUN_ID = randomUUID();

/**
 * 关机拓展的两档预算缺省值 —— **都取自内核导出的那一份**（`shutdown-hooks.js` 的
 * `DEFAULT_BUDGET_MS` 与 `DEFAULT_DISPOSE_BUDGET_MS`），本文件不另写数字：
 * 同一阈值两处定义，早晚只会改到一处。
 */
const DEFAULT_HOOK_BUDGET_MS = DEFAULT_BUDGET_MS;

/**
 * 交棒之后**兜底自退**的两个等待上限（毫秒）。
 *
 * 平台那条路自己带 5 秒强退上限（`profile-boot` 的 `createProcessShutdown`：`timeoutMs = 5e3`），
 * 所以这里给足 10 秒只为"平台接住了但迟迟不退"的极端情形；**一个接手的都没有**时用 1.5 秒快退。
 * 兜底定时器一律 `unref()`：它只负责"卡住时把进程推下去"，不该把正要退出的进程拖住。
 */
const HANDOFF_FALLBACK_MS = 10000;
const HANDOFF_NO_HANDLER_MS = 1500;

/** **生产默认的兜底自退**：就是真退出。单独具名只为一件事 —— 让判据能按**身份**断言它还在（见下）。 */
function defaultHandoffExit(code) {
  process.exit(code);
}

/**
 * 兜底自退**实际调用**的函数 —— 只为离线判据留的可替换点（生产恒为 `defaultHandoffExit`）。
 *
 * 为什么必须有这个点：判据要能验"兜底真的会退"，但**绝不能让判据进程自己被它杀掉** ——
 * 那样测试会在打印结论之前就 exit 0，读起来是绿的、其实一条都没跑完（本仓库真踩过这一脚）。
 * 离线判据把它换成记数器；生产路径不改它。
 *
 * ⚠ **这条缝的边界**（护栏判据钉着它，见 `test/host.test.mjs` 的「判据缝」两组）：
 *   · 只有**测试**可以换它（`__test.setHandoffExit`，传非函数即复位）；
 *   · 默认值必须是**真退出**（`defaultHandoffExit`，函数体就是 `process.exit`）。
 *     不许换成记数器 / 日志器 / 任何"看起来退了其实没退"的可注入替身 —— 那样门禁会永久瞎掉：
 *     判据照样全绿，而真机上一次"平台没接住"就再没人把进程推下去；
 *   · 生产代码**除这里之外**不许读写它，也不许另开一条退出路径绕过它。
 */
let handoffExit = defaultHandoffExit;

// ── 路径 ──────────────────────────────────────────────────────────────────────

/**
 * DSH 主目录：优先环境变量 `DSH_HOME`，其次 `~/.dsh` —— 与平台 `resolveDshHome` **同口径**：
 *   · 只认**去掉首尾空白后仍非空**的值（纯空白＝没设，平台就是这么判的）；
 *   · 一律返回**绝对路径**（相对值按当前工作目录解析，平台也这样）。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/**
 * 「确保目录 + 写一份 JSON」—— 本文件三处落盘共用（待续清单 / 计划内关闭标记 / 客户端自报）。
 * **会抛**：这一次失败该"记账并继续"还是"如实报错"，由调用方决定。
 */
function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** 本插件的私有目录（不侵入平台既有文件）。 */
function storageDir() {
  return join(dshHome(), 'storages', 'safely-quit');
}

/** 待续清单：启动半区按它决定要不要提示续跑。 */
function pendingFile() {
  return join(storageDir(), 'pending-resume.json');
}

/** 计划内关闭标记：用来把「人点的关闭」与「崩溃/断电」分开（只有前者才提示续跑）。 */
function markerFile() {
  return join(storageDir(), 'intentional-shutdown.json');
}

/** 客户端自报：浏览器半区每次装配时写一份，排障时宿主这边能读回来（只读通道 GET /report）。 */
function reportFile() {
  return join(storageDir(), 'client-report.json');
}

// ── 守卫（本插件自己的两道门：只服务回环连接 + 改状态必须同源）──────────

/** 只把真正的回环地址当自己人；取不到地址（不是真实请求上下文）一律拒绝。 */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * 改变状态的请求必须是**同源浏览器**请求：要么 `origin` 与 `host` 同源且 host 是回环，
 * 要么没有 `origin` 但 `sec-fetch-site: same-origin`（浏览器对同源 POST 会带其中一个）。
 * 跨站表单 / 跨站 fetch / 命令行裸 POST 都拿不到这两样，因此被挡在门外。
 *
 * ⚠ 这道门挡的是**浏览器跨站/跨源**，**不挡同机其他进程**：同机任意进程补一个
 * `sec-fetch-site: same-origin` 头就能过门。这不是缺陷（同机进程本来就能直接杀掉 DSH，杀进程不需要
 * 经过本插件），但别把它读成"能挡同机其他进程"，也别据此把威胁模型写宽。真要挡同机其他进程，得引入
 * 每次运行随机生成、由页面拿到的 token（属产品口径决策，见 README 的安全一节）。
 */
function isSameOriginMutation(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof host !== 'string') return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host && loopbackHost;
    } catch {
      return false;
    }
  }
  return loopbackHost && req.headers['sec-fetch-site'] === 'same-origin';
}

// ── HTTP 小工具 ──────────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 读请求体（JSON，带上限）。空体返回 `null`；超限抛 413。 */
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('request body must be JSON');
    error.statusCode = 400;
    throw error;
  }
}

// ── 取值小工具 ────────────────────────────────────────────────────────────────

/** 取第一个非空字符串，都没有则 null（平台字段名多版本共存时避免猜错就崩）。 */
function pickString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/** Agent 的会话 id（与 `ctx.agents.get(id)` 同口径）。 */
function agentIdOf(agent) {
  return pickString(agent?.id);
}

/**
 * 注册表里**全部存活 agent** —— 顶层会话 **+ 子代理**（subagent / AgentTeams 成员 / fork worker）。
 *
 * ⚠ **等停集合必须用它，不能用 `roots()`**：`roots()` 只给 `owner === undefined` 的顶层会话
 * （`dsh-agent` 的 `AgentRegistry.roots()`），而子代理也在同一个注册表里、也在跑 step ——
 * 只按顶层会话等停，它们就会被 SIGTERM **在 step 中途带走**（真机：成员会话日志末尾只有 `step/start`、
 * 没有 `turn/end`，父会话拿到的是被掐断的结果）。pre-step 拦截本来就是按 agent id 生效的，
 * 把子代理的 id 放进停止集，它们一样会停在 step 边界。
 *
 * 但**清单只记顶层会话**（子代理会话平台拒绝独立 resume、跑完还会被回收）—— 清单那一侧的取舍
 * 见 `snapshotForClose`，两件事分开走。
 *
 * `list()` 缺席（更老的平台包）时退回 `roots()`：**明知会少等子代理**，但比"一个都不等"强。
 *
 * @param {object} ctx 宿主上下文（`agents` 服务由平台注入）
 * @returns {object[]} 存活 agent 数组（拿不到服务 ⇒ 空数组）
 */
function liveAgents(ctx) {
  const registry = ctx?.agents;
  if (registry === null || registry === undefined) return [];
  if (typeof registry.list === 'function') {
    const all = registry.list();
    if (Array.isArray(all)) return all;
  }
  return typeof registry.roots === 'function' ? (registry.roots() ?? []) : [];
}

/**
 * 某个 agent 所属的**顶层会话 id**（把子代理上溯到"能被用户继续"的那个会话）。
 *
 * 为什么需要上溯：清单里的一行是要给用户点「继续」的。子代理会话两条都过不去 ——
 *   ① 平台拒绝独立 resume（`ApiSessionSubagentOwnership`：它有 subagent owner）；
 *   ② 它跑完会被回收（真机实测：`~/.dsh/subagent-gc-backup/<项目>/<childId>`）。
 * 所以"有子代理在跑"这件事必须折算成它**所属的顶层会话**那一行。
 *
 * 怎么上溯：注册表把"谁建的"记在**表项**上而不是 agent 对象上（`enter(id, agent, owner)`），
 * 公开面只给了 `isOwnedBy(childId, candidate)` ⇒ 只能拿候选父逐个问。层级很浅（成员会话通常 1~2 层），
 * 8 层只是兜底（防环 / 防异常深）。
 *
 * 上溯不到（父已不在 / 老平台没有 `isOwnedBy`）⇒ **原样返回**：宁可记下这个子会话（开机可能显示
 * "这个会话不在了"），也不能因为映射不出来就把"有活在跑"整个吞掉。
 *
 * @param {object} ctx 宿主上下文
 * @param {string} id 任意 agent / 会话 id
 * @returns {string} 顶层会话 id（自己的 owner 为空时就是它自己）
 */
function topLevelSessionIdOf(ctx, id) {
  const registry = ctx?.agents;
  if (typeof registry?.isOwnedBy !== 'function') return id;
  const all = liveAgents(ctx);
  let current = id;
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = all.find((agent) => {
      try {
        return registry.isOwnedBy(current, agent) === true;
      } catch {
        return false;
      }
    });
    if (parent === undefined) return current;
    const parentId = agentIdOf(parent);
    if (parentId === null || parentId === current) return current;
    current = parentId;
  }
  return current;
}

/**
 * 关闭开始那一刻，把一个 agent 记成清单里的一行。
 *
 * ⚠ `cwd` / `title` 走多路径尝试：平台 Session 的形状以 DSH 0.2.0-rc.2 实读的 `dsh-session` 类型为准，
 * 取不到就老实写 null，**不猜、不编**（这两个字段只影响启动期卡片的展示）。
 */
function describeAgent(agent) {
  const session = agent?.session ?? null;
  return {
    sessionId: agentIdOf(agent) ?? 'unknown',
    status: agent?.status === 'running' ? 'running' : 'idle',
    cwd: pickString(session?.header?.cwd, session?.cwd, session?.meta?.cwd),
    title: pickString(session?.header?.title, session?.title, session?.meta?.title),
  };
}

/**
 * 读客户端上报的「界面开着的会话」。
 *
 * 三种取值必须分得开，因为它们代表三件不同的事：
 *   · `null` —— **没上报**（老客户端 / 命令行演练）⇒ 宿主不知道界面开着什么，只能记在跑的；
 *   · `[]`   —— 上报了"一个都没开"⇒ 这正是"上次关闭一个会话都没开"那种正常情形；
 *   · `[id…]`—— 界面上开着的那些（本平台一个主视图 ⇒ 正常 0 或 1 个）。
 *
 * 形状不对的条目直接丢（对外数据不信任）；重复的按首次出现保留（同一行记两遍会让卡片列重）。
 */
function readOpenSessionIds(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id === '' || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_OPEN_SESSION_IDS) break;
  }
  return out;
}

/**
 * 客户端报的"这份开着的会话是怎么读出来的"（诊断用）：只收短标识（字母 / 连字符，≤32 字符）。
 *
 * 为什么连这个也记：这张卡片的错法有两种 —— "列多了"（读数口径错）与"该列的没列"
 * （客户端读不出来）。清单里只有会话行，看不出是哪一种；带上来源，开机复用同一份记录就能分辨。
 */
function readOpenSource(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > 32 || !/^[A-Za-z-]+$/.test(text)) return null;
  return text;
}

/**
 * 关闭快照 —— **只记「被这次关闭打断的 agent loop」**（设计口径，2026-10-18 明确：
 * "我们只继续因为关闭中断的 agent loop"）。
 *
 * 所以只取**在跑**的 agent：
 *   · 界面开着但当时空闲的会话 ⇒ **不记**：它没有被打断的 loop，"继续"它等于凭空造一个任务；
 *   · 本次运行里翻到过、关闭时并没在跑的会话 ⇒ 不记（真机事故：这样记会列出 16 行几天前就关掉的）；
 *   · 在跑的 ⇒ 记，`statusAtClose` 一律 `running`（它们就是被 step 边界打断的那批）。
 *
 * **子代理一律折算成它所属的顶层会话**（`topLevelSessionIdOf`）：子代理在跑 ⇒ 记它的顶层会话
 * （自己空闲也算被打断，`stop.kind` 记 `delegated`）。理由见 `topLevelSessionIdOf`：子代理会话平台
 * 拒绝独立 resume、跑完还会被回收，记它等于记一行死链。
 *
 * 客户端上报的"界面开着哪些会话"**不进快照**，只进 `scope`（诊断：回答"我开着的那个为什么没列"——
 * 因为它当时没在跑）。
 *
 * @param {object} ctx 宿主上下文
 * @returns {object[]} 清单行（`describeAgent` 的形状 + `selfRunning` / `delegated` 两个留痕位）
 */
function snapshotForClose(ctx) {
  const agents = liveAgents(ctx);
  const topOf = new Map();
  for (const agent of agents) {
    const id = agentIdOf(agent);
    if (id !== null) topOf.set(id, topLevelSessionIdOf(ctx, id));
  }
  const rows = new Map();
  const rowOf = (topId) => {
    let row = rows.get(topId);
    if (row === undefined) {
      row = { sessionId: topId, status: 'running', cwd: null, title: null, selfRunning: false, delegated: false };
      rows.set(topId, row);
    }
    return row;
  };
  for (const agent of agents) {
    const id = agentIdOf(agent);
    if (id === null || agent?.status !== 'running') continue;
    const topId = topOf.get(id) ?? id;
    const row = rowOf(topId);
    if (id === topId) {
      const described = describeAgent(agent);
      row.cwd = described.cwd;
      row.title = described.title;
      row.selfRunning = true;
    } else {
      // 子代理在跑、顶层会话自己可能空闲：这次关闭打断的是它名下的工作 ⇒ 也算它被打断
      row.delegated = true;
      const parent = agents.find((candidate) => agentIdOf(candidate) === topId);
      if (parent !== undefined) {
        const described = describeAgent(parent);
        row.cwd = row.cwd ?? described.cwd;
        row.title = row.title ?? described.title;
      }
    }
  }
  return [...rows.values()];
}

/**
 * 清单里那一行的**停止方式**（只作留痕；客户端不读它）：
 *   · `step-boundary` —— 关闭那一刻它自己在跑，被停在了 step 边界；
 *   · `delegated`     —— 它自己空闲，但**它名下的子代理在跑**，被打断的是那部分工作。
 * （`already-idle` 只为读旧记录而保留在判别里，新记录不会再产生这一档。）
 */
function stopKindOf(row) {
  if (row?.status !== 'running') return 'already-idle';
  if (row?.delegated === true && row?.selfRunning !== true) return 'delegated';
  return 'step-boundary';
}

/**
 * 这一份清单是**按什么范围**记的（进记录、也进 `/state`）：
 * "开机为什么只列了这几行 / 为什么列了这么多"的答案，都在这里，不必再靠推。
 */
function describeScope(openIds, rows, source) {
  return {
    /** 界面开着的会话数（`null` = 客户端没上报）。**只作诊断**：开着但没在跑的不会进清单。 */
    open: openIds === null ? null : openIds.length,
    /** 那份读数怎么来的（`mainView` / `selection-store` / `none`；null = 没上报）。 */
    source: openIds === null ? null : (source ?? 'unknown'),
    /** 关闭那一刻在跑的会话数（= 清单条数；留两处只为对账）。 */
    running: rows.filter((row) => row.status === 'running').length,
    /** 最终记进清单的会话数。 */
    recorded: rows.length,
  };
}

// ── 收尾状态机 ────────────────────────────────────────────────────────────────

/**
 * 一次收尾的全程状态。
 *
 * `stage`：`idle`（平常）→ `waiting`（已下令、等各会话跑完当前步）
 *   → `done`（**已经把关闭交出去**：`appExit` 已调用 / 信号事件已送达平台）或 `failed`（编排在交棒之前就中断了）。
 *   把 `done` 与"成功"绑在一起、把失败单列一档，是为了让界面说真话：落盘失败不该显示成"正在关闭"，
 *   编排中断也不该显示成"已关闭"。
 *
 * 演练（`dryRun`）从 `idle` 到 `done`：只做快照与落清单，**不下停止令、不关宿主、不跑关机拓展**，
 * 而且**不占这一次进程的关闭名额** —— 演练之后 `/close` 仍然受理真关闭（它是排障手段，不是关闭）。
 *
 * @param {{hooks?:object, budgets?:object}} [setup] `hooks` = 关机拓展注册表；`budgets` = 两档预算（apply 传入）
 */
function createSession(setup) {
  return {
    stage: 'idle',
    dryRun: false,
    startedAt: null,
    startedAtMs: null,
    finishedAt: null,
    /** 已下令「跑完当前一步就停」的 sessionId 集合 —— pre-step 拦截器认这个集合（等待期间新变忙的会补进来）。 */
    stopIds: new Set(),
    /** 关闭开始那一刻的全量快照（含当时已空闲的；等待期间新变忙的会补进去）。 */
    snapshot: [],
    /** 这份快照是**按什么范围**记的（见 describeScope）：开机"为什么只列了这几行"的答案。 */
    snapshotScope: null,
    /** 这一轮实际等到了尚未静默的 sessionId。 */
    pendingNow: [],
    /** sessionId → 被 reject 丢弃、未执行的输入条数。 */
    dropped: new Map(),
    forceRequested: false,
    forceRequestedAtMs: null,
    lastError: null,
    /** 落盘类失败（清单 / 标记）逐条留账：关闭照走，但读数必须说清哪一步没写成。 */
    bookkeepingErrors: [],
    /** 这一趟写下的待续记录的 `closedAt`（编排失败时用它判断该不该把那份记录标成失败）。 */
    recordClosedAt: null,
    /** 最近一次开机读数（`GET /last-pending`）的裁决 —— 见 publicState 的 `lastPending`。 */
    lastPending: null,
    /** 这一趟交棒走的哪条路（`{via, fallbackMs}`，见 resignToPlatform；只作诊断读数）。 */
    handoff: null,
    /** 真关闭的受理哨兵：`/close` 在**读请求体之前**同步占位，堵住两条并发 /close 各起一套编排。 */
    closeAccepted: false,
    /** 这一趟「继续」接过的会话（sessionId → 时间）：同一次点击的重复到达不再投第二条。 */
    continued: new Map(),
    /** 「继续」用的会话服务作用域（`sessionController` / `sessions`；没来 ⇒ null，继续会如实报没接上）。 */
    continueScope: null,
    /** 最近一次「继续」的结果（`/state` 的 `lastContinue`，排障用）。 */
    lastContinue: null,
    /** 关机拓展（外部插件登记的动作）：注册表 + 本趟进度账。 */
    hooks: setup?.hooks ?? null,
    hookPhase: 'idle',
    hookRun: null,
    /** 预算（毫秒）：`hookBudgetMs` 关闭流程那一趟 / `hookTimeoutMs` 单条缺省 / `disposeBudgetMs` 兜底那一趟。 */
    budgets: setup?.budgets ?? null,
  };
}


/** 关机拓展对界面的只读视图（界面据此把"正在执行关机拓展"说清楚，不必翻日志）。 */
function hooksView(session) {
  const hooks = session.hooks;
  const list = hooks === null || hooks === undefined || typeof hooks.list !== 'function' ? [] : hooks.list();
  const last = session.hookRun ?? (hooks !== null && hooks !== undefined && typeof hooks.lastRun === 'function' ? hooks.lastRun() : null);
  const finished = list.filter((row) => row.status === 'done' || row.status === 'failed' || row.status === 'skipped').length;
  return {
    phase: session.hookPhase ?? 'idle',
    total: list.length,
    finished,
    failed: list.filter((row) => row.status === 'failed').length,
    /** 正在跑的那一条（没在跑 ⇒ null）。 */
    running: list.find((row) => row.status === 'running')?.id ?? null,
    /** 逐条明细（排障：某条为什么没跑成，看这里的 error）。 */
    entries: list.map((row) => ({ id: row.id, label: row.label, status: row.status, ms: row.ms, error: row.error })),
    lastRunMs: Number.isFinite(last?.elapsedMs) ? last.elapsedMs : null,
  };
}

/** 给客户端的只读视图（不含内部集合）。 */
function publicState(session) {
  return {
    stage: session.stage,
    /** 这次收尾是否已失败（编排在交棒之前中断）——界面据此显示「重试」而不是"正在关闭"。 */
    failed: session.stage === 'failed',
    dryRun: session.dryRun,
    /** 插件版本：**唯一真源是包元数据**（见 readPackageVersion）——客户端不自带版本字面量，一律读这一处。 */
    version: PLUGIN_VERSION,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    hostPid: process.pid,
    total: session.snapshot.length,
    /** 关闭开始那一刻在跑的会话数。 */
    runningAtClose: session.snapshot.filter((row) => row.status === 'running').length,
    /** 这份清单是按什么范围记的（界面开着几个 / 在跑几个 / 记了几个；见 describeScope）。 */
    scope: session.snapshotScope === null ? null : { ...session.snapshotScope },
    /** 此刻还没停稳的会话 id。 */
    pending: [...session.pendingNow],
    /** 已停稳的会话 id。 */
    stopped: session.snapshot
      .map((row) => row.sessionId)
      .filter((id) => !session.pendingNow.includes(id)),
    dropped: Object.fromEntries(session.dropped),
    forceRequested: session.forceRequested,
    elapsedMs: session.startedAtMs === null ? null : Date.now() - session.startedAtMs,
    lastError: session.lastError,
    /** 落盘失败（清单/标记）逐条留账：这些失败不阻断关闭，但不能不看见。 */
    bookkeepingErrors: [...session.bookkeepingErrors],
    /** 这一趟交棒走的哪条路（`appExit` / `emit` / `exit`；没交棒 ⇒ null）——排障一眼看到。 */
    handoff: session.handoff === null ? null : { ...session.handoff },
    /**
     * 关机拓展（外部插件登记的动作）的进度。
     */
    hooks: hooksView(session),
    /**
     * **开机读数的裁决**（最近一次 `GET /last-pending` 的结果；没读过就是 null）。
     *
     * 为什么必须留这份读数：记录"没弹卡片"时，盘上往往已经没有记录了 —— 只剩"有没有提示过"
     * 这一个事实，而"为什么没提示"（不存在 / 坏了 / 不是计划内关闭 / 没有在跑的会话 / 已交付过）
     * 只写在 stderr 那一行里。人看不到 stderr 时，这一档就变成了只能靠猜。
     */
    lastPending: session.lastPending === null ? null : { ...session.lastPending },
    /**
     * 最近一次「继续」的结果（`POST /continue` 的回执原样留一份）。
     *
     * 为什么值得留：卡片上那颗键点下去之后，用户看到的只是"已接上 / 没接上"；失败到底是哪一档
     * （会话不在 / 会话服务缺席 / 宿主拒绝）此前只能靠界面上那四个字猜。
     */
    lastContinue: session.lastContinue === null ? null : { ...session.lastContinue },
  };
}


/** 落盘：待续清单（规格 §4 的数据契约；两个「交付」字段见文件头的生死契约）。 */
function writePending(session, reason) {
  const closedAt = new Date().toISOString();
  const payload = {
    version: 2,
    reason,
    closedAt,
    hostPid: process.pid,
    /** 交付标记：客户端把卡片显示到屏幕上之后才写（`POST /pending/claim`）。 */
    deliveredAt: null,
    deliveredBy: null,
    /**
     * 这一份清单是**按什么范围**记的（界面开着几个 / 在跑几个 / 怎么读出来的 / 最终记了几个）。
     * 只作诊断：开机卡片按 `sessions` 渲染，不读这一块。
     */
    scope: session.snapshotScope === null ? null : { ...session.snapshotScope },
    sessions: session.snapshot.map((row) => ({
      sessionId: row.sessionId,
      cwd: row.cwd,
      title: row.title,
      statusAtClose: row.status,
      stop: {
        kind: stopKindOf(row),
        at: closedAt,
        droppedInputs: session.dropped.get(row.sessionId) ?? 0,
      },
    })),
  };
  writeJson(pendingFile(), payload);
  // 记下"这一趟写的那份记录"的时间戳：编排失败时才知道该不该把它标成失败（见 markPendingFailed）。
  session.recordClosedAt = closedAt;
  return payload;
}

/**
 * 把这一趟写下的待续记录标成「关闭失败」—— 它**并不代表真关过机**。
 *
 * 为什么必须处置它：编排失败时宿主并没有关，那份 `user-requested` 记录要是留着，下一次开机会把它
 * 当成"上次用插件关过机" ⇒ 弹一张「上次关闭时有 N 个会话在跑」的卡片，而那件事根本没发生过。
 * 标成 `close-failed` 之后，开机读数按 `reason !== 'user-requested'` **当场回收**它
 * （判据表见 loadPendingForBoot），既不误导，又把现场留在盘上给排障看。
 *
 * 只动**本趟写的**那一份：盘上记录的 `closedAt` 与 `session.recordClosedAt` 不一致时不动它
 * （可能是更早一次成功关闭留下的，或者是别人写的）。
 *
 * @returns {boolean} 是否真的改了盘上的记录
 */
function markPendingFailed(session, reason) {
  try {
    const record = readRecord();
    if (record === null) return false;
    if (typeof record.closedAt !== 'string' || record.closedAt !== session.recordClosedAt) return false;
    const next = {
      ...record,
      reason: 'close-failed',
      failedAt: new Date().toISOString(),
      failedReason: String(reason ?? '编排失败'),
      lastError: session.lastError ?? null,
    };
    writeJson(pendingFile(), next);
    noteRecord('关闭编排失败：这一趟的待续记录已标成 close-failed（开机读数会回收它，不再误报续跑）');
    return true;
  } catch (error) {
    noteRecord(`标记失败记录时出错（不追究）：${String(error?.message ?? error)}`);
    return false;
  }
}

// ── 待续记录的生死（见文件头的四条规则）─────────────────────────────────────────

/** 记一条回收/认领的痕迹（进 stderr：`dsh web` 那个窗口里看得见，排障不必靠猜）。 */
function noteRecord(message) {
  try {
    process.stderr.write(`[safely-quit] ${message}\n`);
  } catch {
    // 写日志绝不能再抛：调用方多在 catch 段或定时器回调里，从这里抛出去会打断它们。
  }
}

/** 读记录；读不到 / 形状不对 ⇒ null。 */
function readRecord() {
  const file = pendingFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 回收记录文件（开机回收 / 用户关掉面板）。删不掉不抛。 */
function dropRecord() {
  try {
    unlinkSync(pendingFile());
    return true;
  } catch {
    return false;
  }
}

/** 记录里"关闭那一刻在跑"的会话数（只作诊断读数与标题报数用；0 个不代表记录没有可列的行）。 */
function interruptedCount(record) {
  const rows = Array.isArray(record?.sessions) ? record.sessions : [];
  return rows.filter((row) => row?.statusAtClose === 'running').length;
}

/**
 * 开机读记录 —— **唯一会回收记录的读**（`GET /last-pending`）。
 *
 * 四种"不作为待续提示"的情形一律**当场回收**（删文件）并在回执里说清为什么，这样"记录存在"这件事
 * 始终只意味着一种东西：**有一份还没交给过人的待续清单**。
 *
 * | 情形 | 判据 | 为什么回收 |
 * |---|---|---|
 * | 坏了 | JSON 读不出来 | 读不动的记录没有用处 |
 * | 不是计划内关闭 | `reason !== 'user-requested'` | 规格 §5：只有用户点的关闭才提示；演练记录不该在开机变成提示 |
 * | 没有内容 | 记录里的会话数 = 0 | 一个会话都没有，面板没有可列的行；留着只会烂在盘上 |
 * | 过期 | `deliveredBy` 有值且 ≠ 本次 RUN_ID | 那份已经交给过界面，而这一次 DSH 不是用插件关的 ⇒ 再提示就是骗人 |
 *
 * @param {string} [runId] 本次运行标识（判据用；缺省取模块级 RUN_ID）
 * @returns {{available:boolean, pending?:object, reaped?:boolean, why?:string, closedAt?:string|null}}
 */
function loadPendingForBoot(runId = RUN_ID) {
  const file = pendingFile();
  if (!existsSync(file)) return { available: false };
  const record = readRecord();
  if (record === null) {
    dropRecord();
    noteRecord('开机读数：记录读不动 ⇒ 回收');
    return { available: false, reaped: true, why: 'unreadable' };
  }
  const closedAt = typeof record.closedAt === 'string' ? record.closedAt : null;
  if (record.reason !== 'user-requested') {
    dropRecord();
    noteRecord(`开机读数：不是计划内关闭（reason=${String(record.reason)}）⇒ 回收，不提示续跑`);
    return { available: false, reaped: true, why: 'not-intentional', reason: record.reason ?? null, closedAt };
  }
  // 记录里**只要还有会话**就交给界面 —— 关闭那一刻恰好一个都没在跑时，卡片列出来的是
  // 「上次关闭时开着的会话」，给人一个回到现场的入口（没有可列的行才是"没有内容"）。
  const recorded = Array.isArray(record.sessions) ? record.sessions : [];
  if (recorded.length === 0) {
    dropRecord();
    noteRecord('开机读数：记录里一个会话都没有 ⇒ 回收，不提示');
    return { available: false, reaped: true, why: 'empty', closedAt };
  }
  const deliveredBy = typeof record.deliveredBy === 'string' ? record.deliveredBy : null;
  if (deliveredBy !== null && deliveredBy !== runId) {
    dropRecord();
    noteRecord(`开机读数：这份记录在更早的一次开机里已经交给过界面（deliveredAt=${String(record.deliveredAt)}），而这一次 DSH 不是用插件关的 ⇒ 回收`);
    return { available: false, reaped: true, why: 'stale', closedAt, deliveredAt: record.deliveredAt ?? null };
  }
  return { available: true, pending: record, delivered: deliveredBy === runId };
}

/**
 * 认领：客户端**把卡片真的显示到屏幕上**之后调它（`POST /pending/claim`）。
 *
 * 为什么不放在"读记录"那一刻：接口读过 ≠ 界面出现过（浮层宿主没挂时接口照样成功）。放在这里，
 * 「一次都没弹出来」的记录还是"没交出去过"，下次开机会再试一次 —— 而不是白白作废。
 *
 * @returns {{ok:boolean, stamped?:boolean, already?:boolean, why?:string}}
 */
function claimPending(closedAt) {
  const record = readRecord();
  if (record === null) return { ok: false, why: 'no-record' };
  if (typeof closedAt !== 'string' || closedAt === '' || record.closedAt !== closedAt) {
    return { ok: false, why: 'closedAt-mismatch', current: typeof record.closedAt === 'string' ? record.closedAt : null };
  }
  const deliveredBy = typeof record.deliveredBy === 'string' ? record.deliveredBy : null;
  if (deliveredBy === RUN_ID) return { ok: true, already: true };
  const next = { ...record, deliveredAt: new Date().toISOString(), deliveredBy: RUN_ID };
  try {
    writeJson(pendingFile(), next);
  } catch (error) {
    return { ok: false, why: 'write-failed', error: String(error?.message ?? error) };
  }
  noteRecord(`待续记录已认领（closedAt=${closedAt}）：本次运行把卡片交给了界面`);
  return { ok: true, stamped: true };
}

/**
 * 清空：**用户把面板关掉**了（`POST /pending/clear`）—— 卡片上的每一条关闭路径都会走到这里。
 *
 * `closedAt` 是道保险：客户端看到的是哪一份、就只许清哪一份。文件已经被新的一次关闭覆盖（时间戳变了）
 * ⇒ 拒绝删除，免得把"刚存好的那份"给误删了。
 *
 * @returns {{ok:boolean, cleared:boolean, why?:string}}
 */
function clearPending(closedAt) {
  const record = readRecord();
  if (record === null) return { ok: true, cleared: false, why: 'no-record' }; // 幂等
  if (typeof closedAt !== 'string' || closedAt === '' || record.closedAt !== closedAt) {
    return { ok: false, cleared: false, why: 'closedAt-mismatch', current: typeof record.closedAt === 'string' ? record.closedAt : null };
  }
  const cleared = dropRecord();
  noteRecord(`待续记录已清空（closedAt=${closedAt}）：面板关掉了`);
  return { ok: true, cleared };
}

// ── 「继续」= 投一条下一轮消息并唤醒驱动（设计原意，见可行性论证 §1.1 的驱动面）───────────
// 为什么不是目标（`ctx.goals` / `remote.goals`）：目标是一份**持久的目标**，一武装就会让轮次驱动
// 在 agent 空闲时**自己**开下一轮（默认上限 256 轮）——那是无人值守的自动续跑，本插件明确不做
// （设计规格 §1「不自动续跑」）。被关闭打断的会话绝大多数也根本没有目标，给它建一份等于凭空造一个
// 任务、还会在会话里留下一个用户从没设过的目标。这里的动作只有一次：**投一条消息 + 唤醒驱动**。
//
// 为什么放在宿主：① 冷会话只有宿主侧的 `sessionController.resolveAgent` 会把它恢复出来；
// ② 消息来源必须是**插件**（`source.kind`）—— 客户端能发的只有用户消息（`session.prompt` 把
// source 写死成 `kind:'user'`），那是冒充用户发言。
// 与 `dsh-schedule` 投「到点提醒」用的是同一条公开路（`resolveAgent` → `agent.followup` → `flush`）。

/** 这条消息的来源标签：界面据此把本轮渲染成「非人触发」的通知，而不是用户气泡。 */
const CONTINUE_SOURCE_KIND = 'safely-quit';

/**
 * 「继续」投给会话的那一整句（**唯一出处**）。
 *
 * 只说两件事：被打断的那一步接着做完；那一步其实已经做完就按原计划往下走。
 * 不写"你还有活要干"这类替用户下结论的话 —— 是否还有活，由会话自己的上下文判断。
 */
const CONTINUE_TEXT = '上次关闭 DSH 打断了这个会话正在进行的那一步。接着把它做完；如果那一步其实已经完成，就按你原来的计划继续。';

/** 深冻结（与平台 `freezeMessage` 同效：消息一旦交给 inbox 就是不可变的）。 */
function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** 造一条**插件来源**的用户角色消息（`followup` 收的就是它）。 */
function continueMessage(text = CONTINUE_TEXT) {
  return freezeDeep({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: CONTINUE_SOURCE_KIND },
  });
}

/** 一次「继续」请求最多接几个会话（卡片就是一屏的量；多出来的分批也该由人点，不替人排队）。 */
const MAX_CONTINUE_IDS = 32;

/**
 * 把一条「继续」请求里的会话 id 读成干净清单（去空、去重、限条数）。
 *
 * @param {unknown} value 请求体的 `sessionIds`（或单个 `sessionId`）
 * @returns {string[]} 最多 `MAX_CONTINUE_IDS` 个
 */
function readContinueIds(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const ids = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id === '' || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_CONTINUE_IDS) break;
  }
  return ids;
}

/**
 * 接续**一个**会话：恢复它（冷会话在 `resolveAgent` 里被拉起来）→ 投一条「继续」→ 等落盘。
 *
 * 四档如实回报，不做静默替换：
 *  · `attached` —— 消息进了 inbox，驱动已经被唤醒；
 *  · `already` —— 它本来就在跑（这一趟已经接过的也算，免得一次点击投两条）；
 *  · `missing` —— 这个会话真的不在了（被删 / 身份不对）；
 *  · `failed` —— 其它失败（服务缺席、宿主拒绝、落盘失败以外的一切），`detail` 说清是哪一步。
 *
 * @param {object|null} ctx 注入了 `sessionController` / `sessions` 的作用域
 * @param {object|null} session 收尾状态（只用来记"这一趟接接过谁"，不参与判定）
 * @param {string} sessionId 目标会话
 * @returns {Promise<{result:'attached'|'already'|'missing'|'failed', detail?:string, flushed?:boolean}>}
 */
async function continueOne(ctx, session, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { result: 'failed', detail: 'bad-session-id' };
  if (session?.continued?.has?.(sessionId) === true) return { result: 'already' };
  const controller = ctx === null || ctx === undefined ? null : ctx.sessionController;
  if (controller === null || controller === undefined || typeof controller.resolveAgent !== 'function') {
    return { result: 'failed', detail: 'session-service-unavailable' };
  }
  let found;
  try {
    found = await controller.resolveAgent(sessionId);
  } catch (error) {
    return { result: 'failed', detail: `resolve threw: ${String(error?.message ?? error)}` };
  }
  const failure = found !== null && found !== undefined && typeof found === 'object' ? found.error : null;
  if (failure !== null && failure !== undefined) {
    const code = String(failure.code ?? failure.message ?? 'resolve failed');
    return { result: code.startsWith('session/not-found') ? 'missing' : 'failed', detail: code };
  }
  const agent = found?.agent ?? found;
  if (agent === null || agent === undefined || typeof agent !== 'object') return { result: 'failed', detail: 'no-agent' };
  if (agent.status === 'running') {
    // 已经在跑：**不**再投一条（两条「继续」会让模型把同一段活做两遍）。
    // 这里**不**记进 `session.continued`：它跑完之后用户再点一次，仍然该投一条（那一次才是真的"接续"）。
    return { result: 'already' };
  }
  if (typeof agent.followup !== 'function') return { result: 'failed', detail: 'agent-has-no-followup' };
  try {
    agent.followup(continueMessage());
  } catch (error) {
    return { result: 'failed', detail: `followup threw: ${String(error?.message ?? error)}` };
  }
  if (session?.continued?.set) session.continued.set(sessionId, new Date().toISOString());
  // 落盘是"尽力"：消息已经进 inbox，flush 失败只影响崩溃后的可恢复性，不改变"已接上"这件事。
  let flushed = false;
  try {
    if (ctx?.sessions && typeof ctx.sessions.flush === 'function' && agent.session !== undefined) {
      await ctx.sessions.flush(agent.session);
      flushed = true;
    }
  } catch (error) {
    noteRecord(`继续：落盘没成功（不影响已接上）：${String(error?.message ?? error)}`);
  }
  return { result: 'attached', flushed, kind: CONTINUE_SOURCE_KIND };
}

/**
 * 逐个接续（**串行**：一次点击就把几个会话同时点着，只是让它们抢同一台机器）。
 *
 * @param {object|null} ctx 注入了 `sessionController` / `sessions` 的作用域
 * @param {object|null} session 收尾状态
 * @param {string[]} sessionIds 目标会话
 * @returns {Promise<Array<{sessionId:string, result:string, detail?:string}>>}
 */
async function continueSessions(ctx, session, sessionIds) {
  const rows = [];
  for (const sessionId of readContinueIds(sessionIds)) {
    rows.push({ sessionId, ...(await continueOne(ctx, session, sessionId)) });
  }
  return rows;
}

/** 落盘：计划内关闭标记（与崩溃区分；只落标记，不动任何系统配置）。 */
function writeMarker(session, reason) {
  writeJson(markerFile(), {
    reason,
    at: new Date().toISOString(),
    hostPid: process.pid,
    sessions: session.snapshot.length,
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── 关机拓展（外部插件登记的动作）───────────────────────────────────────────────

/**
 * 跑一趟关机拓展。
 *
 * 两条入口共用这一个函数：
 *  · **插件关闭流程**（`reason='user-requested'`）：在 `waitForQuiescence` 之后、`SIGTERM` 之前 ——
 *    此时所有会话已停在安全边界、整棵树还活着，是跑外部动作最干净的时刻，预算也宽松；
 *  · **dispose 兜底**（`reason='host-exit'`）：宿主被 Ctrl+C / 外部 SIGTERM 关掉时，平台会
 *    `await fiber.dispose()`（5 秒 grace）⇒ 我们借这一趟跑掉**还没跑过**的那些（`ranAt` 已经落上的跳过）。
 *
 * 本函数**绝不抛**：关机阶段多一条错误日志，也比"因为一条外部钩子把关闭流程打断"强。
 *
 * @param {object} session 收尾状态
 * @param {string} reason 执行原因（进执行账）
 * @param {number} [budgetMs] 覆盖预算（兜底那趟用短预算）
 * @returns {Promise<object|null>} 执行账；没有注册表 ⇒ null
 */
async function runHookPhase(session, reason, budgetMs) {
  const hooks = session?.hooks;
  if (hooks === null || hooks === undefined || typeof hooks.run !== 'function') return null;
  const budget = Number.isFinite(budgetMs) ? budgetMs : session.budgets?.hookBudgetMs;
  session.hookPhase = 'running';
  try {
    const run = await hooks.run({ reason, budgetMs: budget });
    session.hookRun = run;
    return run;
  } catch (error) {
    session.lastError = `关机拓展阶段出错：${String(error?.message ?? error)}`;
    return null;
  } finally {
    session.hookPhase = 'done';
  }
}

// ── 关闭编排 ──────────────────────────────────────────────────────────────────

/**
 * 跑一步「最好能成功」的落盘：失败只记账，**绝不打断关闭编排**。
 *
 * 为什么单独抽出来：`/close` 的语义是「把宿主关掉」，清单与标记只是**附带产物**。让落盘异常穿过
 * 整段编排，就会出现「用户点了关闭、宿主却不关，而对外读数还说 done」——关闭与记账必须解耦。
 */
function safeBookkeeping(session, what, run) {
  try {
    run();
  } catch (error) {
    const message = `${what}失败：${String(error?.message ?? error)}`;
    session.bookkeepingErrors.push(message);
    session.lastError = message;
    noteRecord(message);
  }
}

/**
 * 把「此刻真在跑」的 agent 补进停止集合与清单 —— **子代理也算**。
 *
 * 为什么要有：关闭等待窗口可能长达数分钟（另一个会话卡在审批上等人点「立即停止」）。只认"关闭那一刻
 * 的名单"时，这期间用户在关闭那一刻还空闲的会话里发条消息 ⇒ 那个会话会真的跑起来，既不被拦在 step 边界、
 * 也不进清单，最后被 SIGTERM 在半路带走 —— 正是本插件用 step 边界要避开的「工具结果未知」。
 * 子代理同理（父会话等成员回报时可以是 idle，而成员正在跑 step）。
 *
 * 每拍（以及每次 pre-step 判定之前）重算一次。新变忙的 agent：① 进 `stopIds`（下一步就会被拦 ——
 * pre-step 按 agent id 生效，子代理一样拦得住）；② 折算成**顶层会话**补一条清单行
 * （`statusAtClose` 记 running）；③ 子代理贡献的那一行额外留痕 `delegated`（见 `stopKindOf`）。
 *
 * @returns {number} 这一拍新补进来的 agent 数（0 = 没有新变忙的）
 */
function refreshStopSet(ctx, session) {
  if (session.stage !== 'waiting' || session.dryRun) return 0;
  const agents = liveAgents(ctx);
  let added = 0;
  for (const agent of agents) {
    const id = agentIdOf(agent);
    if (id === null || agent?.status !== 'running' || session.stopIds.has(id)) continue;
    session.stopIds.add(id);
    const topId = topLevelSessionIdOf(ctx, id);
    const row = session.snapshot.find((item) => item.sessionId === topId);
    if (row === undefined) {
      const described = id === topId ? describeAgent(agent) : null;
      const parent = id === topId ? undefined : agents.find((candidate) => agentIdOf(candidate) === topId);
      const parentDescribed = parent === undefined ? null : describeAgent(parent);
      session.snapshot.push({
        sessionId: topId,
        status: 'running',
        cwd: described?.cwd ?? parentDescribed?.cwd ?? null,
        title: described?.title ?? parentDescribed?.title ?? null,
        selfRunning: id === topId,
        delegated: id !== topId,
      });
    } else if (id === topId) {
      row.status = 'running';
      row.selfRunning = true;
    } else {
      row.status = 'running';
      row.delegated = true;
    }
    added += 1;
  }
  return added;
}

/**
 * **交棒**：把「关掉这个进程」交给平台 —— **不许**用 `process.kill(process.pid,'SIGTERM')` 交棒
 * （Windows 上那是 `TerminateProcess`：进程当场死、平台的处理器不跑，见文件头）。
 *
 * 三条路按优先级走：
 *  ① **`ctx.appExit(0)`** —— 平台自己的关停控制器（`dsh-cmdline` 提供、`profile-boot` 的
 *     `createProcessShutdown` 实现）：先 `await fiber.dispose(); await disposeProxy();` 再让进程退出，
 *     自带 5 秒强退上限，且重复调用会合并成一趟（`:47`）。**这是最干净的一条：不需要自造信号。**
 *  ② 拿不到 `appExit`（不是 DSH 宿主 / 服务缺席）⇒ **`process.emit('SIGTERM')`**：平台注册在
 *     `process.on('SIGTERM', …)`（`profile-boot:295`）上的处理器会真的被调用，走的还是平台那条路。
 *     ⚠ 事件是同步派发的，会**跑一遍所有监听器**，包括本插件自己那个"宿主确实要退出"的标记器 ——
 *     它只是把 `hostExitSignalled` 置真（幂等，没有副作用；重复置真不影响任何分支）。
 *  ③ 两者都没接住（appExit 抛错、也没有任何 SIGTERM 监听者）⇒ `HANDOFF_NO_HANDLER_MS` 后兜底自退。
 *
 * ①②都还各押一条**有上限的兜底自退**（`unref` 过，不拖住正常退出）：说好了要关，就得有人真的关。
 *
 * @param {object} ctx 宿主上下文（`appExit` 是它从父作用域继承到的平台服务）
 * @param {{emit?:Function, schedule?:Function, exit?:Function}} [deps] **只为判据留的注入点**：
 *   `emit` 替换 `process.emit`、`schedule` 替换 `setTimeout`（判据据此瞬间拿到兜底回调、
 *   不必真等 10 秒）、`exit` 替换兜底自退函数。生产路径一律不传。
 * @returns {{via:'appExit'|'emit'|'exit', fallbackMs:number}} 这一趟走的是哪条 + 兜底时长
 */
function resignToPlatform(ctx, deps) {
  const schedule = typeof deps?.schedule === 'function' ? deps.schedule : (fn, ms) => setTimeout(fn, ms);
  const exit = typeof deps?.exit === 'function' ? deps.exit : (code) => handoffExit(code);
  const emit = typeof deps?.emit === 'function' ? deps.emit : (name) => process.emit(name);
  const armFallback = (ms, why) => {
    const timer = schedule(() => {
      noteRecord(`交棒后 ${ms}ms 仍未退出（${why}）⇒ 兜底自退`);
      try {
        exit(0);
      } catch {
        // 走到这一步已经没什么可做的
      }
    }, ms);
    try {
      timer?.unref?.();
    } catch {
      // 老运行时没有 unref 也不影响：平台的 5 秒上限会先到
    }
  };

  // ① 平台自带的关停原语（在关停这一刻读一次即可：树早就装好了，不存在"服务还没 ACTIVE"的问题）
  try {
    const appExit = typeof ctx?.get === 'function' ? ctx.get('appExit') : undefined;
    if (typeof appExit === 'function') {
      appExit(0);
      armFallback(HANDOFF_FALLBACK_MS, 'appExit 已调用但进程没退');
      return { via: 'appExit', fallbackMs: HANDOFF_FALLBACK_MS };
    }
  } catch (error) {
    noteRecord(`appExit 调用失败（改走信号事件）：${String(error?.message ?? error)}`);
  }

  // ② 进程内派发信号事件（平台的处理器会跑；不依赖 OS 真投递信号）
  let delivered = false;
  try {
    delivered = emit('SIGTERM') === true;
  } catch (error) {
    noteRecord(`emit('SIGTERM') 失败（改走兜底自退）：${String(error?.message ?? error)}`);
  }
  if (delivered) {
    armFallback(HANDOFF_FALLBACK_MS, '信号事件已送达但进程没退');
    return { via: 'emit', fallbackMs: HANDOFF_FALLBACK_MS };
  }

  // ③ 没人接手：快一点自退（此刻没有任何人会替我们收尾）
  armFallback(HANDOFF_NO_HANDLER_MS, '既没有 appExit 也没有 SIGTERM 监听者');
  return { via: 'exit', fallbackMs: HANDOFF_NO_HANDLER_MS };
}

/**
 * 开始收尾。**不阻塞调用方**（路由返回 202 后客户端轮询 `/state` 看进度）。
 *
 * 顺序（设计规格 §2）：
 *   ① 快照 `ctx.agents.list()`；② 把当时在跑的放进 `stopIds`（pre-step 拦截器据此拒绝下一步）；
 *   ③ 等全停（**不自动强杀**，只有用户点 `/force` 才 cancel）；④ 落清单 + 标记；⑤ **交棒给平台**（见 resignToPlatform）。
 *
 * 三条硬纪律（每条都对应一个真踩过的坑）：
 *   · **重入哨兵**：`waiting` 已置位就直接让位 —— 并发的两条 `/close` 只能起一套编排（关机拓展不许跑两遍）。
 *   · **记账与关闭解耦**：清单/标记写失败只进 `bookkeepingErrors`，交棒照样做（见 safeBookkeeping）。
 *   · **`done` 的含义是"已经把关闭交出去"**：编排在它之前中断 ⇒ `failed`（界面据此显示「重试」，
 *     而且重试**真的能再关一次** —— 见 handleRoute 的 /close 与 markPendingFailed）。
 *
 * @param {object} ctx - 宿主上下文（须已注入 agents）。
 * @param {object} session - 收尾状态（见 createSession）。
 * @param {{dryRun: boolean, openSessionIds?: string[]|null, openSource?: string|null}} options
 *   演练时只做 ①④ 并跳过 ⑤；`openSessionIds` = 客户端上报的"界面上开着哪些会话"（**只进 `scope`
 *   作诊断，不参与清单**，见 describeScope），`openSource` = 那份读数的来源。
 * @returns {Promise<void>}
 */
async function beginClose(ctx, session, options) {
  // 重入哨兵：真关闭已在编排中 ⇒ 本次是重复到达，直接让位。
  // 这一步在第一个 await 之前**同步**执行，所以它本身就足以挡住并发到达的第二条 /close。
  if (session.stage === 'waiting') return;
  const dryRun = options?.dryRun === true;
  // 把上一趟的残留清干净：`failed` / 演练之后重新受理时，旧账绝不能带进新一趟
  // （旧 `stopIds` 会把已经正常跑着的会话拦下来，旧 `dropped`/`snapshot` 会污染新清单）。
  session.stopIds = new Set();
  session.pendingNow = [];
  session.snapshot = [];
  session.snapshotScope = null;
  session.dropped = new Map();
  session.forceRequested = false;
  session.forceRequestedAtMs = null;
  session.bookkeepingErrors = [];
  session.lastError = null;
  session.recordClosedAt = null;
  session.handoff = null;
  session.stage = 'waiting';
  session.dryRun = dryRun;
  session.startedAt = new Date().toISOString();
  session.startedAtMs = Date.now();

  try {
    // ① 快照：**只记被这次关闭打断的 agent loop**（在跑的；子代理折算到它的顶层会话，见 snapshotForClose）
    const openIds = Array.isArray(options?.openSessionIds) ? options.openSessionIds : null;
    session.snapshot = snapshotForClose(ctx);
    session.snapshotScope = describeScope(openIds, session.snapshot, options?.openSource ?? null);
    const openText = openIds === null
      ? '未上报'
      : `${openIds.length} 个（读数：${String(session.snapshotScope.source)}；只作诊断，不进清单）`;
    noteRecord(`关闭快照：在跑 ${session.snapshotScope.running} 个 ⇒ 记 ${session.snapshotScope.recorded} 个；界面报开着 ${openText}`);

    if (dryRun) {
      // 演练：只快照 + 落清单。**不下停止令、不等静默、不关宿主** ——
      // 所以它能在正在使用的宿主上安全跑，用来验登记正确性与路由/状态机。
      // 演练唯一的产出就是那份清单，所以这里也走记账通道（失败照样看得出来）。
      safeBookkeeping(session, '演练清单', () => writePending(session, 'dry-run'));
      session.stage = 'done';
      session.finishedAt = new Date().toISOString();
      return;
    }

    // ② 下令「跑完当前这一步就停」——**按 agent 下**（不是按清单行）：清单里的一行可能代表
    //    一个空闲的顶层会话（它名下的子代理在跑），真正要拦的是那些在跑 step 的 agent。
    for (const agent of liveAgents(ctx)) {
      const id = agentIdOf(agent);
      if (id !== null && agent?.status === 'running') session.stopIds.add(id);
    }
    session.pendingNow = [...session.stopIds];
    // 进入等待的瞬间先落一次盘：即使宿主随后被强杀，清单也已经在盘上（失败不阻断关闭，只记账）。
    safeBookkeeping(session, '首次清单', () => writePending(session, 'user-requested'));

    // ③ 等全停
    await waitForQuiescence(ctx, session);

    // ③.5 **关机拓展**：其它插件登记的动作在这里跑完（在交棒之前 ⇒ 预算宽松、树还活着）。
    //     演练（dryRun）在上面就 return 了，走不到这里 —— 演练绝不该执行外部的关机动作。
    await runHookPhase(session, 'user-requested');

    // ③.8 结算前再对一次账（这一拍还在跑的会话必须进清单），然后各落一次盘
    refreshStopSet(ctx, session);
    safeBookkeeping(session, '最终清单', () => writePending(session, 'user-requested'));
    safeBookkeeping(session, '关闭标记', () => writeMarker(session, 'user-requested'));

    // ④ 交棒：**请平台关自己**（`ctx.appExit`）→ 退而求其次在进程内派发 SIGTERM 事件 → 再不行才有上限兜底自退。
    //    先置 done 再交棒 —— `done` 的含义就是"已经把关闭交出去"（见文件头状态机）。
    //    ⚠ 绝不用 `process.kill(process.pid,'SIGTERM')`：Windows 上它是 TerminateProcess，
    //    平台的处理器不跑 ⇒ 持久化 flush 与其它插件的 dispose 收尾全被跳过（真子进程实测：exit=1、监听未被回调）。
    session.stage = 'done';
    session.finishedAt = new Date().toISOString();
    const handoff = resignToPlatform(ctx);
    session.handoff = handoff;
    noteRecord(`交棒：走 ${handoff.via}（兜底 ${handoff.fallbackMs}ms）`);
  } catch (error) {
    // 编排在交棒之前中断 ⇒ 如实报 failed。
    // 绝不在这里置 done：那会让界面永远停在「正在关闭（已等 N 秒）」，而宿主其实根本没收到关闭命令。
    session.lastError = String(error?.message ?? error);
    session.stage = 'failed';
    session.finishedAt = new Date().toISOString();
    // 这一趟写下的那份 user-requested 记录并不代表真关过机 ⇒ 标成失败（开机读数会回收它）。
    if (!dryRun && session.recordClosedAt !== null) markPendingFailed(session, session.lastError);
  }
}

/**
 * 等所有已下令的会话跑完当前一步而静默。
 *
 * **刻意不设自动超时强杀**：卡住（典型是等一个无人应答的工具审批）时一直等，
 * 由人在界面上点「立即停止」才 cancel —— 自动强杀等于擅自中断在飞 agent 的工作，
 * 正是「关闭入口人类专属、不自动强杀」这两条硬约束要防的。
 * `agent.cancel(cause)` 的语义见 `dsh-agent-loop/lib/index.js:405-411`：默认清空 inbox 并中断当前 phase。
 *
 * 每一拍都先 `refreshStopSet`：等待窗口里新变忙的会话也要被拦、也要进清单（见那个函数的注释）。
 *
 * @returns {Promise<void>}
 */
async function waitForQuiescence(ctx, session) {
  for (;;) {
    refreshStopSet(ctx, session);
    const pending = [];
    for (const id of session.stopIds) {
      const agent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(id) : undefined;
      // agent 已从注册表消失 = 已经停稳（比 status 更彻底）
      if (agent === undefined || agent === null) continue;
      if (agent.status === 'running') pending.push(id);
    }
    session.pendingNow = pending;
    if (pending.length === 0) return;

    if (session.forceRequested) {
      // 人在界面上显式要求立即停止 ⇒ 此刻才 cancel（且只 cancel 还挂着的那些）
      for (const id of pending) {
        const agent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(id) : undefined;
        if (agent === undefined || agent === null) continue;
        try {
          agent.cancel({ kind: 'user-force-stop' });
        } catch (error) {
          session.lastError = `cancel ${id} 失败：${String(error?.message ?? error)}`;
        }
      }
      // 再给一段宽限让它们真正收敛；超时也继续往下走（用户已明确要求停）
      const deadline = (session.forceRequestedAtMs ?? Date.now()) + FORCE_GRACE_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        refreshStopSet(ctx, session);
        const still = [];
        for (const id of session.stopIds) {
          const agent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(id) : undefined;
          if (agent !== undefined && agent !== null && agent.status === 'running') still.push(id);
        }
        session.pendingNow = still;
        if (still.length === 0) return;
      }
      return;
    }

    await sleep(POLL_MS);
  }
}

// ── pre-step 拦截器 ───────────────────────────────────────────────────────────

/**
 * 收尾期间，对已下令的 agent 拒绝进入下一步。
 *
 * 先 `await next()` 再决定：不打断瀑布的合作语义（下游监听器照常跑完，包括它们自己的判定）。
 * 下游若已 reject，就尊重下游的结果，不重复计数。
 *
 * @returns {object} 瀑布决定：原样放行，或 `{kind:'reject'}`。
 */
function decidePreStep(session, payload, decision) {
  if (session.stage !== 'waiting') return decision;
  if (decision?.kind === 'reject') return decision;
  const id = agentIdOf(payload?.agent);
  if (id === null || !session.stopIds.has(id)) return decision;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (messages.length > 0) {
    session.dropped.set(id, (session.dropped.get(id) ?? 0) + messages.length);
  }
  return { kind: 'reject' };
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

async function handleRoute(ctx, session, req, res) {
  // 门 1：只服务回环连接
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return sendJson(res, 403, { error: 'loopback connections only' });
  }
  // 门 2：读请求挡跨站；写请求必须同源
  if (req.method === 'GET') {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return sendJson(res, 403, { error: 'cross-site reads are not allowed' });
    }
  } else if (!isSameOriginMutation(req)) {
    return sendJson(res, 403, { error: 'state-changing requests must be same-origin' });
  }

  let url;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }
  const sub = url.pathname.startsWith(ROUTE_PATH) ? url.pathname.slice(ROUTE_PATH.length) : url.pathname;

  try {
    if (req.method === 'GET' && (sub === '/state' || sub === '' || sub === '/')) {
      return sendJson(res, 200, publicState(session));
    }

    if (req.method === 'POST' && sub === '/continue') {
      // 「继续」= 投一条下一轮消息并唤醒驱动（不碰目标、不产生用户消息、只这一轮）。
      // 受理面只看会话 id：**清单之外**的会话不会被接上（客户端只会送清单里的 id，这里再挡一道）。
      const body = await readJsonBody(req, BODY_MAX_BYTES);
      const ids = readContinueIds(body?.sessionIds ?? body?.sessionId);
      if (ids.length === 0) {
        return sendJson(res, 400, {
          error: 'sessionIds must contain at least one session id',
          hint: 'POST {"sessionIds":["<id>", …]}',
        });
      }
      if (session.continueScope === null || session.continueScope === undefined) {
        // 会话服务没来（老平台 / 该插件缺席）：**如实**报没接上，不拿别的东西顶替。
        return sendJson(res, 503, { error: 'session services unavailable', results: [] });
      }
      const results = await continueSessions(session.continueScope, session, ids);
      session.lastContinue = { at: new Date().toISOString(), results };
      const attached = results.filter((row) => row.result === 'attached').length;
      for (const row of results) {
        noteRecord(`继续：${row.sessionId} ⇒ ${row.result}${row.detail === undefined ? '' : `（${row.detail}）`}`);
      }
      return sendJson(res, 200, { ok: true, attached, results });
    }

    if (req.method === 'POST' && sub === '/close') {
      // 「能不能开始一次关闭」必须**同步**判完（在读请求体之前）——
      // 否则两条并发 /close 会都通过检查、各起一套编排（同一个关机拓展跑两遍）。
      // 两种"可以再来一次"的例外：
      //   · 刚跑完的**演练**（它不占关闭名额，见下面 dryRun 分支）；
      //   · **上一趟失败了**（`failed`：那次没关成，名额必须还回来 —— 不还的话用户点「重试」
      //     只会一直吃 409，这个进程里用插件关 DSH 的入口就永久失效）。
      const afterDryRun = session.dryRun === true && session.stage === 'done';
      const canReopen = session.stage === 'failed';
      if (session.stage !== 'idle' && !afterDryRun && !canReopen) {
        return sendJson(res, 409, { error: 'already closing', state: publicState(session) });
      }
      if (session.closeAccepted) {
        return sendJson(res, 409, { error: 'close already accepted', state: publicState(session) });
      }
      // 同步占位：它只覆盖"读请求体"这段异步窗口（后到的 /close 被上面那道挡下）。
      // 名额的归还**只有一个地方**：下面的 `finally`。
      session.closeAccepted = true;
      // 从占位到交棒之间，两件事各只有一个发生点：
      //   · `stage` 的推进**完全不在这段里** —— 它是 beginClose 在第一个 await 之前同步做的，
      //     任何提前返回天然不碰 stage，"忘了回落"在结构上不可能出现；
      //   · 名额只在 `finally` 归还 —— 任何提前返回、任何抛错都自动走它。
      try {
        const body = await readJsonBody(req, BODY_MAX_BYTES); // 坏 JSON / 超限 ⇒ 抛给外层 catch（400/413）
        const dryRun = body?.dryRun === true;
        // 「上次关闭时的会话」的本义：界面**开着**的那些由客户端随这次请求上报（见 snapshotForClose）。
        // 没带 ⇒ `null`（"不知道"）⇒ 宿主退到"只记在跑的"；带了空数组 ⇒ "一个都没开"，同样记不到行。
        const openSessionIds = readOpenSessionIds(body?.openSessionIds);
        const openSource = readOpenSource(body?.openSource);
        // 不可逆动作要一道显式确认；演练不需要（它什么都不改）
        if (!dryRun && body?.confirm !== true) {
          return sendJson(res, 400, {
            error: 'confirm must be true',
            hint: 'POST {"confirm":true}；演练用 {"dryRun":true}',
          });
        }
        // 所有校验都通过之后才放行。这里**不写任何过渡态**：`beginClose` 会在它的第一个
        // await 之前同步把 stage 置成 `waiting`，两次写入之间没有让出点 ⇒ 中间态根本没有
        // 能被谁读到的机会（写一个读不到的状态，只会让后来的人以为这里有一个阶段）。
        // 真正挡住并发重复受理的是上面那个占位：`closeAccepted`。
        if (dryRun) {
          // 演练走同一条受理路（快照 + 落清单），但**不关宿主**；名额由 finally 当场归还，
          // 所以演练不该把这一次进程的真关闭永久锁死。
          void beginClose(ctx, session, { dryRun: true, openSessionIds, openSource });
        } else {
          // 不 await：路由立刻回 202，客户端用 /state 看进度。
          // 哨兵保持占位（beginClose 开头会把 stage 置 waiting，两道一起挡重复到达）。
          void beginClose(ctx, session, { dryRun: false, openSessionIds, openSource });
        }
        return sendJson(res, 202, { ok: true, accepted: true, dryRun });
      } finally {
        // **唯一**的名额归还点：被拒（坏 JSON / 没确认 / 以后新加的校验）都不许把名额带走。
        // 此刻 stage 要么还是被拒前的原值，要么已被 beginClose 同步推成 waiting/done。
        session.closeAccepted = false;
      }
    }

    if (req.method === 'POST' && sub === '/force') {
      if (session.stage !== 'waiting' || session.dryRun) {
        return sendJson(res, 409, { error: 'not waiting', state: publicState(session) });
      }
      if (!session.forceRequested) {
        session.forceRequested = true;
        session.forceRequestedAtMs = Date.now();
      }
      return sendJson(res, 200, { ok: true, state: publicState(session) });
    }

    if (req.method === 'POST' && sub === '/report') {
      // 客户端半区的**自报**（排障通道）：浏览器里发生了什么，宿主这边留一份。
      // 为什么需要它：客户端的问题在浏览器里，宿主看不见 —— 有了这一条，排障不用靠用户复述。
      const body = await readJsonBody(req, BODY_MAX_BYTES);
      const payload = body === null || typeof body !== 'object' ? { raw: String(body) } : body;
      const record = { at: new Date().toISOString(), hostPid: process.pid, report: payload };
      try {
        writeJson(reportFile(), record);
      } catch (error) {
        return sendJson(res, 500, { error: `report not saved: ${String(error?.message ?? error)}` });
      }
      try {
        // 同一行也进跑 dsh web 的那个窗口（stderr），现场可读
        process.stderr.write(`[safely-quit] 客户端自报 ${JSON.stringify(payload)}\n`);
      } catch {
        // stderr 不可用不追究
      }
      return sendJson(res, 200, { ok: true, savedAt: record.at });
    }

    if (req.method === 'GET' && sub === '/report') {
      // 读回最近一次自报（只读；排障用）
      if (!existsSync(reportFile())) return sendJson(res, 200, { available: false });
      try {
        return sendJson(res, 200, { available: true, ...JSON.parse(readFileSync(reportFile(), 'utf8')) });
      } catch (error) {
        return sendJson(res, 200, { available: false, error: String(error?.message ?? error) });
      }
    }

    if (req.method === 'GET' && sub === '/last-pending') {
      // **开机读数**：唯一会回收记录的读（判据表见 loadPendingForBoot）。不存在 / 已回收 ⇒ available:false。
      const verdict = loadPendingForBoot();
      // 裁决留痕（进 `/state` 的 `lastPending`）：记录被回收后盘上就没有证据了，这一份是"为什么没提示"的唯一落点。
      session.lastPending = {
        at: new Date().toISOString(),
        available: verdict.available === true,
        reaped: verdict.reaped === true,
        why: verdict.why ?? null,
        reason: verdict.reason ?? null,
        // 提示那一档的 closedAt 在 pending 里（回收那一档在顶层）：两条路都要对上同一份记录。
        closedAt: verdict.closedAt ?? verdict.pending?.closedAt ?? null,
        interrupted: verdict.available === true ? interruptedCount(verdict.pending) : 0,
      };
      return sendJson(res, 200, verdict);
    }

    if (req.method === 'GET' && sub === '/pending') {
      // **只读诊断**：记录此刻原样是什么样（**不回收**，与 /last-pending 刻意区分开）。
      const record = readRecord();
      if (record === null) return sendJson(res, 200, { available: false });
      return sendJson(res, 200, {
        available: true,
        interrupted: interruptedCount(record),
        deliveredByThisRun: typeof record.deliveredBy === 'string' && record.deliveredBy === RUN_ID,
        record,
      });
    }

    if (req.method === 'POST' && sub === '/pending/claim') {
      // 客户端把卡片**真的显示到屏幕上**之后认领（见 claimPending）：从此这一次运行的 F5 仍会显示，
      // 而下一次开机读到它就知道"已经交出去过"。
      const body = await readJsonBody(req, BODY_MAX_BYTES);
      const result = claimPending(body?.closedAt);
      return sendJson(res, result.ok === true ? 200 : 409, result);
    }

    if (req.method === 'POST' && sub === '/pending/clear') {
      // 用户把面板关掉了 ⇒ 记录清空（界面上不设「不用了」那颗键：关面板本身就是那个意思）。
      const body = await readJsonBody(req, BODY_MAX_BYTES);
      const result = clearPending(body?.closedAt);
      return sendJson(res, result.ok === true ? 200 : 409, result);
    }

    return sendJson(res, 404, { error: 'not found', path: sub });
  } catch (error) {
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    return sendJson(res, status, { error: String(error?.message ?? error) });
  }
}

// ── 装配 ──────────────────────────────────────────────────────────────────────

/**
 * 组装**对外服务面**（`ctx.safelyQuit`）：别的插件在这里登记「关机时要执行的动作」。
 *
 * 形状刻意做成"只读 + 登记"两件事，**不含"关闭 DSH"的触发口** —— 关闭入口是人类专属这条硬约束
 * 不因为多了一个服务而松动（消费者也不得拿它拼出 AI 可触发的关闭路径）。
 *
 * `positiveOf`（数值兜底）不另写一份：数值口径与内核共用同一个实现
 * （`shutdown-hooks.js` 导出），避免"同一规则两处定义、只改一处"。
 *
 * @param {object} session 收尾状态（预算放在它身上）
 * @returns {object} 服务面
 */
function createServiceFace(session) {
  const hooks = session.hooks;
  return {
    version: 1,
    serviceName: SERVICE_NAME,
    /**
     * 登记一条关机动作。
     * @param {Function|{command:string, args?:string[], shell?:boolean, cwd?:string, env?:object}} action
     * @param {{id?:string, label?:string, order?:number, timeoutMs?:number}} [hookOptions]
     * @returns {Function} 摘除器（幂等）
     */
    onShutdown: (action, hookOptions) => hooks.onShutdown(action, hookOptions),
    /** 按 id 摘掉一条（返回是否摘到了）。 */
    off: (id) => hooks.off(id),
    /** 只读：当前注册表。 */
    list: () => hooks.list(),
    /** 只读：最近一趟执行账。 */
    lastRun: () => hooks.lastRun(),
    /** 只读：这一套的预算（消费者据此判断自己的 timeoutMs 合不合理）。 */
    budgets: () => ({ ...(session.budgets ?? {}) }),
    /**
     * 手动跑一趟（排障用：确认自己登记的钩子真的能跑，不必真去关一次 DSH）。
     * 已经跑过的那些照样跳过（一条钩子一次进程至多一次）。
     */
    runNow: (runOptions) => hooks.run({
      reason: typeof runOptions?.reason === 'string' ? runOptions.reason : 'manual',
      budgetMs: Number.isFinite(runOptions?.budgetMs) ? runOptions.budgetMs : session.budgets?.hookBudgetMs,
    }),
  };
}

/**
 * 把服务挂上去（**服务先挂**：界面后到不影响，同 SkillInjection 的装配顺序）。
 *
 * 两条纪律：
 *  ① 同 scope 重名 `provide` 会抛（会连累整页起不来）⇒ 先 `ctx.get` 探一次，已存在就让位；
 *  ② 清理一律交回 fiber：`ctx.provide(...)` **本身就是一次 fiber effect**，随 fiber 卸载自动回收；
 *     它返回的是 Disposable 对象（不是函数），所以这里不另包一层 `ctx.effect` —— 那是永远走不到的死码。
 *
 * @returns {boolean} 是否真的挂上了
 */
function provideService(ctx, face) {
  try {
    if (ctx === null || ctx === undefined || typeof ctx.provide !== 'function') return false;
    if (typeof ctx.get === 'function' && ctx.get(SERVICE_NAME) !== undefined) {
      noteRecord(`服务 ${SERVICE_NAME} 已存在 ⇒ 本插件让位（不重复 provide）`);
      return false;
    }
    ctx.provide(SERVICE_NAME, face);
    return true;
  } catch (error) {
    noteRecord(`服务 ${SERVICE_NAME} 提供失败（已让位）：${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * 装配入口。
 *
 * 两条接线纪律（都是实测教训）：
 *   ① 取服务一律 `ctx.inject([...], cb)`，**不要**在 apply 期一次性 `ctx.get`：
 *      loader 并发启动，一次性读取会把尚未 ACTIVE 的服务静默跳过；
 *   ② `apply` 必须显式 `return undefined`：返回值会被 cordis 当成 effect 解释，
 *      返回普通对象会让 `dsh web` 起不来。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} [config] - profile 里给的配置（`hooks.budgetMs` / `hooks.timeoutMs` / `hooks.disposeBudgetMs`）
 * @returns {undefined} 恒为 undefined。
 */
export function apply(ctx, config) {
  const budgets = {
    hookBudgetMs: positiveOf(config?.hooks?.budgetMs, DEFAULT_HOOK_BUDGET_MS),
    hookTimeoutMs: positiveOf(config?.hooks?.timeoutMs, null),
    disposeBudgetMs: positiveOf(config?.hooks?.disposeBudgetMs, DEFAULT_DISPOSE_BUDGET_MS),
  };
  const hooks = createShutdownHooks({
    ...(Number.isFinite(budgets.hookTimeoutMs) ? { timeoutMs: budgets.hookTimeoutMs } : {}),
    budgetMs: budgets.hookBudgetMs,
    log: (line) => noteRecord(line),
  });
  if (!Number.isFinite(budgets.hookTimeoutMs)) budgets.hookTimeoutMs = hooks.defaultTimeoutMs;
  const session = createSession({ hooks, budgets });

  // ① 对外服务：别的插件在这里登记"关机时要执行的动作"（`ctx.inject(['safelyQuit'], …)`）。
  provideService(ctx, createServiceFace(session));

  // ② 只打一个标记：宿主**确实要退出**了（SIGTERM / SIGINT / 控制台关闭）。
  //    为什么需要它：dispose 也会在**热重载 / 插件卸载**时发生，那种情况绝不该跑关机动作
  //    （否则改一次 profile 补丁就等于关了一次 DSH）。
  let hostExitSignalled = false;
  const onHostExitSignal = () => {
    hostExitSignalled = true;
  };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const signal of signals) {
    try {
      process.on(signal, onHostExitSignal);
    } catch {
      // 平台可能没监听这个信号；监听不上不影响主流程
    }
  }
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      for (const signal of signals) {
        try {
          process.off(signal, onHostExitSignal);
        } catch {
          // 摘不掉不追究
        }
      }
    });

    // ③ 兜底：宿主**被动**关闭（Ctrl+C / 外部 SIGTERM / 系统注销）时，平台会 `await fiber.dispose()`
    //    （5 秒 grace）⇒ 借这一趟把**还没跑过**的关机动作跑掉。主动那一趟跑过的会自己跳过。
    ctx.effect(() => () => {
      if (!hostExitSignalled) return undefined;
      noteRecord(`宿主退出（dispose 兜底）：跑还没跑过的关机拓展，预算 ${budgets.disposeBudgetMs}ms`);
      return runHookPhase(session, 'host-exit', budgets.disposeBudgetMs);
    });
  }

  // pre-step 拦截器常驻：`stage !== 'waiting'` 时它只是 `await next()` 原样放行，零行为影响。
  // 判定之前先用**最新读数**刷新停止集合：等待窗口里新变忙的会话，从它的第一步起就要被拦住
  // （`agentsCtx` 由下面那次注入填上；注入尚未就绪时刷新只是空转，不会报错）。
  let agentsCtx = null;
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    refreshStopSet(agentsCtx, session);
    return decidePreStep(session, payload, decision);
  });

  // 等 webServer 就绪（= listen 完成后）才注册路由；agents 用于快照与等待。
  ctx.inject(['webServer', 'agents'], (routeCtx) => {
    agentsCtx = routeCtx;
    // 会话服务（`sessionController` / `sessions`）**只服务「继续」**，所以单独一道注入：
    // 并进上面那一道的话，这个服务一旦缺席，整块路由都挂不上 —— 连「关闭 DSH」入口都会跟着消失。
    // 单独注入时缺席只会让「继续」如实报"没接上"（`/continue` 回 503），关闭照常可用。
    routeCtx.inject(['sessionController', 'sessions'], (continueCtx) => {
      session.continueScope = continueCtx;
    });
    routeCtx.effect(
      () => routeCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: (req, res) => handleRoute(routeCtx, session, req, res),
      }),
      'dsh-safely-quit: route',
    );
    if (routeCtx.logger) {
      routeCtx.logger.info('safely-quit: 已装载（路由 %s；关机拓展 %d 条）', ROUTE_PATH, hooks.list().length);
    }
  });

  return undefined;
}

/**
 * 测试缝：离线用例直接调这些成员。
 *
 * **两组，请按组使用**（判据按"行为面 / 状态面"分组，内部重命名不会让判据成片变红）：
 *   A. **行为面**：纯函数与编排入口 —— 判据应该只认这些（同样的输入 ⇒ 同样的对外读数）。
 *   B. **状态面**：收尾状态机的字段入口、落盘路径、只读常量 —— 判据允许直接读写，
 *      用来构造前置状态或断言"东西落在哪儿"。
 */
export const __test = {
  // ── A. 行为面 ──
  agentIdOf,
  beginClose,
  claimPending,
  clearPending,
  continueMessage,
  continueOne,
  continueSessions,
  createServiceFace,
  createSession,
  decidePreStep,
  describeAgent,
  describeScope,
  handleRoute,
  hooksView,
  interruptedCount,
  isLoopbackAddress,
  isSameOriginMutation,
  loadPendingForBoot,
  liveAgents,
  pickString,
  positiveOf,
  provideService,
  publicState,
  readJsonBody,
  readOpenSessionIds,
  readOpenSource,
  refreshStopSet,
  resignToPlatform,
  runHookPhase,
  safeBookkeeping,
  sendJson,
  snapshotForClose,
  stopKindOf,
  topLevelSessionIdOf,
  waitForQuiescence,
  markPendingFailed,
  /**
   * 判据缝：替换兜底自退的退出函数（**离线判据必须换掉它**，见 handoffExit 的注释）。
   * 传非函数即**复位回生产默认**（`defaultHandoffExit`）—— 复位不许回到"上一次的替身"。
   */
  setHandoffExit: (fn) => {
    handoffExit = typeof fn === 'function' ? fn : defaultHandoffExit;
  },
  /** 护栏用：读回此刻生效的兜底自退函数（判据据此断言"测试之外恒为生产默认"）。 */
  getHandoffExit: () => handoffExit,
  /** 护栏用：生产默认那个（真退出）—— 判据按身份比对，替身顶不上。 */
  defaultHandoffExit,

  // ── B. 状态面（含落盘路径与只读常量）──
  dshHome,
  dropRecord,
  markerFile,
  pendingFile,
  readPackageVersion,
  readRecord,
  writeJson,
  writeMarker,
  writePending,
  DEFAULT_DISPOSE_BUDGET_MS,
  DEFAULT_HOOK_BUDGET_MS,
  FORCE_GRACE_MS,
  HANDOFF_FALLBACK_MS,
  HANDOFF_NO_HANDLER_MS,
  HOOK_ERROR_CODE,
  MAX_CONTINUE_IDS,
  MAX_OPEN_SESSION_IDS,
  CONTINUE_SOURCE_KIND,
  CONTINUE_TEXT,
  PLUGIN_VERSION,
  POLL_MS,
  ROUTE_PATH,
  RUN_ID,
  SERVICE_NAME,
  createShutdownHooks,
};
