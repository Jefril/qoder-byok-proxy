// Qoder BYOK 补丁流水线（跨平台，取代 apply-all.ps1 + scripts/patch-qoder-*.ps1）。
//
// 步骤与 Windows 版一一对应，每步独立尝试、互不中断，摘要里看真实落地情况：
//   1) 备份 bundle            _qoder_byok_backup/<stamp>/（revert 挑 pristine 备份用）
//   2) byok-unlock            解锁 Settings > Models 的 BYOK 入口（4 条替换）
//   3) baseurl                customModel.url 透传 baseUrl
//   4) merge-model-fields     保留自定义模型的 reasoning/context 字段
//   5) live-model             CSP 放行本地代理 + 渲染进程轮询 /state 刷新模型名
//   6) live-name-fix          修复历史 live 补丁引入的多余括号（本版不再产生）
//   7) experts                调 experts-patch.js（P1/P4/P5a-c/P6/P13/P12）
//   8) checksums              统一重算 product.json / featureFlags.json
//   9) syntax check           node --check 两个 bundle
//
// 日志：仓库根 _apply_all_log.txt；完成标记 APPLY-ALL DONE / APPLY-ALL FAILED
// （admin.js 的 /api/apply-status 按这两个字符串轮询，别改）。
//
// 用法：node apply-patches.js [--root <dir>] [--dry]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./qoder-paths');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const rootIdx = argv.indexOf('--root');
const REPO = path.join(__dirname, '..');

// root 解析顺序：--root > config.json ideRoot > 平台默认值
function resolveRoot() {
  if (rootIdx >= 0 && argv[rootIdx + 1]) return argv[rootIdx + 1];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'qoder-proxy', 'config.json'), 'utf8'));
    if (cfg.ideRoot && Q.looksLikeIdeRoot(cfg.ideRoot)) return cfg.ideRoot;
  } catch { /* ignore */ }
  return Q.IS_MAC ? '/Applications/Qoder CN IDE.app' : 'D:\\Qoder IDE';
}

const ROOT = resolveRoot();
const APP = Q.appDirOf(ROOT);
const LOG_PATH = path.join(REPO, '_apply_all_log.txt');

const logLines = [];
function Log(m) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${m}`;
  logLines.push(line);
  console.log(line);
  if (!DRY) fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
}

const wb = APP ? path.join(APP, Q.WB_REL) : '';
const aw = APP ? path.join(APP, Q.AW_REL) : '';
const wbHtml = APP ? path.join(APP, Q.WB_HTML_REL) : '';
const awHtml = APP ? path.join(APP, Q.AW_HTML_REL) : '';

// ---------------- 通用替换工具 ----------------
/** 字面量替换（与 ps1 的 .Replace 等价）。
 *  返回 { status: 'applied'|'already'|'absent'|'error', hits } */
function replaceLiteral(text, find, repl, maxHits, label, log) {
  const done = text.split(repl).length - 1;
  if (done >= 1) { log(`${label}: already applied`); return { status: 'already', text }; }
  const hits = text.split(find).length - 1;
  if (hits === 0) { log(`${label}: anchor absent`); return { status: 'absent', text }; }
  if (hits > maxHits) { log(`${label}: unexpected anchor count ${hits}`); return { status: 'error', text }; }
  return { status: 'applied', text: text.split(find).join(repl), hits };
}

function writeFileIfChanged(file, text, log) {
  const before = fs.readFileSync(file, 'utf8');
  if (before !== text) {
    if (!DRY) fs.writeFileSync(file, text, 'utf8');
    log(`written: ${path.basename(file)}`);
  }
}

// ---------------- 各步骤 ----------------

function stepBackup() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15); // 到秒，避免同秒冲突加一位
  const dir = path.join(REPO, '_qoder_byok_backup', stamp);
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
  for (const f of [wb, aw]) {
    if (!DRY) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  }
  Log(`backup ok: ${dir}`);
  return dir;
}

// patch-qoder-byok.ps1 的 4 条：后端 byokConfig.enabled=false 与服务端校验全部绕过。
// CN 版 bundle 的压缩变量名与国际版不同（如 r→n），锚点用捕获组回引，
// 与 experts-patch.js 的抗重命名做法一致；done 正则用于幂等检测（已应用特征）。
function stepByok() {
  const patches = [
    {
      name: 'byok-remote-gate',
      find: /_applyByokRemoteEnabledFromResponse\((\w+)\)\{const (\w+)=\1\?\.enabled!==!1;/g,
      done: /_applyByokRemoteEnabledFromResponse\(\w+\)\{const \w+=!0;/,
      repl: (_m, arg, v) => `_applyByokRemoteEnabledFromResponse(${arg}){const ${v}=!0;`,
    },
    {
      name: 'byok-config-enabled',
      find: /return\{enabled:(\w+)\.enabled\?\?!0,providers:\1\.providers\}\}/g,
      done: /return\{enabled:!0,providers:\w+\.providers\}\}/,
      repl: (_m, v) => `return{enabled:!0,providers:${v}.providers}}`,
    },
    {
      name: 'byok-check-bypass',
      find: /async checkByokConfig\((\w+),(\w+)\)\{/g,
      done: /async checkByokConfig\(\w+,\w+\)\{return\{success:!0\};/,
      repl: (_m, a, b) => `async checkByokConfig(${a},${b}){return{success:!0};`,
    },
    {
      name: 'byok-model-availability',
      find: /_getCustomModelDisabledReason\((\w+),(\w+),(\w+),(\w+)=!0\)\{/g,
      done: /_getCustomModelDisabledReason\(\w+,\w+,\w+,\w+=!0\)\{return;/,
      repl: (_m, a, b, c, d) => `_getCustomModelDisabledReason(${a},${b},${c},${d}=!0){return;`,
    },
    {
      // 账号门控（服务层）：企业账号被判定不支持 BYOK。
      // 之前 4 条补丁只盖住远程开关与服务端校验，这一条是服务层独立的账号类型判断
      //（P4 只改了 UI 层的 useMemo 调用点，没盖到这个函数体）。
      name: 'byok-account-gate',
      find: /_isCustomModelSupportedByCurrentAccount\(\)\{return \w+\(this\._applicationAuthService\.userPlan\?\.user_type,this\._applicationAuthService\.userInfo,this\._applicationAuthService\.userPlan\?\.is_personal_version\)\}/g,
      done: /_isCustomModelSupportedByCurrentAccount\(\)\{return!0\}/,
      repl: () => '_isCustomModelSupportedByCurrentAccount(){return!0}',
    },
    {
      // 账号门控（UI 层）：BYOK 管理页组件里另有一份 `Y=()=>VX(userPlan...)` 的
      // 独立判定（与 P4 的 useMemo 形态不同，之前没盖到），D(Y())=false 时页面
      // 显示「BYOK 功能已被企业管理员禁用」。每个 bundle 约 6 处，全部恒真。
      // 替换串尾带 /*qbp*/ 标记做幂等检测（()=>!0 本身太通用，不能当特征）。
      name: 'byok-ui-account-gate',
      find: /(\w+)=\(\)=>(\w+)\((\w+)\.userPlan\?\.user_type,\3\.userInfo,\3\.userPlan\?\.is_personal_version\)/g,
      done: /\(\)=>!0\/\*qbp\*\//,
      maxHits: 12,
      repl: (_m, y) => `${y}=()=>!0/*qbp*/`,
    },
  ];
  for (const file of [wb, aw]) {
    const name = path.basename(file);
    let text = fs.readFileSync(file, 'utf8');
    for (const p of patches) {
      const label = `${name} :: ${p.name}`;
      // byok 的 4 条是硬性要求：锚点既不在原始形态也不在已应用形态 = 版本变了，必须报错
      if (p.done.test(text)) { Log(`${label} already applied`); continue; }
      p.find.lastIndex = 0;
      const hits = [...text.matchAll(p.find)];
      if (hits.length === 0) throw new Error(`anchor not found: ${p.name} in ${name}`);
      const expect = p.maxHits || 1;
      if (hits.length > expect) throw new Error(`anchor count ${hits.length} (expected <=${expect}): ${p.name} in ${name}`);
      p.find.lastIndex = 0;
      text = text.replace(p.find, p.repl);
      Log(`${label} applied`);
    }
    writeFileIfChanged(file, text, Log);
  }
  Log('byok-unlock DONE');
}

function stepBaseUrl() {
  for (const file of [wb, aw]) {
    const text = fs.readFileSync(file, 'utf8');
    const r = replaceLiteral(text,
      'type:u,is_vl:l.is_vl??!1',
      'type:u,url:l.baseUrl||"",is_vl:l.is_vl??!1',
      3, `${path.basename(file)} :: baseurl`, Log);
    if (r.status === 'applied') writeFileIfChanged(file, r.text, Log);
  }
  Log('baseurl DONE');
}

function stepMerge() {
  for (const file of [wb, aw]) {
    const text = fs.readFileSync(file, 'utf8');
    const r = replaceLiteral(text,
      'is_vl:n.is_vl,is_reasoning:n.is_reasoning,max_input_tokens:n.max_input_tokens,contextConfig:n.contextConfig,thinkingConfig:n.thinkingConfig,reasoningLabel:n.reasoningLabel',
      'is_vl:n.is_vl||e.is_vl,is_reasoning:n.is_reasoning||e.is_reasoning,max_input_tokens:n.max_input_tokens||e.max_input_tokens,contextConfig:n.contextConfig||e.contextConfig,thinkingConfig:n.thinkingConfig||e.thinkingConfig,reasoningLabel:n.reasoningLabel||e.reasoningLabel',
      2, `${path.basename(file)} :: merge`, Log);
    if (r.status === 'applied') writeFileIfChanged(file, r.text, Log);
  }
  Log('merge-model-fields DONE');
}

// live-model：CSP 放行 + 轮询器。替换串与 ps1 版逐字符一致（缩进 \n + tab），
// revert 的清理正则依赖这个形态。
function stepLiveModel() {
  const cspPattern = /connect-src\s+'self'\s+https:\s+ws:\s*;/;
  const cspRepl = "connect-src\n\t\t\t\t\t'self'\n\t\t\t\t\thttps:\n\t\t\t\t\tws:\n\t\t\t\t\thttp://127.0.0.1:8788\n\t\t\t\t;";
  for (const f of [wbHtml, awHtml]) {
    if (!fs.existsSync(f)) { Log(`${path.basename(f)}: missing, skip CSP`); continue; }
    const t = fs.readFileSync(f, 'utf8');
    if (t.includes('127.0.0.1:8788')) { Log(`${path.basename(f)}: CSP already patched`); continue; }
    const hits = (t.match(new RegExp(cspPattern.source, 'g')) || []).length;
    if (hits !== 1) throw new Error(`CSP anchor count ${hits} in ${f}`);
    writeFileIfChanged(f, t.replace(cspPattern, cspRepl), Log);
    Log(`${path.basename(f)}: CSP patched`);
  }

  const anchor = 'this._registerGetCustomModelsHandler()}';
  // v1：只热同步 displayName。保留常量用于把已装 v1 的 bundle 原地升级到 v2。
  const pollerV1 = 'this._registerGetCustomModelsHandler();const _lm=this;setInterval(async()=>{try{const _r=await fetch("http://127.0.0.1:8788/state");const _j=await _r.json();if(!_j||!_j.displayName)return;const _m=_lm._models.find(x=>x.id===(_j.recordId||"model_mocktest"));if(_m&&_m.displayName!==_j.displayName){_m.displayName=_j.displayName;_lm._storeModels(!1);_lm._onDidChangeModels.fire(_lm.getModels())}}catch{}},3000)}';
  // v2：同步全部能力字段（is_vl/is_reasoning/上下文/输出上限/thinkingConfig），
  // 控制台切上游（自动 sync 写库）后 IDE 3s 内自动生效，无需重启。
  // `_cur=JSON.stringify([_m.displayName` 是 v2 特征；`_lm=this;setInterval` 保留为 revert 的脏标记。
  const poller = 'this._registerGetCustomModelsHandler();const _lm=this;setInterval(async()=>{try{const _r=await fetch("http://127.0.0.1:8788/state");const _j=await _r.json();if(!_j)return;const _m=_lm._models&&_lm._models.find(x=>x.id===(_j.recordId||"model_mocktest"));if(!_m)return;const _cur=JSON.stringify([_m.displayName,_m.is_vl,_m.is_reasoning,_m.max_input_tokens,_m.max_output_tokens,_m.thinkingConfig]);const _nw=JSON.stringify([_j.displayName,_j.is_vl,_j.is_reasoning,_j.max_input_tokens,_j.max_output_tokens,_j.thinkingConfig]);if(_cur!==_nw){_m.displayName=_j.displayName;_m.is_vl=_j.is_vl;_m.is_reasoning=_j.is_reasoning;_m.max_input_tokens=_j.max_input_tokens;_m.max_output_tokens=_j.max_output_tokens;_m.thinkingConfig=_j.thinkingConfig;_lm._storeModels(!1);_lm._onDidChangeModels.fire(_lm.getModels())}}catch{}},3000)}';
  for (const f of [wb, aw]) {
    const t = fs.readFileSync(f, 'utf8');
    if (t.includes('_cur=JSON.stringify([_m.displayName')) { Log(`${path.basename(f)}: poller v2 already present`); continue; }
    if (t.includes(pollerV1)) {
      writeFileIfChanged(f, t.split(pollerV1).join(poller), Log);
      Log(`${path.basename(f)}: poller upgraded v1 -> v2`);
      continue;
    }
    const hits = t.split(anchor).length - 1;
    if (hits !== 1) throw new Error(`poller anchor count ${hits} in ${f}`);
    writeFileIfChanged(f, t.split(anchor).join(poller), Log);
    Log(`${path.basename(f)}: poller patched (v2)`);
  }
  Log('live-model DONE');
}

// fix-qoder-live-patch.ps1：老版 live 补丁会在 anchor 后多出一个 ')'，本版已修正，
// 保留检测以修复历史上已损坏的安装。
function stepLiveFix() {
  const broken = 'this._registerGetCustomModelsHandler());const _lm=this;';
  const fixed = 'this._registerGetCustomModelsHandler();const _lm=this;';
  for (const f of [wb, aw]) {
    const t = fs.readFileSync(f, 'utf8');
    const n = t.split(broken).length - 1;
    if (n === 0) { Log(`${path.basename(f)}: nothing to fix`); continue; }
    if (n !== 1) throw new Error(`unexpected ${n} occurrences in ${f}`);
    writeFileIfChanged(f, t.split(broken).join(fixed), Log);
    Log(`${path.basename(f)}: fixed`);
  }
}

function stepExperts() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'experts-patch.js'), '--root', ROOT]
    .concat(DRY ? ['--dry'] : []), { encoding: 'utf8', timeout: 300000 });
  for (const line of String(r.stdout || '').split('\n').filter(Boolean).slice(-12)) Log(`  ${line}`);
  if (r.status !== 0) throw new Error(`experts-patch exit=${r.status}`);
  Log('experts DONE');
}

function stepChecksums() {
  const relKeys = {
    'vs/workbench/workbench.desktop.main.js': wb,
    'lingma/agents-window/agents-window.desktop.main.js': aw,
    'vs/code/electron-browser/workbench/workbench.html': wbHtml,
    'lingma/agents-window/electron-browser/agents-window.html': awHtml,
  };
  Q.fixChecksums(APP, relKeys, Log);
  Log('checksums DONE');
}

function stepSyntaxCheck() {
  for (const f of [wb, aw]) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    Log(`syntax ${path.basename(f)}: exit=${r.status}`);
    if (r.status !== 0) throw new Error(`syntax check failed: ${path.basename(f)}`);
  }
}

// ---------------- 主流程 ----------------
function main() {
  if (!DRY && fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  Log(`start root=${ROOT} platform=${process.platform}${DRY ? ' (dry)' : ''}`);

  if (!APP || !fs.existsSync(wb)) {
    Log(`ABORT: no workbench bundle under ${ROOT}`);
    Log('APPLY-ALL FAILED');
    process.exit(2);
  }
  if (!fs.existsSync(aw)) {
    Log(`ABORT: no agents-window bundle under ${ROOT}`);
    Log('APPLY-ALL FAILED');
    process.exit(2);
  }
  Log('bundle ok: both present');

  Log('stopping Qoder IDE...');
  Q.stopIde(Log);
  if (!DRY) {
    const { execSync } = require('child_process');
    try { execSync('sleep 2'); } catch { /* ignore */ }
  }
  Log('qoder stopped');

  const steps = [
    ['byok-unlock', () => { if (!DRY) stepBackup(); stepByok(); }],
    ['baseurl', stepBaseUrl],
    ['merge-model-fields', stepMerge],
    ['live-model', stepLiveModel],
    ['live-name-fix', stepLiveFix],
    ['experts', stepExperts],
    ['checksums', stepChecksums],
    ['syntax', stepSyntaxCheck],
  ];

  const results = [];
  for (const [name, fn] of steps) {
    try {
      fn();
      results.push(`${name}=OK`);
    } catch (e) {
      Log(`${name}: EXCEPTION ${e.message}`);
      results.push(`${name}=EXC`);
    }
  }
  Log(`SUMMARY ${results.join(' ')}`);
  const failed = results.some((r) => r.endsWith('EXC'));
  if (failed) {
    Log('APPLY-ALL FAILED');
    process.exit(1);
  }
  Log('APPLY-ALL DONE');
  console.log('APPLY OK');
}

main();
