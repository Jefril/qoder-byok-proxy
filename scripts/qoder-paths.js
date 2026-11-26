// 跨平台路径与安装目录解析（Windows / macOS 共用）。
//
// 「root」统一指包含 app 目录的那一层：
//   Windows: D:\Qoder IDE                 （app = root\resources\app）
//   macOS:   /Applications/Qoder CN IDE.app（app = root/Contents/Resources/app）
// bundle / product.json 的相对路径一律从 app 目录算，不再拼 resources\app，
// 这样两个平台的差异收敛在 APP_SUB 一个常量上。
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_MAC = process.platform === 'darwin';
const APP_SUB = IS_MAC ? path.join('Contents', 'Resources', 'app') : path.join('resources', 'app');

// 相对 app 目录的 bundle 路径（workbench / agents-window 两套渲染进程）
const WB_REL = path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js');
const AW_REL = path.join('out', 'lingma', 'agents-window', 'agents-window.desktop.main.js');
// live-model 补丁要动的两个 html（CSP）
const WB_HTML_REL = path.join('out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html');
const AW_HTML_REL = path.join('out', 'lingma', 'agents-window', 'electron-browser', 'agents-window.html');

/**
 * root → app 目录。容错三种传法：.app 目录、Contents 目录、app 目录本身。
 * 找不到（没有 product.json 的）返回 null，不抛。
 */
function appDirOf(root) {
  if (!root) return null;
  const cands = [path.join(root, APP_SUB), path.join(root, 'Resources', 'app'), root];
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'product.json'))) return c; } catch { /* ignore */ }
  }
  return null;
}

function looksLikeIdeRoot(dir) {
  const app = appDirOf(dir);
  return !!app && fs.existsSync(path.join(app, WB_REL));
}

/**
 * 用户数据目录（含 User/settings.json、User/globalStorage/state.vscdb、logs）。
 *   Windows: %APPDATA%\Qoder
 *   macOS:   ~/Library/Application Support/<nameShort>（CN 版 QoderCN，国际版 Qoder）
 * macOS 按 product.json 的 nameShort 取；目录缺失时兜底扫 Qoder 前缀目录
 * （国际版与 CN 版数据目录并存时取 state.vscdb 最新修改的那个）。
 */
function userDataDir(appDir) {
  if (!IS_MAC) return path.join(process.env.APPDATA || '', 'Qoder');
  let nameShort = 'QoderCN';
  try {
    nameShort = JSON.parse(fs.readFileSync(path.join(appDir, 'product.json'), 'utf8')).nameShort || nameShort;
  } catch { /* 读不到就用 CN 版默认 */ }
  const base = path.join(os.homedir(), 'Library', 'Application Support');
  const primary = path.join(base, nameShort);
  if (fs.existsSync(path.join(primary, 'User', 'globalStorage', 'state.vscdb'))) return primary;
  try {
    const alt = fs.readdirSync(base)
      .filter((d) => /^qoder/i.test(d))
      .map((d) => {
        const db = path.join(base, d, 'User', 'globalStorage', 'state.vscdb');
        try { return { p: path.join(base, d), t: fs.statSync(db).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    if (alt.length) return alt[0].p;
  } catch { /* ignore */ }
  return primary;
}

/**
 * argv.json 位置。Windows 版历史路径是 ~/.qoder/argv.json（国际版）；
 * macOS CN 版按 dataFolderName 在 ~/.qoder-cn/argv.json，两个都探测。
 */
function argvJsonCandidates() {
  const home = os.homedir();
  if (!IS_MAC) return [path.join(home, '.qoder', 'argv.json')];
  return [path.join(home, '.qoder-cn', 'argv.json'), path.join(home, '.qoder', 'argv.json')];
}

/** 停掉正在运行的 Qoder IDE（打补丁前文件不能被占用，且退出时会写回覆盖）。
 *  只匹配 *IDE*.app，不会误杀 Qoder Desktop（Qoder CN.app）。 */
function stopIde(log) {
  if (IS_MAC) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('pkill', ['-f', 'Qoder.*IDE\\.app/Contents/MacOS'], { encoding: 'utf8' });
    // pkill 匹配不到时 exit=1，属于正常情况（IDE 没在跑）
    log(`pkill exit=${r.status}`);
  } else {
    const { spawnSync } = require('child_process');
    const r = spawnSync('taskkill', ['/IM', 'Qoder IDE.exe', '/F'], { encoding: 'utf8' });
    try { spawnSync('taskkill', ['/IM', 'Qoder.exe', '/F'], { encoding: 'utf8' }); } catch { /* ignore */ }
    log(`taskkill exit=${r.status}`);
  }
}

/** SHA256 → base64 → 去掉 '='，与 Qoder product.json 里的 checksums 格式一致 */
function checksumB64(file) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '');
}

/**
 * 重算 bundle checksums 并写回 product.json / featureFlags.json。
 * relKeys 是 { 'vs/workbench/...': 绝对路径 } 映射，键与 json 里的字段名一致。
 * 每个文件必须存在；返回更新的条目数。
 */
function fixChecksums(appDir, relKeys, log) {
  let changedTotal = 0;
  for (const jsonName of ['product.json', 'featureFlags.json']) {
    const p = path.join(appDir, jsonName);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { log(`${jsonName} 读取失败，跳过`); continue; }
    let changed = 0;
    for (const [k, file] of Object.entries(relKeys)) {
      const m = new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"([^"]+)"').exec(text);
      if (!m) { log(`${jsonName} :: key not found: ${k}`); continue; }
      const hash = checksumB64(file);
      if (m[1] === hash) continue;
      text = text.replace(m[1], hash);
      changed++;
    }
    if (changed > 0) {
      fs.writeFileSync(p, text, 'utf8');
      log(`${jsonName} checksums updated (${changed})`);
      changedTotal += changed;
    }
  }
  return changedTotal;
}

module.exports = {
  IS_MAC, APP_SUB, WB_REL, AW_REL, WB_HTML_REL, AW_HTML_REL,
  appDirOf, looksLikeIdeRoot, userDataDir, argvJsonCandidates,
  stopIde, checksumB64, fixChecksums,
};
