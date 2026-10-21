/**
 * client.test.mjs —— 浏览器半产物的**离线判据**（零第三方依赖：不需要真 React，也不需要浏览器）。
 *
 * 做法：用 `node:vm` 造一个假 `window.__ModuleLoader__`，把 `lib/client.js` **真执行**一遍，
 * 拿到它的 `factory`；再用一个极简 React 替身（`createElement` / hooks 直接返回普通对象）
 * 真调用注册进去的组件，**断言它渲染出来的元素树**。
 *
 * 为什么不用"读源码正则"当判据：那是纸面判据，改坏了照样绿。这里每一步都是**真执行**：
 *   · factory 真跑 → exports 真拿到 → apply 真调 → 坞注册真发生（假服务捕获参数）；
 *   · 图标组件真被当组件调用 → 返回的 `<svg>` 树逐项断言；
 *   · 与宿主对话的请求真被发出（假 fetch 捕获 URL / method / body），错误分支真抛；
 *   · 状态→文案的映射是纯函数，逐个分支断言；
 *   · 样式注入真发生（假 document 捕获 `<style>` 节点），并断言自绘方块规则 `.sq-dot` **绝迹**；
 *   · **记录生死**：守望循环真跑 —— 认领门槛跨过去才发 `/pending/claim`、用户关掉面板
 *     才发 `/pending/clear`、平台清栈则补开；`fakeExpireAfter` 用来在假 DOM 里造出"层被摘掉"这件事。
 *
 * 用法：`node test/client.test.mjs`（exit 0 = 全过）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`);
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── 假浏览器：捕获 load 规格 + 捕获样式注入 ──────────────────────────────────

let loaded = null;
const injectedStyles = [];
/** 假 DOM：`querySelector` 只认"浮层层 / 浮层根"两类选择器（`overlayProbe` 与 `cardRect` 要用）。 */
const fakeNodes = new Map();
/**
 * 「这个选择器再被查几次就消失」的计划表 —— 用来演**平台清层栈**
 * （真机时间线：卡片出现 ~605ms 后 `layers` 从 1 掉到 0，而宿主根还在）。
 * 没有它，离线判据里就造不出"层被外部摘掉"这件事，看护那半条纪律只能靠嘴说。
 */
const fakeExpireAfter = new Map();
/** 假事件总线：`watchUserInteraction` 挂的 `pointerdown` / `keydown` / `wheel` 落在这里。 */
const fakeListeners = new Map();
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (node) => injectedStyles.push(node) },
  documentElement: { appendChild: (node) => injectedStyles.push(node) },
  addEventListener: (type, fn) => {
    const set = fakeListeners.get(type) ?? new Set();
    set.add(fn);
    fakeListeners.set(type, set);
  },
  removeEventListener: (type, fn) => { fakeListeners.get(type)?.delete(fn); },
  querySelector: (selector) => {
    const plan = fakeExpireAfter.get(selector);
    if (plan !== undefined) {
      if (plan.remaining <= 0) {
        fakeExpireAfter.delete(selector);
        fakeNodes.delete(selector);
        return null;
      }
      plan.remaining -= 1;
    }
    return fakeNodes.get(selector) ?? null;
  },
};
/** 触发一次假交互事件（`pointerdown` / `keydown` / `wheel`）。 */
function fireFake(type) {
  for (const fn of [...(fakeListeners.get(type) ?? [])]) {
    try { fn({ type }); } catch { /* 监听器自己的错不该打断判据 */ }
  }
}

const sandbox = {
  window: {
    __ModuleLoader__: { load: (spec) => { loaded = spec; } },
    document: fakeDocument,
    // ⚠ 假定时器**要真的回调**（只返回 0 会让 `nextTick` 永不 resolve，曾造成一次假绿），
    //    但必须**有额度**：收尾态会自我续期轮询，无限回调会把测试进程挂死。
    setTimeout: (fn) => {
      if (fakeTimerBudget <= 0) return 0;
      fakeTimerBudget -= 1;
      queueMicrotask(() => { try { if (typeof fn === 'function') fn(); } catch { /* 假定时器吞掉 */ } });
      return 0;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    innerWidth: 1280,
    innerHeight: 800,
  },
  console: { warn: () => {} },
};
/**
 * 假定时器额度（每个用例开始时由 `resetFakeTimers()` 重置）。
 * ⚠ 额度要够开机那条链吃：卡片按「开 → 核验 → 必要时重开」跨平台服务的补装窗口，
 * 最多 12 轮、每轮 1 次渲染等待 + 1 次重试间隔 ⇒ 单次 bootInto 就能连吃 20+ 个定时器。
 * 额度**必须有限**（收尾态的自我续期轮询会无限回调，没有额度会把测试进程挂死）。
 */
let fakeTimerBudget = 200;
function resetFakeTimers() {
  fakeTimerBudget = 200;
}
createContext(sandbox);
runInContext(source, sandbox, { filename: 'lib/client.js' });

// ── 极简 React 替身（真调用组件，不渲染成 DOM）────────────────────────────────

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  // 惰性初始化照真 React 的语义支持（组件里用了 useState(() => Date.now())）
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
};

/** 假 fetch：记录每次调用（URL + init），返回预置响应。 */
function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, options) {
  const status = options?.status ?? 200;
  return {
    ok: options?.ok ?? status < 400,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// ── ① 模块发现 ────────────────────────────────────────────────────────────────

check('client.js 调用了 __ModuleLoader__.load', loaded !== null && loaded !== undefined);
eq('模块 id == 包名（loader 条目名 = 行 name = 包名）', loaded?.id, pkg.name);
eq('模块 id 也等于 package.json 的 name', loaded.id, 'dsh-safely-quit');
check('load 规格带 factory', typeof loaded?.factory === 'function');

const exportsObj = loaded.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error(`未预期的 require('${name}') —— 客户端产物只应依赖 react 种子`);
});
check('factory 返回 exports', exportsObj !== null && typeof exportsObj === 'object');
check('exports 暴露 apply', typeof exportsObj.apply === 'function');

const T = exportsObj.__test ?? {};
check('暴露测试缝 __test（纯件可直接离线调用）', typeof T === 'object' && T !== null);

// ── ② 坞注册（假服务捕获参数）─────────────────────────────────────────────────

const registered = [];
const makeGui = () => ({
  register(entry, Component) {
    registered.push({ entry, Component });
    return () => {};
  },
});
const gui = makeGui();
let effectRegistered = 0;
const injectedNames = [];
const ctx = {
  get: () => gui,
  inject: (deps, cb) => {
    check('注入一律走运行时形式（服务名数组 + 回调，不是声明式 inject）', Array.isArray(deps) && typeof cb === 'function', JSON.stringify(deps));
    injectedNames.push(...deps);
    cb({ get: () => gui });
  },
  effect: (fn) => {
    effectRegistered += 1;
    fn();
  },
};

const applyResult = exportsObj.apply(ctx);
eq('apply 恒返回 undefined（返回值会被当作 effect 解释）', applyResult, undefined);
// 注入面**逐个点名**（多注入一个服务必须在这里被看见）：gui-frame 是坞/浮层的落点，
// uiWorkspace 是受 inject 守卫的那一面（切会话，见 client.js 的 readService）。
// 「继续」不再需要任何客户端服务 —— 它走的是宿主那条 HTTP（POST /continue）。
eq('运行时注入的服务名恰好是这两组', JSON.stringify([...new Set(injectedNames)].sort()),
  JSON.stringify(['gui-frame', 'uiWorkspace']));
// 注册发生在**一次读数之后**（先读上次的待续清单，才知道摆不摆角标）⇒ 等一个宏任务再看结果。
await new Promise((resolve) => setTimeout(resolve, 0));
eq('注册只发生一次', registered.length, 1);

const { entry, Component } = registered[0] ?? {};
eq('entry.id', entry?.id, 'dsh-safely-quit/quit');
eq('entry.kind 是 action（进坞面板）', entry?.kind, 'action');
eq('entry.order', entry?.order, 30);
eq('entry.source = 包名（坞的 stale 判定用）', entry?.source, pkg.name);
eq('entry.label 是 thunk', typeof entry?.label, 'function');
eq('label thunk 返回按钮文字', entry?.label(), '关闭 DSH');
check('entry.id 带命名空间前缀（ENTRY_ID_PATTERN）', /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(String(entry?.id)));
check('entry.id 不占保留 key', entry?.id !== 'conversation');

// ── ③ 图标：既给坞的 icon 槽，也画在按钮里 ────────────────────────────────────

check('entry.icon 已提供（坞会用 el(icon,{size:16}) 渲染它）', typeof entry?.icon === 'function');

const dockIconTree = entry?.icon?.({ size: 16 });
eq('坞的图标槽拿到 svg', dockIconTree?.type, 'svg');
eq('坞的图标按传入 size 显示', dockIconTree?.props?.width, 16);
eq('viewBox 是 24 格标准盒', dockIconTree?.props?.viewBox, '0 0 24 24');
eq('颜色只走 currentColor（暗色主题自动跟随）', dockIconTree?.props?.stroke, 'currentColor');
eq('填充为 none（是描边图标）', dockIconTree?.props?.fill, 'none');
eq('图标对无障碍隐藏', dockIconTree?.props?.['aria-hidden'], 'true');
eq('图标含两个笔画（开口圆环 + 中心竖线）', dockIconTree?.children?.length, 2);
eq('第一个笔画是圆环 path', dockIconTree?.children?.[0]?.type, 'path');
check('圆环 path 有 d 指令', typeof dockIconTree?.children?.[0]?.props?.d === 'string' && dockIconTree.children[0].props.d.startsWith('M'));
eq('第二个笔画是竖线', dockIconTree?.children?.[1]?.type, 'line');

const noSizeIcon = entry?.icon?.({});
check('未传 size 时用缺省尺寸', Number.isFinite(noSizeIcon?.props?.width) && noSizeIcon.props.width > 0);
eq('非法 size（0）也退到缺省', entry?.icon?.({ size: 0 })?.props?.width, noSizeIcon?.props?.width);

// ── ④ 坞面板首帧（组件真被调用）：**只有关闭按钮**（续跑卡片不进这里）────────────

const panelTree = Component();
eq('面板正文是一个竖排容器（坞把组件直接摆进自己那一行）', panelTree?.type, 'div');
eq('面板带机检锚点', panelTree?.props?.['data-safely-quit-panel'], 'true');
eq('★ 坞面板里只有一格（续跑卡片**不**塞进按钮面板 —— 那条落点设计上已否掉）', panelTree?.children?.length, 1);
check('那一格是关闭按钮组件', typeof panelTree?.children?.[0]?.type === 'function');
eq('开机拿不到会话列表 ⇒ 循环中数 0 ⇒ 不摆角标（坞按注册那一刻的字段画行）', entry?.badge, undefined);

// 面板每次打开都是**新组件实例**（坞现造 content）⇒ 这里拿到的就是"关掉再打开"的那一份
const QuitButton = panelTree?.children?.[0]?.type;
const buttonTree = QuitButton();
eq('★ 这颗键**不是** <button>（坞那一行本身就是 button，再嵌一层就是按钮套按钮）', buttonTree?.type, 'div');
eq('键上带机检锚点', buttonTree?.props?.['data-safely-quit-entry'], 'dsh-safely-quit/quit');
eq('键带阶段锚点（排障用）', buttonTree?.props?.['data-safely-quit-phase'], 'idle');
eq('键带"此刻点它有没有用"的锚点', buttonTree?.props?.['data-safely-quit-actionable'], 'true');
eq('键首个子节点是电源图标组件', buttonTree?.children?.[0]?.type, entry.icon);
eq('键里的图标尺寸与坞图标槽一致（16）', buttonTree?.children?.[0]?.props?.size, 16);
eq('键文字是「关闭 DSH」', buttonTree?.children?.[1]?.children?.[0], '关闭 DSH');
check('★ 键上不再有 type=button（它不是表单按钮，是那一行的动作面）', buttonTree?.props?.type === undefined);
check('键点击有处理函数（已接线）', typeof buttonTree?.props?.onClick === 'function');
check('★ 键上挂了 ref（要把"点那一行"也接过来）', buttonTree?.props?.ref !== undefined && buttonTree.props.ref !== null);

// ── ⑤ 与宿主对话的三个请求（假 fetch 捕获）───────────────────────────────────

check('__test 暴露 requestClose', typeof T.requestClose === 'function');
check('__test 暴露 requestForce', typeof T.requestForce === 'function');
check('__test 暴露 readState', typeof T.readState === 'function');
eq('端点前缀与宿主一致', T.ENDPOINT, '/api/dsh-safely-quit');

{
  const fetchImpl = fakeFetch(jsonResponse({ ok: true, accepted: true }));
  await T.requestClose(fetchImpl);
  const call = fetchImpl.calls[0];
  eq('close 打到 /close', call?.url, '/api/dsh-safely-quit/close');
  eq('close 用 POST', call?.init?.method, 'POST');
  eq('close 带 JSON 头', call?.init?.headers?.['content-type'], 'application/json');
  eq('close 默认带 confirm:true（不可逆动作的显式确认）', call?.init?.body, '{"confirm":true}');
}
{
  const fetchImpl = fakeFetch(jsonResponse({ ok: true }));
  await T.requestClose(fetchImpl, { dryRun: true });
  eq('dryRun 时只发演练指令（不真关）', fetchImpl.calls[0]?.init?.body, '{"dryRun":true}');
}
{
  const fetchImpl = fakeFetch(jsonResponse({ error: 'already closing' }, { status: 409 }));
  let threw = null;
  try {
    await T.requestClose(fetchImpl);
  } catch (error) {
    threw = error;
  }
  check('非 2xx 抛错（界面转错误态）', threw !== null);
  check('错误里带上宿主给的原因', String(threw?.message).includes('already closing'), String(threw?.message));
}
{
  const fetchImpl = fakeFetch(jsonResponse({ ok: true }));
  await T.requestForce(fetchImpl);
  eq('force 打到 /force', fetchImpl.calls[0]?.url, '/api/dsh-safely-quit/force');
  eq('force 用 POST', fetchImpl.calls[0]?.init?.method, 'POST');
}
{
  const fetchImpl = fakeFetch(jsonResponse({ stage: 'waiting', pending: ['a'] }));
  const state = await T.readState(fetchImpl);
  eq('state 打到 /state', fetchImpl.calls[0]?.url, '/api/dsh-safely-quit/state');
  eq('state 用 GET', fetchImpl.calls[0]?.init?.method, 'GET');
  eq('state 返回宿主原样给的状态', state?.stage, 'waiting');
}

// ── ⑤.1 关闭时上报「界面上开着哪些会话」（宿主拿它写待续清单）───────────────────
//
// 口径：**"开着" = 主视图持有这个会话**（`retainInfo().retainedBy.mainView`），不是"这次运行里
// 翻到过"。真机事故就出在后者：界面一个会话都没开，开机卡片却列了 16 个（跨 7 个工作区、
// 最早两天前建的）。下面几条钉住三件事：主路只认主视图、主路说"没有"就是没有、读不出来要说清。

check('__test 暴露 readOpenSessionIds', typeof T.readOpenSessionIds === 'function');

/** 造一个假 sessions 面：`ids` = 列表里的会话，`mainView` = 被主视图持有的那些。 */
function fakeSessionsFace(ids, mainView, options) {
  const held = new Set(mainView ?? []);
  const face = {
    list: {
      getSnapshot: () => ({
        ids: [...ids],
        byId: Object.fromEntries(ids.map((id) => [id, { sessionId: id }])),
        phase: 'ready',
      }),
    },
  };
  if (options?.noRetainInfo !== true) {
    face.retainInfo = (id) => ({
      getSnapshot: () => ({
        referenceCount: held.has(id) ? 1 : 0,
        retainedBy: held.has(id) ? { mainView: 1 } : {},
      }),
    });
  }
  if (options?.retainInfoThrows === true) {
    face.retainInfo = () => { throw new Error('boom'); };
  }
  return face;
}

/** 假 localStorage（只认一个键）。 */
function fakeStorage(value) {
  return { getItem: () => value };
}

{
  // 主路：列表里有三个会话，只有 b 被主视图持有
  const scope = T.readOpenSessionIds(fakeSessionsFace(['a', 'b', 'c'], ['b']), null);
  eq('★ 主路只把主视图持有的那个算"开着"', scope.ids.join(','), 'b');
  eq('主路的来源标识如实上报', scope.source, 'mainView');
}
{
  // 主路读成功但一个都没持有 ⇒ **就是空的**；本地存储里那个旧选择不许翻案
  const scope = T.readOpenSessionIds(
    fakeSessionsFace(['a', 'b'], []),
    fakeStorage(JSON.stringify({ sessionId: 'a' })),
  );
  eq('★ 主路说"一个都没开" ⇒ 不退回本地存储（退路不能翻主路的案）', scope.ids.length, 0);
  eq('来源仍是主路', scope.source, 'mainView');
}
{
  // 主路读不了（老平台没有 retainInfo）⇒ 退到平台自己持久化的"当前会话"
  const scope = T.readOpenSessionIds(
    fakeSessionsFace(['a'], [], { noRetainInfo: true }),
    fakeStorage(JSON.stringify({ sessionId: 'z-9' })),
  );
  eq('没有 retainInfo ⇒ 退路读本地存储里的当前会话', scope.ids.join(','), 'z-9');
  eq('退路的来源标识如实上报', scope.source, 'selection-store');
}
{
  const scope = T.readOpenSessionIds(fakeSessionsFace(['a'], [], { noRetainInfo: true }), fakeStorage('{}'));
  eq('退路读到空选择（用户停在"没有会话"的主视图）⇒ 一个都没有', scope.ids.length, 0);
  eq('空选择时来源仍是退路（不是 none）', scope.source, 'selection-store');
}
{
  const scope = T.readOpenSessionIds(fakeSessionsFace(['a'], [], { noRetainInfo: true }), fakeStorage(''));
  eq('退路键不存在 ⇒ 空', scope.ids.length, 0);
}
{
  const scope = T.readOpenSessionIds(fakeSessionsFace(['a'], [], { noRetainInfo: true }), fakeStorage('{坏 JSON'));
  eq('退路 JSON 坏了 ⇒ 不抛、报"读不出来"', scope.source, 'none');
}
{
  const scope = T.readOpenSessionIds(fakeSessionsFace(['a'], ['a'], { retainInfoThrows: true }), fakeStorage(JSON.stringify({ sessionId: 'q' })));
  eq('主路抛错 ⇒ 落退路', scope.ids.join(','), 'q');
}
{
  const scope = T.readOpenSessionIds(null, null);
  eq('两路都拿不到 ⇒ 空', scope.ids.length, 0);
  eq('★ 读不出来必须如实报 none（宿主据此"只记在跑的"，而不是当成"一个都没开"）', scope.source, 'none');
}
{
  // 主路里会话列表还没拉到 ⇒ 不能拿"空列表"当答案（那会把开着的会话漏掉）
  const pendingList = { list: { getSnapshot: () => ({ ids: null, byId: null, phase: 'pending' }) } };
  const scope = T.readOpenSessionIds(pendingList, fakeStorage(JSON.stringify({ sessionId: 'p-1' })));
  eq('列表还没拉到 ⇒ 退路补位', scope.ids.join(','), 'p-1');
  eq('列表还没拉到 ⇒ 来源是退路', scope.source, 'selection-store');
}
{
  // 请求体形状：读到了就带上（宿主据此写清单）
  const fetchImpl = fakeFetch(jsonResponse({ ok: true }));
  await T.requestClose(fetchImpl, { openSessionIds: ['s-1'], openSource: 'mainView' });
  const body = JSON.parse(fetchImpl.calls[0]?.init?.body);
  eq('关闭请求里带上开着的会话', body.openSessionIds.join(','), 's-1');
  eq('关闭请求里带上来源（诊断用）', body.openSource, 'mainView');
  eq('确认位还在（不可逆动作的门不能被读数挤掉）', body.confirm, true);
}
{
  const fetchImpl = fakeFetch(jsonResponse({ ok: true }));
  await T.requestClose(fetchImpl, { openSessionIds: [], openSource: 'mainView' });
  eq('"一个都没开"照实上报空数组（宿主据此记空清单、开机不弹卡片）',
    JSON.stringify(JSON.parse(fetchImpl.calls[0]?.init?.body).openSessionIds), '[]');
}
{
  const fetchImpl = fakeFetch(jsonResponse({ ok: true }));
  await T.requestClose(fetchImpl, { openSessionIds: null, openSource: 'none' });
  eq('读不出来就**不带**这两个字段（宿主按"没上报"处理）', fetchImpl.calls[0]?.init?.body, '{"confirm":true}');
}
{
  const fetchImpl = fakeFetch(jsonResponse({ ok: true }));
  await T.requestClose(fetchImpl, { dryRun: true, openSessionIds: ['x'], openSource: 'mainView' });
  const body = JSON.parse(fetchImpl.calls[0]?.init?.body);
  eq('演练也能带读数（命令行验清单口径用）', `${body.dryRun}/${body.openSessionIds?.[0]}`, 'true/x');
}
{
  // 状态机真跑一遍：confirm() 在发 /close **之前**把读数读出来，并原样上报
  const clock = makeClock();
  let scopeCalls = 0;
  const fetchImpl = fakeFetch(jsonResponse({ stage: 'waiting', pending: [], elapsedMs: 0 }));
  const store = T.createQuitStore({
    fetch: fetchImpl,
    schedule: clock.schedule,
    cancel: clock.cancel,
    openSessionIds: () => {
      scopeCalls += 1;
      return { ids: ['w-1'], source: 'mainView' };
    },
  });
  store.begin();
  await store.confirm();
  const closeCall = fetchImpl.calls.find((call) => String(call.url).endsWith('/close'));
  const body = JSON.parse(closeCall?.init?.body ?? '{}');
  eq('★ 关闭请求里带着状态机读到的那个会话', body.openSessionIds?.join(','), 'w-1');
  eq('只读一次（发请求前读，别在请求之后补读）', scopeCalls, 1);
}
{
  // 反例：读数口自己抛错 ⇒ 关闭照常发（绝不因为读数把关闭卡住），只是不带这两个字段
  const clock = makeClock();
  const fetchImpl = fakeFetch(jsonResponse({ stage: 'waiting', pending: [], elapsedMs: 0 }));
  const store = T.createQuitStore({
    fetch: fetchImpl,
    schedule: clock.schedule,
    cancel: clock.cancel,
    openSessionIds: () => { throw new Error('scope boom'); },
  });
  store.begin();
  await store.confirm();
  const closeCall = fetchImpl.calls.find((call) => String(call.url).endsWith('/close'));
  eq('读数炸了也照样发关闭请求', closeCall?.init?.body, '{"confirm":true}');
  eq('而且状态机进了收尾态', store.getSnapshot().phase, 'closing');
}

// ── ⑥ 显示状态机：每个阶段这颗键长什么样（真源 = QUIT_STATES / QUIT_TRANSITIONS）────
//
// 做法：**先机检机器自身**（五档齐全 / 字段齐全 / 转移表与状态表一一对应），再逐档断言渲染出来的
// 视图，最后**真跑一遍状态机**、逐跳与转移表对账 —— 表与行为不许分家。

const D = T.describePhase;
check('__test 暴露 describePhase', typeof D === 'function');
check('__test 暴露显示状态机本体', typeof T.QUIT_STATES === 'object' && T.QUIT_STATES !== null);
check('__test 暴露转移表与其判据', typeof T.QUIT_TRANSITIONS === 'object' && typeof T.canTransition === 'function');

/** 把 TEXT 表里的文案全渲染成一段文字（函数档给几个样本参数），用于"某句已绝迹"这类机检。 */
const allCopy = () => Object.values(T.TEXT)
  .map((value) => (typeof value === 'function' ? String(value(2, 7)) : String(value)))
  .join(' | ');

// 机器自身：五档、每档字段齐全、号令都有实现、class 都以 sq-btn 起头（盒子尺寸仍归坞那一行）
eq('阶段清单 = 五档（idle/confirming/closing/closed/failed）', T.QUIT_PHASES.join(','), 'idle,confirming,closing,closed,failed');
eq('未知阶段退到 idle 档', T.QUIT_FALLBACK_PHASE, 'idle');
for (const phase of T.QUIT_PHASES) {
  const state = T.QUIT_STATES[phase];
  check(`档 ${phase}：label/title 都是"吃 ctx 出字符串"的纯函数`,
    typeof state?.label === 'function' && typeof state?.title === 'function');
  check(`档 ${phase}：class 以 sq-btn 起头（阶段色只改颜色、不动盒子）`, String(state?.className).startsWith('sq-btn'), state?.className);
  check(`档 ${phase}：号令在 QUIT_COMMANDS 里有实现`, typeof T.QUIT_COMMANDS?.[state?.action] === 'function', state?.action);
  check(`档 ${phase}：actionable 是布尔`, typeof state?.actionable === 'boolean');
  // ★ 设计口径：键上**只有一段文字** —— 没有"附注"这条通路（每档都不许有 hint 字段）
  eq(`★ 档 ${phase}：没有 hint/附注这条通路（键上只有一段文字）`, 'hint' in state, false);
}
eq('★ describePhase 的视图模型里没有 hint 字段（组件也无从渲染第二个文字节点）', 'hint' in D('closing', null, 0), false);
eq('转移表的键集与状态表一一对应', Object.keys(T.QUIT_TRANSITIONS).join(','), T.QUIT_PHASES.join(','));
for (const from of Object.keys(T.QUIT_TRANSITIONS)) {
  for (const to of T.QUIT_TRANSITIONS[from]) {
    check(`转移表：${from} → ${to} 的终点是已知阶段`, T.QUIT_PHASES.includes(to), to);
  }
}
eq('canTransition：声明过的边为真', T.canTransition('idle', 'confirming'), true);
eq('canTransition 反例：idle 不许直接跳到 closed', T.canTransition('idle', 'closed'), false);
eq('canTransition 反例：closed 不许回到 idle', T.canTransition('closed', 'idle'), false);

// 逐档：渲染出来的视图（`main` = 键上**那一段**文字）
eq('idle：键上是「关闭 DSH」', D('idle', null, 0).main, '关闭 DSH');
eq('idle：点它有反应', D('idle', null, 0).actionable, true);
eq('idle：点击号令是 begin', D('idle', null, 0).action, 'begin');
eq('idle：class 是常态那一档', D('idle', null, 0).className, 'sq-btn');

eq('confirming：键上是「再点一次确认关闭」', D('confirming', null, 0).main, '再点一次确认关闭');
eq('confirming：点它有反应', D('confirming', null, 0).actionable, true);
eq('confirming：点击号令是 confirm', D('confirming', null, 0).action, 'confirm');
eq('confirming：用警告色那一档', D('confirming', null, 0).className, 'sq-btn sq-btn-confirm');
eq('★ confirming：文案表里 confirmHint 已删', 'confirmHint' in T.TEXT, false);
check('★ 那句旧说明（"关闭后本页会断开"）全表绝迹', !allCopy().includes('本页会断开'), allCopy());

{
  // ★ 收尾中：这一段文字 =「立即停止」+「（已等 S 秒）」拼成**一个字符串**（不是两个节点、不是第二行）
  const view = D('closing', { pending: ['a', 'b'], forceRequested: false }, 12000, null, 2);
  eq('★ closing：键上那一段文字 =「立即停止（已等 S 秒）」', view.main, '立即停止（已等 12 秒）');
  eq('closing：点它有反应（就是执行立即停止）', view.actionable, true);
  eq('closing：点击号令是 force', view.action, 'force');
  eq('closing：样式锚点是 .sq-btn-force', view.className, 'sq-btn sq-btn-force');
  eq('closing：悬停说明是固定那句（不跟读数变）', view.title, T.TEXT.forceTitle);
  check('★ closing：视图模型里不再有"第二颗按钮"这种字段', !('showForce' in view), JSON.stringify(view));
}
{
  const view = D('closing', { pending: [], forceRequested: false }, 3000);
  eq('★ closing：秒数照样拼进那段文字（不因待停清空换说法）', view.main, '立即停止（已等 3 秒）');
}
{
  const view = D('closing', { pending: ['a'], forceRequested: true }, 5000);
  eq('★ closing：已请求强杀也不再换文案（还是那一段文字）', view.main, '立即停止（已等 5 秒）');
}
eq('closed：键上是「DSH 已关闭」', D('closed', null, 0).main, 'DSH 已关闭');
eq('★ closed：补充那句进悬停说明（键面上不出现）', D('closed', null, 0).title, '可以关掉这个页面了');
eq('closed：这颗键不再做事（点它没反应）', D('closed', null, 0).actionable, false);
eq('★ closed：号令退成 none（组件不许自己判阶段）', D('closed', null, 0).action, 'none');
eq('failed：键上是「重试」（它本身就是重试键）', D('failed', null, 0).main, '重试');
eq('failed：点击号令是 retry', D('failed', null, 0).action, 'retry');
check('★ failed：失败原因住在悬停说明里', String(D('failed', null, 0, 'ETIMEDOUT').title).includes('ETIMEDOUT'), D('failed', null, 0, 'ETIMEDOUT').title);
check('failed：悬停说明仍说清"关闭没成功"', String(D('failed', null, 0, 'ETIMEDOUT').title).includes('关闭没成功'));
eq('failed：没有原因时不留下孤零零的冒号', D('failed', null, 0, null).title, '关闭没成功');
eq('★ failed：键面上只有「重试」两个字（原因不下键面）', D('failed', null, 0, 'ETIMEDOUT').main, '重试');
eq('未知阶段退到 idle 文案（不显示空白）', D('nonsense', null, 0).main, '关闭 DSH');
eq('未知阶段也退到 idle 的 class 与号令', `${D('nonsense', null, 0).className}/${D('nonsense', null, 0).action}`, 'sq-btn/begin');

// 悬停说明的"读数档"：把"关的话要等几个"说清（数值来自循环中会话数）
check('悬停说明按循环中会话数说清"关的话要等几个"', String(D('idle', null, 0, null, 3).title).includes('3'), D('idle', null, 0, null, 3).title);
eq('0 个在跑时悬停说明说清"直接收尾"', D('idle', null, 0, null, 0).title, '现在没有会话在循环中：关闭会直接收尾');
eq('读数拿不到时退回通用说明', D('idle', null, 0).title, T.TEXT.title);

// 文案定稿（设计口径）——把决定固化成判据，防回退
eq('停止按钮叫「立即停止」，不叫「终止」（后者会被读成"终止关闭"）', T.TEXT.force, '立即停止');
eq('★ 文案表：已等秒数是一句可拼的短句（拼在「立即停止」后面）', T.TEXT.elapsed(7), '（已等 7 秒）');
eq('★ 文案表：旧的两套进度说法与"已请求停止"档都已删除',
  ['waiting', 'noPending', 'forceSent', 'closing', 'confirmHint'].filter((key) => key in T.TEXT).join(','), '');
check('★ 键上不再重复"还有 N 个会话在跑"（那是右侧角标的活）', !allCopy().includes('还有 2 个会话在跑'), allCopy());
check('全表不含技术词「收敛」', !allCopy().includes('收敛'));
check('全表不叫「立即终止」', !allCopy().includes('立即终止'));
check('悬停说明不重复按钮名（按钮上已经有「关闭 DSH」）', !String(T.TEXT.title).startsWith('关闭 DSH'), T.TEXT.title);

// tone 是"这一档用哪套显示"；未知阶段与初始态同档
eq('收尾中的 tone 与初始态不同', D('closing', { pending: [] }, 0).tone !== D('idle', null, 0).tone, true);
eq('已关闭的 tone 与初始态不同', D('closed', null, 0).tone !== D('idle', null, 0).tone, true);

{
  // ★★ 表与行为对账：真跑一遍状态机，走位里每一跳都必须在 QUIT_TRANSITIONS 里声明过
  const seen = [];
  const store = T.createQuitStore({
    fetch: async (url) => (String(url).endsWith('/close')
      ? jsonResponse({ error: 'already closing' }, { status: 409 })
      : jsonResponse({ stage: 'idle' })),
    schedule: () => 1,
    cancel: () => {},
  });
  const record = () => {
    const phase = store.getSnapshot().phase;
    if (seen[seen.length - 1] !== phase) seen.push(phase);
  };
  store.subscribe(record);
  record();
  store.begin();          // idle → confirming
  await store.confirm();  // confirming → closing（随后 /close 被拒）→ failed
  store.retry();          // failed → idle
  eq('★ 真状态机的走位 = 表里声明的那条链', seen.join('→'), 'idle→confirming→closing→failed→idle');
  for (let step = 1; step < seen.length; step += 1) {
    check(`★ 走位第 ${step} 跳（${seen[step - 1]} → ${seen[step]}）在转移表里声明过`,
      T.canTransition(seen[step - 1], seen[step]), `${seen[step - 1]} → ${seen[step]}`);
  }
}

// ── ⑦ 样式注入 ────────────────────────────────────────────────────────────────

eq('样式被注入一次', injectedStyles.length, 1);
const cssText = injectedStyles[0]?.textContent ?? '';
check('样式含按钮规则', cssText.includes('.sq-btn{'));
check('样式含新图标规则（只定位，不给颜色）', cssText.includes('.sq-icon{flex:none;display:block}'));
check('旧的自绘方块规则已删除（.sq-dot 不复存在）', !cssText.includes('.sq-dot'));
check('图标规则里没有颜色字面量（靠 currentColor 继承）', !/\.sq-icon\{[^}]*#[0-9a-fA-F]{3}/.test(cssText));
check('样式含收尾卡片规则', cssText.includes('.sq-card{'));
check('样式含面板竖排容器规则', cssText.includes('.sq-stack{'));
// ── ⑦-2 坞里的**对齐契约**（用户报「本插件的按钮在按钮坞里特立独行、和别的按钮完全不对齐」）──────────
// 那一条行盒（`padding:7px 8px` / `min-height:36px` / `font-size:14px` / `line-height:22px` / 悬停底色 /
// `border-radius:8px`）是**坞画的**（`[data-guif-dock-action]` = DSH 侧栏 `.panelRow` 的逐值照抄）。
// 插件这层只许做内容：自带其中任何一项，内容就相对邻居多缩进一截、整行也被顶高一截。
// 真机读数（`tools/dock-shot.mjs`）：自带行盒那版 icon 左内缩 18px / 行高 46px / 文字 13px，而邻居是 8px / 36px / 14px。
{
  const btn = (cssText.match(/\.sq-btn\{([^}]*)\}/) ?? [null, ''])[1];
  check('坞里的键不自带内边距（缩进由行给；邻居是 0）', /padding:0[;}]/.test(btn), btn);
  check('坞里的键不自带固定高度（行高由 line-height 撑；邻居是 22px）', !/(?:^|;)height:/.test(btn), btn);
  check('坞里的键与邻居同字号同字高（14px / 22px）', /font-size:14px/.test(btn) && /line-height:22px/.test(btn), btn);
  check('坞里的键不自升文字颜色（跟随行；改前写的是 label-primary，比邻居重一档）', /color:inherit/.test(btn), btn);
  check('坞里的键不再自画悬停底色（整行一个悬停面；自画的那版早被坞的中和规则按 !important 抹掉）', !cssText.includes('.sq-btn:hover{'));
  check('坞里的键不再有按下的位移（邻居都没有，只有我们有就是"特立独行"）', !cssText.includes('.sq-btn:active{'));
  check('竖排包装层给了收缩下限（坞的角标是 margin-left:auto 的兄弟，不给就把它挤出可视区）', /\.sq-stack\{[^}]*min-width:0/.test(cssText));
}
check('样式含续跑行规则', cssText.includes('.sq-session{'));
check('样式含「继续 / 打开」小键规则', cssText.includes('.sq-open{'));
check('样式里不再有收起键规则（「不用了」连同它的样式一起删干净）', !cssText.includes('.sq-dismiss'));
check('fiber 清理已挂上（状态机 + 坞入口各一份，卸载时都不留残留）', effectRegistered === 2, `实际 ${effectRegistered}`);

// ── ⑧ 反例：服务缺席与注册抛错都不许打死整页 ─────────────────────────────────

{
  const exports2 = loaded.factory(() => ReactStub);
  const missingGuiCtx = {
    get: () => undefined,
    inject: (deps, cb) => cb({ get: () => undefined }),
    effect: () => { throw new Error('不该走到 effect'); },
  };
  let threw = null;
  try {
    exports2.apply(missingGuiCtx);
  } catch (error) {
    threw = error;
  }
  eq('服务缺席时不抛错（页面照常）', threw, null);
}
{
  const exports3 = loaded.factory(() => ReactStub);
  const throwingCtx = {
    get: () => undefined,
    inject: (deps, cb) => cb({
      get: () => ({
        register() {
          throw new Error('GUIF-E-ENTRY-INVALID: 模拟坞侧拒绝');
        },
      }),
    }),
    effect: () => {},
  };
  let threw = null;
  try {
    exports3.apply(throwingCtx);
  } catch (error) {
    threw = error;
  }
  eq('坞拒绝注册时不抛错（客户端抛错会打死整页）', threw, null);
}
{
  const exports4 = loaded.factory(() => ReactStub);
  let threw = null;
  try {
    exports4.apply(null);
  } catch (error) {
    threw = error;
  }
  eq('ctx 为空时不抛错', threw, null);
}
{
  // 请求层反例：宿主返回非 JSON 文本时，错误信息仍可读（不许在这里崩）
  const fetchImpl = fakeFetch({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
  let threw = null;
  try {
    await T.requestForce(fetchImpl);
  } catch (error) {
    threw = error;
  }
  check('宿主返回非 JSON 错误时仍抛出可读原因', String(threw?.message).includes('boom'), String(threw?.message));
}

// ── ⑨ 启动半区：上次关的时候谁在跑（读清单 → 角标 → 一键打开，不发消息）──────────

const MANIFEST = {
  available: true,
  pending: {
    version: 1,
    reason: 'user-requested',
    closedAt: '2026-10-05T02:11:53.721Z',
    hostPid: 6744,
    sessions: [
      { sessionId: 'session-a', cwd: 'D:\\work\\proj-a', title: null, statusAtClose: 'idle' },
      { sessionId: 'session-b', cwd: 'D:/work/proj-b', title: '改需求', statusAtClose: 'running' },
      { sessionId: 'session-c', statusAtClose: 'idle' },
    ],
  },
};

check(
  '__test 暴露启动半区的纯件',
  [T.parsePending, T.describeResume, T.planBoot, T.openSession, T.readPending, T.ResumeCard, T.createPanel, T.baseName, T.claimPendingRecord, T.clearPendingRecord, T.closedByUser, T.watchResumeCard, T.countRunning, T.badgeOf, T.runningTitleOf, T.setDockBadge, T.watchRunning]
    .every((fn) => typeof fn === 'function'),
);

{
  const model = T.parsePending(MANIFEST);
  eq('清单归一化：条数', model?.total, 3);
  eq('清单归一化：关闭时在跑的条数', model?.running, 1);
  eq('关闭时在跑的排最前面（那才是被打断、最想接着看的）', model?.sessions?.[0]?.sessionId, 'session-b');
  eq('有标题就用标题', model?.sessions?.[0]?.label, '改需求');
  eq('没标题退回目录名（反斜杠路径）', model?.sessions?.find((s) => s.sessionId === 'session-a')?.label, 'proj-a');
  eq('正斜杠 + 结尾斜杠也认', T.baseName('D:/work/proj-b/'), 'proj-b');
  eq('没有目录名时退回会话 id 短标识', model?.sessions?.find((s) => s.sessionId === 'session-c')?.label, 'session-c');
  eq('closedAt 带出来（"看过了"标记按它比对）', model?.closedAt, '2026-10-05T02:11:53.721Z');
}
{
  eq('宿主说没有待续 ⇒ null（界面什么都不显示）', T.parsePending({ available: false }), null);
  eq('载荷形状不对 ⇒ null', T.parsePending(null), null);
  eq('一条可用会话都没有 ⇒ null', T.parsePending({ available: true, pending: { sessions: [] } }), null);
  eq(
    '坏行被跳过、好行仍可用',
    T.parsePending({ available: true, pending: { sessions: [null, { sessionId: '' }, { sessionId: 'ok' }] } })?.total,
    1,
  );
}
{
  // ── ⑪-2 角标 = **循环中会话数**（设计口径：如果关闭，需要暂停的总会话数）──────────
  // 判据三层：① 怎么数（`countRunning`）；② 0 个怎么画（`badgeOf` 必须给 null，不能给 0）；
  //          ③ 悬停说明把那个数说清楚（`runningTitleOf`）。
  eq(
    '循环中会话数 = 列表里 running=true 的行数',
    T.countRunning({ ids: ['a', 'b', 'c'], byId: { a: { running: true }, b: { running: false }, c: { running: true } } }),
    2,
  );
  eq('一个都没在跑 ⇒ 0', T.countRunning({ byId: { a: { running: false } } }), 0);
  eq('列表还没拿到（phase=pending 的空壳）⇒ 0，不谎报', T.countRunning({ ids: [], byId: {}, phase: 'pending' }), 0);
  eq('没有列表服务 ⇒ 0（不抛）', T.countRunning(null), 0);
  eq('行形状不对（缺 running 位）⇒ 不计入', T.countRunning({ byId: { a: {}, b: null, c: { running: true } } }), 1);
  eq('★ 0 个在跑 ⇒ 角标取值 null（画一个"0"是噪声；坞面板行那边 0 会被真画出来）', T.badgeOf(0), null);
  eq('有在跑 ⇒ 就是那个数', T.badgeOf(3), 3);
  eq('小数/异常值收敛成整数或 null', `${T.badgeOf(2.7)}|${T.badgeOf(-1)}|${T.badgeOf(NaN)}`, '2|null|null');
  check('悬停说明：有在跑时报出个数并说清"跑完当前一步再停"', T.runningTitleOf(2).includes('2') && T.runningTitleOf(2).includes('循环中') && T.runningTitleOf(2).includes('跑完当前一步'), T.runningTitleOf(2));
  check('悬停说明：0 个在跑时说"直接收尾"（免得人以为数没了是坏了）', T.runningTitleOf(0).includes('没有会话在循环中'), T.runningTitleOf(0));
  check('两条读数档都不以按钮名开头（按钮上已经写着「关闭 DSH」）', !T.runningTitleOf(1).startsWith('关闭 DSH') && !T.runningTitleOf(0).startsWith('关闭 DSH'));
}
{
  // 推角标的通道：**切片面是三参**（callerCtx, id, badge）—— 按两参调会静默失败（别的插件踩过）
  const calls = [];
  const gui = { __slice: (name) => (name === 'dock' ? { setBadge: (ctx, id, value) => { calls.push([ctx, id, value]); return true; } } : undefined) };
  const callerCtx = { tag: 'ctx' };
  eq('切片面在位 ⇒ 推上去', T.setDockBadge(gui, callerCtx, 4), true);
  const first = calls[0] ?? [];
  eq('★ 第一个实参是调用方 ctx（不是 id）', first[0], callerCtx);
  eq('第二个实参才是入口 id', first[1], 'dsh-safely-quit/quit');
  eq('第三个实参是值', first[2], 4);
  T.setDockBadge(gui, callerCtx, null);
  eq('推 null = 擦掉角标', calls[1]?.[2], null);
  eq('切片面缺席 ⇒ 返回 false（界面只是不显示那个数，不抛）', T.setDockBadge({}, callerCtx, 1), false);
  eq('服务面缺席 ⇒ false', T.setDockBadge(null, callerCtx, 1), false);
}
{
  // `watchRunning`：订阅会话列表 → 每次变化同时更新 store 与角标；随 fiber 拆订阅
  const pushed = [];
  let listener = null;
  let unsubscribed = 0;
  const list = {
    snapshot: { byId: { a: { running: true } } },
    getSnapshot() { return this.snapshot; },
    subscribe(fn) { listener = fn; return () => { unsubscribed += 1; }; },
  };
  const store = { running: null, setRunning(n) { this.running = n; } };
  const gui = { __slice: () => ({ setBadge: (ctx, id, value) => { pushed.push(value); return true; } }) };
  const effects = [];
  // 照 cordis 的语义：`effect(cb)` 会**调用 cb 并收下它返回的 disposer**（卸载时调那个）。
  const ownerCtx = { effect: (fn) => { effects.push(fn()); } };
  const serviceCtx = { get: (name) => (name === 'sessions' ? { list } : null) };
  eq('订阅上了 ⇒ true', T.watchRunning(serviceCtx, gui, store, ownerCtx), true);
  eq('先给一次当下的读数（不等第一次变化）', `${store.running}|${pushed[0]}`, '1|1');
  list.snapshot = { byId: { a: { running: true }, b: { running: true }, c: { running: false } } };
  listener();
  eq('列表一变 ⇒ store 跟着变', store.running, 2);
  eq('列表一变 ⇒ 角标跟着变', pushed[1], 2);
  list.snapshot = { byId: {} };
  listener();
  eq('全部跑完 ⇒ 角标擦掉（推 null）', pushed[2], null);
  eq('拆订阅挂到了 fiber 上（卸载不留订阅）', effects.length, 1);
  eq('卸载时真的退订了', typeof effects[0] === 'function' ? (effects[0](), unsubscribed) : -1, 1);
  eq('拿不到会话服务 ⇒ false（角标只是不实时，不抛）', T.watchRunning({ get: () => null }, gui, store, ownerCtx), false);
  const noSub = { get: () => ({ list: { getSnapshot: () => ({ byId: { a: { running: true } } }) } }) };
  eq('列表不可订阅（旧宿主）⇒ 仍然给一次读数并返回 true', `${T.watchRunning(noSub, gui, store, ownerCtx)}|${pushed[pushed.length - 1]}`, 'true|1');
}
{
  const model = T.parsePending(MANIFEST);
  const fresh = T.planBoot(model);
  eq('有被打断的会话 ⇒ 卡片数据带上', fresh.initialResume === model, true);
  eq('★ 开机计划里**不再有角标**这一项（角标改成实时的循环中会话数）', 'badge' in fresh, false);
  eq('★ 开机计划里也**不再有"看过了"这一项**（那件事归宿主盘上的记录管，见下）', 'acked' in fresh, false);
  eq('planBoot 只吃一个参数（旧的两参形态已废）', T.planBoot.length, 1);
}
{
  const model = T.parsePending(MANIFEST);
  const card = T.describeResume(model, null);
  eq('标题报出"3 个会话、其中 1 个在跑"（混合档：行数 > 在跑数）', card?.title, T.TEXT.resumeMixed(3, 1));
  eq('★ 卡片列出清单里的全部会话（在跑的打头，空闲的跟在后面）', card?.rows?.length, 3);
  eq('★ 列的就是那个在跑的会话', card?.rows?.[0]?.sessionId, 'session-b');
  eq('★ 空闲会话也进来，且标记为非打断', `${card?.rows?.[1]?.interrupted}|${card?.rows?.[2]?.interrupted}`, 'false|false');
  eq('列表还没拿到时不禁用按键（不谎报"会话没了"）', card?.rows?.[0]?.openable, true);
  const renamed = T.describeResume(model, { phase: 'ready', byId: { 'session-b': { displayTitle: '改需求（新名）' } } });
  eq('标签优先取当前列表里的标题（用户可能改过名）', renamed?.rows?.[0]?.label, '改需求（新名）');
  const vanished = T.describeResume(model, { phase: 'ready', byId: {} });
  eq('列表拉全了却查不到 ⇒ 会话没了（不给键）', vanished?.rows?.[0]?.openable, false);
  const pendingList = T.describeResume(model, { phase: 'pending', byId: {} });
  eq('列表还在拉（phase=pending）⇒ 不下"会话没了"的结论', pendingList?.rows?.[0]?.openable, true);
  eq('快照形状怪（没有 phase）⇒ 同样不下"会话没了"的结论', T.describeResume(model, { byId: {} })?.rows?.[0]?.openable, true);
  eq('没有清单 ⇒ 没有卡片', T.describeResume(null, null), null);
}
{
  // ★ 一个都没被打断 ⇒ 卡片照样弹：列的是"上次关的时候开着的会话"（每行仍是「继续」）
  const allIdle = T.parsePending({ available: true, pending: { closedAt: 'y', sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] } });
  eq('★ 全空闲 ⇒ 卡片照样弹（设计口径：关闭后开机要能看见上次的会话）', T.planBoot(allIdle, null).initialResume === allIdle, true);
  eq('★ 全空闲 ⇒ 两行都在（不是空卡片）', T.describeResume(allIdle, null)?.rows?.length, 2);
  eq('★ 全空闲的旧记录 ⇒ 混合档标题（行数 2、在跑 0）', T.describeResume(allIdle, null)?.title, T.TEXT.resumeMixed(2, 0));
  eq('★ 混合记录 ⇒ 标题报**总条数 + 其中在跑几个**', T.describeResume(T.parsePending(MANIFEST), null)?.title, T.TEXT.resumeMixed(3, 1));
  eq('★ 只要有一个被打断，卡片就弹', T.planBoot(T.parsePending(MANIFEST), null).initialResume !== null, true);
}
{
  const calls = [];
  eq('打开会话：调到 ctx.sessions.open', T.openSession({ open: (id) => calls.push(id) }, 'session-b'), true);
  eq('打开会话：传的就是这个 id', calls[0], 'session-b');
  eq('客户端会话服务缺席 ⇒ false（不抛）', T.openSession(null, 'session-b'), false);
  const ghost = { open: () => { throw new Error('unknown session'); } };
  let threw = null;
  try {
    T.openSession(ghost, 'ghost');
  } catch (error) {
    threw = error;
  }
  eq('宿主拒绝（id 不在列表里）⇒ 吞掉不抛（客户端抛错会打死整页）', threw, null);
  eq('宿主拒绝时如实返回 false（界面把键变成重试）', T.openSession(ghost, 'ghost'), false);
}
{
  // 平台 0.2.0 起「切会话」搬到了 uiWorkspace.openSession（`sessions` 面不再有 open）——
  // 这一组是那条真机故障的回归判据：两条路都要认、新面优先、新面坏了要退回老面。
  const wsCalls = [];
  const workspace = { openSession: (id) => wsCalls.push(id) };
  eq('uiWorkspace 面：取得到就返回它本身', T.resolveUiWorkspace({ get: (n) => (n === 'uiWorkspace' ? workspace : null) }) === workspace, true);
  eq('uiWorkspace 面：服务缺席 ⇒ null', T.resolveUiWorkspace(null), null);
  eq('uiWorkspace 面：没有 openSession 的冒牌面 ⇒ null', T.resolveUiWorkspace({ get: () => ({}) }), null);

  eq('★ 0.2.0 真身：sessions 面只剩目录（没有 open），靠 uiWorkspace 照样切得过去', T.openSession({ list: {} }, 'session-b', workspace), true);
  eq('★ 切的就是这个 id', wsCalls[0], 'session-b');

  const legacy = [];
  wsCalls.length = 0;
  eq('两条路都在场 ⇒ 只走新面（不重复切）', T.openSession({ open: (id) => legacy.push(id) }, 'session-c', workspace), true);
  eq('两条路都在场：老面一次都没被调', legacy.length, 0);

  wsCalls.length = 0;
  eq('新面当场抛错 ⇒ 退回老面并成功', T.openSession({ open: (id) => legacy.push(id) }, 'session-d', { openSession: () => { throw new Error('boom'); } }), true);
  eq('退回的那一下真的落到老面', legacy[0], 'session-d');
  eq('新面抛错 + 老面缺席 ⇒ false，不抛（界面把键变成重试）', T.openSession(null, 'session-e', { openSession: () => { throw new Error('boom'); } }), false);
  eq('空 id ⇒ false（不拿空目标去问平台）', T.openSession({ open: (id) => legacy.push(id) }, '', workspace), false);
  eq('非字符串 id ⇒ false', T.openSession({ open: (id) => legacy.push(id) }, undefined, workspace), false);

  // 失败时的现场读数：缺的是哪一面必须看得见（这一档以往只能靠人在浏览器里复述）
  const faces = T.probeContinueFaces({
    sessions: () => ({ list: {} }),
    workspace: () => ({ openSession() {} }),
    fetch: () => {},
  });
  eq('失败读数：sessions 面在、但它没有 open（真机那条故障的形状）', `${faces.sessions}/${faces.sessionsOpen}`, 'object/false');
  eq('失败读数：uiWorkspace.openSession 在', faces.workspaceOpen, true);
  eq('失败读数：fetch 在（真正把消息投出去的那一面）', faces.fetch, true);
  eq('失败读数：面全缺席也如实报 null（不抛）', JSON.stringify(T.probeContinueFaces({})),
    JSON.stringify({ sessions: null, sessionsOpen: false, workspace: null, workspaceOpen: false, fetch: false }));
  eq('失败读数：取值函数自己抛 ⇒ 当作缺席（读数绝不把主流程带崩）', T.probeContinueFaces({ sessions: () => { throw new Error('boom'); } }).sessions, null);

  // 受守卫的服务（`uiWorkspace`）只能靠注入拿：readService 的取法与退路
  eq('readService：注入作用域里有 ⇒ 直接取到', T.readService({ get: (n) => (n === 'uiWorkspace' ? workspace : null) }, 'uiWorkspace') === workspace, true);
  eq('readService：未声明就取（get 当场抛）⇒ 属性退路仍取得到', typeof T.readService({
    get: () => { throw new Error('cannot get property "uiWorkspace" without inject'); },
    uiWorkspace: workspace,
  }, 'uiWorkspace')?.openSession, 'function');
  eq('readService：两路都取不到 ⇒ null，不抛', T.readService({ get: () => { throw new Error('without inject'); } }, 'uiWorkspace'), null);
    eq('readService：holder 是 null ⇒ null，不抛', T.readService(null, 'uiWorkspace'), null);
}
{
  // ★ 「继续」= 请宿主投一条**续行消息**（`POST /continue`），客户端**不碰目标**。
  //   为什么不能走目标：目标一武装，轮次驱动就会在 agent 空闲时**自己**开下一轮（默认上限 256 轮）
  //   —— 那是无人值守的自动续跑（设计规格 §1 明确不做）；被关闭打断的会话也根本没有目标。
  eq('客户端不再有任何目标原语（这六个入口都该消失）',
    [T.readGoal, T.createGoal, T.resumeGoal, T.describeContinue, T.resolveGoals, T.unwrapGoalResult].filter((item) => item !== undefined).length, 0);
  eq('也不再有"新建续跑目标"的文案', T.TEXT.continueRunning, undefined);

  const calls = [];
  const attach = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ ok: true, attached: 1, results: [{ sessionId: 's8', result: 'attached' }] });
  };
  const deps = { sessions: () => ({ list: {} }), workspace: () => ({ openSession() {} }), fetch: attach };
  eq('★ 点「继续」⇒ 请宿主接续，如实回"已接上"', await T.continueSession(deps, 's8'), 'attached');
  eq('打到 /continue', calls[0]?.url, '/api/dsh-safely-quit/continue');
  eq('用 POST', calls[0]?.init?.method, 'POST');
  eq('只送这一个会话 id', JSON.parse(calls[0]?.init?.body).sessionIds[0], 's8');
  eq('请求体里没有任何"目标"字样（接续不靠目标）', /goal|objective|目标/i.test(calls[0]?.init?.body ?? ''), false);
}
{
  // 宿主回的四档要如实分开：接上 / 本来就在跑 / 会话不在了 / 没接上
  const depsWith = (result) => ({
    sessions: () => ({ list: {} }),
    workspace: () => ({ openSession() {} }),
    fetch: async () => jsonResponse({ ok: true, results: [{ sessionId: 's1', result }] }),
  });
  eq('宿主说接上了 ⇒ attached', await T.continueSession(depsWith('attached'), 's1'), 'attached');
  eq('宿主说本来就在跑 ⇒ already', await T.continueSession(depsWith('already'), 's1'), 'already');
  eq('★ 宿主说这个会话不在 ⇒ gone（界面显示"这个会话不在了"，不装成失败）', await T.continueSession(depsWith('missing'), 's1'), 'gone');
  eq('宿主说没接上（服务缺席等）⇒ failed', await T.continueSession(depsWith('failed'), 's1'), 'failed');
  eq('宿主回的形状不对 ⇒ failed（不瞎猜成已接上）', await T.continueSession({ ...depsWith('attached'), fetch: async () => jsonResponse({ ok: true }) }, 's1'), 'failed');
  eq('请求本身抛错 ⇒ failed（键变重试）', await T.continueSession({ ...depsWith('attached'), fetch: async () => { throw new Error('ECONNREFUSED'); } }, 's1'), 'failed');
  eq('没有 fetch 面 ⇒ failed（不假装已接上）', await T.continueSession({ sessions: () => ({ list: {} }), workspace: () => ({ openSession() {} }) }, 's1'), 'failed');
}
{
  // continueSession 必须把"切会话"这一面用上 —— 否则人看不到"是哪个会话被接上"
  const viaWs = [];
  const withWs = {
    sessions: () => ({ list: {} }),
    workspace: () => ({ openSession: (id) => viaWs.push(id) }),
    fetch: async () => jsonResponse({ ok: true, results: [{ sessionId: 's6', result: 'attached' }] }),
  };
  eq('★ continueSession 走 uiWorkspace 切会话（0.2.0 那条路）', await T.continueSession(withWs, 's6'), 'attached');
  eq('切会话用的正是 uiWorkspace 面', viaWs[0], 's6');
}
{
  const fetchImpl = fakeFetch(jsonResponse(MANIFEST));
  const model = await T.readPending(fetchImpl);
  eq('读清单打到 /last-pending', fetchImpl.calls[0]?.url, '/api/dsh-safely-quit/last-pending');
  eq('读清单用 GET', fetchImpl.calls[0]?.init?.method, 'GET');
  eq('读清单拿到归一化结果', model?.running, 1);
}
{
  eq('接口说没有 ⇒ null', await T.readPending(fakeFetch(jsonResponse({ available: false }))), null);
  eq('接口报错 ⇒ null（当作没有待续，不摆错误态）', await T.readPending(fakeFetch(jsonResponse({ error: 'boom' }, { status: 500 }))), null);
  eq('没有 fetch ⇒ null（离线 / 老浏览器）', await T.readPending(null), null);
  eq('读取抛错 ⇒ null（拿不到清单不该拦住按钮）', await T.readPending(async () => { throw new Error('ECONNREFUSED'); }), null);
}
{
  // ★ 记录的两条通路（设计口径）：**认领**（卡片站稳了）与**清空**（用户关了面板）
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ ok: true, stamped: true });
  };
  eq('认领：打到 /pending/claim', await T.claimPendingRecord(okFetch, 'ts-1'), true);
  eq('认领：POST', calls[0]?.init?.method, 'POST');
  eq('认领：带上这份记录的时间戳（不许认领别的记录）', JSON.parse(calls[0]?.init?.body).closedAt, 'ts-1');
  eq('认领：URL 就在同一前缀下', calls[0]?.url, '/api/dsh-safely-quit/pending/claim');
  eq('清空：打到 /pending/clear', await T.clearPendingRecord(okFetch, 'ts-1'), true);
  eq('清空：POST 且带时间戳', `${calls[1]?.init?.method}|${JSON.parse(calls[1]?.init?.body).closedAt}`, 'POST|ts-1');
  eq('清空：URL 就在同一前缀下', calls[1]?.url, '/api/dsh-safely-quit/pending/clear');
  eq('宿主回 ok:false ⇒ 不算成功', await T.claimPendingRecord(fakeFetch(jsonResponse({ ok: false })), 'ts-1'), false);
  eq('宿主报错 ⇒ 不算成功（下一拍心跳会重试）', await T.clearPendingRecord(fakeFetch(jsonResponse({ error: 'boom' }, { status: 409 })), 'ts-1'), false);
  eq('没有 fetch ⇒ false（离线 / 老浏览器，不抛）', await T.claimPendingRecord(null, 'ts-1'), false);
  eq('没有时间戳 ⇒ 不发这次请求（免得清错记录）', await T.clearPendingRecord(okFetch, null), false);
  eq('请求抛错 ⇒ 吞掉返回 false（客户端抛错会打死整页）', await T.claimPendingRecord(async () => { throw new Error('ECONNREFUSED'); }, 'ts-1'), false);
}
{
  // 面板交互（直接调卡片渲染出来的那两个回调 —— 钩子在替身里是空实现，状态变化不在这里验）
  const openedCalls = [];
  const sentIds = [];
  const model = T.parsePending(MANIFEST);
  const Live = T.createResumeCardLive({
    sessions: () => ({ open: (id) => openedCalls.push(id), list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } }),
    // 点「继续」= 请宿主投一条续行消息（客户端不碰目标、也不发用户消息）
    workspace: () => ({ openSession: (id) => openedCalls.push(id) }),
    fetch: async (url, init) => {
      sentIds.push(...JSON.parse(init.body).sessionIds);
      return jsonResponse({ ok: true, results: [{ sessionId: 'session-b', result: 'attached' }] });
    },
  });
  const tree = Live({ model });
  eq('卡片外壳渲染出卡片', tree?.type, T.ResumeCard);
  const cardProps = tree?.props ?? {};
  cardProps.onContinue?.('session-b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  eq('点「继续」⇒ 先切到那个会话', openedCalls[0], 'session-b');
  eq('点「继续」⇒ 真的请宿主接续（不是只切会话）', sentIds[0], 'session-b');
  eq('卡片外壳**不再往浏览器本地存任何东西**（记录的去留归宿主）', tree?.props?.onDismiss, undefined);
  eq('没有清单 ⇒ 卡片模型是 null（内层返回 null，不留空壳）', Live({ model: null })?.props?.model, null);
  const panelWithout = T.createPanel({ store: null, initialResume: null, sessions: () => null })();
  check('没有状态机时面板也不崩（关闭键退回初始态）', panelWithout?.children?.[0]?.type?.()?.props?.['data-safely-quit-phase'], 'idle');
}
{
  // 卡片渲染树：每一行都是「继续」（没有"打开"这种只切窗口的键）+ 一颗总键「一键继续」+ 没了的只说明
  const model = T.parsePending(MANIFEST);
  const card = T.ResumeCard({ model: T.describeResume(model, null), opened: {}, onContinue: () => {}, onContinueAll: () => {} });
  eq('卡片带机检锚点', card?.props?.['data-safely-quit-resume'], 'true');
  eq('卡片标题在第一行（条数是行数，在跑几个在括号里）', card?.children?.[0]?.children?.[0], '上次关闭时有 3 个会话（1 个在跑）');
  eq('第一行是"那一刻在跑"的会话（键名「继续」）', card?.children?.[1]?.children?.[1]?.children?.[0], '继续');
  eq('第一行的键指向那个会话', card?.children?.[1]?.children?.[1]?.props?.['data-safely-quit-continue'], 'session-b');
  eq('★ 卡片把清单里的会话全画出来（每行一颗键）', (card?.children ?? []).filter((child) => child?.props?.['data-safely-quit-session'] !== undefined).length, 3);
  // 动作行按"最后一行实体"来找（清单里有几个会话、尾部有没有 null 占位都不影响这条判据）
  const kids = (node) => (node?.children ?? []).filter((child) => child !== null && child !== undefined);
  const cardKids = kids(card);
  const actions = cardKids[cardKids.length - 1];
  eq('动作行带机检锚点', actions?.props?.['data-safely-quit-resume-actions'], 'true');
  eq('★ 动作行里只有那一颗总键「一键继续」', actions?.children?.length, 1);
  eq('动作行头一颗就是总键「一键继续」', actions?.children?.[0]?.children?.[0], '一键继续');
  eq('总键带机检锚点', actions?.children?.[0]?.props?.['data-safely-quit-continue-all'], 'true');
  check(
    '★ 整张卡片里不出现「打开」两个字（设计口径：不要这个功能）',
    !JSON.stringify(card).includes('打开'),
    JSON.stringify(card)?.slice(0, 200),
  );
  check(
    '★★ 整张卡片里也没有「不用了」了（2026-10-07 用户："『不用了』删掉" —— 关面板本身就是那个意思）',
    !JSON.stringify(card).includes('不用了') && !JSON.stringify(card).includes('data-safely-quit-dismiss'),
    JSON.stringify(card)?.slice(0, 300),
  );
  const gone = T.ResumeCard({
    model: { title: 't', rows: [{ sessionId: 'g', label: '没了的会话', running: false, openable: false }] },
    opened: {},
    onContinue: () => {},
    onContinueAll: () => {},
  });
  eq('会话没了 ⇒ 只说明、不给键', gone?.children?.[1]?.children?.[1]?.children?.[0], '这个会话不在了');
  const failed = T.ResumeCard({
    model: { title: 't', rows: [{ sessionId: 'f', label: '没接上的', running: true, openable: true }] },
    opened: { f: 'failed' },
    onContinue: () => {},
    onContinueAll: () => {},
  });
  eq('没接上 ⇒ 键就地变重试文案', failed?.children?.[1]?.children?.[1]?.children?.[0], '没接上，再点一次');
  const already = T.ResumeCard({
    model: { title: 't', rows: [{ sessionId: 'a', label: '本来就在跑的', running: true, openable: true }] },
    opened: { a: 'already' },
    onContinue: () => {},
    onContinueAll: () => {},
  });
  eq('本来就在跑 ⇒ 如实说「已经在跑」', already?.children?.[1]?.children?.[1]?.children?.[0], '已经在跑');
  const withSummary = T.ResumeCard({
    model: { title: 't', rows: [] },
    opened: {},
    summary: '已接上 2 个',
    onContinue: () => {},
    onContinueAll: () => {},
  });
  const summaryKids = (withSummary?.children ?? []).filter((child) => child !== null && child !== undefined);
  eq('总键点完有回执行（挂在整卡的最后一行）', summaryKids[summaryKids.length - 1]?.children?.[0], '已接上 2 个');
  eq('没有模型 ⇒ 返回 null（不占位）', T.ResumeCard({ model: null }), null);
}
{
  // 真跑一遍开机读数：给沙箱装 fetch，看注册参数上有没有角标与卡片数据
  const savedFetch = sandbox.window.fetch;
  sandbox.window.fetch = async (url) => (String(url).endsWith('/last-pending') ? jsonResponse(MANIFEST) : jsonResponse({ ok: true }));
  const exportsBoot = loaded.factory(() => ReactStub);
  const bootRegistered = [];
  const guiBoot = { register: (bootEntry, bootComponent) => { bootRegistered.push({ entry: bootEntry, Component: bootComponent }); return () => {}; } };
  const ctxBoot = {
    get: () => guiBoot,
    inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? guiBoot : null) }),
    effect: () => {},
  };
  exportsBoot.apply(ctxBoot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  eq('开机读数完成才注册（有清单时也是恰好一次）', bootRegistered.length, 1);
  eq('★ 角标不再来自"上次关闭的清单"（宿主给了清单，但这条 boot 里拿不到会话列表 ⇒ 不摆角标）', bootRegistered[0]?.entry?.badge, undefined);
  eq('有清单也不改入口 id / kind', `${bootRegistered[0]?.entry?.id}|${bootRegistered[0]?.entry?.kind}`, 'dsh-safely-quit/quit|action');
  check('首帧面板里已经有卡片数据', bootRegistered[0]?.Component?.().children?.[0]?.props?.model !== null);
  sandbox.window.fetch = savedFetch;
}
{
  // 反证：这一半**只打开会话、不替用户说话**（A 档口径的机检）
  check('启动半区不调用 session.prompt（不在用户没点之前发消息）', !/\.prompt\s*\(/.test(source));
  check('启动半区不 import / 触碰 gui-frame 的模块（单向依赖不变）', !/from\s+['"]dsh-gui-frame/.test(source));
}

// 续跑卡片的文案定稿（设计口径）——把决定固化成判据，防回退
eq('行内那颗键叫「继续」', T.TEXT.resumeContinue, '继续');
eq('★ 卡片上有那颗总键「一键继续」', T.TEXT.resumeAll, '一键继续');
eq('★ 文案表里再没有「打开」这一项（设计口径：不要这个功能）', Object.values(T.TEXT).includes('打开'), false);
eq('★★ 文案表里也没有「不用了」了（2026-10-07 用户："『不用了』删掉"）', Object.values(T.TEXT).includes('不用了'), false);
eq('★★ 源码里连这个文案键都不该留着（防"改了渲染没改表"）', T.TEXT.resumeDismiss, undefined);
check('源码里没有残留的收起键锚点', !/data-safely-quit-dismiss/.test(source));
check('源码里没有残留的浏览器本地"看过了"标记', !/dsh-safely-quit\/ack/.test(source) && !/localStorage\s*[.[]/.test(source));
check('卡片标题说人话（不出现 session / resume 这类技术词）', !/session|resume/i.test(`${T.TEXT.resumeRunning(3)}${T.TEXT.resumeMixed(23, 2)}`), T.TEXT.resumeRunning(3));
eq('★ 卡片有两档标题：正常档（全是被打断的）/ 混合档（旧记录：行数 > 在跑数）', 'resumeMixed' in T.TEXT && 'resumeRunning' in T.TEXT, true);
eq('★ 旧口径的"空闲档"标题已删除（开着但没在跑的会话不再进卡片）', 'resumeIdle' in T.TEXT, false);
check('正常档标题报条数且说人话', T.TEXT.resumeRunning(2).includes('2') && !/session|resume/i.test(T.TEXT.resumeRunning(2)), T.TEXT.resumeRunning(2));
// ★ 账要对得上：标题里的第一个数 = 行数（在跑几个只放括号里）—— 真机那次的错法就是"标题 2、行 23"
eq('★ 混合档标题：第一个数是行数，括号里才是在跑数', T.TEXT.resumeMixed(23, 2), '上次关闭时有 23 个会话（2 个在跑）');
eq('★ 正常档标题就是"N 个会话在跑"（N = 行数）', T.TEXT.resumeRunning(2), '上次关闭时有 2 个会话在跑');
eq('★ 全被打断的记录用正常档标题（不会出现多余的括号）',
  T.describeResume(T.parsePending({ available: true, pending: { closedAt: 'z', sessions: [{ sessionId: 'a', statusAtClose: 'running' }, { sessionId: 'b', statusAtClose: 'running' }] } }), null)?.title,
  '上次关闭时有 2 个会话在跑');
check('"会话没了"的说明不出现技术词', !/session|id/i.test(T.TEXT.resumeGone), T.TEXT.resumeGone);

// ── ⑫ 一键继续：请宿主投一条续行消息（设计口径："要接着跑，不是打开窗口"）──────────────
{
  // 客户端**没有**"新建目标 / 重新武装目标"这类入口了 —— 接续不靠目标：
  // 目标一武装，轮次驱动就会在 agent 空闲时自己开下一轮（默认上限 256 轮），那是无人值守的自动续跑。
  eq('没有 describeContinue 这种"按目标状态分档"的入口', T.describeContinue, undefined);
  eq('没有 createGoal 这类"替用户造一个目标"的入口', T.createGoal, undefined);
  eq('没有 resumeGoal 这类"重新武装目标"的入口', T.resumeGoal, undefined);
  eq('没有 readGoal / unwrapGoalResult / resolveGoals（目标读取面整条都不在了）',
    [T.readGoal, T.unwrapGoalResult, T.resolveGoals].filter((item) => item !== undefined).length, 0);
  eq('没有 continueObjective 那句目标原文', T.continueObjective, undefined);
  check('源码里不再调用目标接口（只剩历史注释提到它）', !/\.goals\.(get|create|resume)\s*\(/.test(source), '命中 goals 接口调用');
}
{
  // 唯一的接续出口：/continue 的请求形状（真调用，捕获实参）
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonResponse({ ok: true, results: [] }); };
  await T.requestContinue(fetchImpl, ['a', 'b']);
  eq('请求打到 /continue', calls[0]?.url, '/api/dsh-safely-quit/continue');
  eq('用 POST', calls[0]?.init?.method, 'POST');
  eq('body 就是 {sessionIds}', calls[0]?.init?.body, JSON.stringify({ sessionIds: ['a', 'b'] }));
  const empty = [];
  await T.requestContinue(async (url, init) => { empty.push(init.body); return jsonResponse({ ok: true }); }, undefined);
  eq('没有 id ⇒ 送空数组（宿主会 400，客户端不自己编一个）', empty[0], JSON.stringify({ sessionIds: [] }));
  eq('请求体里没有"目标"字样', /goal|objective|目标/i.test(calls[0]?.init?.body ?? ''), false);
}
{
  // 总键「一键继续」：一次把**这张卡片里**的会话都接上（真调组件回调，看副作用）
  // ⚠ 卡片只含"关闭那一刻在跑"的会话 ⇒ 测试数据必须带 `statusAtClose: 'running'`
  const opened = [];
  const sent = [];
  const model = T.parsePending({
    available: true,
    pending: {
      closedAt: 'ts-9',
      sessions: [
        { sessionId: 'r1', statusAtClose: 'running' },
        { sessionId: 'i2', statusAtClose: 'running' },
        { sessionId: 'gone3', statusAtClose: 'running' }, // 被打断但会话已经不在了 ⇒ 跳过
      ],
    },
  });
  const fetchImpl = async (url, init) => {
    const ids = JSON.parse(init.body).sessionIds;
    sent.push(...ids);
    return jsonResponse({ ok: true, results: ids.map((sessionId) => ({ sessionId, result: 'attached' })) });
  };
  const Live = T.createResumeCardLive({
    sessions: () => ({ open: (id) => opened.push(id), list: { getSnapshot: () => ({ phase: 'ready', byId: { r1: {}, i2: {} } }) } }),
    workspace: () => ({ openSession: (id) => opened.push(id) }),
    fetch: fetchImpl,
  });
  const tree = Live({ model });
  const props = tree?.props ?? {};
  props.onContinueAll?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  eq('总键：两个还在的会话都被请求接续（串行、各一次）', sent.join(','), 'r1,i2');
  eq('总键：卡片里还在的会话都被切到过（两个）', opened.length, 2);
  eq('总键：已经不在列表里的会话被跳过（不瞎点）', opened.includes('gone3'), false);
  eq('回执文案：说清接上几个 / 几个本来就在跑 / 几个没接上', T.TEXT.resumeSummary(2, 1, 1), '已接上 2 个，1 个本来就在跑，1 个没接上');
  eq('回执文案：全接上时不提失败', T.TEXT.resumeSummary(3, 0, 0), '已接上 3 个');
}
{
  // 反假绿：源码里不许出现"用目标代替接续"的路径（字段与判据都不许留）
  check('源码里没有 resumeOpen 这个文案键了', !/resumeOpen/.test(source));
  check('源码里没有 describeContinue 这类按目标分档的逻辑', !/describeContinue/.test(source));
  check('源码里没有 canResumeGoal（那正是"能不能续目标"的旧判据）', !/canResumeGoal/.test(source));
  check('源码里没有 createGoal 调用（不替用户造目标）', !/createGoal\s*\(/.test(source));
}

// ── ⑩ 收尾状态机住在模块里（面板关掉再打开不许回到初始态）+ 开机浮层卡片 ──────────

/** 可控时钟：接住 store 排的定时器，手动放行（离线判据里没有真时间在走）。 */
function makeClock() {
  let seq = 0;
  const jobs = new Map();
  return {
    schedule(fn, ms) {
      seq += 1;
      jobs.set(seq, { fn, ms });
      return seq;
    },
    cancel(handle) {
      jobs.delete(handle);
    },
    size: () => jobs.size,
    delays: () => [...jobs.values()].map((job) => job.ms),
    /** 放行一个定时器（按入队顺序），并让里面的微任务链跑完。 */
    async runOne() {
      const first = [...jobs.entries()][0];
      if (first === undefined) return false;
      jobs.delete(first[0]);
      await first[1].fn();
      await flush();
      return true;
    },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

check('__test 暴露状态机与浮层的纯件', [T.createQuitStore, T.createQuitButton, T.createPanel, T.openResumePanel, T.cardRect, T.isClosingStage, T.elapsedOf, T.publishDebug, T.overlayProbe, T.layerBoxOf, T.boxOf, T.describeProbe]
  .every((fn) => typeof fn === 'function'));

eq('宿主 stage 判定：waiting 算收尾中', T.isClosingStage('waiting'), true);
eq('宿主 stage 判定：done 也算收尾中（已落盘、即将关闭）', T.isClosingStage('done'), true);
eq('宿主 stage 判定：idle 不算', T.isClosingStage('idle'), false);
eq('已等毫秒优先用宿主读数（跨页面重载也算得对）', T.elapsedOf({ elapsedMs: 12345 }, 0, 999999), 12345);
eq('宿主没给读数时退回本地时钟', T.elapsedOf({}, 1000, 4000), 3000);
eq('两头都没有 ⇒ 0（不显示 NaN）', T.elapsedOf(null, null, 4000), 0);

{
  // 阶段流转 + 轮询归 store（组件不在场也照样走）
  const clock = makeClock();
  const stateResponse = { stage: 'waiting', pending: ['a'], forceRequested: false, elapsedMs: 3000 };
  const fetchImpl = fakeFetch(jsonResponse(stateResponse));
  const store = T.createQuitStore({ fetch: fetchImpl, schedule: clock.schedule, cancel: clock.cancel });
  eq('初始阶段是 idle', store.getSnapshot().phase, 'idle');
  store.begin();
  eq('点一次 ⇒ 进入确认态', store.getSnapshot().phase, 'confirming');
  eq('确认态自己排了一个 5 秒的退表定时器', clock.delays().includes(T.CONFIRM_MS), true);
  await store.confirm();
  eq('再点一次 ⇒ 进入收尾态', store.getSnapshot().phase, 'closing');
  eq('收尾时向宿主发了关闭请求', fetchImpl.calls.some((call) => call.url.endsWith('/close')), true);
  check('收尾态自己排了轮询（定时器不归组件）', clock.size() > 0);
  await clock.runOne();
  eq('轮询把宿主读数写进快照（已等毫秒来自宿主）', store.getSnapshot().elapsedMs, 3000);
  eq('轮询把待停会话也带进来（宿主读数原样留档；键上不再用它，见 ⑥ 的收尾态判据）', store.getSnapshot().hostState?.pending?.length, 1);
}
{
  // 反例：宿主连续不应答 ⇒ 判定已关闭
  const clock = makeClock();
  const store = T.createQuitStore({
    fetch: async (url) => {
      if (String(url).endsWith('/close')) return jsonResponse({ ok: true });
      throw new Error('ECONNREFUSED');
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    offlineStrikes: 2,
  });
  store.begin();
  await store.confirm();
  await clock.runOne();
  eq('失败一次还不下结论', store.getSnapshot().phase, 'closing');
  await clock.runOne();
  eq('连续失败到阈值 ⇒ 判定宿主已经关了', store.getSnapshot().phase, 'closed');
}
{
  // 反例：确认态超时自己退回（不留在"半按着"的状态）
  const clock = makeClock();
  const store = T.createQuitStore({ fetch: fakeFetch(jsonResponse({ stage: 'idle' })), schedule: clock.schedule, cancel: clock.cancel });
  store.begin();
  await clock.runOne();
  eq('确认态超时 ⇒ 退回 idle', store.getSnapshot().phase, 'idle');
}
{
  // 与宿主对齐：收尾中刷新页面 / 热换模块后，界面要接着显示收尾态
  const store = T.createQuitStore({ fetch: fakeFetch(jsonResponse({ stage: 'waiting', pending: ['a'], elapsedMs: 8000 })), schedule: () => 1, cancel: () => {} });
  await store.attach();
  eq('宿主说在收尾 ⇒ 挂载即收尾态', store.getSnapshot().phase, 'closing');
  eq('已等秒数直接用宿主的读数', store.getSnapshot().elapsedMs, 8000);
}
{
  const store = T.createQuitStore({ fetch: fakeFetch(jsonResponse({ stage: 'idle' })), schedule: () => 1, cancel: () => {} });
  await store.attach();
  eq('宿主说平常 ⇒ 保持 idle', store.getSnapshot().phase, 'idle');
}
{
  // 反例：宿主已经不认这个接口了（重启过），本地还记着在关 ⇒ 收尾成"已关闭"
  const clock = makeClock();
  const store = T.createQuitStore({
    fetch: async (url) => {
      if (String(url).endsWith('/close')) return jsonResponse({ ok: true });
      throw new Error('host gone');
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    offlineStrikes: 9,
  });
  store.begin();
  await store.confirm();
  await store.attach();
  eq('宿主不在且本地在收尾 ⇒ 转成已关闭（不留悬念）', store.getSnapshot().phase, 'closed');
}
{
  // 失败可重试；卸载后定时器要清干净
  const clock = makeClock();
  const store = T.createQuitStore({
    fetch: async (url) => (String(url).endsWith('/close') ? jsonResponse({ error: 'already closing' }, { status: 409 }) : jsonResponse({ stage: 'idle' })),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  store.begin();
  await store.confirm();
  eq('关闭请求被拒 ⇒ 失败态', store.getSnapshot().phase, 'failed');
  check('失败态带上宿主给的原因', String(store.getSnapshot().errorText).includes('already closing'));
  store.retry();
  eq('重试回到 idle', store.getSnapshot().phase, 'idle');
  store.begin();
  const before = clock.size();
  store.dispose();
  eq('卸载时把自己的定时器清干净', clock.size(), 0);
  eq('卸载前确实有定时器（否则上面那条是空真）', before > 0, true);
}
{
  // 订阅：状态机在组件不在场时照跑；订阅只影响重绘
  const store = T.createQuitStore({ fetch: fakeFetch(jsonResponse({ stage: 'idle' })), schedule: () => 1, cancel: () => {} });
  let notified = 0;
  const off = store.subscribe(() => { notified += 1; });
  store.begin();
  eq('订阅者收到变化', notified, 1);
  off();
  store.retry();
  eq('退订后不再收到', notified, 1);
  const bad = store.subscribe(() => { throw new Error('订阅者自己炸了'); });
  let threw = null;
  try { store.begin(); } catch (error) { threw = error; }
  eq('订阅者抛错不打断状态机', threw, null);
  bad();
}
{
  // ★ 用户报的那个 bug：收尾中把面板关掉再打开，不许回到「关闭 DSH」
  const clock = makeClock();
  const store = T.createQuitStore({ fetch: fakeFetch(jsonResponse({ stage: 'waiting', pending: ['a'], elapsedMs: 2000 })), schedule: clock.schedule, cancel: clock.cancel });
  const deps = { store, initialResume: null, sessions: () => null, storage: () => null };
  store.begin();
  await store.confirm();
  await clock.runOne(); // 让轮询把宿主读数（待停 1 个）写进快照
  const panelA = T.createPanel(deps);
  const renderQuit = (panel) => panel().children?.[0]?.type?.();
  eq('第一次打开面板：显示收尾中', renderQuit(panelA)?.props?.['data-safely-quit-phase'], 'closing');
  // 坞关掉面板 = 旧组件卸载；再点开 = 又造一份新组件（panels.mjs:113-130 现造 content）
  const panelB = T.createPanel(deps);
  eq('★ 面板关掉再打开：仍是收尾中（状态不住在组件里）', renderQuit(panelB)?.props?.['data-safely-quit-phase'], 'closing');
  check('★ 收尾时这一行本身就是「立即停止（已等 S 秒）」', String(renderQuit(panelB)?.children?.[1]?.children?.[0]).startsWith(T.TEXT.force), JSON.stringify(renderQuit(panelB)?.children?.[1]));
  check('★ 它带收尾态的样式锚点（.sq-btn-force）', String(renderQuit(panelB)?.props?.className).includes('sq-btn-force'), renderQuit(panelB)?.props?.className);
}
{
  // 浮层卡片：形状、只在有清单且没"看过"时弹、退路都不抛
  const opened = [];
  const gui = {
    overlay: {
      open(request) {
        opened.push(request);
        return { id: request.id, close: () => { opened.push({ closed: request.id }); } };
      },
    },
  };
  const model = { closedAt: 'ts-1', total: 2, running: 1, sessions: [{ sessionId: 'a', running: true, label: 'A' }] };
  const handle = T.openResumePanel(gui, { model, sessions: () => null, storage: () => null });
  check('浮层开出来了（拿到句柄）', handle !== null && typeof handle.close === 'function');
  const request = opened[0];
  eq('浮层 id 带命名空间前缀', request?.id, T.OVERLAY_ID);
  eq('浮层用「面板」族（贴边浮出的一块面，不是浮动窗口）', request?.family, 'panel');
  eq('浮层标题说人话', request?.title, '上次关闭时的会话');
  check('浮层带落点（无锚点 ⇒ 自带一个右上角矩形）', Number.isFinite(request?.initialRect?.x) && Number.isFinite(request?.initialRect?.width));
  eq('浮层内容是那张卡片（带机检锚点）', request?.content?.props?.['data-safely-quit-pop'], 'true');
  eq('没有清单 ⇒ 不弹（返回 null，不占浮层）', T.openResumePanel(gui, { model: null, sessions: () => null, storage: () => null }), null);
  eq('GUIFrame 没有 overlay 能力 ⇒ 静默降级', T.openResumePanel({}, { model, sessions: () => null, storage: () => null }), null);
  eq('overlay.open 抛错 ⇒ 吞掉返回 null（坞里那一行照常）', T.openResumePanel({ overlay: { open: () => { throw new Error('GF-E-OVERLAY'); } } }, { model, sessions: () => null, storage: () => null }), null);
}
{
  // ★★ 活卡片那条路的 deps **一个面都不能漏**：漏了 `workspace` 就切不过去，漏了 `fetch`
  //    就投不出去（真机踩过：openResumePanel 给活卡片重建 deps 时漏了 workspace）。
  //    这条判据走的是"浮层那条真路"：openResumePanel → 浮层内容里那层活卡片 → 点行内那颗键。
  const panels = [];
  const panelGui = { overlay: { open: (request) => { panels.push(request); return { close() {} }; } } };
  const wsCalls = [];
  const asked = [];
  const panelModel = { closedAt: 'ts-9', total: 1, running: 1, sessions: [{ sessionId: 's9', running: true, label: 'S9' }] };
  T.openResumePanel(panelGui, {
    model: panelModel,
    sessions: () => ({ list: { getSnapshot: () => ({ phase: 'ready', byId: { s9: { displayTitle: 'S9' } } }) } }),
    workspace: () => ({ openSession: (id) => wsCalls.push(id) }),
    fetch: async (url, init) => { asked.push(...JSON.parse(init.body).sessionIds); return jsonResponse({ ok: true, results: [{ sessionId: 's9', result: 'attached' }] }); },
  });
  const content = panels[0]?.content;
  const live = (content?.children ?? []).find((child) => typeof child?.type === 'function');
  check('浮层内容里那层活卡片找得到（deps 从这一层进）', typeof live?.type === 'function');
  const liveCard = live.type(live.props);
  liveCard?.props?.onContinue?.('s9');
  await new Promise((resolve) => setTimeout(resolve, 0));
  eq('★ 行内「继续」用的是 uiWorkspace 面（活卡片没漏面）', wsCalls[0], 's9');
  eq('★ 切过去之后才请宿主接续（/continue 真的打到）', asked[0], 's9');
}
{
  // 落点：按"浮层根"的真实尺寸量（量不到退回窗口），并且永远夹在容器里
  const layerSelector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  eq('假 DOM 里还没有浮层根 ⇒ 退回窗口尺寸量落点', T.cardRect().x, 1280 - T.CARD_SIZE.width - 24);
  fakeNodes.set('[data-guif-overlay-root]', { getBoundingClientRect: () => ({ width: 600, height: 400 }) });
  eq('按浮层根量：容器放得下就贴着右边（600-400-24）', T.cardRect().x, 176);
  fakeNodes.set('[data-guif-overlay-root]', { getBoundingClientRect: () => ({ width: 410, height: 400 }) });
  eq('容器窄到放不下 ⇒ 夹回左边距，不再飞出视野', T.cardRect().x, 24);
  fakeNodes.set('[data-guif-overlay-root]', { getBoundingClientRect: () => ({ width: 1400, height: 900 }) });
  eq('宽容器同样贴右上角', T.cardRect().x, 1400 - T.CARD_SIZE.width - 24);
  fakeNodes.delete('[data-guif-overlay-root]');
  eq('卡片尺寸取常量（不随窗口变）', `${T.cardRect().width}x${T.cardRect().height}`, `${T.CARD_SIZE.width}x${T.CARD_SIZE.height}`);
  // 浮层"真的落地了吗"：这是**只读取证**的硬读数（接口成功但没渲染 = 没弹出来）
  fakeNodes.set(layerSelector, { getBoundingClientRect: () => ({ width: 400, height: 300, left: 800, top: 72, right: 1200, bottom: 372 }) });
  eq('浮层那一层在 DOM 里且与视口相交 ⇒ 算弹出来了', T.overlayLayerVisible(), true);
  fakeNodes.set(layerSelector, { getBoundingClientRect: () => ({ width: 400, height: 300, left: 5000, top: 72, right: 5400, bottom: 372 }) });
  eq('浮层在 DOM 里但落在视野外 ⇒ 不算弹出来', T.overlayLayerVisible(), false);
  fakeNodes.delete(layerSelector);
  eq('浮层压根没进 DOM ⇒ 不算弹出来', T.overlayLayerVisible(), false);

  // ★★★ GUIFrame 的层包裹节点是 **`display: contents`**
  //   （真源 `dsh-gui-frame/src/client/overlay/styles.mjs:39-42`：注释原文「不生成盒子」），
  //   对它量 `getBoundingClientRect()` **恒得 0×0**；真正有盒子的是层里那块面板
  //   （`overlay/panel.mjs:70-77` 的 `position:absolute` + 显式 width/height）。
  //   ⚠ 量**层自身**会恒判"没弹出来" ⇒ 把卡片当场关掉（用户看到的就是那 160ms 的一闪）。
  const panelish = { getBoundingClientRect: () => ({ width: 400, height: 300, left: 856, top: 72, right: 1256, bottom: 372 }) };
  const contentsLayer = {
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    querySelectorAll: () => [panelish], // 真机分支：扫层子树
  };
  fakeNodes.set(layerSelector, contentsLayer);
  eq('★ display:contents 的层自身量不到盒子（复刻真机形状）', T.boxOf(contentsLayer), null);
  const probeOnContents = T.overlayProbe();
  eq('★ 但层里那块面板有盒子 ⇒ 探针量到的是它', Math.round(probeOnContents.box?.width ?? -1), 400);
  eq('★ 探针如实记下"层里几个有盒元素"', probeOnContents.boxes, 1);
  eq('★ 于是判据给"弹出来了"（旧代码在这一格判 false 并关掉卡片）', T.overlayLayerVisible(), true);
  check('★ 探针读数带齐排障要的字段', probeOnContents.layerInDom === true && probeOnContents.visible === true
    && probeOnContents.viewport.width === 1280 && typeof T.describeProbe(probeOnContents) === 'string', JSON.stringify(T.describeProbe(probeOnContents)));
  // 回退分支：宿主给的层节点没有 querySelectorAll 时，靠 children 往下走
  fakeNodes.set(layerSelector, { getBoundingClientRect: () => ({ width: 0, height: 0 }), children: [panelish] });
  eq('★ 没有 querySelectorAll 时，靠 children 也能量到那块面板', T.overlayLayerVisible(), true);
  // 负控：放宽判据之后**不许**一律判真
  fakeNodes.set(layerSelector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }) }],
  });
  eq('★ 负控：层与其子树都没有盒子 ⇒ 仍判"没弹出来"', T.overlayLayerVisible(), false);
  fakeNodes.set(layerSelector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 9000, top: 72, right: 9400, bottom: 372 }) }],
  });
  eq('★ 负控：盒子在视野之外 ⇒ 仍判"没弹出来"', T.overlayLayerVisible(), false);
  fakeNodes.delete(layerSelector);
}
{
  // 调试面：排障时不用猜"到底加载了没、读到了什么"
  sandbox.window.__safelyQuit = undefined;
  T.publishDebug({ version: 'test', badge: 3 });
  eq('调试面挂在 window 上', sandbox.window.__safelyQuit?.badge, 3);
  T.publishDebug({ resumePath: 'dock' });
  eq('调试面是合并写入（不覆盖已有字段）', sandbox.window.__safelyQuit?.badge, 3);
  eq('调试面记下卡片走的是哪条路', sandbox.window.__safelyQuit?.resumePath, 'dock');
  sandbox.window.__safelyQuit = undefined;
}
{
  // 开机全链路：有清单 + 没看过 ⇒ 注册入口（带角标）+ 弹卡片（浮层真落地 ⇒ 不兜底）
  const savedFetch = sandbox.window.fetch;
  const savedStorage = sandbox.window.localStorage;
  // 宿主此刻正处在收尾中 ⇒ 开机读数必须把它接回来（刷新页面 / 热换模块都不许回到「关闭 DSH」）
  const sentReports = [];
  sandbox.window.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/report')) {
      try {
        sentReports.push(JSON.parse(String(init?.body ?? '{}')));
      } catch {
        sentReports.push(null);
      }
      return jsonResponse({ ok: true });
    }
    if (target.endsWith('/last-pending')) return jsonResponse(MANIFEST);
    if (target.endsWith('/state')) return jsonResponse({ stage: 'waiting', pending: ['a'], forceRequested: false, elapsedMs: 4000 });
    return jsonResponse({}, { status: 404 });
  };
  const store = new Map();
  sandbox.window.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  // ★ 真机形状：层包裹节点是 `display: contents`（自身恒 0×0），有盒子的是层里那块面板
  fakeNodes.set('[data-guif-overlay-layer="dsh-safely-quit/resume"]', {
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
  });
  const popped = [];
  const closedBySelfCheck = [];
  const gui = {
    register: (entry, Component) => { popped.push({ entry, Component }); return () => {}; },
    overlay: {
      open: (request) => {
        popped.push({ overlay: request });
        return { id: request.id, close: () => { closedBySelfCheck.push(request.id); } };
      },
    },
    dock: { open: () => { popped.push({ fallback: true }); return true; }, close: () => true },
  };
  const ctx = {
    get: () => gui,
    inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? gui : null) }),
    effect: () => {},
  };
  resetFakeTimers();
  const exportsBoot = loaded.factory(() => ReactStub);
  exportsBoot.apply(ctx);
  await flush();
  eq('坞入口注册了', popped.filter((item) => item.entry !== undefined).length, 1);
  eq('开机卡片弹了', popped.filter((item) => item.overlay !== undefined).length, 1);
  eq('弹出的卡片用的就是这份清单', popped.find((item) => item.overlay !== undefined)?.overlay?.content?.children?.[0]?.props?.model?.closedAt, MANIFEST.pending.closedAt);
  eq('调试面记下了这次读数', sandbox.window.__safelyQuit?.pending?.total, 3);
  eq('浮层真的落地可见 ⇒ 卡片路径记成 overlay', sandbox.window.__safelyQuit?.resumePath, 'overlay');
  eq('★★ 卡片没被自检关掉（2026-10-05：就是这一关让卡片"闪一下就没了"）', closedBySelfCheck.length, 0);
  check('自报里带上探针原始读数（层在 DOM、量到盒子的个数）', sentReports.some((body) => body?.overlayProbe?.visible === true
    && body.overlayProbe.boxes >= 1 && body.overlayProbe.layerInDom === true), JSON.stringify(sentReports.find((body) => body?.overlayProbe !== undefined)?.overlayProbe ?? {}));
  eq('浮层成功时不开坞面板（不再把卡片塞回按钮面板里）', popped.filter((item) => item.fallback !== undefined).length, 0);
  eq('自报发给了宿主（POST /report）', sentReports.length >= 1, true);
  check('自报里带上"卡片走了哪条路"', sentReports.some((body) => body?.resumePath === 'overlay'), JSON.stringify(sentReports[0] ?? {}));
  // ★ 宿主正在收尾时开机（= 收尾中刷新页面 / HMR 换过模块）：按钮必须直接显示收尾态
  const bootPanel = popped.find((item) => item.entry !== undefined)?.Component;
  eq(
    '★ 开机与宿主对齐：宿主在收尾 ⇒ 面板首帧就是收尾态',
    bootPanel?.().children?.[0]?.type?.()?.props?.['data-safely-quit-phase'],
    'closing',
  );
  // ★ 第二趟：宿主说"没有待续记录"（= 上一次那份已经交出去过，或者用户把面板关掉时清掉了）
  //   ⇒ 入口照常注册，但**一张卡片都不弹**（"如果记录中没有内容，打开 DSH 时面板就不显示"）。
  sandbox.window.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/report')) return jsonResponse({ ok: true });
    if (target.endsWith('/last-pending')) return jsonResponse({ available: false });
    if (target.endsWith('/state')) return jsonResponse({ stage: 'idle' });
    return jsonResponse({}, { status: 404 });
  };
  sandbox.window.__safelyQuit = undefined;
  const popped2 = [];
  const gui2 = {
    register: (entry) => { popped2.push({ entry }); return () => {}; },
    overlay: { open: (request) => { popped2.push({ overlay: request }); return { id: request.id, close: () => {} }; } },
    dock: { open: () => { popped2.push({ fallback: true }); return true; } },
  };
  resetFakeTimers();
  const exportsBoot2 = loaded.factory(() => ReactStub);
  exportsBoot2.apply({
    get: () => gui2,
    inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? gui2 : null) }),
    effect: () => {},
  });
  await flush();
  eq('没有记录 ⇒ 坞入口照常注册', popped2.filter((item) => item.entry !== undefined).length, 1);
  eq('★ 没有记录 ⇒ 不弹卡片', popped2.filter((item) => item.overlay !== undefined).length, 0);
  eq('★ 没有记录 ⇒ 也不兜底开面板', popped2.filter((item) => item.fallback !== undefined).length, 0);
  sandbox.window.fetch = savedFetch;
  fakeNodes.delete('[data-guif-overlay-layer="dsh-safely-quit/resume"]');
}
{
  // ★ 浮层没落地时**不**回落按钮面板（设计上已否掉那条落点）：如实记账 + 记下原因
  // ★★ **探针判不出来时绝不许关卡片**（关掉的正是用户看得见的那张）
  const savedFetch = sandbox.window.fetch;
  const savedStorage = sandbox.window.localStorage;
  sandbox.window.fetch = async (url) => (String(url).endsWith('/last-pending') ? jsonResponse(MANIFEST) : jsonResponse({ stage: 'idle' }));
  sandbox.window.localStorage = { getItem: () => null, setItem: () => {} };
  const closed = [];
  const run = async (gui) => {
    const seen = [];
    const target = { ...gui, register: (entry) => { seen.push(entry); return () => {}; } };
    resetFakeTimers();
    const app = loaded.factory(() => ReactStub);
    app.apply({
      get: () => target,
      inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? target : null) }),
      effect: () => {},
    });
    await flush();
    return seen;
  };
  // 接口成功，但 DOM 里**始终**量不到那一层（= 冷启动时被补装清栈的那种）
  await run({ overlay: { open: (request) => ({ id: request.id, close: () => { closed.push(request.id); } }) } });
  eq('层始终没进 DOM ⇒ 记 none（不假装弹出来了、也不往按钮面板里塞）', sandbox.window.__safelyQuit?.resumePath, 'none');
  check('并且如实说清"重开 N 次都没进 DOM"', typeof sandbox.window.__safelyQuit?.overlayError === 'string'
    && sandbox.window.__safelyQuit.overlayError.includes('仍没进 DOM'), sandbox.window.__safelyQuit?.overlayError);
  eq('★ 重试用满了预算（每一次都是"开 → 核验 → 重开"）', sandbox.window.__safelyQuit?.overlayAttempts, T.OVERLAY_OPEN_TRIES);
  eq('★ 关掉的全是"没进 DOM 的空句柄"（关它无副作用）', closed.length, T.OVERLAY_OPEN_TRIES);
  check('自报里带上探针原始读数', sandbox.window.__safelyQuit?.overlayProbe !== undefined && sandbox.window.__safelyQuit?.overlayProbe !== null
    && sandbox.window.__safelyQuit.overlayProbe.layerInDom === false, JSON.stringify(sandbox.window.__safelyQuit?.overlayProbe));
  eq('坞入口照常注册（关闭按钮不受影响）', sandbox.window.__safelyQuit?.dockRegistered, true);
  sandbox.window.__safelyQuit = undefined;
  await run({});
  eq('GUIFrame 不在场 ⇒ 也如实记 none（不假装成功）', sandbox.window.__safelyQuit?.resumePath, 'none');
  eq('GUIFrame 不在场 ⇒ 也没人碰过卡片句柄', closed.length, T.OVERLAY_OPEN_TRIES);
  sandbox.window.fetch = savedFetch;
  sandbox.window.localStorage = savedStorage;
  sandbox.window.__safelyQuit = undefined;
}
{
  // ★★★ 补装窗口的坑（真机实测）：平台服务晚到 ⇒ overlay 先装**降级件**、
  //    就绪后 dispose 再补装，而 dispose 会 `stack.clear()` ⇒ 开机那一下 open 的记录被清掉、
  //    层永远不出现。判据：**层没进 DOM 就重开**，第 3 次进了 ⇒ 记 overlay（不是"重试到放弃"）。
  const layerSelector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  const savedFetch = sandbox.window.fetch;
  const savedStorage = sandbox.window.localStorage;
  sandbox.window.fetch = async (url) => (String(url).endsWith('/last-pending') ? jsonResponse(MANIFEST) : jsonResponse({ stage: 'idle' }));
  sandbox.window.localStorage = { getItem: () => null, setItem: () => {} };
  const closed = [];
  let opens = 0;
  const gui = {
    register: () => () => {},
    overlay: {
      open: (request) => {
        opens += 1;
        // 前两次：记录被"补装"清掉 ⇒ 层不在 DOM；第三次（服务到齐后）真的渲染出来
        if (opens >= 3) {
          fakeNodes.set(layerSelector, {
            getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
            querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
          });
        }
        return { id: request.id, close: () => { closed.push(request.id); } };
      },
    },
  };
  resetFakeTimers();
  const app = loaded.factory(() => ReactStub);
  app.apply({
    get: () => gui,
    inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? gui : null) }),
    effect: () => {},
  });
  await flush();
  eq('★ 跨过补装窗口：第 3 次开才落地 ⇒ 记 overlay', sandbox.window.__safelyQuit?.resumePath, 'overlay');
  eq('★ 如实记下试了几次', sandbox.window.__safelyQuit?.overlayAttempts, 3);
  eq('★ 只关了前两次"没进 DOM 的空句柄"', closed.length, 2);
  eq('★ 没落下任何错误（这次是成功路径）', sandbox.window.__safelyQuit?.overlayError, null);
  fakeNodes.delete(layerSelector);
  sandbox.window.fetch = savedFetch;
  sandbox.window.localStorage = savedStorage;
  sandbox.window.__safelyQuit = undefined;
}
{
  // ★★ 纪律回归：层**在 DOM 里**但探针量不到（视野外/判据失灵）⇒ **不重开、不关掉**（卡片归用户处置）
  const layerSelector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  const savedFetch = sandbox.window.fetch;
  const savedStorage = sandbox.window.localStorage;
  sandbox.window.fetch = async (url) => (String(url).endsWith('/last-pending') ? jsonResponse(MANIFEST) : jsonResponse({ stage: 'idle' }));
  sandbox.window.localStorage = { getItem: () => null, setItem: () => {} };
  const closed = [];
  let opens = 0;
  fakeNodes.set(layerSelector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 9000, top: 72, right: 9400, bottom: 372 }) }],
  });
  const gui = {
    register: () => () => {},
    overlay: { open: (request) => { opens += 1; return { id: request.id, close: () => { closed.push(request.id); } }; } },
  };
  resetFakeTimers();
  const app = loaded.factory(() => ReactStub);
  app.apply({
    get: () => gui,
    inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? gui : null) }),
    effect: () => {},
  });
  await flush();
  eq('★ 层在 DOM 就算弹出来了（记 overlay-unverified，不是没弹）', sandbox.window.__safelyQuit?.resumePath, 'overlay-unverified');
  eq('★★ 层在 DOM 就绝不重开', opens, 1);
  eq('★★ 层在 DOM 就绝不关掉（哪怕判据说它不可见）', closed.length, 0);
  check('并且如实记下探针读数', sandbox.window.__safelyQuit?.overlayError?.includes('盒子') === true, sandbox.window.__safelyQuit?.overlayError);
  fakeNodes.delete(layerSelector);
  sandbox.window.fetch = savedFetch;
  sandbox.window.localStorage = savedStorage;
  sandbox.window.__safelyQuit = undefined;
}
{
  // ★★★ 看护：用户**没动作**却消失（被平台清层栈，宿主根还在 —— 见上面 `fakeExpireAfter` 那段的读数）⇒
  //     守望重开一次把它救回来；救回来之后站稳了就**认领**记录。
  const layerSelector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  const layerNode = {
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
  };
  const savedFetch = sandbox.window.fetch;
  const hostPosts = [];
  sandbox.window.fetch = async (url, init) => {
    const target = String(url);
    if (init?.method === 'POST') hostPosts.push(target.split('/').pop());
    if (target.endsWith('/last-pending')) return jsonResponse(MANIFEST);
    return jsonResponse({ ok: true, stamped: true, cleared: true });
  };
  let opens = 0;
  const gui = {
    register: () => () => {},
    overlay: {
      open: (request) => {
        opens += 1;
        fakeNodes.set(layerSelector, layerNode);
        // 第一次开出来的层"活不过几次查询"（= 平台清栈）；重开的那一次就让它一直留着
        if (opens === 1) fakeExpireAfter.set(layerSelector, { remaining: 3 });
        else fakeExpireAfter.delete(layerSelector);
        return { id: request.id, close: () => {} };
      },
    },
  };
  resetFakeTimers();
  const app = loaded.factory(() => ReactStub);
  app.apply({
    get: () => gui,
    inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? gui : null) }),
    effect: () => {},
  });
  await flush();
  eq('★ 层被清掉后，守望重开了一次', opens, 2);
  eq('★ 卡片还在（救回来了，不是"闪一下就没了"）', T.overlayProbe().layerInDom, true);
  eq('★ 重开之后卡片路径不变', sandbox.window.__safelyQuit?.resumePath, 'overlay');
  eq('★★ 站稳之后把记录认领了（宿主收到 /pending/claim）', hostPosts.includes('claim'), true);
  eq('★★ 用户没关它 ⇒ 不许清空记录', hostPosts.includes('clear'), false);
  fakeNodes.delete(layerSelector);
  fakeExpireAfter.delete(layerSelector);
  sandbox.window.fetch = savedFetch;
  sandbox.window.__safelyQuit = undefined;
}
{
  // ★★★ 「装得下」（真机读数：11 个会话 ⇒ 卡片实体高 364.8px，而 rect 只给了 300 ⇒
  //    面板内容区 `overflow:auto`，卡底那颗总键「一键继续」要滚动才够得着）：
  //    开出来之后按**实测高度**再开一次（同 id ⇒ 栈里先摘后加、卡片原地变大、不闪），并如实记账。
  const layerSelector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  const cardSelector = '[data-safely-quit-pop]';
  const savedFetch = sandbox.window.fetch;
  const savedStorage = sandbox.window.localStorage;
  sandbox.window.fetch = async (url) => (String(url).endsWith('/last-pending') ? jsonResponse(MANIFEST) : jsonResponse({ stage: 'idle' }));
  sandbox.window.localStorage = { getItem: () => null, setItem: () => {} };
  fakeNodes.set(layerSelector, {
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
  });
  const runOnce = async (cardBoxHeight) => {
    fakeNodes.set(cardSelector, {
      getBoundingClientRect: () => ({ width: 378, height: cardBoxHeight, left: 841, top: 128, right: 1219, bottom: 128 + cardBoxHeight }),
    });
    const rects = [];
    const gui = {
      register: () => () => {},
      overlay: { open: (request) => { rects.push(request.initialRect?.height ?? null); return { id: request.id, close: () => {} }; } },
    };
    resetFakeTimers();
    const app = loaded.factory(() => ReactStub);
    app.apply({ get: () => gui, inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? gui : null) }), effect: () => {} });
    await flush();
    return rects;
  };
  const tall = await runOnce(520); // 清单长：卡片 520 高，缺省的 300 装不下
  eq('★ 第一次按缺省高度开', tall[0], T.CARD_SIZE.height);
  eq('★★ 装不下 ⇒ 按实测高度再开一次（卡片实体高 + 面板的头与内边距）', tall[1], 520 + T.CARD_CHROME_HEIGHT);
  eq('★ 只重开这一次（不是反复折腾）', tall.length, 2);
  eq('★ 如实记下"高度调过"', sandbox.window.__safelyQuit?.overlayResized, true);
  eq('★ 面板最终高度也进自报', sandbox.window.__safelyQuit?.overlayRectHeight, 520 + T.CARD_CHROME_HEIGHT);
  eq('★ 卡片照样算"弹出来了"', sandbox.window.__safelyQuit?.resumePath, 'overlay');
  sandbox.window.__safelyQuit = undefined;
  const short = await runOnce(100); // 负控：卡片本来就装得下 ⇒ 不许为它重开
  eq('★ 负控：装得下就一次都不重开', short.length, 1);
  eq('★ 负控：也没记成"调过高度"', sandbox.window.__safelyQuit?.overlayResized, false);
  eq('★ 高度覆盖参数生效（纯件）', T.cardRect(512).height, 512);
  eq('★ 不传高度时仍用缺省（纯件）', T.cardRect().height, T.CARD_SIZE.height);
  fakeNodes.delete(cardSelector);
  fakeNodes.delete(layerSelector);
  sandbox.window.fetch = savedFetch;
  sandbox.window.localStorage = savedStorage;
  sandbox.window.__safelyQuit = undefined;
}
{
  // ★★★ 「补差」（11 会话真机实测：按"卡片盒高 + 定值"调高之后**仍差 22px** ——
  //    面板一调高，滚动条的出现/消失会改变内容宽度、行内文字随之换行，内容又高了一点）。
  //    ⇒ 判据是直接量**面板内容区还差多少**（`scrollHeight - clientHeight`）并按它补齐，两轮内收敛。
  const layerSelector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  const bodySelector = '[data-guif-panel-body="dsh-safely-quit/resume"]';
  const savedFetch = sandbox.window.fetch;
  const savedStorage = sandbox.window.localStorage;
  sandbox.window.fetch = async (url) => (String(url).endsWith('/last-pending') ? jsonResponse(MANIFEST) : jsonResponse({ stage: 'idle' }));
  sandbox.window.localStorage = { getItem: () => null, setItem: () => {} };
  fakeNodes.set(layerSelector, {
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
  });
  const runWithBody = async (contentHeight) => {
    let panelHeight = T.CARD_SIZE.height;
    let scrollHeight = contentHeight;
    fakeNodes.set(bodySelector, {
      get scrollHeight() { return scrollHeight; },
      get clientHeight() { return Math.max(0, panelHeight - 40); }, // 内容区 = 面板高 − 头与边距
    });
    const rects = [];
    const gui = {
      register: () => () => {},
      overlay: {
        open: (request) => {
          rects.push(request.initialRect?.height ?? null);
          panelHeight = request.initialRect?.height ?? panelHeight;
          scrollHeight = contentHeight; // 内容需要的高度是给定的（不随面板变）
          return { id: request.id, close: () => {} };
        },
      },
    };
    resetFakeTimers();
    const app = loaded.factory(() => ReactStub);
    app.apply({ get: () => gui, inject: (deps, cb) => cb({ get: (name) => (name === 'gui-frame' ? gui : null) }), effect: () => {} });
    await flush();
    return rects;
  };
  const fixed = await runWithBody(363); // 缺省 300 ⇒ 内容区 260 ⇒ 差 103
  eq('★ 第一次按缺省高度开', fixed[0], T.CARD_SIZE.height);
  eq('★★ 按"内容区还差多少"补齐（300 + 103 + 2）', fixed[1], 405);
  eq('★★ 补完就收敛（不再反复重开）', fixed.length, 2);
  eq('★ 记下最终高度', sandbox.window.__safelyQuit?.overlayRectHeight, 405);
  eq('★ 记下"高度调过"', sandbox.window.__safelyQuit?.overlayResized, true);
  sandbox.window.__safelyQuit = undefined;
  const fits = await runWithBody(200); // 负控：内容区本来就够（260 ≥ 200）⇒ 一次都不调
  eq('★ 负控：内容放得下就一次都不调', fits.length, 1);
  eq('★ 负控：也没记成"调过高度"', sandbox.window.__safelyQuit?.overlayResized, false);
  fakeNodes.delete(bodySelector);
  fakeNodes.delete(layerSelector);
  sandbox.window.fetch = savedFetch;
  sandbox.window.localStorage = savedStorage;
  sandbox.window.__safelyQuit = undefined;
}
{
  // ★★ 守望的纪律直接调纯件测（时序完全可控 —— 端到端那条链在离线判据里跑得太快，插不进干预点）：
  //    ① 站稳 ⇒ 认领记录；② 用户把面板关掉 ⇒ 清空记录并收手；
  //    ③ 平台清栈（没人动过）⇒ 补开到上限后如实收手，且**不**认领（下次开机还能再提示）；
  //    ④ 一次都没弹出来 ⇒ 慢节奏长窗口补到上限。
  const layerSelector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  const layerNode = {
    getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }),
  };
  const hostCalls = [];
  const fetchImpl = async (url, init) => {
    hostCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return jsonResponse({ ok: true, stamped: true });
  };
  const deps = { model: MANIFEST.pending, sessions: () => null, closedAt: 'ts-9', fetch: fetchImpl };
  const noLayerGui = { overlay: { open: (request) => ({ id: request.id, close: () => {} }) } };
  /** 会走的假时钟：每读一次前进 1 秒（离线判据里真时间根本不走，认领门槛靠它跨过去）。 */
  const makeFakeNow = () => {
    let t = 1_000_000;
    return () => { t += 1000; return t; };
  };

  // ① 层一直在场 ⇒ 站稳之后认领一次；随后用户关掉面板 ⇒ 清空记录 + 收手
  fakeNodes.set(layerSelector, layerNode);
  fakeExpireAfter.set(layerSelector, { remaining: 4 }); // 采到第 5 次时"层没了"
  resetFakeTimers();
  hostCalls.length = 0;
  const closed = await T.watchResumeCard(noLayerGui, deps, { state: { interacted: true, lastAt: Number.MAX_SAFE_INTEGER } }, { everOpened: true, now: makeFakeNow() });
  eq('★ 站稳之后认领了记录', closed.claimed, true);
  eq('★★ 用户关掉面板 ⇒ 清空了记录', closed.cleared, true);
  eq('★★ 收手原因如实记账', closed.end, 'closed-by-user');
  eq('★ 先认领、后清空（顺序不能反）', hostCalls.map((call) => call.url.split('/').pop()).join(','), 'claim,clear');
  eq('★ 清空带的是这份记录的时间戳', hostCalls[1]?.body?.closedAt, 'ts-9');
  eq('★ 认领之后不再重开（面板的去留归用户）', closed.reopens, 0);
  fakeNodes.delete(layerSelector);

  // ② 用户没动过、层却被清掉 ⇒ 补开到上限，且**不认领**（这份记录还该被再提示一次）
  fakeNodes.delete(layerSelector);
  resetFakeTimers();
  hostCalls.length = 0;
  const gaveUp = await T.watchResumeCard(noLayerGui, deps, { state: { interacted: false, lastAt: null } }, { everOpened: true, now: makeFakeNow() });
  eq('★ 平台清栈 ⇒ 重开到上限', gaveUp.reopens, T.WATCH_REOPENS);
  eq('★ 上限之后如实收手（不无限重开）', gaveUp.end, 'gave-up');
  eq('★★ 没站稳就不认领（记录还是"没交出去过"）', gaveUp.claimed, false);
  eq('★★ 也没清空（用户没关它）', gaveUp.cleared, false);
  eq('★ 一次宿主请求都没发', hostCalls.length, 0);

  // ③ "用户动过"的判据是**窗口**：太早的动过不算（那是平台清栈）
  const stale = await T.watchResumeCard(noLayerGui, deps, { state: { interacted: true, lastAt: 0 } }, { everOpened: true, now: makeFakeNow() });
  eq('★ 交互太久远 ⇒ 不当成"用户关的"（仍按平台清栈补开）', stale.end, 'gave-up');
  eq('★ 判据是纯函数，单测直接调', T.closedByUser({ state: { interacted: true, lastAt: 5 } }, 5 + T.INTERACTION_WINDOW_MS), true);
  eq('★ 超出窗口 ⇒ false', T.closedByUser({ state: { interacted: true, lastAt: 5 } }, 6 + T.INTERACTION_WINDOW_MS), false);
  eq('★ 没动过 ⇒ false', T.closedByUser({ state: { interacted: false, lastAt: null } }, 100), false);
  eq('★ 旧形状（只有布尔位）⇒ 保守当成用户关的', T.closedByUser({ state: { interacted: true } }, 100), true);

  // ④ 一次都没弹出来 ⇒ 补弹档：慢节奏长窗口补到上限（**不看用户交互**）
  resetFakeTimers();
  const never = await T.watchResumeCard(noLayerGui, deps, { state: { interacted: true, lastAt: Number.MAX_SAFE_INTEGER } }, { everOpened: false, now: makeFakeNow() });
  eq('★ 从未弹出 ⇒ 补弹到上限后放弃', never.end, 'never-appeared');
  eq('★ 补弹次数 = 上限（不是无限补）', never.reopens, T.OVERLAY_REOPEN_TRIES);
  eq('★ 没弹出来过就绝不认领', never.claimed, false);

  // ④b **宿主不认这条接口时不许刷屏**（宿主对 /pending/claim 回 404 时，每拍重试 + 每拍往诊断账里
  //     记一笔 ⇒ 账无界增长）
  resetFakeTimers();
  let claimTries = 0;
  const refuseFetch = async (url) => {
    if (String(url).includes('/pending/claim')) claimTries += 1;
    return jsonResponse({ error: 'not found' }, { status: 404 });
  };
  fakeNodes.set(layerSelector, layerNode);
  fakeExpireAfter.set(layerSelector, { remaining: 12 }); // 让它在认领试满之后消失 ⇒ 走"用户关掉"这条路收口
  const refused = await T.watchResumeCard(
    noLayerGui,
    { ...deps, fetch: refuseFetch },
    { state: { interacted: true, lastAt: Number.MAX_SAFE_INTEGER } },
    { everOpened: true, now: makeFakeNow() },
  );
  eq('★ 认领被拒不当作成功', refused.claimed, false);
  eq('★★ 认领最多试 CLAIM_MAX_TRIES 次（不是每一拍都试）', claimTries, T.CLAIM_MAX_TRIES);
  eq('★★ 诊断账里只留第一笔失败（不刷屏）', refused.log.filter((row) => row.event === 'claim-failed').length, 1);
  check('★ 诊断账有上限（长跑不许无界增长）', refused.log.length <= T.WATCH_LOG_MAX, `log=${refused.log.length}`);
  fakeNodes.delete(layerSelector);
  resetFakeTimers();

  // ⑤ 补到一半宿主才挂上 ⇒ 记一笔 appeared，然后转进守望（这里让它随后被用户关掉以收口）
  resetFakeTimers();
  hostCalls.length = 0;
  let lateOpens = 0;
  const lateGui = {
    overlay: {
      open: (request) => {
        lateOpens += 1;
        if (lateOpens >= 3) {
          fakeNodes.set(layerSelector, layerNode);
          fakeExpireAfter.set(layerSelector, { remaining: 4 });
        }
        return { id: request.id, close: () => {} };
      },
    },
  };
  const late = await T.watchResumeCard(lateGui, deps, { state: { interacted: true, lastAt: Number.MAX_SAFE_INTEGER } }, { everOpened: false, now: makeFakeNow() });
  check('★ 补弹档补到第 3 次时层出现 ⇒ 记一笔 appeared', late.log.some((row) => row.event === 'appeared'), JSON.stringify(late.log));
  eq('★ 补成之后照常认领', late.claimed, true);
  eq('★ 补成之后照常被"用户关掉"收口', late.end, 'closed-by-user');
  fakeNodes.delete(layerSelector);
  fakeExpireAfter.delete(layerSelector);

  // 监视器：一有用户动作就记下时刻，`stop()` 之后摘干净（不许留着监听器）
  const watch = T.watchUserInteraction();
  eq('监视器初始 = 没动过', watch.state.interacted, false);
  fireFake('pointerdown');
  eq('pointerdown 就置位', watch.state.interacted, true);
  check('★ 同时记下时刻（判据窗口要用它）', Number.isFinite(watch.state.lastAt), JSON.stringify(watch.state));
  const watch2 = T.watchUserInteraction();
  fireFake('keydown');
  eq('keydown 也算（Esc 关卡片走的就是它）', watch2.state.interacted, true);
  const watch3 = T.watchUserInteraction();
  fireFake('wheel');
  eq('滚轮也算（页面在动就等于人在）', watch3.state.interacted, true);
  watch2.stop();
  watch2.state.interacted = false;
  fireFake('keydown');
  eq('★ stop() 之后不再置位（监听器摘干净了）', watch2.state.interacted, false);
  watch.stop();
  watch3.stop();
}
{
  // ★ 「继续」= 请宿主投一条**插件来源**的续行消息：客户端这一侧只送会话 id，
  //   正文由宿主造（`source.kind='safely-quit'`），界面画成"非人触发的本轮"，不是用户气泡。
  const bodies = [];
  const deps = {
    sessions: () => ({ list: {} }),
    workspace: () => ({ openSession() {} }),
    fetch: async (url, init) => { bodies.push(init.body); return jsonResponse({ ok: true, results: [{ sessionId: 'x', result: 'attached' }] }); },
  };
  await T.continueSession(deps, 'x');
  check('客户端送的只有会话 id（正文里没有任何要模型读的话）', /^\{"sessionIds":\["x"\]\}$/.test(bodies[0] ?? ''), bodies[0]);
  check('客户端不构造 user 角色消息（消息只在宿主造）', !/role:\s*'user'/.test(source));
}
{
  // 键名不撒谎：卡片里永远只有「继续」这一颗（"打开"已在设计上否掉，见上面 ⑨ 段的反假绿判据）
  const model = T.parsePending(MANIFEST);
  const card = T.describeResume(model, null);
  eq('★ 卡片把清单里的会话全列出来', card?.rows?.length, 3);
  eq('行上没有"按目标分档"的字段了（接续只有一条路）', 'action' in (card?.rows?.[0] ?? {}), false);
  eq('也没有 canResume 这类诊断字段', 'canResume' in (card?.rows?.[0] ?? {}), false);
  eq('★ 目标视图缺席也不影响卡片（describeResume 不再吃第三个参数）', T.describeResume(model, null)?.title, T.TEXT.resumeMixed(3, 1));
}
{
  // ★★ 记录的去留**不归浏览器本地**（设计口径）：
  //    点键不记账、关面板才清空 —— 卡片外壳里连"存储"这个概念都不该有。
  const model = T.parsePending(MANIFEST);
  let pinged = 0;
  const Live = T.createResumeCardLive({
    sessions: () => ({ open: () => { pinged += 1; }, list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } }),
    workspace: () => ({ openSession: () => { pinged += 1; } }),
    fetch: async () => jsonResponse({ ok: true, results: [] }),
  });
  const tree = Live({ model });
  eq('卡片外壳渲染出卡片', tree?.type, T.ResumeCard);
  check('★ 外壳的 deps 里没有 storage / 记账面（记录归宿主）', !('storage' in tree.props) && tree.props.onDismiss === undefined);
  eq('渲染本身不碰任何会话', pinged, 0);
}
{
  // 文案定稿（浮层那一张）
  eq('浮层标题是「上次关闭时的会话」', T.TEXT.resumePanelTitle, '上次关闭时的会话');
  check('浮层标题也不含技术词', !/session|resume|overlay/i.test(T.TEXT.resumePanelTitle), T.TEXT.resumePanelTitle);
  check('样式含浮层卡片规则（外层留白 + 不吃双层底色）', cssText.includes('.sq-pop{') && cssText.includes('.sq-pop .sq-card{'));
}

// ── ⑪ 按钮不嵌套（项目规则）+ 「立即停止」就是那一行本身 ──────────────────────

/** 树里有没有"按钮套按钮"（元素树是替身造的普通对象，直接递归即可）。 */
function hasNestedButton(tree, insideButton = false) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return false;
  const isButton = tree.type === 'button';
  if (isButton && insideButton) return true;
  const children = Array.isArray(tree.children) ? tree.children : [];
  for (const child of children) {
    if (hasNestedButton(child, insideButton || isButton)) return true;
  }
  return false;
}
/** 树里有几颗 <button>。 */
function countButtons(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return 0;
  let total = tree.type === 'button' ? 1 : 0;
  const children = Array.isArray(tree.children) ? tree.children : [];
  for (const child of children) total += countButtons(child);
  return total;
}
{
  const clock = makeClock();
  const store = T.createQuitStore({
    fetch: fakeFetch(jsonResponse({ stage: 'waiting', pending: ['a'], forceRequested: false, elapsedMs: 1000 })),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const Quit = T.createQuitButton(store);
  eq('待机态：这一行里**一颗 <button> 都没有**', countButtons(Quit()), 0);
  eq('待机态：这一行自己也不是 <button>', Quit()?.type === 'button', false);
  eq('★ 把它套进坞那一行（模拟 GUIFrame 的 <button data-guif-dock-action>）也没有嵌套按钮', hasNestedButton({ type: 'button', children: [Quit()] }), false);
  store.begin();
  eq('确认态：同样一颗 <button> 都没有', countButtons(Quit()), 0);
  eq('确认态：键名是「再点一次确认关闭」', Quit()?.children?.[1]?.children?.[0], T.TEXT.confirm);
  await store.confirm();
  await clock.runOne();
  const closingTree = Quit();
  eq('★ 收尾态：一颗 <button> 都没有（「立即停止」就是这一行本身，不再是嵌进去的小按钮）', countButtons(closingTree), 0);
  eq('★ 收尾态：套进坞那一行后仍无嵌套按钮', hasNestedButton({ type: 'button', children: [closingTree] }), false);
  eq('★ 收尾态：键上那一段文字 =「立即停止」+ 已等秒数', closingTree?.children?.[1]?.children?.[0], '立即停止（已等 1 秒）');
  // ★ 键上**只有一段文字**（"附注"这条通路不存在，见 ⑥ 段的逐档判据）⇒ 收尾态就是一段拼好的话
  eq('★ 收尾态：文字节点只有两个（图标 + 那一段文字）', closingTree?.children?.length, 2);
  eq('★ 收尾态：那一段文字 =「立即停止（已等 S 秒）」', closingTree?.children?.[1]?.children?.[0], '立即停止（已等 1 秒）');
  eq('★ 收尾态：那一段文字走 .sq-label（没有第二个文字节点、没有 .sq-inline）', closingTree?.children?.[1]?.props?.className, 'sq-label');
  check('★ 收尾态：树里不存在 .sq-inline 这个附注锚点', !String(JSON.stringify(closingTree)).includes('sq-inline'), JSON.stringify(closingTree?.children));
  check('★ 收尾态：渲染树里不再出现"还有 N 个会话在跑"', !String(JSON.stringify(closingTree)).includes('还有'), JSON.stringify(closingTree?.children));
  // 续跑卡片（浮层里那张）不在任何按钮里，所以它可以有自己的键 —— 但同样不许互相嵌套
  const card = T.ResumeCard({
    model: T.describeResume(T.parsePending(MANIFEST), null, { 'session-b': { phase: 'active', activation: 'disarmed' } }),
    opened: {},
    onOpen: () => {},
    onDismiss: () => {},
  });
  eq('续跑卡片：里面的按钮也没互相嵌套', hasNestedButton(card), false);
  check('续跑卡片：确实有按钮（否则上一条是空真）', countButtons(card) > 0, String(countButtons(card)));
}
{
  // ★★ 渲染树与显示状态机**同源**：每一档都把"组件真渲染出来的"与"机器说该显示的"逐项对上
  //    （每一档都要对账：漏掉已关闭那一档的 class 就是一条没人管的缺口）
  const clock = makeClock();
  const store = T.createQuitStore({
    fetch: async (url) => {
      if (String(url).endsWith('/close')) return jsonResponse({ ok: true });
      throw new Error('宿主走了'); // 轮询一律失败 ⇒ 连续三拍后判定"宿主已经关了"
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const Quit = T.createQuitButton(store);
  const renderedVsMachine = (label) => {
    const snap = store.getSnapshot();
    const view = T.describePhase(snap.phase, snap.hostState, snap.elapsedMs, snap.errorText, snap.running);
    const tree = Quit();
    eq(`★ ${label}：渲染的 class 来自机器（组件不许自己判阶段）`, tree?.props?.className, view.className);
    eq(`★ ${label}：渲染的悬停说明来自机器`, tree?.props?.title, view.title);
    eq(`★ ${label}：渲染的可点锚点来自机器`, tree?.props?.['data-safely-quit-actionable'], view.actionable ? 'true' : 'false');
    eq(`★ ${label}：键上那一段文字与机器一致`, tree?.children?.[1]?.children?.[0], view.main);
    eq(`★ ${label}：键上只有两个节点（图标 + 一段文字，没有第二个文字节点）`, tree?.children?.length, 2);
    return tree;
  };
  renderedVsMachine('待机态');
  store.begin();
  renderedVsMachine('确认态');
  await store.confirm();
  for (let tick = 0; tick < 5 && store.getSnapshot().phase !== 'closed'; tick += 1) await clock.runOne();
  eq('轮询连续失败 ⇒ 判定宿主已经退了', store.getSnapshot().phase, 'closed');
  const closedTree = renderedVsMachine('已关闭');
  eq('★ 已关闭：键不再做事（锚点说 false）', closedTree?.props?.['data-safely-quit-actionable'], 'false');
  eq('★ 已关闭：键上就是「DSH 已关闭」（补充那句只进悬停）', closedTree?.children?.[1]?.children?.[0], T.TEXT.closed);
  eq('★ 已关闭：悬停说明是「可以关掉这个页面了」', closedTree?.props?.title, T.TEXT.closedHint);
  eq('★ 已关闭：样式锚点换成 .sq-btn-done', closedTree?.props?.className, 'sq-btn sq-btn-done');
}
{
  // 那一行的原生监听：点行（键盘 Enter/Space 激活）要能作用到这颗键；点插件自己的元素不重复触发
  const handlers = [];
  const row = {
    addEventListener: (type, fn) => handlers.push({ type, fn }),
    removeEventListener: () => {},
  };
  const node = { closest: () => row, contains: (target) => target === node, parentElement: row };
  eq('从我们的元素能往上找到那一行', T.dockRowOf(node) === row, true);
  eq('没有 closest 时退回父节点', T.dockRowOf({ parentElement: row }) === row, true);
  eq('找不到就返回 null（不抛）', T.dockRowOf(null), null);
  eq('事件落在我们元素里 ⇒ 归我们的 onClick 管', T.insideNode(node, node), true);
  eq('事件落在别的节点（比如那一行自己）⇒ 不归我们', T.insideNode(node, { other: true }), false);
}

// ── ⑯ 回归判据（逐条真跑）────────────────────────────────────────────────────

// 路由前缀是**同一事实**，两半必须真的对上（真 import 宿主模块比对，不靠第三个字面量转述）
{
  const hostMod = await import('../lib/index.js');
  eq('★ 客户端 ENDPOINT === 宿主 ROUTE_PATH（真 import 比对）', T.ENDPOINT, hostMod.ROUTE_PATH);
  eq('★ 客户端产物里只有一处拼前缀的请求出口（收在 callHost）', [...source.matchAll(/fetchImpl\s*\(\s*`\$\{ENDPOINT\}/g)].length, 1);
  eq('★★ 客户端产物里零版本字面量（版本只能从宿主 /state 读回来）', /\bv?\d+\.\d+\.\d+\b/.test(source), false);
  eq('★ 宿主模块的版本 = 包元数据那一份（唯一真源）', hostMod.PLUGIN_VERSION, pkg.version);
}

// 客户端把宿主报的版本读进来（自己不留第二份）
{
  resetFakeTimers();
  sandbox.window.__safelyQuit = undefined;
  const store = T.createQuitStore({ fetch: async () => jsonResponse({ stage: 'idle', version: pkg.version }) });
  await store.attach();
  eq('★ 客户端读到的版本 = 包元数据那一份（它自己没有第二个来源）', store.getSnapshot().hostState?.version, pkg.version);
  eq('★ 调试面记下宿主报的版本（排障一眼看到客户端用的是哪一版）', sandbox.window.__safelyQuit?.hostVersion, pkg.version);
  store.dispose();
  sandbox.window.__safelyQuit = undefined;
}

// 宿主报 failed ⇒ 客户端显示「重试」，而不是永远卡在"正在关闭"
{
  resetFakeTimers();
  eq('★ 宿主 failed 不算收尾中（不把一次失败说成正在关）', T.isClosingStage('failed'), false);
  eq('★ failed 档的键面就是「重试」', T.describePhase('failed', null, 0, '落盘失败：ENOTDIR').main, T.TEXT.retry);
  check('★ 失败原因进悬停说明（键面只留一句）',
    String(T.describePhase('failed', null, 0, '落盘失败：ENOTDIR').title).includes('ENOTDIR'),
    T.describePhase('failed', null, 0, 'x').title);
  const store = T.createQuitStore({
    fetch: async (url) => jsonResponse(String(url).endsWith('/close')
      ? { ok: true }
      : { stage: 'failed', failed: true, lastError: '落盘失败：ENOTDIR' }),
  });
  store.begin();
  await store.confirm();
  await flush();
  eq('★★ 轮询读到宿主 failed ⇒ 客户端转「重试」档', store.getSnapshot().phase, 'failed');
  eq('★ 宿主给的原因带进界面', store.getSnapshot().errorText, '落盘失败：ENOTDIR');
  store.dispose();
}

// 消失的成因要**分得开** —— 交互当场摘层 ≠ 交互之后平台清栈
{
  eq('★ 交互当场把层摘掉 ⇒ 算用户关的（GUIFrame dismiss 的时序）',
    T.closedByUser({ state: { interacted: true, lastAt: 5, dismissedByInteraction: true } }, 999999), true);
  eq('★★ 交互时层还在、之后才没 ⇒ 不算用户关的（平台清栈，记录必须留着）',
    T.closedByUser({ state: { interacted: true, lastAt: 5, layerSurvivedInteraction: true } }, 6), false);
  eq('★ 旧形状（没有当场证据）仍走窗口判据（有判据钉住）',
    T.closedByUser({ state: { interacted: true, lastAt: 5 } }, 5 + T.INTERACTION_WINDOW_MS), true);
  // 真跑一遍监视器：层在场时的一次交互 ⇒ 记成"与卡片无关"
  const selector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  fakeNodes.set(selector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
  });
  const watch = T.watchUserInteraction();
  fireFake('pointerdown');
  await flush();
  eq('★ 监视器当场核验：层还在 ⇒ 记成"这次交互与卡片无关"', watch.state.layerSurvivedInteraction, true);
  eq('★ 因此不会被当成"用户关的"（旧判据会在这里误判）', T.closedByUser(watch, Date.now()), false);
  watch.stop();
  fakeNodes.delete(selector);
}
{
  // ★★ 面板头部那颗 × 走的是 React 的 onClick：摘层发生在**点击之后**（另一个任务），
  //    交互当场与"微任务复核"那两看层都还在 ⇒ 旧判据把它记成"这次交互与卡片无关" ⇒ 守望随后把
  //    用户刚关掉的卡片**又打开**（真机读数：点了 4 次 ×，卡片 4 次自己回来）。
  //    现在多了一次**延迟复核**（INTERACTION_REVIEW_MS 之后再看一眼）：层没了就改判成"用户关的"。
  resetFakeTimers();
  const selector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  fakeNodes.set(selector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
  });
  // 延迟复核的定时器注入成"手动放行"：离线环境的假 `window.setTimeout` 是**微任务**，
  // 区分不出"当场"与"稍后"，而这条判据的全部意义就在于这两个时刻看到的东西不同。
  const pendingReviews = [];
  const watch = T.watchUserInteraction({ setTimeout: (fn) => { pendingReviews.push(fn); return pendingReviews.length; }, clearTimeout: () => {} });
  fireFake('pointerdown');
  await flush(); // 微任务复核：层还在 ⇒ 先记成"与卡片无关"（这正是旧代码停下的地方）
  eq('交互当场层还在 ⇒ 先记成"与卡片无关"', watch.state.layerSurvivedInteraction, true);
  fakeNodes.delete(selector); // 点击事件里的 React 提交把层摘掉
  eq('延迟复核还没跑 ⇒ 判据还停在"与卡片无关"（反例：这一步是旧代码的终态）', T.closedByUser(watch, Date.now()), false);
  for (const fn of pendingReviews.splice(0)) fn(); // 放行延迟复核
  eq('★★ 延迟复核看到层没了 ⇒ 改判成"用户关的"', watch.state.dismissedByInteraction, true);
  eq('★ 那条过期的"与卡片无关"读数被覆盖', watch.state.layerSurvivedInteraction, false);
  eq('★ 守望据此收手并清空记录（不再跟用户对着干）', T.closedByUser(watch, Date.now()), true);
  watch.stop();
  fakeNodes.delete(selector);
}
{
  // ★★ 重开之后要有**宽限拍**：`openResumePanel` 到层真的进 DOM 有一段延迟，宽限期内"层不在场"
  //    不算又消失了一次。没有它每一拍都会再重开一次把额度烧光（真机 log：reopen 连发三次，
  //    中间一次 reappeared 都没有）。
  resetFakeTimers();
  const selector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  fakeNodes.set(selector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 820, top: 72, right: 1220, bottom: 372 }) }],
  });
  fakeExpireAfter.set(selector, { remaining: 1 }); // 采一拍后层就没了，且再也不回来
  const result = await T.watchResumeCard(
    { overlay: { open: (request) => ({ id: request.id, close: () => {} }) } },
    {
      model: MANIFEST.pending,
      sessions: () => null,
      closedAt: 'ts-grace',
      fetch: async () => jsonResponse({ ok: true, stamped: true }),
    },
    { state: { interacted: false, lastAt: null } },
    { everOpened: true, now: (() => { let t = 1_000_000; return () => { t += 1000; return t; }; })() },
  );
  eq('层一直没回来 ⇒ 额度用完收手', result.end, 'gave-up');
  eq('重开次数等于额度（没有被"还没出现"额外消耗）', result.reopens, T.WATCH_REOPENS);
  const waits = result.log.filter((row) => row.event === 'reopen-wait').length;
  eq('★★ 每次重开之后恰好等满宽限拍（不是每拍都重开）', waits, T.WATCH_REOPENS * T.REOPEN_GRACE_TICKS);
  eq('★ 重开次数两位数以内（额度没被瞬间烧光）', result.reopens <= T.WATCH_REOPENS, true);
  fakeNodes.delete(selector);
  fakeExpireAfter.delete(selector);
}

// 层在 DOM 里但整个在视口外 ⇒ 用户没看见，不算交付（不认领）
{
  resetFakeTimers();
  const selector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  fakeNodes.set(selector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 9000, top: 72, right: 9400, bottom: 372 }) }],
  });
  fakeExpireAfter.set(selector, { remaining: 4 }); // 采几拍后"层没了"⇒ 走平台清栈那条路收口
  const posts = [];
  const result = await T.watchResumeCard(
    { overlay: { open: (request) => ({ id: request.id, close: () => {} }) } },
    {
      model: MANIFEST.pending,
      sessions: () => null,
      closedAt: 'ts-outside',
      fetch: async (url) => { posts.push(String(url)); return jsonResponse({ ok: true, stamped: true }); },
    },
    { state: { interacted: false, lastAt: null } },
    { everOpened: true, now: (() => { let t = 1_000_000; return () => { t += 1000; return t; }; })() },
  );
  eq('★ 层在视口外 ⇒ 不算交付', result.claimed, false);
  eq('★ 一个认领请求都没发出去', posts.filter((url) => url.includes('/pending/claim')).length, 0);
  check('★ 也没删记录（不是用户关的）', result.cleared === false, JSON.stringify(result));
  fakeNodes.delete(selector);
  fakeExpireAfter.delete(selector);
}

// attach 落在"某一拍在飞"的空档上，不许长出第二条轮询链
{
  resetFakeTimers();
  const queue = [];
  const gates = [];
  let scheduledCount = 0;
  let stateCalls = 0;
  const store = T.createQuitStore({
    fetch: async (url) => {
      if (String(url).endsWith('/close')) return jsonResponse({ ok: true });
      stateCalls += 1;
      // 第一次（attach 用的）立刻回；之后的都挂住，等用例自己放行（回什么由用例决定）
      if (stateCalls === 1) return jsonResponse({ stage: 'waiting', elapsedMs: 1 });
      return new Promise((resolve) => { gates.push((payload) => resolve(jsonResponse(payload))); });
    },
    pollMs: 5,
    schedule: (fn) => { scheduledCount += 1; queue.push(fn); return scheduledCount; },
    cancel: () => {},
  });
  await store.attach(); // 宿主说在收尾 ⇒ 进 closing 并排第一拍
  eq('进入收尾态后排了第一拍', scheduledCount, 1);
  eq('相位是收尾中', store.getSnapshot().phase, 'closing');
  queue.shift()(); // 第一拍：状态请求挂住（在飞）
  eq('第一拍发出了状态请求', gates.length, 1);
  const attaching = store.attach(); // 同一空档里再来一次"与宿主对齐"
  eq('对齐也发出了状态请求', gates.length, 2);
  gates[1]({ stage: 'waiting', elapsedMs: 2 }); // 先让"对齐"的回执落地（更新的那份读数）
  await flush();
  const beforeStale = scheduledCount;
  gates[0]({ stage: 'waiting', elapsedMs: 1 }); // 再让在飞那一拍（此刻已经过期、读数更旧）落地
  await flush();
  await attaching;
  eq('★★ 过期的那一拍不许再续期（否则两条轮询链，失败计数双倍增长）', scheduledCount, beforeStale);
  eq('★ 也不许把过期读数落进快照（它比对齐那一次更旧）', store.getSnapshot().hostState?.elapsedMs, 2);
  store.dispose();
}

// 层在 DOM 但**不可见** ⇒ 既不认领、也不重开（"层在场却量不到盒子"是独立的一档）
{
  resetFakeTimers();
  const selector = '[data-guif-overlay-layer="dsh-safely-quit/resume"]';
  // 真机形状：层包裹节点 display:contents（自身恒 0×0），层里那块面板落在视口外（left=9000）
  fakeNodes.set(selector, {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 400, height: 300, left: 9000, top: 72, right: 9400, bottom: 372 }) }],
  });
  fakeExpireAfter.set(selector, { remaining: 6 }); // 采几拍后层没了 ⇒ 走"用户动过手"那条窗口判据收口，循环能结束
  const posts = [];
  const result = await T.watchResumeCard(
    { overlay: { open: (request) => ({ id: request.id, close: () => {} }) } },
    {
      model: MANIFEST.pending,
      sessions: () => null,
      closedAt: 'ts-invisible',
      fetch: async (url) => { posts.push(String(url)); return jsonResponse({ ok: true, stamped: true, cleared: true }); },
    },
    { state: { interacted: true, lastAt: Number.MAX_SAFE_INTEGER } },
    { everOpened: true, now: (() => { let t = 1_000_000; return () => { t += 1000; return t; }; })() },
  );
  eq('★ 层在 DOM 但不可见 ⇒ 不认领（用户没看见过的不算交付）', result.claimed, false);
  eq('★ 也不重开（层还在场，去重开等于跟用户对着干）', result.reopens, 0);
  eq('★ 一个认领请求都没发出去', posts.filter((url) => url.includes('/pending/claim')).length, 0);
  check('★ 收口原因如实记账', String(result.end) === 'closed-by-user', JSON.stringify(result));
  fakeNodes.delete(selector);
  fakeExpireAfter.delete(selector);
}

// 宿主失败之后界面不许把一次失败永远说成"正在关闭"：`failed` 不算收尾中（要显示「重试」）
{
  eq('★ failed 不算收尾中（它显示「重试」）', T.isClosingStage('failed'), false);
}

if (failures.length > 0) {
  console.error(`✗ client.test：${failures.length} 条未过（通过 ${passed}）`);
  for (const line of failures) console.error(`   ✗ ${line}`);
  process.exit(1);
}
console.log(`✓ client.test：全部通过（${passed} 条判据；真加载产物 + 真调用组件 + 请求形状 + 状态文案 + 反例）`);
