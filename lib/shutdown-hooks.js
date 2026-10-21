/**
 * shutdown-hooks.js —— **关机拓展**的注册表与执行器（SafelyQuit 对外那个服务的内核）。
 *
 * ═══ 它解决什么 ═══
 *   其它自研插件常有「DSH 关闭时要执行某个动作（常常是一条命令）」的需求。各家自己写
 *   `ctx.effect(() => () => …)` 会留下四个缺口：没有统一顺序、没有超时、失败看不见、
 *   也不能在「用插件按钮体面关闭」这条路径上被**等到**。本模块把这件事收成一处：登记 → 排序 → 逐个执行（带超时与错误隔离）→ 记账。
 *
 * ═══ 三条硬约定（消费者必须知道）═══
 *   ① **只有关闭时才跑，且一次进程至多跑一遍**：两条入口分别是「插件驱动的体面关闭」（在 SIGTERM 之前，
 *      预算充足）与「宿主自己走 dispose 的兜底」（Ctrl+C / 外部 SIGTERM / 系统注销；预算被平台的 5 秒
 *      grace 压着）。两条入口共用同一份账：`ranAt` 已落上的条目跳过；**同一时刻的两趟 `run()` 由单飞
 *      守卫合并成一趟**（并发到达的第二趟复用第一趟的结果，钩子函数体绝不会被执行两遍）。
 *   ② **失败不阻塞**：一条钩子抛错或超时，只记在它自己头上，后面的照跑；整个阶段也不会抛穿调用方。
 *   ③ **零依赖、零副作用在模块外**：`spawn` / 时钟 / 日志 / Windows 杀树全部可注入 ⇒ 离线判据能真跑。
 *      ⚠ 时钟注入的边界：注入的 `now` 只决定**记账与预算算术**；两条超时路径用的是真实定时器
 *      （`setTimeout`），假时钟不会缩短等待 —— 离线用例请把 `timeoutMs` 调小，别指望推进假时钟。
 *
 * ═══ 不做的事 ═══
 *   · 不提供「关闭 DSH」的触发口（人类专属入口这条硬约束不变，见 lib/index.js 文件头）。
 *   · 不重试、不做依赖编排（钩子之间的先后只由 `order` 决定，需要"B 等 A"就写成一条钩子）。
 */

import { spawn as nodeSpawn } from 'node:child_process';

/** 提供给别的插件的服务名（`ctx.inject(['safelyQuit'], …)`）。 */
export const SERVICE_NAME = 'safelyQuit';

/** 登记参数不合法时抛出的错误码（消费者写错了要**响亮**，不要静默收下一条永不执行的钩子）。 */
export const HOOK_ERROR_CODE = 'SAFELY_QUIT_E_HOOK';

/** 单条命令式钩子保留的输出尾巴长度（够排障，不至于把会话日志撑爆）。 */
const OUTPUT_TAIL_CHARS = 800;

/** 一条钩子默认的超时上限。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/** 整个关机拓展阶段的默认总预算。 */
export const DEFAULT_BUDGET_MS = 30000;

/**
 * dispose 兜底那一趟的默认预算。
 *
 * 为什么和总预算一样放在内核里：两档预算都是**这个执行器的口径**（主动一趟 / dispose 兜底一趟），
 * 宿主半只引用、不各写一份数字 ——「同一阈值两处定义」是踩过的坑（改一处忘另一处，谁都不报错）。
 * 取 2500ms 的理由：平台整棵树只有 5 秒 grace，兜底不能把这段时间吃光。
 */
export const DEFAULT_DISPOSE_BUDGET_MS = 2500;

/** 造一个带错误码的登记错误。 */
function hookError(message) {
  const error = new Error(message);
  error.code = HOOK_ERROR_CODE;
  return error;
}

/** 只留尾巴（命令输出可能很长；诊断只要最后那几行）。 */
function tailText(text) {
  const value = String(text ?? '');
  return value.length <= OUTPUT_TAIL_CHARS ? value : `…${value.slice(value.length - OUTPUT_TAIL_CHARS)}`;
}

function messageOf(error) {
  return String(error?.message ?? error);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 数值兜底：只接受正数，否则取缺省（config 是从 profile / 消费者交进来的"外面的数据"）。
 * 与 `lib/index.js` 共用同一实现（那边 import 本函数），避免同一条数值口径两处定义。
 */
export function positiveOf(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Windows 上杀掉整棵进程树（`child.kill()` 常常只杀掉 shell，留下真正干活的那个）。
 * 尽力而为：杀不掉不追究（超时已经记账，阶段不会因此卡住）。
 */
function defaultKillTree(child) {
  if (process.platform !== 'win32') return;
  if (!Number.isInteger(child?.pid)) return;
  try {
    const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {});
  } catch {
    // 杀不掉就算了
  }
}

/**
 * 选出这一套实际使用的「杀进程树」实现 —— 单独导出，判据才能直接问这条规则（不必真去杀进程）。
 *
 * 规则：**注入了 `spawn` 却没注入 `killTree` ⇒ 缺省不杀树**。理由：真实现会去
 * `taskkill /PID <child.pid> /T /F`，而离线判据里的假 child 的 pid 常常是个真数字 ——
 * 那是"测试顺手杀掉同机任意进程"的脚枪。要真杀树的离线用例请显式注入 `killTree`。
 */
export function resolveKillTree(options = {}) {
  if (typeof options.killTree === 'function') return options.killTree;
  if (typeof options.spawn === 'function') return () => {};
  return defaultKillTree;
}

/**
 * 造一个关机拓展注册表。
 *
 * @param {{now?:Function, log?:Function, spawn?:Function, killTree?:Function,
 *   timeoutMs?:number, budgetMs?:number}} [options] 全部可注入（离线判据用）
 * @returns {object} 见下方 return 的各个成员
 */
export function createShutdownHooks(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const spawnImpl = typeof options.spawn === 'function' ? options.spawn : nodeSpawn;
  const killTree = resolveKillTree(options);
  const defaultTimeoutMs = positiveOf(options.timeoutMs, DEFAULT_HOOK_TIMEOUT_MS);
  const defaultBudgetMs = positiveOf(options.budgetMs, DEFAULT_BUDGET_MS);

  /** 注册序（`order` 相同的按它排；也是 id 自动编号的来源）。 */
  let seq = 0;
  /** 注册表（顺序即注册序；执行时按 order+seq 排一份副本）。 */
  const entries = [];
  /** 最近一次整体执行的结果（只读面给排障用）。 */
  let lastRun = null;
  /** 在飞的那一趟（单飞守卫用）：非 null 时并发到达的 `run()` 直接复用它。 */
  let inFlight = null;

  /**
   * 把消费者交进来的东西规范化成一条钩子的内部形状。
   *
   * 两种形态（其余一律抛 `SAFELY_QUIT_E_HOOK`）：
   *   · 函数：`async (ctx) => {}`，`ctx = {reason, id, timeoutMs, log}`；
   *   · 命令：`{command, args?, shell?, cwd?, env?}`。
   */
  function normalize(action) {
    if (typeof action === 'function') return { kind: 'function', call: action };
    if (isPlainObject(action)) {
      if (typeof action.run === 'function') return { kind: 'function', call: action.run };
      const command = typeof action.command === 'string' ? action.command.trim() : '';
      if (command !== '') {
        const args = Array.isArray(action.args) ? action.args.map((item) => String(item)) : [];
        return {
          kind: 'command',
          spec: {
            command,
            args,
            shell: action.shell === true,
            cwd: typeof action.cwd === 'string' && action.cwd !== '' ? action.cwd : null,
            env: isPlainObject(action.env) ? { ...action.env } : null,
          },
        };
      }
    }
    throw hookError('关机拓展的动作必须是函数，或 {command, args?, shell?, cwd?, env?}（收到 '
      + `${action === null ? 'null' : typeof action}）`);
  }

  /** 一条钩子对外的只读视图。 */
  function view(entry) {
    return {
      id: entry.id,
      label: entry.label,
      order: entry.order,
      kind: entry.kind,
      timeoutMs: entry.timeoutMs,
      status: entry.status,
      ranAt: entry.ranAt,
      ms: entry.ms,
      error: entry.error,
      ...(entry.kind === 'command' ? { command: entry.spec.command, args: [...entry.spec.args] } : {}),
      /** 命令式钩子的输出尾巴（排障：命令为什么失败，一眼能看）。 */
      ...(entry.output === null || entry.output === undefined
        ? {}
        : { output: { stdout: entry.output.stdout, stderr: entry.output.stderr } }),
    };
  }

  /** 跑一条函数式钩子（带超时；超时后**放弃等待**但不取消它 —— 函数没法从外面掐掉）。 */
  async function runFunction(entry, timeoutMs, reason) {
    const work = Promise.resolve()
      .then(() => entry.call({ reason, id: entry.id, timeoutMs, log }))
      .then(() => ({ ok: true }), (error) => ({ ok: false, error: messageOf(error) }));
    let timer = null;
    try {
      const outcome = await Promise.race([
        work,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: `超时（>${timeoutMs}ms）`, timedOut: true }), timeoutMs);
        }),
      ]);
      return outcome;
    } finally {
      if (timer !== null) clearTimeout(timer);
      // 超时后 work 仍然在跑：它自己已经吃掉 rejection，这里再兜一层，绝不让它变成 unhandled
      work.catch(() => {});
    }
  }

  /** 跑一条命令式钩子（带超时 + 尽力杀树）。 */
  function runCommand(entry, timeoutMs, reason) {
    return new Promise((resolve) => {
      const spec = entry.spec;
      const env = spec.env === null ? process.env : { ...process.env, ...spec.env };
      let child = null;
      try {
        child = spawnImpl(spec.command, spec.args, {
          ...(spec.cwd === null ? {} : { cwd: spec.cwd }),
          env,
          shell: spec.shell === true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ ok: false, error: messageOf(error) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      let timer = null;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        resolve({ ...outcome, output: { stdout, stderr } });
      };
      // ⚠ 定时器**先建**：`child.on('error')` 若被同步回调，finish 已经先把 done 置位、把定时器清掉，
      //    不会剩下一个越过 timeoutMs 后仍去 child.kill()/killTree() 的孤儿定时器（句柄泄漏 + 误杀）。
      timer = setTimeout(() => {
        if (done) return; // 双保险：已经 settle 就不再碰这个 child
        try {
          child.kill();
        } catch {
          // 已经退出了
        }
        try {
          // 注入的 killTree 也可能抛（它不该把异常抛进定时器回调 —— 那会变成未捕获异常而打死宿主）
          killTree(child);
        } catch {
          // 杀树失败不追究：超时这件事已经记在账上了
        }
        finish({ ok: false, error: `超时（>${timeoutMs}ms）已终止` });
      }, timeoutMs);
      try {
        child.stdout?.on('data', (chunk) => { stdout = tailText(stdout + String(chunk)); });
        child.stderr?.on('data', (chunk) => { stderr = tailText(stderr + String(chunk)); });
      } catch {
        // 拿不到管道不影响结果判定
      }
      child.on?.('error', (error) => finish({ ok: false, error: messageOf(error) }));
      child.on?.('close', (code, signal) => {
        if (code === 0) finish({ ok: true });
        else finish({ ok: false, error: `退出码 ${code === null || code === undefined ? `signal:${signal}` : code}` });
      });
      void reason;
    });
  }

  return {
    serviceName: SERVICE_NAME,
    defaultTimeoutMs,
    defaultBudgetMs,

    /**
     * 登记一条「DSH 关闭时执行」的动作。
     *
     * @param {Function|{command:string, args?:string[], shell?:boolean, cwd?:string, env?:object}} action
     * @param {{id?:string, label?:string, order?:number, timeoutMs?:number}} [hookOptions]
     *   `id` 建议带包名前缀（`dsh-xxx/stop-watcher`）—— 同一 id 再次登记＝**替换**旧的（热重载友好）。
     *   `order` 越小越先跑（缺省 0，同序按登记先后）。
     * @returns {Function} 摘除器（幂等；摘掉的是**这一次登记**那条）
     */
    onShutdown(action, hookOptions = {}) {
      const normalized = normalize(action);
      const requestedId = typeof hookOptions?.id === 'string' && hookOptions.id.trim() !== ''
        ? hookOptions.id.trim()
        : null;
      if (requestedId !== null) {
        const existing = entries.findIndex((item) => item.id === requestedId);
        if (existing >= 0) entries.splice(existing, 1); // 同 id 替换（重挂载不重复、不报错）
      }
      seq += 1;
      const entry = {
        id: requestedId ?? `hook-${seq}`,
        label: typeof hookOptions?.label === 'string' && hookOptions.label !== '' ? hookOptions.label : null,
        order: Number.isFinite(hookOptions?.order) ? Math.floor(hookOptions.order) : 0,
        timeoutMs: positiveOf(hookOptions?.timeoutMs, defaultTimeoutMs),
        kind: normalized.kind,
        ...(normalized.kind === 'function' ? { call: normalized.call } : { spec: normalized.spec }),
        seq,
        status: 'pending',
        ranAt: null,
        ms: null,
        error: null,
      };
      entries.push(entry);
      log(`关机拓展已登记：${entry.id}（${entry.kind}${entry.label === null ? '' : `，${entry.label}`}，order=${entry.order}，超时 ${entry.timeoutMs}ms）`);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },

    /** 按 id 摘掉一条（摘不到返回 false，不抛）。 */
    off(id) {
      const index = entries.findIndex((item) => item.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    },

    /** 只读：当前注册表（排障 / 界面用）。 */
    list() {
      return entries.map(view);
    },

    /** 只读：最近一次执行的总账（没跑过 ⇒ null）。 */
    lastRun() {
      return lastRun === null ? null : { ...lastRun, results: lastRun.results.map((row) => ({ ...row })) };
    },

    /**
     * **执行这一趟关机拓展**。失败不抛、不阻塞后续；已经跑过（`ranAt != null`）的跳过。
     *
     * **单飞**：同一时刻只允许一趟在飞 —— 并发到达的第二趟**复用**第一趟的结果，
     * 钩子函数体绝不会被执行两遍（见文件头约定 ①）。两条入口（关闭流程 / dispose 兜底）
     * 与消费者的 `runNow` 都可能撞在一起，这道守卫就挡在这里。
     *
     * @param {{reason?:string, budgetMs?:number}} [runOptions]
     * @returns {Promise<object>} `{reason, startedAt, finishedAt, budgetMs, results, exhausted}`
     */
    async run(runOptions = {}) {
      if (inFlight !== null) return inFlight;
      inFlight = runOnce(runOptions);
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };

  /** 真正跑一趟（只由 `run` 的单飞守卫调用）。 */
  async function runOnce(runOptions = {}) {
    const reason = typeof runOptions.reason === 'string' && runOptions.reason !== ''
      ? runOptions.reason
      : 'shutdown';
    const budgetMs = positiveOf(runOptions.budgetMs, defaultBudgetMs);
    const startedAt = now();
    const startedAtIso = new Date(startedAt).toISOString();
    const ordered = [...entries].sort((left, right) => (left.order - right.order) || (left.seq - right.seq));
    const results = [];
    let exhausted = false;

    for (const entry of ordered) {
      if (entry.ranAt !== null) {
        results.push({ id: entry.id, status: 'skipped', why: '已经执行过', ms: 0, error: null });
        continue;
      }
      const remaining = budgetMs - (now() - startedAt);
      if (remaining <= 0) {
        entry.status = 'skipped';
        entry.error = '总预算用尽';
        exhausted = true;
        results.push({ id: entry.id, status: 'skipped', why: '总预算用尽', ms: 0, error: entry.error });
        log(`关机拓展跳过 ${entry.id}：总预算 ${budgetMs}ms 已用尽`);
        continue;
      }
      const timeoutMs = Math.min(entry.timeoutMs, remaining);
      entry.status = 'running';
      const begin = now();
      const outcome = entry.kind === 'command'
        ? await runCommand(entry, timeoutMs, reason)
        : await runFunction(entry, timeoutMs, reason);
      entry.ms = now() - begin;
      entry.ranAt = now();
      entry.status = outcome.ok === true ? 'done' : 'failed';
      entry.error = outcome.ok === true ? null : (outcome.error ?? '未知失败');
      entry.output = outcome.output ?? null;
      results.push({ id: entry.id, status: entry.status, ms: entry.ms, error: entry.error });
      log(outcome.ok === true
        ? `关机拓展完成 ${entry.id}（${entry.ms}ms）`
        : `关机拓展失败 ${entry.id}（${entry.ms}ms）：${entry.error}`);
      if (outcome.output !== undefined && (outcome.output.stdout !== '' || outcome.output.stderr !== '')) {
        log(`  输出 ${entry.id}：stdout=${JSON.stringify(tailText(outcome.output.stdout))} stderr=${JSON.stringify(tailText(outcome.output.stderr))}`);
      }
    }

    const finishedAt = now();
    lastRun = {
      reason,
      startedAt: startedAtIso,
      finishedAt: new Date(finishedAt).toISOString(),
      budgetMs,
      elapsedMs: finishedAt - startedAt,
      exhausted,
      total: results.length,
      failed: results.filter((row) => row.status === 'failed').length,
      results,
    };
    log(`关机拓展这一趟结束：${lastRun.total} 条，失败 ${lastRun.failed} 条，用时 ${lastRun.elapsedMs}ms（原因 ${reason}）`);
    return lastRun;
  }
}
