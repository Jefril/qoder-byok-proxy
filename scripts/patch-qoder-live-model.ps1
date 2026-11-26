#Requires -Version 5.1
# Live model display: allow the renderer to call the local proxy /state endpoint
# and poll it so the model name in Qoder updates without a restart.
# Run elevated.
param([string]$Root = 'D:\Qoder IDE')

$ErrorActionPreference = 'Stop'
$logPath = (Join-Path $PSScriptRoot '_live_patch_log.txt')
function Log([string]$m) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m)
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}
if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force }

$app = Join-Path $Root 'resources\app'
$htmlFiles = @(
  (Join-Path $app 'out\vs\code\electron-browser\workbench\workbench.html'),
  (Join-Path $app 'out\lingma\agents-window\electron-browser\agents-window.html')
)
$jsFiles = @(
  (Join-Path $app 'out\vs\workbench\workbench.desktop.main.js'),
  (Join-Path $app 'out\lingma\agents-window\agents-window.desktop.main.js')
)

# 1) CSP: allow connect-src to the local proxy
$cspPattern = "connect-src\s+'self'\s+https:\s+ws:\s*;"
foreach ($f in $htmlFiles) {
  $t = [System.IO.File]::ReadAllText($f)
  if ($t -match '127\.0\.0\.1:8788') { Log "$(Split-Path $f -Leaf): CSP already patched"; continue }
  $hits = ([regex]::Matches($t, $cspPattern)).Count
  if ($hits -ne 1) { throw "CSP anchor count $hits in $f" }
  $t = [regex]::Replace($t, $cspPattern, "connect-src`n`t`t`t`t`t'self'`n`t`t`t`t`thttps:`n`t`t`t`t`tws:`n`t`t`t`t`thttp://127.0.0.1:8788`n`t`t`t`t;")
  [System.IO.File]::WriteAllText($f, $t, (New-Object System.Text.UTF8Encoding($false)))
  Log "$(Split-Path $f -Leaf): CSP patched"
}

# 2) Renderer: poll /state and hot-sync all model capability fields (v2).
#    v1 only synced displayName; v2 also syncs is_vl/is_reasoning/max tokens/thinkingConfig.
$anchor = 'this._registerGetCustomModelsHandler()}'
$pollerV1 = 'this._registerGetCustomModelsHandler();const _lm=this;setInterval(async()=>{try{const _r=await fetch("http://127.0.0.1:8788/state");const _j=await _r.json();if(!_j||!_j.displayName)return;const _m=_lm._models.find(x=>x.id===(_j.recordId||"model_mocktest"));if(_m&&_m.displayName!==_j.displayName){_m.displayName=_j.displayName;_lm._storeModels(!1);_lm._onDidChangeModels.fire(_lm.getModels())}}catch{}},3000)}'
$poller = 'this._registerGetCustomModelsHandler();const _lm=this;setInterval(async()=>{try{const _r=await fetch("http://127.0.0.1:8788/state");const _j=await _r.json();if(!_j)return;const _m=_lm._models&&_lm._models.find(x=>x.id===(_j.recordId||"model_mocktest"));if(!_m)return;const _cur=JSON.stringify([_m.displayName,_m.is_vl,_m.is_reasoning,_m.max_input_tokens,_m.max_output_tokens,_m.thinkingConfig]);const _nw=JSON.stringify([_j.displayName,_j.is_vl,_j.is_reasoning,_j.max_input_tokens,_j.max_output_tokens,_j.thinkingConfig]);if(_cur!==_nw){_m.displayName=_j.displayName;_m.is_vl=_j.is_vl;_m.is_reasoning=_j.is_reasoning;_m.max_input_tokens=_j.max_input_tokens;_m.max_output_tokens=_j.max_output_tokens;_m.thinkingConfig=_j.thinkingConfig;_lm._storeModels(!1);_lm._onDidChangeModels.fire(_lm.getModels())}}catch{}},3000)}'
foreach ($f in $jsFiles) {
  $t = [System.IO.File]::ReadAllText($f)
  if ($t.Contains('_cur=JSON.stringify([_m.displayName')) { Log "$(Split-Path $f -Leaf): poller v2 already present"; continue }
  if ($t.Contains($pollerV1)) {
    $t = $t.Replace($pollerV1, $poller)
    [System.IO.File]::WriteAllText($f, $t, (New-Object System.Text.UTF8Encoding($false)))
    Log "$(Split-Path $f -Leaf): poller upgraded v1 -> v2"
    continue
  }
  $hits = ([regex]::Matches($t, [regex]::Escape($anchor))).Count
  if ($hits -ne 1) { throw "poller anchor count $hits in $f" }
  $t = $t.Replace($anchor, $poller)
  [System.IO.File]::WriteAllText($f, $t, (New-Object System.Text.UTF8Encoding($false)))
  Log "$(Split-Path $f -Leaf): poller patched (v2)"
}

# 3) Refresh checksums
function Get-ChecksumB64([string]$p) {
  $sha = [System.Security.Cryptography.SHA256]::Create(); $fs = [System.IO.File]::OpenRead($p)
  try { $h = $sha.ComputeHash($fs) } finally { $fs.Dispose(); $sha.Dispose() }
  return [Convert]::ToBase64String($h).TrimEnd('=')
}
$map = [ordered]@{
  'vs/workbench/workbench.desktop.main.js'                            = $jsFiles[0]
  'lingma/agents-window/agents-window.desktop.main.js'                = $jsFiles[1]
  'vs/code/electron-browser/workbench/workbench.html'                 = $htmlFiles[0]
  'lingma/agents-window/electron-browser/agents-window.html'          = $htmlFiles[1]
}
foreach ($jsonName in @('product.json', 'featureFlags.json')) {
  $path = Join-Path $app $jsonName
  $jt = [System.IO.File]::ReadAllText($path)
  $changed = 0
  foreach ($k in $map.Keys) {
    $hash = Get-ChecksumB64 $map[$k]
    $m = [regex]::Match($jt, '"' + [regex]::Escape($k) + '"\s*:\s*"([^"]+)"')
    if (-not $m.Success) { Log "$jsonName :: key missing $k"; continue }
    if ($m.Groups[1].Value -eq $hash) { continue }
    $jt = $jt.Replace($m.Groups[1].Value, $hash); $changed++
  }
  if ($changed -gt 0) {
    [System.IO.File]::WriteAllText($path, $jt, (New-Object System.Text.UTF8Encoding($false)))
    Log "$jsonName checksums updated ($changed)"
  }
}
Log 'LIVE PATCH DONE'
