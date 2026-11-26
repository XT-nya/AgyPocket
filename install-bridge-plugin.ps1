param(
    [string]$ProjectId = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginSrc = Join-Path $RepoRoot "plugin\agy-pocket-bridge"
$GeminiRoot = Join-Path $env:USERPROFILE ".gemini"
$PluginDest = Join-Path $GeminiRoot "config\plugins\agy-pocket-bridge"
$ConfigPath = Join-Path $GeminiRoot "config\config.json"
$ProjectsDir = Join-Path $GeminiRoot "config\projects"

if (-not (Test-Path $PluginSrc)) {
    throw "Plugin source folder not found: $PluginSrc"
}

$NodeCmd = Get-Command node -ErrorAction Stop
$NodeExe = $NodeCmd.Source

Write-Host "[AgyPocket] Installing official bridge plugin to $PluginDest ..."
New-Item -ItemType Directory -Force -Path $PluginDest | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PluginDest "hooks") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PluginDest "sidecars\bridge") | Out-Null

Copy-Item -Path (Join-Path $PluginSrc "plugin.json") -Destination (Join-Path $PluginDest "plugin.json") -Force
Copy-Item -Path (Join-Path $PluginSrc "hooks\hook_relay.mjs") -Destination (Join-Path $PluginDest "hooks\hook_relay.mjs") -Force
Copy-Item -Path (Join-Path $PluginSrc "sidecars\bridge\sidecar.json") -Destination (Join-Path $PluginDest "sidecars\bridge\sidecar.json") -Force
Copy-Item -Path (Join-Path $PluginSrc "sidecars\bridge\server.mjs") -Destination (Join-Path $PluginDest "sidecars\bridge\server.mjs") -Force

$env:AGYPOCKET_INSTALL_PLUGIN_DEST = $PluginDest
$env:AGYPOCKET_INSTALL_CONFIG_PATH = $ConfigPath
$env:AGYPOCKET_INSTALL_PROJECTS_DIR = $ProjectsDir
$env:AGYPOCKET_INSTALL_PROJECT_ID = $ProjectId
$env:AGYPOCKET_INSTALL_NODE_EXE = $NodeExe

$NodeScript = @'
const fs = require('node:fs');
const path = require('node:path');

const pluginDest = process.env.AGYPOCKET_INSTALL_PLUGIN_DEST;
const configPath = process.env.AGYPOCKET_INSTALL_CONFIG_PATH;
const projectsDir = process.env.AGYPOCKET_INSTALL_PROJECTS_DIR;
let projectId = (process.env.AGYPOCKET_INSTALL_PROJECT_ID || '').trim();
const nodeExeRaw = (process.env.AGYPOCKET_INSTALL_NODE_EXE || 'node').replace(/\\/g, '/');
const nodeBin = /\s/.test(nodeExeRaw) ? `"${nodeExeRaw}"` : nodeExeRaw;

const hookScriptRaw = path.join(pluginDest, 'hooks', 'hook_relay.mjs').replace(/\\/g, '/');
const quotedHook = /\s/.test(hookScriptRaw) ? `"${hookScriptRaw}"` : hookScriptRaw;

const hooksPayload = {
  'agy-pocket-bridge-hooks': {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `${nodeBin} ${quotedHook} PreToolUse`,
            timeout: 120,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `${nodeBin} ${quotedHook} PostToolUse`,
            timeout: 5,
          },
        ],
      },
    ],
    PreInvocation: [
      {
        type: 'command',
        command: `${nodeBin} ${quotedHook} PreInvocation`,
        timeout: 5,
      },
    ],
    Stop: [
      {
        type: 'command',
        command: `${nodeBin} ${quotedHook} Stop`,
        timeout: 5,
      },
    ],
  },
};

function atomicWrite(target, obj) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

atomicWrite(path.join(pluginDest, 'hooks.json'), hooksPayload);

let cfg = {};
if (fs.existsSync(configPath)) {
  const backupPath = `${configPath}.agypocket.bak`;
  fs.copyFileSync(configPath, backupPath);
  console.log(`[AgyPocket] Backed up config.json to ${backupPath}`);
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    cfg = {};
  }
}

if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
cfg.plugins['agy-pocket-bridge'] = { enabled: true };

if (!cfg.sidecars || typeof cfg.sidecars !== 'object') cfg.sidecars = {};
const existingSidecar = cfg.sidecars['agy-pocket-bridge/bridge'] || {};
cfg.sidecars['agy-pocket-bridge/bridge'] = {
  ...existingSidecar,
  enabled: true,
  schemaVersion: existingSidecar.schemaVersion || 1,
};

atomicWrite(configPath, cfg);
console.log('[AgyPocket] Installed agy-pocket-bridge successfully!');
console.log('[AgyPocket] Please restart Antigravity Desktop App once to activate the Sidecar and Hooks.');
'@

$NodeScript | & $NodeExe -
if ($LASTEXITCODE -ne 0) {
    throw "Node configuration step failed with exit code $LASTEXITCODE"
}
