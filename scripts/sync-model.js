// 把上游网关的模型元数据同步进 Qoder 的自定义模型记录（state.vscdb）。
// 取代 sync-qoder-model.ps1，跨平台（macOS 自带 sqlite3）。
//
// 读 qoder-proxy/config.json 的 upstream（baseUrl/apiKey/model/displayName/
// reasoningEffort/maxTokens），查网关 /models，重写 aicoding.customModels，
// 让 IDE 显示正确的模型名、上下文窗口、视觉/推理标记与思考档位。
//
// 用法：node sync-model.js [--root <dir>] [--id model_mocktest]
// 退出码：0 成功；2 配置缺失；3 网关查询失败；4 模型不存在；5 sqlite 失败
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./qoder-paths');

const argv = process.argv.slice(2);
const REPO = path.join(__dirname, '..');
const PROXY_DIR = path.join(REPO, 'qoder-proxy');

const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : '';
};

const ID = argOf('id') || 'model_mocktest';

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(PROXY_DIR, 'config.json'), 'utf8'));
} catch (e) {
  console.error(`config.json 读取失败: ${e.message}`);
  process.exit(2);
}
const up = cfg.upstream || {};
if (!up.baseUrl || !up.apiKey || !up.model) {
  console.error('upstream 未配置完整（baseUrl / apiKey / model）');
  process.exit(2);
}
const base = up.baseUrl.replace(/\/+$/, '');
console.log(`gateway: ${base}  model: ${up.model}`);

function rootDir() {
  const r = argOf('root');
  if (r) return r;
  if (cfg.ideRoot && Q.looksLikeIdeRoot(cfg.ideRoot)) return cfg.ideRoot;
  return Q.IS_MAC ? '/Applications/Qoder CN IDE.app' : 'D:\\Qoder IDE';
}
const APP = Q.appDirOf(rootDir());
if (!APP) {
  console.error(`找不到 Qoder 安装目录: ${rootDir()}`);
  process.exit(2);
}
const DB = path.join(Q.userDataDir(APP), 'User', 'globalStorage', 'state.vscdb');

// 单引号翻倍：拼进 SQL 的所有值必须过这里，displayName 里有 ' 时 UPDATE 才不会静默失败
const sqlLit = (v) => String(v).replace(/'/g, "''");

(async () => {
  let j;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${up.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(3); }
    j = await res.json();
  } catch (e) {
    console.error(`网关查询失败: ${e.message}`);
    process.exit(3);
  }
  const m = (j.data || []).find((x) => x.id === up.model);
  if (!m) { console.error(`model ${up.model} not found on gateway`); process.exit(4); }

  // 用户在控制台显式设的显示名原样使用；网关返回 "cn:xxx" / "a/b" 这类前缀时取最后一段
  let displayName;
  if (up.displayName) {
    displayName = up.displayName;
  } else {
    displayName = m.display_name || m.id;
    if (/^[a-z]+:/.test(displayName) || displayName.includes('/')) {
      displayName = m.id.split(/[/:]/).pop();
    }
  }
  // 兼容两种网关元数据格式：bigmodel 顶层 max_input_tokens/max_output_tokens/reasoning(_levels)；
  // opencode 的 limit.context/limit.output 与 capabilities.reasoning.{supported,effort}
  const caps = m.capabilities || {};
  const gwLimit = m.limit || {};
  const gwInput = Number(m.max_input_tokens) > 0 ? Number(m.max_input_tokens) : Number(gwLimit.context) || 0;
  const gwOutput = Number(m.max_output_tokens) > 0 ? Number(m.max_output_tokens) : Number(gwLimit.output) || 0;
  // 输入上限：控制台配的 contextLength 优先，其次网关报的值，最后退回默认
  const maxInput = Number(up.contextLength) > 0 ? Number(up.contextLength) : (gwInput > 0 ? gwInput : 128000);
  // 输出上限：控制台配的 maxTokens 优先，其次网关报的值
  const maxOutput = Number(up.maxTokens) > 0 ? Number(up.maxTokens) : (gwOutput > 0 ? gwOutput : 0);
  // 视觉标记：网关可能返回字面量 "image"，也可能是 MIME 形式 "image/jpeg"/"image/webp"（如 opencode），都算
  const isVl = ((m.modalities && m.modalities.input) || []).some((s) => s === 'image' || String(s).startsWith('image/'));
  const isReasoning = !!m.reasoning || !!(caps.reasoning && caps.reasoning.supported);
  const levels = (m.reasoning_levels || (caps.reasoning && caps.reasoning.effort) || []).filter(Boolean);

  let efforts = null;
  let defaultLevel = null;
  if (levels.length) {
    // 默认思考档位：控制台选的优先（前提是该模型支持这一档），否则退回第一档
    defaultLevel = up.reasoningEffort && levels.includes(up.reasoningEffort) ? up.reasoningEffort : levels[0];
    efforts = {};
    for (const l of levels) {
      efforts[l] = { display_name: { cn_zh: l, en_us: l }, isDefault: l === defaultLevel };
    }
  }

  const record = {
    id: ID,
    provider: 'deepseek',
    providerDisplayName: 'DeepSeek',
    model: 'local-model',
    displayName,
    baseUrl: up.baseUrl,
    apiKey: up.apiKey,
    visible: true,
    hasApiKey: true,
    is_vl: isVl,
    is_reasoning: isReasoning,
    max_input_tokens: maxInput,
    reasoningLabel: '思考等级',
    createTime: Date.now(),
  };
  if (maxOutput > 0) record.max_output_tokens = maxOutput;
  if (efforts) {
    record.thinkingConfig = {
      enabled: { isDefault: true, defaultEffortKey: defaultLevel, efforts },
      disabled: { isDefault: false },
    };
  }

  const json = JSON.stringify([record]);
  const sqlite = process.env.SQLITE3 || 'sqlite3';
  const sql = `UPDATE ItemTable SET value = CAST('${sqlLit(json)}' AS TEXT) WHERE key='aicoding.customModels';`;
  const r = spawnSync(sqlite, [DB, sql], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) {
    console.error(`sqlite 失败: ${(r.stderr || '').slice(0, 300)}`);
    process.exit(5);
  }

  console.log('record updated:');
  console.log(`  displayName       = ${displayName}`);
  console.log(`  max_input_tokens  = ${maxInput}`);
  console.log(`  is_vl             = ${isVl}`);
  console.log(`  is_reasoning      = ${isReasoning}  levels=${levels.join(',')}`);
  console.log(`  max_output_tokens = ${maxOutput}`);
  console.log('Restart Qoder IDE to reload the model list.');
})();
