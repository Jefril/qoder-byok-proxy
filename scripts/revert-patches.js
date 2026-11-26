// 全量回滚：恢复 Qoder 出厂状态（原始 bundle、原始 CSP、无代理、自动更新开）。
// 取代 revert-all.ps1，跨平台。macOS 改 bundle 不需要提权。
//
// 与 Windows 版的差异（有意为之）：
//   - 只停 proxy.js，不杀 admin.js。原版靠提权杀掉 admin 来避免它的
//     http.proxy 守卫把刚清掉的代理设置补回去；这里改为回滚一开始就清掉
//     config.json 的 ideProxyPort，守卫自然停手，控制台还能看回滚日志。
//
// 日志：仓库根 _revert_all_log.txt；完成标记 REVERT-ALL DONE / REVERT-ALL FAILED。
// 用法：node revert-patches.js [--root <dir>] [--backup <dir>] [--keep-model-record]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./qoder-paths');

const argv = process.argv.slice(2);
const REPO = path.join(__dirname, '..');

function resolveRoot() {
  const i = argv.indexOf('--root');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'qoder-proxy', 'config.json'), 'utf8'));
    if (cfg.ideRoot && Q.looksLikeIdeRoot(cfg.ideRoot)) return cfg.ideRoot;
  } catch { /* ignore */ }
  return Q.IS_MAC ? '/Applications/Qoder CN IDE.app' : 'D:\\Qoder IDE';
}

const ROOT = resolveRoot();
const APP = Q.appDirOf(ROOT);
const USER_DIR = APP ? Q.userDataDir(APP) : '';
const LOG_PATH = path.join(REPO, '_revert_all_log.txt');
const CONFIG = path.join(REPO, 'qoder-proxy', 'config.json');

const Log = (() => {
  const write = (m) => {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${m}`;
    console.log(line);
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  };
  return write;
})();

// 挑最新的 pristine（未被打过补丁的）备份。apply 每次运行都会快照当前 bundle，
// 如果当时已经打过补丁，那份快照也是脏的 —— 恢复它等于没恢复。
// wb 三个标记任一存在即脏；aw 用正则（P4 产物的对象名随构建变化）。
function findPristineBackup() {
  const i = argv.indexOf('--backup');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const bkRoot = path.join(REPO, '_qoder_byok_backup');
  let dirs = [];
  try {
    dirs = fs.readdirSync(bkRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(bkRoot, d.name))
      .sort()
      .reverse();
  } catch { return null; }
  // CN 版 bundle 的压缩变量名与国际版不同（r→n），标记用变量无关正则
  const wbMarkers = [
    /_applyByokRemoteEnabledFromResponse\(\w+\)\{const \w+=!0;/,
    /_isCustomModelSupportedByCurrentAccount\(\)\{return!0\}/,
    /\(\)=>!0\/\*qbp\*\//,
    'shouldShowCommercialMessage(t,e){return!1;',
    '_lm=this;setInterval',
  ];
  const awMarker = /useMemo\)\(\(\)=>!1,\[\w+\.userPlan/;
  for (const d of dirs) {
    const wbB = path.join(d, 'workbench.desktop.main.js');
    const awB = path.join(d, 'agents-window.desktop.main.js');
    if (!fs.existsSync(wbB)) continue;
    let dirty = false;
    const wbText = fs.readFileSync(wbB, 'utf8');
    for (const m of wbMarkers) {
      if (m instanceof RegExp ? m.test(wbText) : wbText.includes(m)) { dirty = true; break; }
    }
    if (!dirty && fs.existsSync(awB) && awMarker.test(fs.readFileSync(awB, 'utf8'))) dirty = true;
    if (!dirty) return d;
  }
  return null;
}

function main() {
  if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  Log(`start root=${ROOT} platform=${process.platform}`);

  const backupDir = findPristineBackup();
  if (!backupDir) {
    Log('no PRISTINE backup found (all backups look patched)');
    Log('REVERT-ALL FAILED');
    process.exit(2);
  }
  Log(`backup dir: ${backupDir}`);

  const wb = path.join(APP, Q.WB_REL);
  const aw = path.join(APP, Q.AW_REL);
  if (!fs.existsSync(wb)) { Log(`ABORT: no workbench bundle under ${ROOT}`); Log('REVERT-ALL FAILED'); process.exit(2); }
  if (!fs.existsSync(aw)) { Log(`ABORT: no agents-window bundle under ${ROOT}`); Log('REVERT-ALL FAILED'); process.exit(2); }
  Log('bundle ok: both present');

  // ---- 0a. 先摘掉 admin 守卫的依据，再停代理 ----
  // 顺序很重要：admin 的 watchdog 每 15s 看 settings.http.proxy 拉起 proxy、
  // http.proxy 守卫每 30s 看 config.ideProxyPort 补回 http.proxy。
  // 这里两样都清掉，守卫停手，才不会出现"回滚完又被自动接管"。
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (cfg.ideProxyPort) {
      delete cfg.ideProxyPort;
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      Log('config.json: ideProxyPort removed (guards disabled)');
    }
  } catch (e) { Log(`config.json clean failed: ${e.message}`); }
  const settingsPath = path.join(USER_DIR, 'User', 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (s['http.proxy'] !== undefined) {
      delete s['http.proxy'];
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n', 'utf8');
      Log('settings: http.proxy removed (early, before stopping proxy)');
    }
  } catch { /* 文件不存在或格式异常，后面第 5 步还会再处理 */ }

  // ---- 1. stop proxy ----
  const r = spawnSync('pkill', ['-f', 'qoder-proxy/proxy\\.js'], { encoding: 'utf8' });
  Log(`stop proxy: pkill exit=${r.status}`);   // 1 = 没有匹配进程，正常

  // ---- 2. restore pristine bundles ----
  for (const [name, dst] of [['workbench.desktop.main.js', wb], ['agents-window.desktop.main.js', aw]]) {
    const src = path.join(backupDir, name);
    if (!fs.existsSync(src)) { Log(`SKIP missing backup ${name}`); continue; }
    fs.copyFileSync(src, dst);
    Log(`restored bundle ${name}`);
  }

  // ---- 3. restore CSP in html ----
  for (const rel of [Q.WB_HTML_REL, Q.AW_HTML_REL]) {
    const h = path.join(APP, rel);
    if (!fs.existsSync(h)) continue;
    const t = fs.readFileSync(h, 'utf8');
    if (t.includes('127.0.0.1:8788')) {
      fs.writeFileSync(h, t.replace(/\r?\n\s*http:\/\/127\.0\.0\.1:8788/g, ''), 'utf8');
      Log(`csp cleaned: ${path.basename(h)}`);
    }
  }

  // ---- 4. recompute checksums ----
  const wbHtml = path.join(APP, Q.WB_HTML_REL);
  const awHtml = path.join(APP, Q.AW_HTML_REL);
  Q.fixChecksums(APP, {
    'vs/workbench/workbench.desktop.main.js': wb,
    'lingma/agents-window/agents-window.desktop.main.js': aw,
    'vs/code/electron-browser/workbench/workbench.html': wbHtml,
    'lingma/agents-window/electron-browser/agents-window.html': awHtml,
  }, Log);

  // ---- 5. settings.json / app.json：删 http.proxy（若上一步没删成）、开自动更新 ----
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    let changed = false;
    if (s['http.proxy'] !== undefined) { delete s['http.proxy']; Log('settings: http.proxy removed'); changed = true; }
    if (s.app && s.app.configAdvancedAutoUpdate !== true) { s.app.configAdvancedAutoUpdate = true; Log('settings: configAdvancedAutoUpdate=true'); changed = true; }
    if (changed) fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch (e) { Log(`settings.json failed: ${e.message}`); }
  const appJsonPath = path.join(USER_DIR, 'User', 'app.json');
  try {
    const a = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    if (a.config && a.config.advanced && a.config.advanced.autoUpdate !== true) {
      a.config.advanced.autoUpdate = true;
      fs.writeFileSync(appJsonPath, JSON.stringify(a, null, 2) + '\n', 'utf8');
      Log('app.json: autoUpdate=true');
    }
  } catch { /* ignore */ }

  // ---- 6. argv.json：删 ignore-certificate-errors ----
  for (const p of Q.argvJsonCandidates()) {
    try {
      const t = fs.readFileSync(p, 'utf8');
      if (!t.includes('ignore-certificate-errors')) continue;
      let next = t.replace(/,?\s*\r?\n\s*"ignore-certificate-errors"\s*:\s*true/, '');
      next = next.replace(/,(\s*[}\]])/g, '$1');   // 清掉因此产生的尾逗号
      fs.writeFileSync(p, next, 'utf8');
      Log(`argv.json: ignore-certificate-errors removed (${p})`);
    } catch { /* ignore */ }
  }

  if (argv.includes('--keep-model-record')) Log('model record kept');

  Log('REVERT-ALL DONE');
  console.log('REVERT OK');
}

main();
