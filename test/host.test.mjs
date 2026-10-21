/**
 * host.test.mjs —— 宿主半区的**离线判据**（零第三方依赖，不需要 DSH 在跑）。
 *
 * 覆盖（每条都有正例与反例，不是恒真断言）：
 *   ① 两道 HTTP 门（回环 / 同源）：`isLoopbackAddress`、`isSameOriginMutation`
 *   ② pre-step 决策：平常放行；收尾中只拒绝「已下令」的 agent；下游已拒绝时尊重它且不重复计数
 *   ③ 收尾编排：dryRun 只快照落盘**不关宿主**；真跑路径全停后才 SIGTERM；force 才 cancel
 *   ④ 清单契约：字段与 `droppedInputs` 计数（规格 §4）
 *   ⑤ 路由：门禁、`/close` 的 confirm、`/state`、`/force`
 *   ⑥ **待续记录的生死**（规格 §1.7）：v2 交付字段 / 认领 / 清空 / 四类回收（坏·非计划内·空·过时）
 *   ⑦ **关机拓展**（规格 §2.3）：注册表 / 排序 / 超时 / 隔离失败 / 幂等 / 命令式（注入假 spawn）
 *   ⑧ 关闭流程里的关机拓展：跑在 SIGTERM **之前**、dryRun 不跑、dispose 兜底只补没跑过的
 *   ⑨ 记录的三条通路（路由层）
 *   ⑩ **回归判据**（逐条真跑）：
 *      版本的唯一真源 / 并发 /close 只受理一条 / 落盘失败照样关 / 编排中断如实报 failed /
 *      演练不占关闭名额 / 等待窗口内新变忙的会话被拦且进清单 / DSH_HOME 与平台同口径 /
 *      关机拓展单飞与缺省不杀树 / 同步 error 不留孤儿定时器 / 落盘辅助函数
 *   ⑪ **受理段不变量与判据缝护栏**：`/close` 的整组提前返回分支逐个驱动（被拒之后阶段原地不动、
 *      随后仍能再关一次）+ 结构面两条收敛纪律（受理段自己不写 stage、名额只在 finally 归还）
 *      + `setHandoffExit` 那条缝的默认实现必须是**真退出**（真起子进程验）。
 *
 * `process.kill` 在本文件里被**临时替换**（只在这几个用例内），用于断言"什么时候才会真的去关宿主"——
 * 这是本套判据最关键的一条牙：**任何没走完全部前置步骤的路径都不许碰到 SIGTERM**。
 *
 * ⚠ 本文件**起两个真子进程**：一个验"命令式关机动作"的默认 spawn 真的是 `node:child_process`；
 * 另一个验"判据缝的生产默认真的是真退出"（子进程里顶住事件循环，只有真退出能结束它）。其余全离线。
 *
 * 用法：`node test/host.test.mjs`（exit 0 = 全过；失败即非 0 并逐条打印）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

// 隔离 DSH_HOME：所有落盘都进临时目录，绝不碰真机 ~/.dsh
const SANDBOX = mkdtempSync(join(tmpdir(), 'safely-quit-test-'));
process.env.DSH_HOME = SANDBOX;

const mod = await import('../lib/index.js');
const {
  agentIdOf, beginClose, createSession, decidePreStep, describeAgent,
  handleRoute, isLoopbackAddress, isSameOriginMutation, markerFile, pendingFile,
  pickString, publicState, readJsonBody, readOpenSessionIds, readOpenSource,
  snapshotForClose, stopKindOf, topLevelSessionIdOf,
  continueMessage, continueOne, continueSessions,
  MAX_OPEN_SESSION_IDS, MAX_CONTINUE_IDS, CONTINUE_TEXT, CONTINUE_SOURCE_KIND,
} = mod.__test;

/**
 * ⚠ **判据进程不许被"兜底自退"杀掉**：交棒的兜底会调 `process.exit(0)`，那会让本文件在打印
 * 「全部通过（N 条）」之前就退出 —— 读起来是绿的、其实一条都没跑完（本仓库真踩过这一脚）。
 * 所以这里把它的退出函数接成记数器，判据要断言"它会被调用"时直接看 `handoffExits`。
 */
const handoffExits = [];
mod.__test.setHandoffExit((code) => { handoffExits.push(code); });

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

// ── 假件 ──────────────────────────────────────────────────────────────────────

function fakeAgent(id, status = 'running') {
  return {
    id,
    status,
    session: { header: { cwd: `D:\\proj\\${id}`, title: `任务 ${id}` } },
    cancelled: [],
    cancel(cause) {
      this.cancelled.push(cause);
      this.status = 'idle';
    },
  };
}

function fakeCtx(agents, options) {
  const find = (id) => agents.find((row) => row.agent.id === id)?.agent;
  const ctx = {
    agents: {
      list: () => agents.map((row) => row.agent),
      get: find,
    },
  };
  // 注册表的"谁建的"记在**表项**上（真源：`dsh-agent` 的 `AgentRegistry.enter(id, agent, owner)`）：
  // 行可以写成 `{ agent, owner: '<父 agent id>' }`，公开面只有 `isOwnedBy(childId, candidate)`。
  if (options?.noIsOwnedBy !== true) {
    ctx.agents.isOwnedBy = (id, owner) => agents.find((row) => row.agent.id === id)?.owner === owner?.id;
  }
  return ctx;
}

/** 造一行"子代理"表项（带 owner）。 */
function childOf(agent, ownerId) {
  return { agent, owner: ownerId };
}

function rows(...pairs) {
  return pairs.map(([agent]) => ({ agent }));
}

/**
 * 交棒探针 —— 验**效果**，不验手段：数"发了几次信号"只验了手段，而手段本身在 Windows 上是错的
 * （`process.kill(pid,'SIGTERM')` = TerminateProcess，平台的处理器根本不会跑）。
 *
 * 这个探针做三件事：
 *   ① 给 ctx 装上**平台形状的 `appExit`**（调用即记账）—— 交棒第一条路；
 *   ② 同时真注册一个 **SIGTERM 监听**（回调即记账）—— 交棒第二条路（`process.emit`）；
 *   ③ 盯着 `process.kill`：**一次都不许被调用**（用错手段必须能判红）。
 * 于是"关闭真的交出去了" = `appExit` 被调用 **或** 监听者被回调，两者都进返回面供判据断言。
 *
 * @param {(probe:{appExitCalls:Array, signalHits:Array, killCalls:Array}) => Promise<void>} run
 * @returns {Promise<{appExitCalls:Array, signalHits:Array, killCalls:Array}>}
 */
async function withHandoffProbe(run) {
  const probe = { appExitCalls: [], signalHits: [], killCalls: [] };
  const listener = () => { probe.signalHits.push({ pid: process.pid, at: Date.now() }); };
  const originalKill = process.kill;
  process.on('SIGTERM', listener);
  process.kill = (pid, signal) => {
    probe.killCalls.push({ pid, signal });
    return true;
  };
  try {
    await run(probe);
  } finally {
    process.kill = originalKill;
    process.off('SIGTERM', listener);
  }
  return probe;
}

/** 给一个假 ctx 装上"平台形状"的 `appExit`（交棒第一条路要读它）。 */
function platformCtx(baseCtx, probe) {
  return {
    ...baseCtx,
    get: (name) => (name === 'appExit' ? (code) => { probe.appExitCalls.push(code); } : undefined),
  };
}

/** 交棒成功：走的是平台原语，或信号事件真到了监听者手里（两者之一即可）。 */
function handoffDelivered(probe) {
  return probe.appExitCalls.length + probe.signalHits.length === 1;
}

// ── ① 两道门 ──────────────────────────────────────────────────────────────────

check('回环 127.0.0.1 放行', isLoopbackAddress('127.0.0.1'));
check('回环 ::1 放行', isLoopbackAddress('::1'));
check('回环 ::ffff:127.0.0.1 放行', isLoopbackAddress('::ffff:127.0.0.1'));
check('外网地址拒绝（反例）', !isLoopbackAddress('192.168.1.9'));
check('地址缺失拒绝（反例）', !isLoopbackAddress(undefined));

const sameOriginReq = (headers) => ({ headers });
check('origin 与 host 同源 ⇒ 放行',
  isSameOriginMutation(sameOriginReq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })));
check('无 origin 但 sec-fetch-site: same-origin ⇒ 放行',
  isSameOriginMutation(sameOriginReq({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })));
check('跨站 origin ⇒ 拒绝（反例）',
  !isSameOriginMutation(sameOriginReq({ host: '127.0.0.1:3080', origin: 'http://evil.example' })));
check('命令行裸 POST（无 origin、无 sec-fetch-site）⇒ 拒绝（反例）',
  !isSameOriginMutation(sameOriginReq({ host: '127.0.0.1:3080' })));
check('非回环 host ⇒ 拒绝（反例）',
  !isSameOriginMutation(sameOriginReq({ host: '10.0.0.5:3080', origin: 'http://10.0.0.5:3080' })));

// ── ② pre-step 决策 ───────────────────────────────────────────────────────────

const idleSession = createSession();
const passthrough = { kind: 'enter', messages: [{ id: 'm1' }] };
eq('平常（stage=idle）原样放行', decidePreStep(idleSession, { agent: fakeAgent('a'), messages: [] }, passthrough), passthrough);
eq('平常不计数', idleSession.dropped.size, 0);

const waiting = createSession();
waiting.stage = 'waiting';
waiting.stopIds.add('a');
const rejected = decidePreStep(waiting, { agent: fakeAgent('a'), messages: [{ id: 'x' }, { id: 'y' }] }, passthrough);
eq('收尾中对已下令的 agent ⇒ reject', rejected.kind, 'reject');
eq('被丢弃的输入计数', waiting.dropped.get('a'), 2);
eq('计数是条数不是次数', waiting.dropped.get('a'), 2);

const other = decidePreStep(waiting, { agent: fakeAgent('b'), messages: [{ id: 'z' }] }, passthrough);
eq('收尾中未下令的 agent ⇒ 放行', other, passthrough);
eq('未下令的 agent 不计入 dropped', waiting.dropped.has('b'), false);

const alreadyRejected = { kind: 'reject' };
const upstream = createSession();
upstream.stage = 'waiting';
upstream.stopIds.add('a');
eq('下游已拒绝 ⇒ 尊重下游结果', decidePreStep(upstream, { agent: fakeAgent('a'), messages: [{ id: 'q' }] }, alreadyRejected), alreadyRejected);
eq('尊重下游时不重复计数', upstream.dropped.size, 0);

// ── ③④ 收尾编排与清单 ─────────────────────────────────────────────────────────

// dryRun：只快照 + 落盘，绝不交棒
{
  const agent = fakeAgent('s-1', 'running');
  const ctx = fakeCtx(rows([agent], [fakeAgent('s-2', 'idle')]));
  const session = createSession();
  const probe = await withHandoffProbe(async (p) => {
    await beginClose(platformCtx(ctx, p), session, { dryRun: true });
    eq('dryRun 不交棒（最关键的一条牙）', handoffDelivered(p), false);
    eq('dryRun 也不碰 process.kill', p.killCalls.length, 0);
  });
  eq('dryRun 的 handoff 读数是 null（没交棒）', publicState(session).handoff, null);
  eq('dryRun 走完到 done', session.stage, 'done');
  eq('dryRun 不下停止令', session.stopIds.size, 0);
  // 没收到客户端上报 ⇒ 宿主**不知道**界面上开着什么 ⇒ 只记在跑的（"多记"就是那张假清单）
  eq('未上报时只记在跑的（空闲的不进清单）', session.snapshot.map((item) => item.sessionId).join(','), 's-1');
  eq('未上报时 scope.open 是 null（不是 0）', publicState(session).scope?.open, null);
  eq('runningAtClose 只数在跑的', publicState(session).runningAtClose, 1);
  const written = JSON.parse(readFileSync(pendingFile(), 'utf8'));
  eq('dryRun 清单 reason', written.reason, 'dry-run');
  eq('dryRun 清单会话数', written.sessions.length, 1);
  const row = written.sessions.find((item) => item.sessionId === 's-1');
  eq('在跑的记 step-boundary', row.stop.kind, 'step-boundary');
  eq('cwd 取自 session.header', row.cwd, 'D:\\proj\\s-1');
  eq('title 取自 session.header', row.title, '任务 s-1');
  eq('记录里带范围读数（诊断用）', written.scope?.recorded, 1);
  eq('记录里带范围读数的在跑数', written.scope?.running, 1);
  check('dryRun 不写「计划内关闭」标记（不是真关闭）', !existsSync(markerFile()));
  void probe;
}

// ── ③.1 关闭快照的范围：**只记被这次关闭打断的 agent loop**（设计口径）──────────────
// 两轮事故各教了一半：① 拿"活着的 agent"当范围 ⇒ 界面一个会话都没开也列了 16 个（那 16 个只是
// "这次运行里翻到过"）；② 一度把"界面开着的空闲会话"也收进清单 ⇒ 它们并没有被打断的 loop，
// 「继续」等于凭空造一个任务。现在只剩一条判据：**当时在跑**。
{
  // ① 界面开着的空闲会话 ⇒ **不进清单**（只在 scope.open 里留痕）
  const open = fakeAgent('o-1', 'idle');
  const ctx = fakeCtx(rows([open], [fakeAgent('o-2', 'idle')]));
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: ['o-1'], openSource: 'mainView' });
  eq('★★ 开着但没在跑 ⇒ 不进清单（"只继续被关闭打断的 loop"）', session.snapshot.length, 0);
  eq('scope 仍记下"界面报开着 1 个"（诊断：我开着的那个为什么没列）', publicState(session).scope?.open, 1);
  eq('scope 记下来源', publicState(session).scope?.source, 'mainView');
  eq('scope 记下最终条数 0', publicState(session).scope?.recorded, 0);
  const written = JSON.parse(readFileSync(pendingFile(), 'utf8'));
  eq('空清单照样落盘（开机按 empty 回收、不弹卡片）', written.sessions.length, 0);
  eq('记录里的 scope 与控制面一致', written.scope?.open, 1);
}
{
  // ② 没上报的活 agent（"这次运行里翻到过"）⇒ 同样不进清单：那 16 行就是这么来的
  const ctx = fakeCtx(rows([fakeAgent('x-1', 'idle')], [fakeAgent('x-2', 'idle')], [fakeAgent('x-3', 'idle')]));
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: [], openSource: 'mainView' });
  eq('三个空闲会话 ⇒ 清单空（不再拿活 agent 凑数）', session.snapshot.length, 0);
  eq('scope 把"上报 0 个"说清楚', publicState(session).scope?.open, 0);
}
{
  // ③ 开着的空闲 + 在跑的：**只记在跑的那一个**
  const ctx = fakeCtx(rows([fakeAgent('m-1', 'idle')], [fakeAgent('m-2', 'running')]));
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: ['m-1'], openSource: 'mainView' });
  eq('★ 只记在跑的那一个', session.snapshot.map((item) => `${item.sessionId}:${item.status}`).join(','), 'm-2:running');
  eq('scope 报在跑数 1', publicState(session).scope?.running, 1);
  eq('scope.recorded 与行数一致', publicState(session).scope?.recorded, session.snapshot.length);
  const written = JSON.parse(readFileSync(pendingFile(), 'utf8'));
  eq('★★ 新记录里每一行都是"被打断"（不再出现 idle 行）',
    written.sessions.every((row) => row.statusAtClose === 'running'), true);
  check('★★ 记录的停止方式只可能是 step-boundary / delegated（already-idle 只属于读旧记录）',
    written.sessions.every((row) => row.stop?.kind === 'step-boundary' || row.stop?.kind === 'delegated'),
    JSON.stringify(written.sessions.map((row) => row.stop?.kind)));
  eq('★ 读旧记录时 already-idle 仍然认（兼容，不会把旧行判成"被打断"）', stopKindOf({ status: 'idle' }), 'already-idle');
}
{
  // ★ 结构性锁定：快照函数**只吃宿主上下文**——"界面开着哪些会话"不再参与清单内容
  eq('★ snapshotForClose 只吃一个参数（开着的会话不进快照）', snapshotForClose.length, 1);
}
{
  // ④ 上报开着、宿主这边还没有活 agent（刚点开就关）⇒ 不记（它不可能被打断）
  const ctx = fakeCtx(rows([fakeAgent('y-1', 'idle')]));
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: ['y-9'], openSource: 'selection-store' });
  eq('没有活 agent 的"开着"不记', session.snapshot.length, 0);
  eq('来源如实记下（诊断用）', publicState(session).scope?.source, 'selection-store');
}
{
  // ⑤ 同一会话既开着又在跑 ⇒ 记一行（不重复）
  const ctx = fakeCtx(rows([fakeAgent('z-1', 'running')]));
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: ['z-1'], openSource: 'mainView' });
  eq('既开着又在跑 ⇒ 只记一行', session.snapshot.length, 1);
  eq('这一行按在跑记', session.snapshot[0].status, 'running');
}
{
  // ⑥ 上报形状不干净：非字符串 / 空串 / 重复 / 超长 —— 只留干净的
  eq('非数组 ⇒ null（没上报）', readOpenSessionIds('o-1'), null);
  eq('非字符串条目丢弃', readOpenSessionIds([1, null, 'a']).join(','), 'a');
  eq('空串丢弃', readOpenSessionIds(['', '  ', 'a']).join(','), 'a');
  eq('重复只留一次', readOpenSessionIds(['a', 'a', 'b']).join(','), 'a,b');
  eq('首尾空白裁掉', readOpenSessionIds([' a ']).join(','), 'a');
  const many = Array.from({ length: MAX_OPEN_SESSION_IDS + 10 }, (_, index) => `id-${index}`);
  eq('超过上限的部分丢掉', readOpenSessionIds(many).length, MAX_OPEN_SESSION_IDS);
  eq('空数组 ≠ 没上报', Array.isArray(readOpenSessionIds([])), true);
  // 来源标识：只收短的小写标识，别的一律当没报
  eq('来源标识原样收下（驼峰也收）', readOpenSource('mainView'), 'mainView');
  eq('来源标识收连字符', readOpenSource('selection-store'), 'selection-store');
  eq('来源标识含空格被拒', readOpenSource('a b'), null);
  eq('来源标识超长被拒', readOpenSource('x'.repeat(33)), null);
  eq('来源标识非字符串被拒', readOpenSource(42), null);
}

// ── ③.2 子代理：**等停照等、清单折算成顶层会话**（在跑的子代理 = 那个顶层会话被打断）────────────
// 背景：子代理（AgentTeams 成员 / subagent）不在 `roots()` 里 ⇒ 旧实现既不等它们（SIGTERM 在 step
// 中途带走），也不记它们（关闭那一刻只有子代理在跑 ⇒ 记录为空 ⇒ 不弹卡片）。
{
  const parent = fakeAgent('p-1', 'idle');
  const child = fakeAgent('c-1', 'running');
  const ctx = fakeCtx([{ agent: parent }, childOf(child, 'p-1')]);
  eq('子代理上溯到顶层会话', topLevelSessionIdOf(ctx, 'c-1'), 'p-1');
  eq('顶层会话上溯到自己', topLevelSessionIdOf(ctx, 'p-1'), 'p-1');
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: [], openSource: 'mainView' });
  eq('★ 清单只记父会话（子代理不单独列成一行）', session.snapshot.map((item) => item.sessionId).join(','), 'p-1');
  eq('★ 父会话按"在跑"记（被打断的是它名下的工作）', session.snapshot[0]?.status, 'running');
  eq('★ 停止方式留痕 delegated', stopKindOf(session.snapshot[0]), 'delegated');
  eq('scope 如实报在跑 1 个', publicState(session).scope?.running, 1);
  const written = JSON.parse(readFileSync(pendingFile(), 'utf8'));
  eq('记录里也是这一行', written.sessions[0]?.sessionId, 'p-1');
  eq('记录里的停止方式', written.sessions[0]?.stop?.kind, 'delegated');
}
{
  // 子代理也空闲、只是被开在界面上 ⇒ 不算被打断 ⇒ 不记
  const parent = fakeAgent('p-2', 'idle');
  const child = fakeAgent('c-2', 'idle');
  const ctx = fakeCtx([{ agent: parent }, childOf(child, 'p-2')]);
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: ['c-2'], openSource: 'mainView' });
  eq('★ 开着的是空闲子会话 ⇒ 清单空（没有被打断的 loop）', session.snapshot.length, 0);
}
{
  // ★ 真跑：在跑的**子代理**必须进停止集（pre-step 按 agent id 生效）；清单仍记父会话
  const parent = fakeAgent('p-3', 'idle');
  const child = fakeAgent('c-3', 'running');
  const ctx = fakeCtx([{ agent: parent }, childOf(child, 'p-3')]);
  const session = createSession();
  await withHandoffProbe(async (probe) => {
    setTimeout(() => { child.status = 'idle'; }, 30);
    await beginClose(platformCtx(ctx, probe), session, { dryRun: false, openSessionIds: [], openSource: 'mainView' });
    eq('★★ 子代理进了停止集（下一步会被拦在 step 边界，而不是被 SIGTERM 半路带走）', session.stopIds.has('c-3'), true);
    eq('★ 父会话（空闲）不进停止集（它没有在跑的 step）', session.stopIds.has('p-3'), false);
    eq('交棒照常', probe.appExitCalls.length, 1);
  });
  eq('真跑清单记父会话', session.snapshot.map((item) => item.sessionId).join(','), 'p-3');
  eq('真跑清单里父会话按在跑记', session.snapshot[0]?.status, 'running');
}
{
  // 老平台没有 isOwnedBy ⇒ 上溯不了 ⇒ 原样记（宁可多一行可能"不在了"的，也不把"有活在跑"吞掉）
  const child = fakeAgent('c-4', 'running');
  const ctx = fakeCtx([childOf(child, 'p-4')], { noIsOwnedBy: true });
  eq('没有 isOwnedBy ⇒ 上溯退化成原样', topLevelSessionIdOf(ctx, 'c-4'), 'c-4');
  const session = createSession();
  await beginClose(ctx, session, { dryRun: true, openSessionIds: [] });
  eq('清单仍然记下它（不吞）', session.snapshot.map((item) => item.sessionId).join(','), 'c-4');
}


// 真跑：全停之后才交棒 —— **验效果**（平台的退出原语真的被调用），不验手段（不数 process.kill）
{
  rmSync(markerFile(), { force: true });
  const agent = fakeAgent('s-3', 'running');
  const ctx = fakeCtx(rows([agent]));
  const session = createSession();
  await withHandoffProbe(async (probe) => {
    // agent 在收尾开始后被外部停稳（模拟"跑完当前一步"）
    setTimeout(() => {
      agent.status = 'idle';
    }, 30);
    await beginClose(platformCtx(ctx, probe), session, { dryRun: false });
    eq('★ 全停之后才交棒：平台的 appExit 真被调用一次', probe.appExitCalls.length, 1);
    eq('★ 交棒参数是 0（正常退出码）', probe.appExitCalls[0], 0);
    eq('★ 关闭**没有**用进程级强杀（process.kill 一次都没被调用）', probe.killCalls.length, 0);
    eq('★ 也不需要退而求其次去发信号事件（appExit 已经接住了）', probe.signalHits.length, 0);
    eq('交棒读数如实记下走的是哪条路', publicState(session).handoff?.via, 'appExit');
  });
  eq('真跑清单 reason', JSON.parse(readFileSync(pendingFile(), 'utf8')).reason, 'user-requested');
  check('真跑写「计划内关闭」标记', existsSync(markerFile()));
  eq('真跑不 cancel 任何 agent（没有强杀）', agent.cancelled.length, 0);
}

// force：只有用户点了「立即停止」才 cancel
{
  const agent = fakeAgent('s-4', 'running');
  const ctx = fakeCtx(rows([agent]));
  const session = createSession();
  agent.cancel = function cancel(cause) {
    this.cancelled.push(cause);
    this.status = 'idle';
  };
  await withHandoffProbe(async (probe) => {
    setTimeout(() => {
      session.forceRequested = true;
      session.forceRequestedAtMs = Date.now();
    }, 20);
    await beginClose(platformCtx(ctx, probe), session, { dryRun: false });
    eq('force 后仍然走完并交棒', probe.appExitCalls.length, 1);
    eq('force 路径也不碰 process.kill', probe.killCalls.length, 0);
  });
  eq('force 才 cancel', agent.cancelled.length, 1);
  eq('cancel 的 cause 是用户发起', agent.cancelled[0]?.kind, 'user-force-stop');
}

// ── ⑤ 路由 ────────────────────────────────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text ?? '';
    },
    json() {
      return this.body.length === 0 ? null : JSON.parse(this.body);
    },
  };
}

function fakeReq({ method = 'GET', url = '/', headers = {}, remote = '127.0.0.1', body = null, raw = null } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: remote };
  // `raw` 用于喂**原样字节**（坏 JSON、空体、超限体）：这些形态过不了 JSON.stringify。
  const payload = raw !== null ? raw : (body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)));
  if (payload !== null) req.push(payload);
  req.push(null);
  return req;
}

const loopbackHeaders = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };

{
  const session = createSession();
  const res = fakeRes();
  await handleRoute({}, session, fakeReq({ url: '/api/dsh-safely-quit/state', remote: '10.1.2.3' }), res);
  eq('非回环 ⇒ 403', res.statusCode, 403);
}
{
  const session = createSession();
  const res = fakeRes();
  await handleRoute({}, session, fakeReq({ url: '/api/dsh-safely-quit/state', headers: { ...loopbackHeaders, 'sec-fetch-site': 'cross-site' } }), res);
  eq('跨站读 ⇒ 403', res.statusCode, 403);
}
{
  const session = createSession();
  const res = fakeRes();
  await handleRoute({}, session, fakeReq({ url: '/api/dsh-safely-quit/state', headers: { host: '127.0.0.1:3080' } }), res);
  eq('回环地址读 /state ⇒ 200', res.statusCode, 200);
  eq('idle 状态可读', res.json().stage, 'idle');
}
{
  const session = createSession();
  const res = fakeRes();
  await handleRoute({}, session, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: {} }), res);
  eq('缺 confirm ⇒ 400', res.statusCode, 400);
  eq('缺 confirm 时不动状态机', session.stage, 'idle');
}
{
  const session = createSession();
  const res = fakeRes();
  await handleRoute({}, session, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: { host: '127.0.0.1:3080' }, body: { confirm: true } }), res);
  eq('跨站裸 POST 关闭 ⇒ 403', res.statusCode, 403);
  eq('被门挡住时不动状态机', session.stage, 'idle');
}
{
  const agent = fakeAgent('s-9', 'idle');
  const ctx = fakeCtx(rows([agent]));
  const session = createSession();
  const res = fakeRes();
  await handleRoute(ctx, session, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: { dryRun: true } }), res);
  eq('演练关闭 ⇒ 202', res.statusCode, 202);
  eq('演练返回 dryRun 标记', res.json().dryRun, true);
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  eq('演练跑完到 done', session.stage, 'done');
}
{
  const session = createSession();
  const res = fakeRes();
  await handleRoute({}, session, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/force', headers: loopbackHeaders }), res);
  eq('非 waiting 时 /force ⇒ 409', res.statusCode, 409);
}
{
  const session = createSession();
  const res = fakeRes();
  await handleRoute({}, session, fakeReq({ url: '/api/dsh-safely-quit/nope', headers: loopbackHeaders }), res);
  eq('未知子路径 ⇒ 404', res.statusCode, 404);
}

// 客户端自报通道（`POST/GET /report`）：浏览器里发生了什么，宿主这边留一份、能读回
{
  const res = fakeRes();
  await handleRoute({}, createSession(), fakeReq({
    method: 'POST',
    url: '/api/dsh-safely-quit/report',
    headers: loopbackHeaders,
    body: { version: 'test', resumePath: 'overlay', pending: { total: 3 } },
  }), res);
  eq('自报 ⇒ 200', res.statusCode, 200);
  eq('自报回执带落盘时刻', typeof res.json()?.savedAt, 'string');
  const back = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ url: '/api/dsh-safely-quit/report', headers: loopbackHeaders }), back);
  eq('自报能读回（GET /report）', back.json()?.report?.resumePath, 'overlay');
  eq('读回带上宿主身份与时刻（排障要对得上现场）', typeof back.json()?.hostPid, 'number');
  const crossSite = fakeRes();
  await handleRoute({}, createSession(), fakeReq({
    method: 'POST',
    url: '/api/dsh-safely-quit/report',
    headers: { host: '127.0.0.1:3080' },
    body: { x: 1 },
  }), crossSite);
  eq('自报也必须同源（写请求的门照旧）', crossSite.statusCode, 403);
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

eq('pickString 取第一个非空', pickString(null, '', 'x', 'y'), 'x');
eq('pickString 全空 ⇒ null', pickString(null, undefined, ''), null);
eq('agentIdOf 取 id', agentIdOf({ id: 'abc' }), 'abc');
eq('agentIdOf 无 id ⇒ null', agentIdOf({}), null);
eq('describeAgent 缺 session 不崩', describeAgent({ id: 'z' }).cwd, null);

// 读体上限（正例 + 反例）
{
  const ok = await readJsonBody(fakeReq({ method: 'POST', body: { a: 1 } }), 4096);
  eq('正常 JSON 体可读', ok?.a, 1);
  let threw = null;
  try {
    await readJsonBody(fakeReq({ method: 'POST', body: 'x'.repeat(5000) }), 1024);
  } catch (error) {
    threw = error;
  }
  eq('超限体 ⇒ 413', threw?.statusCode, 413);
}

// ── ⑥ 待续记录的生死（设计口径：记录只在"还用得上"时存在）─────────────────

const {
  claimPending, clearPending, createShutdownHooks, hooksView, interruptedCount,
  loadPendingForBoot, readRecord, runHookPhase, SERVICE_NAME, HOOK_ERROR_CODE, writePending,
} = mod.__test;

/** 直接往插件私有目录写一份记录（模拟"上一次用插件关闭"的产物）。 */
function writeRecordFile(record) {
  mkdirSync(join(SANDBOX, 'storages', 'safely-quit'), { recursive: true });
  writeFileSync(pendingFile(), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** 一份"标准"的记录：计划内关闭 + 1 个在跑 + 还没交给过界面。 */
function bootRecord(overrides = {}) {
  return {
    version: 2,
    reason: 'user-requested',
    closedAt: '2026-10-07T01:02:03.004Z',
    hostPid: 1234,
    deliveredAt: null,
    deliveredBy: null,
    sessions: [
      { sessionId: 'r1', cwd: 'D:\\a', title: '甲', statusAtClose: 'running', stop: { kind: 'step-boundary', at: 'x', droppedInputs: 0 } },
      { sessionId: 'i2', cwd: 'D:\\b', title: '乙', statusAtClose: 'idle', stop: { kind: 'already-idle', at: 'x', droppedInputs: 0 } },
    ],
    ...overrides,
  };
}

// 写出来的记录是 v2，且**交付标记一开始是空的**（只有客户端认领才写）
{
  rmSync(pendingFile(), { force: true });
  const session = createSession();
  session.snapshot = [{ sessionId: 's1', cwd: null, title: null, status: 'running' }];
  const written = writePending(session, 'user-requested');
  eq('记录版本升到 2', written.version, 2);
  eq('刚写下的记录还没交付（deliveredAt 空）', written.deliveredAt, null);
  eq('刚写下的记录还没交付（deliveredBy 空）', written.deliveredBy, null);
  eq('落盘的记录带 stop.kind（登记没丢）', readRecord().sessions[0].stop.kind, 'step-boundary');
}

// 开机读数：五条通路（正例 + 四条回收的反例）
{
  rmSync(pendingFile(), { force: true });
  eq('没有记录 ⇒ available:false 且不报回收', JSON.stringify(loadPendingForBoot()), '{"available":false}');
}
{
  writeRecordFile(bootRecord());
  const read = loadPendingForBoot('run-A');
  eq('★ 计划内关闭 + 有被打断的会话 + 没交付过 ⇒ 可以提示', read.available, true);
  eq('本次还没交付 ⇒ delivered:false（客户端据此决定弹不弹）', read.delivered, false);
  eq('记录里的会话原样带出去', read.pending.sessions.length, 2);
  eq('读一次不会把记录删掉（"读"与"回收"分得清）', existsSync(pendingFile()), true);
}
{
  // 同一趟运行里认领过 ⇒ 刷新页面（F5）仍然可以显示
  writeRecordFile(bootRecord());
  const claimed = claimPending('2026-10-07T01:02:03.004Z');
  eq('认领成功', `${claimed.ok}|${claimed.stamped}`, 'true|true');
  eq('认领写下了交付时刻', typeof readRecord().deliveredAt, 'string');
  eq('认领写下的是本次运行标识', readRecord().deliveredBy, mod.__test.RUN_ID);
  const again = claimPending('2026-10-07T01:02:03.004Z');
  eq('同一趟重复认领是幂等的（already）', `${again.ok}|${again.already}`, 'true|true');
  eq('★ 本次运行里 F5 仍然算"该显示"', loadPendingForBoot(mod.__test.RUN_ID).available, true);
  eq('本次运行里 F5 带上 delivered:true（界面据此知道已经认领过）', loadPendingForBoot(mod.__test.RUN_ID).delivered, true);
}
{
  // ★★ 用户报的那个 bug：上一次已经交给过界面，而这一次 DSH 不是用插件关的 ⇒ 下次开机不该再看到
  writeRecordFile(bootRecord());
  claimPending('2026-10-07T01:02:03.004Z');
  const later = loadPendingForBoot('run-B');
  eq('★★ 更晚的一次开机读到"已交付"的记录 ⇒ 不提示', later.available, false);
  eq('★★ 并且如实报出回收原因', `${later.reaped}|${later.why}`, 'true|stale');
  eq('★★ 过时记录当场从盘上清掉（不是留着下次再判）', existsSync(pendingFile()), false);
}
{
  writeRecordFile(bootRecord({ reason: 'dry-run' }));
  const read = loadPendingForBoot('run-C');
  eq('演练记录不作为待续提示（规格 §5：只有用户点的关闭才提示）', read.available, false);
  eq('演练记录被回收', `${read.reaped}|${read.why}`, 'true|not-intentional');
  eq('回收原因里带上是哪种 reason', read.reason, 'dry-run');
  eq('演练记录也从盘上清掉', existsSync(pendingFile()), false);
}
{
  writeRecordFile(bootRecord({ sessions: [{ sessionId: 'i1', statusAtClose: 'idle' }] }));
  const read = loadPendingForBoot('run-D');
  eq('★ 记录里只有空闲会话 ⇒ 照样交给界面（开机给人一个回到现场的入口）', read.available, true);
  eq('空闲会话的记录不再按"有没有在跑的"回收', `${read.reaped ?? false}|${read.why ?? 'none'}`, 'false|none');
  eq('记录留着（界面关掉卡片才清）', existsSync(pendingFile()), true);
  eq('interruptedCount 只数在跑的', interruptedCount({ sessions: [{ statusAtClose: 'running' }, { statusAtClose: 'idle' }] }), 1);
  eq('interruptedCount 形状不对 ⇒ 0（不抛）', interruptedCount(null), 0);
}
{
  writeRecordFile(bootRecord({ sessions: [] }));
  const read = loadPendingForBoot('run-D0');
  eq('★ 记录里一个会话都没有 ⇒ 没有可列的行，不提示', read.available, false);
  eq('这种"空记录"的回收原因仍是 empty', `${read.reaped}|${read.why}`, 'true|empty');
  eq('空记录从盘上清掉', existsSync(pendingFile()), false);
}
{
  mkdirSync(join(SANDBOX, 'storages', 'safely-quit'), { recursive: true });
  writeFileSync(pendingFile(), '{ 这不是 JSON', 'utf8');
  const read = loadPendingForBoot('run-E');
  eq('坏记录 ⇒ 不提示', read.available, false);
  eq('坏记录被回收（读不动的记录没有用处）', `${read.reaped}|${read.why}`, 'true|unreadable');
  eq('坏记录从盘上清掉', existsSync(pendingFile()), false);
}
{
  rmSync(pendingFile(), { force: true });
  eq('没有记录时认领 ⇒ 如实拒绝', JSON.stringify(claimPending('ts')), '{"ok":false,"why":"no-record"}');
  eq('没有记录时清空 ⇒ 幂等成功（不报错）', JSON.stringify(clearPending('ts')), '{"ok":true,"cleared":false,"why":"no-record"}');
}
{
  writeRecordFile(bootRecord());
  const wrong = claimPending('别的时刻');
  eq('认领时时间戳对不上 ⇒ 拒绝（不认领别的关闭留下的记录）', `${wrong.ok}|${wrong.why}`, 'false|closedAt-mismatch');
  eq('时间戳对不上时不动文件', readRecord().deliveredBy, null);
  eq('认领时没给时间戳 ⇒ 同样拒绝', claimPending(undefined).ok, false);
}
{
  // ★ 设计口径："如果用户关闭了面板，那么继续会话的记录自动清空"
  writeRecordFile(bootRecord());
  const cleared = clearPending('2026-10-07T01:02:03.004Z');
  eq('关掉面板 ⇒ 清空成功', `${cleared.ok}|${cleared.cleared}`, 'true|true');
  eq('★ 清空后文件真的没了（"记录中没有内容，开机就不显示"由此成立）', existsSync(pendingFile()), false);
  eq('清空后再开机读 ⇒ 什么都不提示', loadPendingForBoot('run-F').available, false);
  eq('清空是幂等的（第二次仍 ok）', clearPending('2026-10-07T01:02:03.004Z').ok, true);
}
{
  // 保险丝：客户端看到的旧记录不许误删"新的一次关闭刚存的那份"
  writeRecordFile(bootRecord({ closedAt: '新的时刻' }));
  const stale = clearPending('旧时刻');
  eq('清空时时间戳对不上 ⇒ 拒绝', `${stale.ok}|${stale.why}`, 'false|closedAt-mismatch');
  eq('拒绝后新记录还在盘上', readRecord().closedAt, '新的时刻');
  rmSync(pendingFile(), { force: true });
}

// ── ⑦ 关机拓展：注册表与执行器（内核直测）─────────────────────────────────────

eq('服务名是对外承诺的那个（消费者 ctx.inject 用）', SERVICE_NAME, 'safelyQuit');
{
  const events = [];
  const hooks = createShutdownHooks({ now: () => Date.now(), log: () => {} });
  const a = hooks.onShutdown(async () => { events.push('a'); }, { id: 'x/late', order: 10 });
  hooks.onShutdown(async () => { events.push('b'); }, { id: 'x/early', order: -5 });
  eq('注册表能读出来', hooks.list().length, 2);
  eq('登记时状态是 pending', hooks.list()[0].status, 'pending');
  const run = await hooks.run({ reason: 'test' });
  eq('执行顺序按 order（早的在前）', events.join(','), 'b,a');
  eq('执行账：条数', run.total, 2);
  eq('执行账：没有失败', run.failed, 0);
  eq('执行账：原因带出去', run.reason, 'test');
  eq('执行账：逐条都记了', run.results.map((row) => row.status).join(','), 'done,done');
  const second = await hooks.run({ reason: 'test-again' });
  eq('★ 同一进程里一条钩子至多跑一次（第二次全部跳过）', second.results.map((row) => row.why).join(','), '已经执行过,已经执行过');
  eq('第二次没有真的再跑一遍（副作用只发生一次）', events.join(','), 'b,a');
  a();
  eq('摘除器摘掉了那一条', hooks.list().length, 1);
  a();
  eq('摘除器是幂等的', hooks.list().length, 1);
  eq('off 按 id 摘除', `${hooks.off('x/early')}|${hooks.off('x/early')}`, 'true|false');
}
{
  // 同 id 再登记 = 替换（热重载友好），不是重复堆叠
  const hooks = createShutdownHooks({ log: () => {} });
  let hits = 0;
  hooks.onShutdown(() => { hits += 1; }, { id: 'dup' });
  hooks.onShutdown(() => { hits += 100; }, { id: 'dup' });
  eq('同 id 再登记是替换（注册表只有一条）', hooks.list().length, 1);
  await hooks.run({});
  eq('跑的是**后登记的那一条**', hits, 100);
}
{
  // 超时 + 抛错：都只算在它自己头上，后面的照跑
  const hooks = createShutdownHooks({ log: () => {} });
  const events = [];
  hooks.onShutdown(() => new Promise(() => {}), { id: 'hang', order: 0, timeoutMs: 40 });
  hooks.onShutdown(() => { throw new Error('炸了'); }, { id: 'boom', order: 1 });
  hooks.onShutdown(async () => { events.push('later'); }, { id: 'later', order: 2 });
  const run = await hooks.run({ reason: 'test', budgetMs: 2000 });
  const byId = Object.fromEntries(run.results.map((row) => [row.id, row]));
  eq('超时的那条记 failed', byId.hang.status, 'failed');
  check('超时原因写清楚', String(byId.hang.error).includes('超时'), byId.hang.error);
  eq('抛错的那条记 failed', byId.boom.status, 'failed');
  eq('抛错原因原样带出', byId.boom.error, '炸了');
  eq('★ 前面失败不影响后面那条照跑', events.join(','), 'later');
  eq('这一趟的失败计数', run.failed, 2);
}
{
  // 总预算用尽：后面的跳过（并如实说为什么）
  const hooks = createShutdownHooks({ log: () => {} });
  hooks.onShutdown(() => new Promise(() => {}), { id: 'slow', order: 0, timeoutMs: 5000 });
  hooks.onShutdown(async () => {}, { id: 'never', order: 1 });
  const run = await hooks.run({ reason: 'test', budgetMs: 60 });
  const byId = Object.fromEntries(run.results.map((row) => [row.id, row]));
  eq('超预算时第一条被限时（不是各跑各的 5000ms）', byId.slow.status, 'failed');
  eq('预算用尽后后面的跳过', byId.never.status, 'skipped');
  eq('并如实报出预算用尽', run.exhausted, true);
}
{
  // 命令式钩子：注入假 spawn，验接线（真进程那条在下面单独跑一次）
  const spawned = [];
  const childListeners = new Map();
  const fakeSpawn = (command, args, options) => {
    spawned.push({ command, args, options });
    const child = {
      pid: 4242,
      killed: false,
      stdout: { on: (type, fn) => childListeners.set(`stdout:${type}`, fn) },
      stderr: { on: (type, fn) => childListeners.set(`stderr:${type}`, fn) },
      on: (type, fn) => childListeners.set(type, fn),
      kill() { this.killed = true; },
    };
    queueMicrotask(() => {
      childListeners.get('stdout:data')?.('hello');
      childListeners.get('stderr:data')?.('warn');
      childListeners.get('close')?.(0, null);
    });
    return child;
  };
  const hooks = createShutdownHooks({ spawn: fakeSpawn, killTree: () => {}, log: () => {} });
  hooks.onShutdown({ command: 'node', args: ['x.mjs'], cwd: 'D:\\proj', env: { A: '1' } }, { id: 'cmd' });
  const run = await hooks.run({ reason: 'test' });
  eq('命令被真的交给 spawn', spawned[0]?.command, 'node');
  eq('参数原样传', spawned[0]?.args.join(','), 'x.mjs');
  eq('cwd 传下去', spawned[0]?.options.cwd, 'D:\\proj');
  eq('env 与进程环境合并（不是覆盖整份）', `${spawned[0]?.options.env.A}|${Object.keys(spawned[0]?.options.env ?? {}).length > 1}`, '1|true');
  eq('默认不经 shell（注入面显式可选）', spawned[0]?.options.shell, false);
  eq('退出码 0 ⇒ done', run.results[0]?.status, 'done');
  const cmdView = hooks.list().find((item) => item.id === 'cmd');
  eq('命令的 stdout 被记下来（排障用）', cmdView?.output?.stdout, 'hello');
  eq('命令的 stderr 也记下来', cmdView?.output?.stderr, 'warn');
}
{
  // 命令非 0 退出 ⇒ failed（且如实报退出码）
  const fakeSpawn = (command, args, options) => {
    void command; void args; void options;
    const listeners = new Map();
    const child = {
      pid: 1,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (type, fn) => listeners.set(type, fn),
      kill: () => {},
    };
    queueMicrotask(() => listeners.get('close')?.(3, null));
    return child;
  };
  const hooks = createShutdownHooks({ spawn: fakeSpawn, killTree: () => {}, log: () => {} });
  hooks.onShutdown({ command: 'false' }, { id: 'bad' });
  const run = await hooks.run({});
  eq('非 0 退出 ⇒ failed', run.results[0]?.status, 'failed');
  check('失败原因报出退出码', String(run.results[0]?.error).includes('3'), run.results[0]?.error);
}
{
  // 命令超时 ⇒ 杀掉 + 记 failed（不把宿主/测试挂住）
  let killed = 0;
  const fakeSpawn = () => ({
    pid: 9,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => { killed += 1; },
  });
  const hooks = createShutdownHooks({ spawn: fakeSpawn, killTree: () => {}, log: () => {} });
  hooks.onShutdown({ command: 'sleep' }, { id: 'slow-cmd', timeoutMs: 40 });
  const run = await hooks.run({ budgetMs: 1000 });
  eq('超时的命令记 failed', run.results[0]?.status, 'failed');
  eq('超时的命令被 kill 掉', killed, 1);
}
{
  // 真跑一条命令（本文件唯一一处起子进程：验"注入的 spawn 默认就是真的 node:child_process"）
  const hooks = createShutdownHooks({ log: () => {}, killTree: () => {} });
  hooks.onShutdown({ command: process.execPath, args: ['-e', 'process.stdout.write("真跑通了")'] }, { id: 'real', timeoutMs: 15000 });
  const run = await hooks.run({ budgetMs: 20000 });
  eq('真命令退出码 0 ⇒ done', run.results[0]?.status, 'done');
}
{
  // 登记参数不合法 ⇒ 响亮报错（静默收下一条永不执行的钩子比报错更坏）
  const hooks = createShutdownHooks({ log: () => {} });
  let threw = null;
  try {
    hooks.onShutdown(null);
  } catch (error) {
    threw = error;
  }
  eq('空动作 ⇒ 抛错', threw?.code, HOOK_ERROR_CODE);
  let threw2 = null;
  try {
    hooks.onShutdown({ command: '   ' });
  } catch (error) {
    threw2 = error;
  }
  eq('空命令 ⇒ 抛错', threw2?.code, HOOK_ERROR_CODE);
  eq('登记失败不留残渣（注册表仍是空的）', hooks.list().length, 0);
  eq('也支持 {run: fn} 这种写法', typeof hooks.onShutdown({ run: async () => {} }, { id: 'r' }), 'function');
}

// ── ⑧ 关闭流程里的关机拓展：位置（交棒之前）+ dryRun 不跑 + 进度可读 ────────────

{
  const order = [];
  const hooks = createShutdownHooks({ log: () => {} });
  hooks.onShutdown(async () => { order.push('hook'); }, { id: 'h1' });
  const agent = fakeAgent('s-20', 'running');
  const ctx = fakeCtx(rows([agent]));
  const session = createSession({ hooks, budgets: { hookBudgetMs: 2000, disposeBudgetMs: 200 } });
  await withHandoffProbe(async (probe) => {
    setTimeout(() => { agent.status = 'idle'; }, 20);
    await beginClose(platformCtx(ctx, probe), session, { dryRun: false });
    eq('关了宿主（平台的 appExit 被调用）', probe.appExitCalls.length, 1);
    order.push('handoff');
  });
  eq('★ 关机拓展在交棒之前跑完（顺序：hook → handoff）', order.join(','), 'hook,handoff');
  eq('这一趟的原因写的是用户点的关闭', session.hookRun?.reason, 'user-requested');
  eq('阶段走完标记成 done', session.hookPhase, 'done');
  const view = publicState(session).hooks;
  eq('状态里能看到这一条的存在', view.total, 1);
  eq('状态里能看到它跑完了', `${view.finished}|${view.failed}`, '1|0');
  eq('hooksView 是给界面的只读视图', Array.isArray(view.entries), true);
}
{
  const order = [];
  const hooks = createShutdownHooks({ log: () => {} });
  hooks.onShutdown(async () => { order.push('hook'); }, { id: 'h2' });
  const session = createSession({ hooks, budgets: { hookBudgetMs: 1000 } });
  await withHandoffProbe(async (probe) => {
    await beginClose(platformCtx(fakeCtx(rows([fakeAgent('s-21', 'idle')])), probe), session, { dryRun: true });
    eq('演练不关宿主', handoffDelivered(probe), false);
  });
  eq('★ 演练绝不执行外部的关机动作', order.length, 0);
  eq('演练里关机拓展阶段没被标记成跑过', session.hookPhase, 'idle');
}
{
  // dispose 兜底那一趟：跑过的不重复，没跑过的补上、且预算短
  const events = [];
  const hooks = createShutdownHooks({ log: () => {} });
  hooks.onShutdown(async () => { events.push('first'); }, { id: 'f1', order: 0 });
  hooks.onShutdown(async () => { events.push('second'); }, { id: 'f2', order: 1 });
  const session = createSession({ hooks, budgets: { hookBudgetMs: 1000, disposeBudgetMs: 200 } });
  await runHookPhase(session, 'user-requested');
  eq('主动那趟两条都跑了', events.join(','), 'first,second');
  hooks.onShutdown(async () => { events.push('third'); }, { id: 'f3', order: 2 });
  await runHookPhase(session, 'host-exit', 200);
  eq('★ 兜底那趟只补没跑过的（不重复执行）', events.join(','), 'first,second,third');
  eq('兜底那趟用的是短预算', session.hookRun?.budgetMs, 200);
  eq('没有注册表时这一步直接返回 null（不抛）', await runHookPhase(createSession(), 'host-exit'), null);
}

// ── ⑨ 路由：记录的三条通路 ────────────────────────────────────────────────────

{
  rmSync(pendingFile(), { force: true });
  const noRecordSession = createSession();
  const read = fakeRes();
  await handleRoute({}, noRecordSession, fakeReq({ url: '/api/dsh-safely-quit/last-pending', headers: loopbackHeaders }), read);
  eq('没有记录 ⇒ /last-pending 说没有', read.json()?.available, false);
  // 裁决留痕：记录被回收后盘上就没证据了，「为什么没提示」只能靠这一份读数（对外读数 lastPending）
  eq('开机裁决留痕：这一次的结论进 /state', publicState(noRecordSession).lastPending?.available, false);
  eq('裁决留痕带上"这次哪种情形"（没有记录 ⇒ why 为空、reaped 不是真的）',
    `${publicState(noRecordSession).lastPending?.why}|${publicState(noRecordSession).lastPending?.reaped}`, 'null|false');

  writeRecordFile(bootRecord());
  const okSession = createSession();
  const ok = fakeRes();
  await handleRoute({}, okSession, fakeReq({ url: '/api/dsh-safely-quit/last-pending', headers: loopbackHeaders }), ok);
  eq('/last-pending 拿到记录', ok.json()?.pending?.sessions?.length, 2);
  eq('裁决留痕：提示过 ⇒ available 真', publicState(okSession).lastPending?.available, true);
  eq('裁决留痕：带上"那一刻在跑"的条数（人一眼看得出卡片会不会弹）', publicState(okSession).lastPending?.interrupted, 1);
  eq('裁决留痕：带上这一份记录的 closedAt（好和盘上/界面上的那一份对上）',
    publicState(okSession).lastPending?.closedAt, '2026-10-07T01:02:03.004Z');

  const diag = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ url: '/api/dsh-safely-quit/pending', headers: loopbackHeaders }), diag);
  eq('GET /pending 是只读诊断（不回收）', `${diag.json()?.available}|${existsSync(pendingFile())}`, 'true|true');
  eq('诊断面报出"那一刻在跑"的条数', diag.json()?.interrupted, 1);

  const claimed = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/pending/claim', headers: loopbackHeaders, body: { closedAt: '2026-10-07T01:02:03.004Z' } }), claimed);
  eq('POST /pending/claim ⇒ 200 且认领成功', `${claimed.statusCode}|${claimed.json()?.stamped}`, '200|true');

  const crossSite = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/pending/clear', headers: { host: '127.0.0.1:3080' }, body: { closedAt: '2026-10-07T01:02:03.004Z' } }), crossSite);
  eq('清空记录也要过同源门（写请求）', crossSite.statusCode, 403);
  eq('被门挡住时记录还在', existsSync(pendingFile()), true);

  const cleared = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/pending/clear', headers: loopbackHeaders, body: { closedAt: '2026-10-07T01:02:03.004Z' } }), cleared);
  eq('POST /pending/clear ⇒ 200 且真的清掉了', `${cleared.statusCode}|${cleared.json()?.cleared}|${existsSync(pendingFile())}`, '200|true|false');

  const mismatch = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/pending/claim', headers: loopbackHeaders, body: { closedAt: '对不上' } }), mismatch);
  eq('时间戳对不上 ⇒ 409（不让界面认领别的记录）', mismatch.statusCode, 409);

  // 回收那一档的裁决留痕：记录被回收后盘上就没证据了，「为什么没提示」只剩这一份读数
  const staleSession = createSession();
  writeRecordFile({ ...bootRecord(), deliveredBy: 'another-run', deliveredAt: '2026-10-07T01:02:04.000Z' });
  const stale = fakeRes();
  await handleRoute({}, staleSession, fakeReq({ url: '/api/dsh-safely-quit/last-pending', headers: loopbackHeaders }), stale);
  eq('过期记录被回收', stale.json()?.available, false);
  eq('裁决留痕：回收原因（why=stale）留在对外读数里', publicState(staleSession).lastPending?.why, 'stale');
  eq('裁决留痕：回收也算一次真实裁决（reaped 真）', publicState(staleSession).lastPending?.reaped, true);
  eq('裁决留痕：回收后盘上确实没有记录了', existsSync(pendingFile()), false);
}

// ── ⑩ 回归判据（逐条真跑）─────────────────────────────────────────────────────

const {
  refreshStopSet, safeBookkeeping, writeJson, writeMarker, readPackageVersion,
  PLUGIN_VERSION, ROUTE_PATH, dshHome, provideService, createServiceFace,
  positiveOf, DEFAULT_HOOK_BUDGET_MS, HANDOFF_FALLBACK_MS, HANDOFF_NO_HANDLER_MS,
} = mod.__test;
const { resolveKillTree } = await import('../lib/shutdown-hooks.js');

/** 造一个"看起来像目录其实是文件"的路径，用来让 mkdirSync 抛 ENOTDIR。 */
const BLOCKER = join(SANDBOX, 'blocker-not-a-dir');
writeFileSync(BLOCKER, 'x', 'utf8');

// 版本只有一个真源（包元数据），对外读数与它同值
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  eq('★ 模块读到的版本 = 包元数据里的版本（唯一真源）', PLUGIN_VERSION, pkg.version);
  eq('同一个函数读出来的也是它（不是另抄一份常量）', readPackageVersion(), pkg.version);
  eq('对外读数 /state 带上同一个版本', publicState(createSession()).version, pkg.version);
  eq('路由前缀常量就是对外承诺的那一个（客户端与装置据此对齐）', ROUTE_PATH, '/api/dsh-safely-quit');
}

// 两条并发 /close 只能受理一条，且只起一套编排
{
  const agent = fakeAgent('c-1', 'idle');
  const ctx = fakeCtx(rows([agent]));
  const session = createSession();
  await withHandoffProbe(async (probe) => {
    const resA = fakeRes();
    const resB = fakeRes();
    await Promise.all([
      handleRoute(platformCtx(ctx, probe), session, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: { confirm: true } }), resA),
      handleRoute(platformCtx(ctx, probe), session, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: { confirm: true } }), resB),
    ]);
    const rejected = resA.statusCode === 409 ? resA : resB;
    eq('★ 并发两条 /close：一条 202、一条 409（不是两条都受理）', [resA.statusCode, resB.statusCode].sort().join(','), '202,409');
    const rejectedBody = rejected.json();
    check('★ 被拒的那条带着原因与当前状态回去（不是静默丢弃）',
      typeof rejectedBody?.error === 'string' && rejectedBody.error !== '' && typeof rejectedBody?.state?.stage === 'string',
      JSON.stringify(rejectedBody));
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 80); });
    eq('★ 只交棒一次（没有两套编排）', probe.appExitCalls.length, 1);
    eq('★ 也没有用进程级强杀', probe.killCalls.length, 0);
  });
  eq('被受理的那条走完到 done', session.stage, 'done');
}

// 内核侧：同一时刻的两趟 run() 合成一趟，钩子函数体绝不跑两遍
{
  const hooks = createShutdownHooks({ log: () => {} });
  let hits = 0;
  hooks.onShutdown(async () => {
    hits += 1;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
  }, { id: 'once' });
  const [first, second] = await Promise.all([hooks.run({ reason: 'a' }), hooks.run({ reason: 'b' })]);
  eq('★ 并发两趟是同一趟（复用同一次执行账）', first, second);
  eq('★ 钩子函数体只执行了一次', hits, 1);
  eq('这一趟的条数就是 1（没有第二趟）', first.total, 1);
}

// 清单写不动时，关闭照走（交棒一定发生），失败只进账
{
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(BLOCKER, 'sub'); // mkdirSync ⇒ ENOTDIR
  const session = createSession();
  try {
    await withHandoffProbe(async (probe) => {
      await beginClose(platformCtx(fakeCtx(rows([fakeAgent('b-1', 'idle')])), probe), session, { dryRun: false });
      eq('★ 落盘失败也照样交棒（用户点的是"关闭"）', probe.appExitCalls.length, 1);
      eq('★ 并且没有退化成进程级强杀', probe.killCalls.length, 0);
    });
    eq('★ done 的含义是"已经把关闭交出去"（这一步确实交出去了）', session.stage, 'done');
    check('落盘失败进了账（不是静默吞掉）', session.bookkeepingErrors.length > 0, JSON.stringify(session.bookkeepingErrors));
    check('对外读数能看到这笔账', publicState(session).bookkeepingErrors.length > 0);
    check('失败原因里有具体错（ENOTDIR）', String(session.lastError).includes('ENOTDIR'), session.lastError);
  } finally {
    process.env.DSH_HOME = previousHome;
  }
}

// 编排在交棒之前就坏了 ⇒ 如实报 failed（绝不假装 done）
{
  const session = createSession();
  const brokenCtx = {
    agents: {
      list: () => { throw new Error('注册表读不动'); },
      get: () => undefined,
    },
  };
  await withHandoffProbe(async (probe) => {
    await beginClose(platformCtx(brokenCtx, probe), session, { dryRun: false });
    eq('编排中断 ⇒ 连交棒都没走到（不调 appExit、也不发信号）', handoffDelivered(probe), false);
    eq('编排中断 ⇒ 也绝不碰 process.kill', probe.killCalls.length, 0);
  });
  eq('★ 编排中断 ⇒ stage=failed', session.stage, 'failed');
  eq('★ 对外读数里失败可分辨（界面据此显示「重试」）', publicState(session).failed, true);
  {
    const res = fakeRes();
    await handleRoute({}, session, fakeReq({ url: '/api/dsh-safely-quit/state', headers: { host: '127.0.0.1:3080' } }), res);
    eq('★ 路由层面拿到的也是真实读数（stage=failed / failed=true）', `${res.json()?.stage}|${res.json()?.failed}`, 'failed|true');
  }
  check('失败原因带出去', String(publicState(session).lastError).includes('注册表读不动'), publicState(session).lastError);
}

// 演练不占这一次进程的关闭名额 —— 演练之后真关闭仍然受理
{
  const session = createSession();
  const dry = fakeRes();
  await handleRoute(fakeCtx(rows([fakeAgent('d-1', 'running')])), session,
    fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: { dryRun: true } }), dry);
  eq('演练受理 ⇒ 202', dry.statusCode, 202);
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
  eq('演练跑完到 done', session.stage, 'done');
  const idle = fakeAgent('d-2', 'idle');
  await withHandoffProbe(async (probe) => {
    const real = fakeRes();
    await handleRoute(platformCtx(fakeCtx(rows([idle])), probe), session,
      fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: { confirm: true } }), real);
    eq('★ 演练之后真关闭仍受理（旧实现会 409 把主功能锁死）', real.statusCode, 202);
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 80); });
    eq('★ 而且真的把关闭交出去了（appExit 被调用）', probe.appExitCalls.length, 1);
    eq('★ 且没有用进程级强杀', probe.killCalls.length, 0);
  });
  eq('真关闭的读数：done 且 dryRun 已翻回 false', `${session.stage}|${session.dryRun}`, 'done|false');
}

// 等待窗口内新变忙的会话要被拦、要进清单
{
  const busy = fakeAgent('n-1', 'running');
  const idle = fakeAgent('n-2', 'idle');
  const ctx = fakeCtx(rows([busy], [idle]));
  const session = createSession();
  session.stage = 'waiting';
  session.stopIds.add('n-1');
  session.snapshot = [describeAgent(busy), describeAgent(idle)];
  idle.status = 'running'; // 关闭等待期间，用户往这个空闲会话里发了消息（它就变忙了）
  eq('刷新把新变忙的补进停止集合', refreshStopSet(ctx, session), 1);
  eq('它进了 stopIds', session.stopIds.has('n-2'), true);
  eq('它的清单行改成 running（开机要提示续跑）', session.snapshot.find((row) => row.sessionId === 'n-2').status, 'running');
  eq('★ 它的下一步会被拦住', decidePreStep(session, { agent: idle, messages: [{ id: 'u1' }] }, passthrough).kind, 'reject');
  eq('拦下来的输入进了 dropped 账', session.dropped.get('n-2'), 1);
  eq('没有新变忙的 ⇒ 刷新是空操作（不重复计数）', refreshStopSet(ctx, session), 0);
  const dry = createSession();
  dry.stage = 'waiting';
  dry.dryRun = true;
  eq('演练期间不下停止令（刷新直接让路）', refreshStopSet(ctx, dry), 0);
}

// DSH_HOME 的口径与平台一致（纯空白 = 没设；相对路径 ⇒ 绝对路径）
{
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '   ';
    eq('★ 纯空白 ⇒ 当作没设（不会落到一个叫空格的文件夹）', dshHome(), join(homedir(), '.dsh'));
    process.env.DSH_HOME = '.';
    eq('★ 相对路径 ⇒ 返回绝对路径（与平台同口径）', dshHome(), resolve('.'));
    process.env.DSH_HOME = SANDBOX;
    eq('正常值 ⇒ 原样（去掉首尾空白后解析）', dshHome(), resolve(SANDBOX));
  } finally {
    process.env.DSH_HOME = previousHome;
  }
}

// provide 的返回值是 Disposable 对象（它本身就是 fiber effect）⇒ 再包一层 ctx.effect 是永远走不到的死码
{
  const effects = [];
  let provided = 0;
  const ctx = {
    provide: () => { provided += 1; return { dispose: () => {} }; },
    effect: (fn) => { effects.push(fn); },
  };
  eq('服务挂上了', provideService(ctx, createServiceFace(createSession())), true);
  eq('provide 被调用一次', provided, 1);
  eq('★ 不再注册走不到的死码 effect（provide 本身即 fiber effect）', effects.length, 0);
}

// 关机拓展总预算只有一处定义（宿主半从内核取；两处各写一个 30000 迟早漂开）
{
  eq('★ 宿主半的缺省预算 = 内核导出的那一份', DEFAULT_HOOK_BUDGET_MS, createShutdownHooks({ log: () => {} }).defaultBudgetMs);
}

// 数值兜底与落盘辅助各只有一份实现
{
  eq('数值兜底：正数留下并取整', positiveOf(12.7, 5), 12);
  eq('数值兜底：0 / 负数 / NaN / 字符串 ⇒ 缺省',
    [positiveOf(0, 5), positiveOf(-1, 5), positiveOf(Number.NaN, 5), positiveOf('9', 5)].join(','), '5,5,5,5');
  const file = join(SANDBOX, 'helpers', 'deep', 'sample.json');
  writeJson(file, { a: 1 });
  eq('落盘辅助：写出的是 2 空格缩进 + 换行结尾的 JSON', readFileSync(file, 'utf8'), `${JSON.stringify({ a: 1 }, null, 2)}\n`);
  let threw = null;
  try {
    writeJson(join(BLOCKER, 'sub', 'x.json'), {});
  } catch (error) {
    threw = error;
  }
  check('落盘辅助：写不动就抛（由调用方决定怎么处置）', threw !== null);
  const session = createSession();
  session.snapshot = [{ sessionId: 'm-1', cwd: null, title: null, status: 'running' }];
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = SANDBOX;
  try {
    writeMarker(session, 'user-requested');
    eq('关闭标记落盘形状没变（reason 还在）', JSON.parse(readFileSync(markerFile(), 'utf8')).reason, 'user-requested');
  } finally {
    process.env.DSH_HOME = previousHome;
    rmSync(markerFile(), { force: true });
  }
}

// 注入假 spawn 而未注入 killTree ⇒ 缺省不杀树（离线场景不该真去 taskkill）
{
  const absent = resolveKillTree({});
  const injected = resolveKillTree({ spawn: () => {} });
  const explicit = resolveKillTree({ spawn: () => {}, killTree: () => {} });
  check('★ 注入了假 spawn ⇒ 缺省杀树是空操作（不是真的 taskkill）', injected !== absent);
  check('显式注入的 killTree 优先于缺省', explicit !== injected);
}

// 注入的 killTree 抛错不许逃出定时器回调（逃出去＝未捕获异常，正在关闭的宿主会死）
{
  let treeKills = 0;
  const fakeSpawn = () => ({
    pid: 987654,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  });
  const hooks = createShutdownHooks({
    spawn: fakeSpawn,
    killTree: () => { treeKills += 1; throw new Error('杀树炸了'); },
    log: () => {},
  });
  hooks.onShutdown({ command: 'x' }, { id: 'boom-tree', timeoutMs: 30 });
  const run = await hooks.run({ reason: 'test' });
  eq('超时那趟照样有结果（异常没逃出去）', run.results[0]?.status, 'failed');
  eq('杀树确实被调用过（证明走的正是这条路径）', treeKills, 1);
}

// 同步 error 之后的超时定时器必须被清掉（不留越界的孤儿定时器去杀进程）
{
  let killed = 0;
  let treeKills = 0;
  const fakeSpawn = () => ({
    pid: 1,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (type, fn) => {
      if (type === 'error') fn(new Error('同步 error'));
    },
    kill: () => { killed += 1; },
  });
  const hooks = createShutdownHooks({ spawn: fakeSpawn, killTree: () => { treeKills += 1; }, log: () => {} });
  hooks.onShutdown({ command: 'x' }, { id: 'sync-error', timeoutMs: 40 });
  const run = await hooks.run({ reason: 'test' });
  eq('同步 error ⇒ failed', run.results[0]?.status, 'failed');
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 90); });
  eq('★ 越过超时线后没人再去杀这个 child（定时器已清）', killed, 0);
  eq('★ 也不再去杀树', treeKills, 0);
}

// 交棒三条路各给读数（注入 emit/schedule/exit ⇒ 瞬间拿到结论，不必真等 10 秒）
{
  const { resignToPlatform } = mod.__test;
  // ① 平台原语在 ⇒ 只用它，不做多余动作
  {
    const appExitArgs = [];
    const emitted = [];
    const runs = resignToPlatform(
      { get: (name) => (name === 'appExit' ? (code) => { appExitArgs.push(code); } : undefined) },
      {
        emit: (name) => { emitted.push(name); return true; },
        schedule: () => ({ unref() {} }),
        exit: () => {},
      },
    );
    eq('★ 有 appExit ⇒ 走平台原语（不自己造信号）', runs.via, 'appExit');
    eq('★ 交给平台的是正常退出码 0', appExitArgs.join(','), '0');
    eq('★ 有 appExit 时不再多发一次信号事件', emitted.length, 0);
    eq('兜底时长 = HANDOFF_FALLBACK_MS（给平台那条路留足）', runs.fallbackMs, HANDOFF_FALLBACK_MS);
  }
  // ② 拿不到 appExit ⇒ 进程内信号事件，**且真的到达监听者**
  {
    const hits = [];
    const listener = () => { hits.push(1); };
    process.on('SIGTERM', listener);
    try {
      const runs = resignToPlatform({}, { schedule: () => ({ unref() {} }) });
      eq('★ 拿不到 appExit ⇒ 退到进程内信号事件', runs.via, 'emit');
      eq('★★ 监听者真的被回调了（"信号事件到达监听者"的读数）', hits.length, 1);
    } finally {
      process.off('SIGTERM', listener);
    }
  }
  // ③ 谁都没接 ⇒ 有上限的兜底自退，且定时器 unref（不拖住正在退出的进程）
  {
    const timers = [];
    let unrefCalled = 0;
    const exits = [];
    const runs = resignToPlatform({}, {
      emit: () => false,
      schedule: (fn, ms) => { timers.push({ fn, ms }); return { unref: () => { unrefCalled += 1; } }; },
      exit: (code) => exits.push(code),
    });
    eq('★ 没有任何接手方 ⇒ 走兜底自退', runs.via, 'exit');
    eq('★ 兜底时长 = HANDOFF_NO_HANDLER_MS（快退，不干等）', runs.fallbackMs, HANDOFF_NO_HANDLER_MS);
    eq('★ 兜底定时器 unref 过（不拖住正常退出）', unrefCalled, 1);
    eq('兜底没到点 ⇒ 不许提前退', exits.length, 0);
    timers[0].fn();
    eq('★★ 到点仍未退出 ⇒ 兜底真的自退（exit(0)）', exits.join(','), '0');
  }
  // ④ appExit 自己抛错 ⇒ 不许把关闭流程带崩，退到信号事件
  {
    const runs = resignToPlatform(
      { get: (name) => (name === 'appExit' ? () => { throw new Error('appExit 炸了'); } : undefined) },
      { emit: () => true, schedule: () => ({ unref() {} }) },
    );
    eq('★ appExit 抛错 ⇒ 退到信号事件（不抛穿调用方）', runs.via, 'emit');
  }
}

// 编排失败之后**还能再关一次**（若把失败当成"名额已用"、用户点「重试」必吃 409）
{
  rmSync(pendingFile(), { force: true });
  const session = createSession();
  // 失败点要落在"首次清单已落盘之后"：判据用**记录文件在不在**（不用数 list 调了几次 ——
  // 那种写法会被实现里多一次枚举就误伤，而这里要验的是"失败发生在写盘之后"这个事实）。
  const flakyCtx = {
    agents: {
      list: () => {
        if (existsSync(pendingFile())) throw new Error('注册表读不动');
        return [fakeAgent('r-0', 'idle')];
      },
      get: () => undefined,
    },
  };
  const first = fakeRes();
  await handleRoute(flakyCtx, session, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: { confirm: true } }), first);
  eq('第一次受理 ⇒ 202', first.statusCode, 202);
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 80); });
  eq('编排失败 ⇒ stage=failed（读数不撒谎）', session.stage, 'failed');
  check('★ 这一趟写下的待续记录已被标成 close-failed（它并不代表真关过机）',
    readRecord()?.reason === 'close-failed', JSON.stringify(readRecord()));
  eq('★ 于是下一次开机不会拿它当"上次用插件关过机"来提示',
    String(loadPendingForBoot('later-run').available), 'false');
  const second = fakeRes();
  await withHandoffProbe(async (probe) => {
    await handleRoute(platformCtx(fakeCtx(rows([fakeAgent('r-1', 'idle')])), probe), session,
      fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/close', headers: loopbackHeaders, body: { confirm: true } }), second);
    eq('★★ 失败之后仍能再关一次（旧实现：重试必吃 409，入口永久失效）', second.statusCode, 202);
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 80); });
    eq('★★ 而且这一次真的把关闭交出去了', probe.appExitCalls.length, 1);
  });
  eq('第二次的读数：done', session.stage, 'done');
  eq('★ 重新受理时把上一趟的账清干净（stopIds 只剩这一趟的）', [...session.stopIds].join(','), '');
  eq('★ 上一趟的失败账也没被带进来', session.bookkeepingErrors.length, 0);
  eq('上一趟的 lastError 也清了', session.lastError, null);
}

// ── ⑪ 受理段不变量 + 判据缝护栏 ────────────────────────────────────────────────
//
// 受理段的风险不是"漏了一处回落"，而是**提前写阶段**：只要在任一条提前返回之前动过 stage，
// 随后**每一条**提前返回都必须记得把它推回去，漏一条就是一条"这个进程里再也关不掉 DSH"的死路。
// 现在的收敛纪律是：受理段自己一个 stage 都不写（阶段推进全归 beginClose，且它在第一个 await
// 之前同步完成），名额只在 finally 归还 —— 于是"忘了回落"在结构上不可能出现。
// 下面先用**行为面**把整组提前返回逐个驱动，再用**结构面**把两条纪律钉死。
{
  const CLOSE_URL = '/api/dsh-safely-quit/close';
  // 分支组：受理段**每一条**提前返回路径（新增一条就该往这张表里加一行）。
  // 每条都在"从 failed 来"与"从 idle 来"两种起点上各驱动一次 —— 前者就是"上一趟失败了再点一次"那条路。
  const branches = [
    ['confirm:false（合法 JSON 但没确认）', { body: { confirm: false } }, (status) => status === 400],
    ['坏 JSON', { raw: '{ this is not json' }, (status) => status === 400],
    ['空体', { raw: '' }, (status) => status === 400],
    ['超限体（> BODY_MAX_BYTES）', { raw: JSON.stringify({ pad: 'x'.repeat(5000) }) }, (status) => status === 413],
    ['合法 JSON 但不是对象', { raw: '"just a string"' }, (status) => status === 400],
  ];
  await withHandoffProbe(async (probe) => {
    for (const [label, payload, isRejected] of branches) {
      for (const start of ['failed', 'idle']) {
        const session = createSession();
        session.stage = start;
        const reject = fakeRes();
        await handleRoute(platformCtx(fakeCtx([]), probe), session,
          fakeReq({ method: 'POST', url: CLOSE_URL, headers: loopbackHeaders, ...payload }), reject);
        check(`【不变量】${label} · 起点 ${start} ⇒ 被拒（不是 202）`, isRejected(reject.statusCode), `status=${reject.statusCode}`);
        eq(`【不变量】${label} · 起点 ${start} ⇒ 阶段没被推动（不留过渡态）`, session.stage, start);
        const retry = fakeRes();
        await handleRoute(platformCtx(fakeCtx([]), probe), session,
          fakeReq({ method: 'POST', url: CLOSE_URL, headers: loopbackHeaders, body: { confirm: true } }), retry);
        eq(`【不变量】${label} · 起点 ${start} ⇒ 被拒之后仍能再关一次（202）`, retry.statusCode, 202);
        await new Promise((resolvePromise) => { setTimeout(resolvePromise, 0); });
      }
    }
  });
  // 结构面（"以后新增一条提前返回也不会漏"的牙）：两条收敛纪律各只许有一个发生点
  {
    const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
    const from = source.indexOf("sub === '/close'");
    const to = source.indexOf("sub === '/force'");
    const admission = from !== -1 && to > from ? source.slice(from, to) : '';
    check('受理段读得到（结构判据的前提）', admission.length > 0, `len=${admission.length}`);
    const stageWrites = [...admission.matchAll(/session\.stage\s*=(?!=)/g)];
    eq('★ 结构：受理段里 `session.stage` 一个写入点都没有（阶段推进全归 beginClose，提前返回不可能漏回落）',
      stageWrites.length, 0);
    const bodyReadAt = admission.indexOf('readJsonBody(req, BODY_MAX_BYTES)');
    const placeholderAt = admission.indexOf('session.closeAccepted = true');
    check('★★ 结构：占位（closeAccepted=true）在"读请求体"之前 —— 并发那条路本来就是它挡的',
      bodyReadAt !== -1 && placeholderAt !== -1 && placeholderAt < bodyReadAt,
      `placeholder@${placeholderAt}，readJsonBody@${bodyReadAt}`);
    eq('★ 结构：名额归还也只写一处',
      [...admission.matchAll(/session\.closeAccepted\s*=\s*false/g)].length, 1);
    check('★★ 结构：那一处在 `finally` 里（提前返回 / 抛错都自动走它）',
      /finally\s*\{[\s\S]*?session\.closeAccepted\s*=\s*false/.test(admission));
  }
}

// ── ⑪ 判据缝的护栏：生产默认必须是"真退出"，不许长成记数器或可注入替身 ──────────────
//
// `setHandoffExit` 这条缝的存在理由很实在：兜底自退会 `process.exit`，而判据进程绝不能被它杀掉
// （真踩过那一脚：测试在打印结论之前 exit 0，读起来全绿、其实一条都没跑完）。但缝开着就有人
// 能顺着它把**真退出**也缝掉 —— 那样门禁会永久瞎掉。这条护栏钉两件事：默认实现的身份、复位语义。
{
  const { getHandoffExit, defaultHandoffExit, setHandoffExit } = mod.__test;
  check('★ 缝有"换掉 / 读回"两个口，且此刻生效的不是生产默认（本文件开场换成了记数器）',
    getHandoffExit() !== defaultHandoffExit);
  check('★★ 生产默认的实现就是真退出（函数体直接调 process.exit）',
    /process\.exit\s*\(/.test(String(defaultHandoffExit)));
  setHandoffExit(null); // 复位：必须回到"生产默认"，不许回到上一次的替身
  eq('★ 传非函数即复位回生产默认（不是回到上一次的替身）', getHandoffExit(), defaultHandoffExit);
  setHandoffExit((code) => { handoffExits.push(code); }); // 立刻装回记数器，防止后面真退
  check('复位之后仍可换回记数器（缝本身还活着）', getHandoffExit() !== defaultHandoffExit);

  // 结构面：产品半区里"退出这个进程"只许有这一处出口，且它就在默认那条缝的函数体里
  {
    const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
    eq('★ 结构：lib/index.js 里 `process.exit(` 只出现一次（唯一出口）',
      [...source.matchAll(/process\.exit\s*\(/g)].length, 1);
    check('★★ 结构：而且它就在 `defaultHandoffExit` 的函数体里',
      /function defaultHandoffExit\(code\)\s*\{\s*process\.exit\(code\);\s*\}/.test(source));
  }

  // ★★ 效果面：真起一个子进程，**不换缝**走生产默认 —— 它必须真的退出。
  //    子进程里挂一个 ref 的 interval 顶住事件循环：除了"真退出"，没有别的东西能结束它。
  //    若有人把默认实现写成记数器 / 日志器（"看起来退了其实没退"），子进程会一直挂着 ⇒ 本条变红。
  {
    const probeScript = join(SANDBOX, 'handoff-default-probe.mjs');
    const libUrl = new URL('../lib/index.js', import.meta.url).href;
    writeFileSync(probeScript, [
      '// 顶层顶住事件循环：只有"真退出"能结束本进程（兜底的定时器是 unref 的，推不动它）',
      'setInterval(() => {}, 1000);',
      `const mod = await import(${JSON.stringify(libUrl)});`,
      '// 没有 appExit、也没有 SIGTERM 监听者 ⇒ 走 HANDOFF_NO_HANDLER_MS 之后的兜底自退',
      'mod.__test.resignToPlatform({});',
      "process.stdout.write('armed\\n');",
      '',
    ].join('\n'), 'utf8');
    const child = spawnSync(process.execPath, [probeScript], { encoding: 'utf8', timeout: 8000 });
    eq('★★ 走生产默认那条缝的子进程真的退出了（exit 0）', child.status, 0);
    check('★★ 而且它确实是被"真退出"结束的（探针已 armed，不是启动就失败）',
      String(child.stdout ?? '').includes('armed'),
      `stdout=${JSON.stringify(String(child.stdout ?? '').trim())} stderr=${JSON.stringify(String(child.stderr ?? '').trim().slice(0, 200))}`);
  }
}

// ── ⑬ 「继续」= 投一条下一轮消息并唤醒驱动（**不碰目标**，规格 §1.1 的驱动面）──────────────
//    这组判据盯三件事：① 消息的形状（插件来源，不是用户发的）；② 四档结论（接上 / 已在跑 / 不在 / 失败）；
//    ③ 不重复投递（一次点击只投一条）。

/** 造一个"会话已恢复出来"的假 agent：记下 followup 收到的消息。 */
function fakeSessionAgent(id, options) {
  const received = [];
  const agent = {
    id,
    status: options?.status ?? 'idle',
    session: { id },
    received,
    followup(message) {
      if (options?.followupThrows === true) throw new Error('followup boom');
      received.push(message);
    },
  };
  return agent;
}

/** 造一个注入了 sessionController / sessions 的作用域（options.flushed 观察 flush）。 */
function fakeContinueCtx(agents, options) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return {
    sessionController: {
      async resolveAgent(sessionId) {
        if (options?.resolveThrows === true) throw new Error('resolve boom');
        if (options?.notFound?.includes(sessionId)) return { error: { code: 'session/not-found' } };
        if (options?.writerHeld?.includes(sessionId)) return { error: { code: 'session/writer-held' } };
        const agent = byId.get(sessionId);
        return agent === undefined ? { error: { code: 'session/not-found' } } : { agent };
      },
    },
    sessions: {
      async flush(session) {
        if (options?.flushThrows === true) throw new Error('flush boom');
        options?.flushed?.push(session?.id ?? null);
        return true;
      },
    },
  };
}

{
  // ① 消息形状：**插件来源**的用户角色消息（界面据此画成"非人触发的本轮"）
  const message = continueMessage();
  eq('消息是 user 角色（inbox 只收这种）', message.role, 'user');
  eq('★ 来源就是本插件（不是 user ⇒ 不冒充用户发言）', message.source.kind, CONTINUE_SOURCE_KIND);
  eq('来源 kind 的字面量', CONTINUE_SOURCE_KIND, 'safely-quit');
  eq('正文只有一段文字', message.content.length, 1);
  eq('正文就是那句唯一文案', message.content[0].text, CONTINUE_TEXT);
  check('正文说的是"接着做完被关闭打断的那一步"', CONTINUE_TEXT.includes('打断'), CONTINUE_TEXT);
  check('正文不冒充用户（没有"我要求 / 用户说"这类口吻）', !/我要求|用户说|作为用户/.test(CONTINUE_TEXT), CONTINUE_TEXT);
  eq('消息深冻结（进了 inbox 就不许再改）', Object.isFrozen(message) && Object.isFrozen(message.content[0]), true);
  check('每次都是一条新消息（id 唯一，两次点击不会被合并成一条）', continueMessage().id !== continueMessage().id);
}
{
  // ② 四档结论 + 副作用
  const agent = fakeSessionAgent('s-idle');
  const flushed = [];
  const ctx = fakeContinueCtx([agent], { flushed });
  const session = createSession();
  eq('★ 空闲会话 ⇒ 投一条「继续」并如实回 attached', (await continueOne(ctx, session, 's-idle')).result, 'attached');
  eq('确实投了一条', agent.received.length, 1);
  eq('投的就是那条插件来源的消息', agent.received[0]?.source?.kind, CONTINUE_SOURCE_KIND);
  eq('投递之后等了一次落盘', flushed.join(','), 's-idle');
  eq('★ 再点一次同一行 ⇒ already（不投第二条，免得同一段活做两遍）', (await continueOne(ctx, session, 's-idle')).result, 'already');
  eq('重复点击之后仍然只有一条', agent.received.length, 1);

  const running = fakeSessionAgent('s-running', { status: 'running' });
  const runningCtx = fakeContinueCtx([running]);
  eq('本来就在跑的会话 ⇒ already', (await continueOne(runningCtx, createSession(), 's-running')).result, 'already');
  eq('★ 已经在跑的时候**一条都不投**', running.received.length, 0);

  const goneCtx = fakeContinueCtx([], { notFound: ['s-gone'] });
  eq('平台说会话不存在 ⇒ missing（界面显示"这个会话不在了"）', (await continueOne(goneCtx, createSession(), 's-gone')).result, 'missing');

  const heldCtx = fakeContinueCtx([], { writerHeld: ['s-held'] });
  const held = await continueOne(heldCtx, createSession(), 's-held');
  eq('别的失败（写租约被占）⇒ failed', held.result, 'failed');
  eq('失败带上平台的错误码（排障看得见是哪一档）', held.detail, 'session/writer-held');
}
{
  // ③ 失败面：服务缺席 / 解析抛错 / followup 抛错 / 落盘失败 —— 一条都不许装成"已接上"
  eq('会话服务缺席 ⇒ failed（如实说没接上）', (await continueOne({}, createSession(), 's1')).result, 'failed');
  eq('解析就抛错 ⇒ failed', (await continueOne(fakeContinueCtx([], { resolveThrows: true }), createSession(), 's1')).result, 'failed');
  const throwing = fakeSessionAgent('s2', { followupThrows: true });
  const throwResult = await continueOne(fakeContinueCtx([throwing]), createSession(), 's2');
  eq('followup 抛错 ⇒ failed（键变重试）', throwResult.result, 'failed');
  check('失败原因写明是 followup 那一步', String(throwResult.detail).includes('followup'), throwResult.detail);

  const agent = fakeSessionAgent('s3');
  const flushFail = await continueOne(fakeContinueCtx([agent], { flushThrows: true }), createSession(), 's3');
  eq('★ 落盘失败**不改变**"已接上"（消息已经进 inbox 了）', flushFail.result, 'attached');
  eq('但落盘结果如实报 false', flushFail.flushed, false);
  eq('消息照样只有一条', agent.received.length, 1);
}
{
  // ④ 批量：串行、去重、限条数、空清单
  const agents = ['a1', 'a2', 'a3'].map((id) => fakeSessionAgent(id));
  const ctx = fakeContinueCtx(agents);
  const batch = await continueSessions(ctx, createSession(), ['a1', 'a2', 'a1', '', null, 42]);
  eq('★ 空值与非字符串会被剔掉（不会拿脏 id 去问平台）', batch.map((row) => row.sessionId).join(','), 'a1,a2');
  eq('两个都接上了（串行逐条投）', batch.map((row) => row.result).join(','), 'attached,attached');
  eq('空清单 ⇒ 空结果（不抛）', (await continueSessions(ctx, createSession(), [])).length, 0);
  const many = Array.from({ length: MAX_CONTINUE_IDS + 8 }, (_, index) => `m${index}`);
  const limited = await continueSessions(fakeContinueCtx([]), createSession(), many);
  eq('★ 一次点击最多接 MAX_CONTINUE_IDS 个（多出来的不替人排队）', limited.length, MAX_CONTINUE_IDS);
}
{
  // ⑤ 路由：POST /continue 的三条分支（没 id / 服务缺席 / 正常）+ 同一道门
  const noIds = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/continue', headers: loopbackHeaders, body: {} }), noIds);
  eq('空 sessionIds ⇒ 400（不静默成功）', noIds.statusCode, 400);

  const noService = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/continue', headers: loopbackHeaders, body: { sessionIds: ['x'] } }), noService);
  eq('★ 会话服务没注入 ⇒ 503（如实说没接上，不拿别的东西顶替）', noService.statusCode, 503);

  const agent = fakeSessionAgent('route-1');
  const routeSession = createSession();
  routeSession.continueScope = fakeContinueCtx([agent]);
  const ok = fakeRes();
  await handleRoute({}, routeSession, fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/continue', headers: loopbackHeaders, body: { sessionIds: ['route-1'] } }), ok);
  eq('正常 ⇒ 200', ok.statusCode, 200);
  const payload = ok.json() ?? {};
  eq('回执里带 attached 计数', payload.attached, 1);
  eq('回执里逐会话给结论', payload.results?.[0]?.result, 'attached');
  eq('/state 里留下最近一次接续的读数（排障用）', routeSession.lastContinue?.results?.[0]?.result, 'attached');
  eq('消息确实投出去了', agent.received.length, 1);

  const crossSite = fakeRes();
  await handleRoute({}, createSession(), fakeReq({ method: 'POST', url: '/api/dsh-safely-quit/continue', headers: { host: '127.0.0.1:3080' }, body: { sessionIds: ['x'] } }), crossSite);
  eq('跨站 POST ⇒ 403（同一个门：接续也是改状态的动作）', crossSite.statusCode, 403);
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────

rmSync(SANDBOX, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`✗ host.test：${failures.length} 条未过（通过 ${passed}）`);
  for (const line of failures) console.error(`   ✗ ${line}`);
  process.exit(1);
}
console.log(`✓ host.test：全部通过（${passed} 条判据，含反例与交棒路径的读数）`);
