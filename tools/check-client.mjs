/**
 * check-client.mjs —— 客户端产物的**浏览器加载等价校验 + 四处接缝的单一真源机检**
 * （本包无构建步骤，故用本脚本兜底）。
 *
 * 为什么不用 `node --check` 就够：本包 `type: module`，`node --check` 会把 `lib/client.js`
 * 按 **ESM** 解析 —— 而它在浏览器里是被 `__ModuleLoader__` 当**经典脚本**执行的。
 * 真正等价于浏览器加载的是 `new Function('window', source)`：顶层出现 import/export
 * 就会在这里报错（那正是本脚本要拦的形态错误）。
 *
 * 拦住**八类**错（下面 ①-⑧ 与代码里的编号一一对应，改代码就把这里一起改）：
 *   ① `lib/client.js` 不能作为经典脚本解析（浏览器加载会直接失败）；
 *   ② 顶层出现 `import` / `export`（经典脚本不允许；`new Function` 的报错不总是直白，故双保险）；
 *   ③ 忘了 `window.__ModuleLoader__.load({ id })`，或 id 与包名不一致（loader 条目名 = 行 name = 包名）；
 *   ④ 路由前缀两半不一致（客户端 `ENDPOINT` vs 宿主 `lib/index.js` 的 `ROUTE_PATH`）；
 *   ⑤ 客户端产物里出现版本字面量（版本只许来自包元数据，经宿主 `/state` 下发）；
 *   ⑥ 网络出口跑散（请求只允许在 `callHost` 那一处拼 `${ENDPOINT}`）；
 *   ⑦ 宿主半把预算阈值"常量名 + 字面量数字"又写了一份（阈值只许在内核 `lib/shutdown-hooks.js` 定义）；
 *   ⑧ 宿主入口形状不对（`package.json` 的 `main` 读不到，或既不导出 name / apply 也不导出 default）；
 * 外加一条**不计入编号**的第三份副本比对：开发工作区真机装置的路由前缀（见 ⑨，装置不在场时跳过）。
 *
 * 为什么 ④⑤⑦⑧⑨ 放在这道门里：判据分在宿主/客户端两套里，**跨半区的同一事实各改一处谁都不报错**
 * （两半前缀不一致时，两套判据仍各自全绿）。这道门就是那条接缝的机检点 ——
 * 它读的是**真实源码**，不依赖任何一方自报。
 *
 * 用法：`node tools/check-client.mjs`（exit 0 = 通过，exit 1 = 有错）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const target = join(pkgRoot, 'lib', 'client.js');
const source = readFileSync(target, 'utf8');

const problems = [];

// ① 经典脚本：能被 new Function 解析（顶层 import/export 会在这里炸）
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source);
} catch (error) {
  problems.push(`lib/client.js 不能作为经典脚本解析（浏览器加载会失败）：${error.message}`);
}

// ② 顶层 ESM 语法（双保险：new Function 报错信息不总是直白）
if (/^\s*(?:import|export)\s/m.test(source)) {
  problems.push('lib/client.js 顶层出现了 import/export —— 客户端产物必须是经典脚本');
}

// ③ 模块 id 与包名一致（loader 条目名 = cordis.patch.yml 的 name = 包名）
const idMatch = source.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/);
if (idMatch === null) {
  problems.push('未找到 window.__ModuleLoader__.load({ id }) —— 客户端产物无法被外壳发现');
} else if (idMatch[1] !== pkg.name) {
  problems.push(`load({ id: '${idMatch[1]}' }) 与包名 '${pkg.name}' 不一致 —— loader 会按行 name（=包名）找模块`);
}

// ④ 路由前缀只有一处定义：客户端字面量必须与宿主半区的 ROUTE_PATH 逐字一致
const hostSource = readFileSync(join(pkgRoot, 'lib', 'index.js'), 'utf8');
const hostRoute = hostSource.match(/export const ROUTE_PATH = '([^']+)'/);
const clientEndpoint = source.match(/const ENDPOINT = '([^']+)'/);
if (hostRoute === null) {
  problems.push('读不到 lib/index.js 的 `export const ROUTE_PATH` —— 前缀的单一真源不见了');
} else if (clientEndpoint === null) {
  problems.push('读不到 lib/client.js 的 `const ENDPOINT` —— 客户端不再声明路由前缀');
} else if (hostRoute[1] !== clientEndpoint[1]) {
  problems.push(`路由前缀两半不一致：宿主 ROUTE_PATH='${hostRoute[1]}' vs 客户端 ENDPOINT='${clientEndpoint[1]}'（客户端会打 404）`);
}

// ⑤ 版本号只有一处定义（包元数据）：客户端产物里不许出现版本字面量
const versionLiteral = source.match(/\bv?\d+\.\d+\.\d+\b/);
if (versionLiteral !== null) {
  problems.push(`lib/client.js 里出现了版本字面量 '${versionLiteral[0]}' —— 版本只能来自包元数据（经宿主 /state 下发），写死一份必然漂移`);
}

// ⑥ 网络出口只有一处：请求只在 callHost 里拼 `${ENDPOINT}`
const exits = [...source.matchAll(/fetchImpl\s*\(\s*`\$\{ENDPOINT\}/g)].length;
if (exits !== 1) {
  problems.push(`lib/client.js 里有 ${exits} 处直接拼 \`\${ENDPOINT}\` 的请求 —— 应该只有 callHost 那一处（否则接缝又散开了）`);
}

// ⑦ 阈值只有一处定义：宿主半不许把预算"常量名 + 字面量数字"再写一遍
//    为什么只比值不够：两侧都是 30000 时，值相等的判据分不出"又写死一份"，得看**写法**。
const literalBudgetNames = ['DEFAULT_HOOK_BUDGET_MS', 'DEFAULT_DISPOSE_BUDGET_MS']
  .filter((name) => new RegExp(`const\\s+${name}\\s*=\\s*\\d`).test(hostSource));
if (literalBudgetNames.length > 0) {
  problems.push(`lib/index.js 把 ${literalBudgetNames.join('、')} 写成了字面量数字 —— 预算只能在内核（lib/shutdown-hooks.js）定义一份，宿主半引用它`);
}
if (!/const\s+DEFAULT_HOOK_BUDGET_MS\s*=\s*DEFAULT_BUDGET_MS;/.test(hostSource)) {
  problems.push('lib/index.js 的 DEFAULT_HOOK_BUDGET_MS 不再引用内核导出的 DEFAULT_BUDGET_MS —— 单一真源断了');
}

// ⑧ 宿主半区：main 必须存在且是 ESM（cordis 动态 import）
const mainPath = join(pkgRoot, pkg.main ?? 'lib/index.js');
try {
  const mainSource = readFileSync(mainPath, 'utf8');
  if (!/export\s+(?:const\s+name|function\s+apply|default)/.test(mainSource)) {
    problems.push(`${pkg.main} 既不导出 name / apply 也不导出 default —— cordis 认不出这是插件`);
  }
} catch (error) {
  problems.push(`读不到宿主半区入口 ${pkg.main}：${error.message}`);
}

// ⑨ 第三份路由前缀副本（开发工作区的**真机装置** `tools/record-lifecycle.mjs`）也要与产品两半逐字一致
//    （产品两半另有判据看管，装置这一份没有）。
//    装置**不在场时跳过、不算失败**：本包可以被单独拷走（副本 / 独立检出里没有开发工作区的 tools/）。
let deviceNote = '跳过：装置不在场（副本或独立检出里没有 tools/record-lifecycle.mjs）';
try {
  const deviceSource = readFileSync(join(pkgRoot, '..', 'tools', 'record-lifecycle.mjs'), 'utf8');
  const deviceRoute = deviceSource.match(/const ROUTE = '([^']+)'/);
  if (deviceRoute === null) {
    problems.push('读不到真机装置的 `const ROUTE` —— 装置不再声明路由前缀（第三份副本失去看管）');
  } else if (hostRoute === null || clientEndpoint === null) {
    deviceNote = '跳过：产品两半的前缀没读全，装置比对无意义';
  } else if (deviceRoute[1] !== hostRoute[1] || deviceRoute[1] !== clientEndpoint[1]) {
    problems.push(`真机装置的 ROUTE='${deviceRoute[1]}' 与产品两半不一致（宿主 '${hostRoute[1]}' / 客户端 '${clientEndpoint[1]}'）—— 前缀一改，装置会以 404 显性失败`);
  } else {
    deviceNote = `与产品两半逐字一致（${deviceRoute[1]}）`;
  }
} catch {
  // 装置不在场：明确跳过（已经写在 deviceNote 里）
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log(`✓ lib/client.js 经典脚本可加载；模块 id = ${idMatch[1]}；宿主入口 ${pkg.main} 形状合法`);
console.log(`✓ 接缝单一真源：路由前缀两半一致（${clientEndpoint[1]}）；客户端零版本字面量；网络出口 ${exits} 处`);
console.log('✓ 阈值单一真源：宿主半的两档预算都不是字面量，且 DEFAULT_HOOK_BUDGET_MS 引用内核的 DEFAULT_BUDGET_MS');
console.log(`✓ 第三份前缀副本（真机装置）：${deviceNote}`);
