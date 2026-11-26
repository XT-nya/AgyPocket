[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CfExeName = "cloudflared" + ".exe"
$BinCf = Join-Path $Root ("bin\" + $CfExeName)
$VenvPy = Join-Path $Root "backend\.venv\Scripts\python.exe"
$BackendDir = Join-Path $Root "backend"
$FrontendIndex = Join-Path $Root "frontend\dist\index.html"
$QrPngPath = Join-Path $Root "pair_qr.png"
$LogOut = Join-Path $Root "backend.stdout.log"
$LogErr = Join-Path $Root "backend.stderr.log"

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "       AgyPocket · 反重力随身远程终端启动器" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan

if (-not (Test-Path $VenvPy)) {
    Write-Host "[错误] 未找到 Python 虚拟环境: $VenvPy" -ForegroundColor Red
    Write-Host "请先运行: python -m venv backend\.venv && .\backend\.venv\Scripts\pip.exe install -r backend\requirements.txt" -ForegroundColor Yellow
    Pause
    exit 1
}
if (-not (Test-Path $FrontendIndex)) {
    Write-Host "[错误] 前端尚未构建，请先在 frontend 目录执行 npm install && npm run build" -ForegroundColor Red
    Pause
    exit 1
}

function Find-CloudflaredBinary {
    param([string]$ConfiguredPath)
    if ($ConfiguredPath -and (Test-Path $ConfiguredPath)) { return $ConfiguredPath }
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    if (Test-Path $BinCf) { return $BinCf }
    return $null
}

function Get-LocalLanIp {
    try {
        if (Get-Command Get-NetIPConfiguration -ErrorAction SilentlyContinue) {
            $virtualRe = 'VirtualBox|VMware|Hyper-V|vEthernet|TAP-Windows|Loopback|Bluetooth|Npcap|WSL'
            $cfgs = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {
                $_.IPv4DefaultGateway -and
                $_.IPv4Address -and
                ($_.InterfaceAlias -notmatch $virtualRe) -and
                ($_.InterfaceDescription -notmatch $virtualRe)
            }
            $candidates = @()
            foreach ($c in $cfgs) {
                foreach ($addr in $c.IPv4Address) {
                    $ip = [string]$addr.IPAddress
                    if ($ip -and $ip -notmatch '^127\.' -and $ip -notmatch '^169\.254\.') {
                        $candidates += [pscustomobject]@{
                            IP    = $ip
                            Alias = [string]$c.InterfaceAlias
                        }
                    }
                }
            }
            $wifi = $candidates | Where-Object { $_.Alias -match 'WLAN|Wi-?Fi' -and $_.IP -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } | Select-Object -First 1
            if ($wifi) { return $wifi.IP }
            $priv = $candidates | Where-Object { $_.IP -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } | Select-Object -First 1
            if ($priv) { return $priv.IP }
            $anyCand = $candidates | Select-Object -First 1
            if ($anyCand) { return $anyCand.IP }
        }
    } catch {}
    try {
        if (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) {
            $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.IPAddress -notmatch '^127\.' -and
                    $_.IPAddress -notmatch '^169\.254\.' -and
                    $_.AddressState -eq 'Preferred' -and
                    $_.InterfaceAlias -notmatch 'VirtualBox|VMware|Hyper-V|vEthernet|TAP-Windows|Loopback|Bluetooth|Npcap|WSL'
                } |
                Select-Object -ExpandProperty IPAddress
            $pref = $ips | Where-Object { $_ -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } | Select-Object -First 1
            if ($pref) { return $pref }
            $first = $ips | Select-Object -First 1
            if ($first) { return $first }
        }
    } catch {}
    try {
        $addrs = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
            ForEach-Object { $_.IPAddressToString } |
            Where-Object { $_ -notmatch '^127\.' -and $_ -notmatch '^169\.254\.' }
        $first = $addrs | Select-Object -First 1
        if ($first) { return $first }
    } catch {}
    return "127.0.0.1"
}

function Normalize-ExternalUrl {
    param([string]$RawInput)
    $raw = ([string]$RawInput).Trim().TrimEnd('/')
    if (-not $raw) { return "" }
    if ($raw -match '^https?://') {
        try {
            $u = [System.Uri]$raw
            if ($u.Host) { return $raw }
        } catch {}
        return ""
    }
    if ($raw -match '^(\d{1,3}\.){3}\d{1,3}(:\d+)?(/.*)?$' -or $raw -match '^localhost(:\d+)?(/.*)?$') {
        return "http://$raw"
    }
    if ($raw -match '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(/.*)?$') {
        return "https://$raw"
    }
    return ""
}

function Save-SettingsFields {
    param([hashtable]$Fields)
    $env:AGY_PATCH_JSON = ($Fields | ConvertTo-Json -Compress)
    & $VenvPy -c "
import json, os
from app.config import load_settings, save_settings
patch = json.loads(os.environ['AGY_PATCH_JSON'])
s = load_settings()
save_settings(s.model_copy(update=patch))
" | Out-Null
    Remove-Item Env:AGY_PATCH_JSON -ErrorAction SilentlyContinue
}

# Check agy CLI login hint (non-blocking)
$agyExe = "$env:LOCALAPPDATA\agy\bin\agy.exe"
if (-not (Test-Path $agyExe)) {
    $cmdAgy = Get-Command agy -ErrorAction SilentlyContinue
    if ($cmdAgy) { $agyExe = $cmdAgy.Source } else { $agyExe = $null }
}
if ($agyExe) {
    Write-Host "[检查] 已检测到官方 agy CLI: $agyExe" -ForegroundColor DarkGray
} else {
    Write-Host "[提示] 未检测到官方 agy CLI，Tab 2 电脑遥控可正常使用，Tab 1 对话需先安装 agy。" -ForegroundColor Yellow
}

$env:PYTHONPATH = $BackendDir
$InitInfo = & $VenvPy -c "
import json
from app.config import load_settings, load_auth_store
from app.main import app
s = load_settings()
a = load_auth_store()
print(json.dumps({
    'port': s.port,
    'needs_setup': not bool(a.passphrase_hash),
    'tunnel_mode': s.tunnel_mode,
    'external_public_url': s.external_public_url,
    'device_name': s.device_name,
    'connection_mode': s.connection_mode,
    'cloudflared_path': s.cloudflared_path,
    'app_version': app.version,
}))
" | ConvertFrom-Json

$Port = [int]$InitInfo.port
$ExpectedVersion = [string]$InitInfo.app_version
$TunnelMode = [string]$InitInfo.tunnel_mode
$ExternalUrl = ([string]$InitInfo.external_public_url).Trim().TrimEnd('/')
$DeviceName = [string]$InitInfo.device_name
$ConnectionMode = [string]$InitInfo.connection_mode
$CloudflaredFound = Find-CloudflaredBinary -ConfiguredPath ([string]$InitInfo.cloudflared_path)

if ($CloudflaredFound) {
    Write-Host "[检查] 已检测到 cloudflared: $CloudflaredFound" -ForegroundColor DarkGray
} else {
    Write-Host "[提示] 未检测到 cloudflared（如需使用 Cloudflare 免费隧道可自行安装并加入 PATH；当前支持 external/局域网模式）。" -ForegroundColor DarkGray
}

if ($InitInfo.needs_setup) {
    Write-Host ""
    Write-Host "[首次配置] 请设置用于手机手动登录的高强度访问口令（至少 6 位）：" -ForegroundColor Yellow
    while ($true) {
        $sec1 = Read-Host "输入访问口令" -AsSecureString
        $sec2 = Read-Host "再次确认口令" -AsSecureString
        $p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec1))
        $p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec2))
        if ($p1.Length -lt 6) {
            Write-Host "口令长度至少 6 位，请重试。" -ForegroundColor Red
            continue
        }
        if ($p1 -ne $p2) {
            Write-Host "两次输入不一致，请重试。" -ForegroundColor Red
            continue
        }
        $env:AGY_INIT_PASS = $p1
        & $VenvPy -c "
import os
from app.config import load_auth_store, save_auth_store
from app.security.auth import hash_passphrase
store = load_auth_store()
salt, h = hash_passphrase(os.environ['AGY_INIT_PASS'])
store.passphrase_salt = salt
store.passphrase_hash = h
save_auth_store(store)
print('AUTH_SETUP_OK')
" | Out-Null
        Remove-Item Env:AGY_INIT_PASS -ErrorAction SilentlyContinue
        $p1 = ""; $p2 = ""
        Write-Host "[完成] 访问口令已加盐哈希保存（本地不存明文）。" -ForegroundColor Green
        break
    }
}

# Onboarding for external URL when unset
if ($TunnelMode -eq "external" -and -not $ExternalUrl) {
    $LanIp = Get-LocalLanIp
    $SuggestedLanUrl = "http://${LanIp}:${Port}"
    Write-Host ""
    Write-Host "[接入引导] 当前为 external 模式且尚未配置接入地址。" -ForegroundColor Yellow
    Write-Host "  本机局域网建议地址: $SuggestedLanUrl" -ForegroundColor Cyan
    Write-Host "  - 直接回车: 使用局域网地址（适合同 Wi-Fi / Tailscale 直连）" -ForegroundColor DarkGray
    Write-Host "  - 输入公网穿透地址 (如 https://xxx.example.com:8443 或节点域名:端口): 适合 SakuraFrp / 自建 frp" -ForegroundColor DarkGray
    if ($CloudflaredFound) {
        Write-Host "  - 输入 cf: 自动切换到 Cloudflare 免费临时隧道 (Temp 模式)" -ForegroundColor DarkGray
    }
    while ($true) {
        $choice = (Read-Host "请输入接入地址或选项 [默认 $SuggestedLanUrl]").Trim()
        if ($choice -eq "cf" -and $CloudflaredFound) {
            $TunnelMode = "quick"
            $ConnectionMode = "temp"
            Save-SettingsFields -Fields @{ tunnel_mode = "quick"; connection_mode = "temp" }
            Write-Host "[已切换] 使用 Cloudflare 临时隧道 (connection_mode = temp)" -ForegroundColor Green
            break
        }
        if (-not $choice) {
            $ExternalUrl = $SuggestedLanUrl
            Save-SettingsFields -Fields @{ tunnel_mode = "external"; external_public_url = $ExternalUrl }
            Write-Host "[完成] 已保存局域网接入地址: $ExternalUrl" -ForegroundColor Green
            break
        }
        $normalized = Normalize-ExternalUrl -RawInput $choice
        if ($normalized) {
            if ($normalized -ne $choice.TrimEnd('/')) {
                Write-Host "[提示] 已自动补全协议头为: $normalized" -ForegroundColor Cyan
            }
            $ExternalUrl = $normalized
            Save-SettingsFields -Fields @{ tunnel_mode = "external"; external_public_url = $ExternalUrl }
            Write-Host "[完成] 已保存接入地址: $ExternalUrl" -ForegroundColor Green
            break
        }
        Write-Host "[提示] 未能识别该地址格式，请重新输入完整网址（例如 https://node.example.com:8443），或直接回车使用局域网地址。" -ForegroundColor Red
    }
}

$NeedLanBind = ($TunnelMode -eq "external") -and ($ExternalUrl -match '^https?://(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|100\.)')
$ListenHost = if ($NeedLanBind) { "0.0.0.0" } else { "127.0.0.1" }

$ServerProc = $null
$ServerActualPid = $null
$StartedOwnServer = $false
$ReusedExisting = $false
$ReachedInteractive = $false
$ExplicitShutdown = $false
$BaseLocal = "http://127.0.0.1:$Port"

function Get-PortListenerPids {
    param([int]$TargetPort)
    $pidSet = New-Object System.Collections.Generic.HashSet[int]
    $usedNetTcp = $false
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            $conns = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop
            $usedNetTcp = $true
            foreach ($c in $conns) {
                if ($c -and $c.OwningProcess -gt 0) {
                    [void]$pidSet.Add([int]$c.OwningProcess)
                }
            }
        }
    } catch {
        if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $_.Exception.Message -match 'No MSFT_NetTCPConnection objects found|找不到任何匹配的 MSFT_NetTCPConnection') {
            $usedNetTcp = $true
        } else {
            $usedNetTcp = $false
        }
    } finally {
        $ErrorActionPreference = $prevPref
    }
    if (-not $usedNetTcp) {
        $prevPref2 = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $lines = & netstat.exe -ano -p TCP 2>$null
            foreach ($line in $lines) {
                if ($line -match "^\s*TCP\s+\S+:$TargetPort\s+\S+\s+LISTENING\s+(\d+)\s*$") {
                    $procId = [int]$Matches[1]
                    if ($procId -gt 0) {
                        [void]$pidSet.Add($procId)
                    }
                }
            }
        } catch {} finally {
            $ErrorActionPreference = $prevPref2
        }
    }
    if ($pidSet.Count -gt 0) {
        $pidSet | Sort-Object
    }
}

function Stop-ProcessTreeSafe {
    param([int]$TargetPid)
    if ($TargetPid -le 0) { return }
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & taskkill.exe /PID $TargetPid /T /F 2>&1 | Out-Null
    } catch {} finally {
        $ErrorActionPreference = $prevPref
    }
}

function Clear-StalePortOwner {
    param(
        [int]$TargetPort,
        [string]$LocalBaseUrl
    )
    $listenerPids = @(Get-PortListenerPids -TargetPort $TargetPort)
    if ($listenerPids.Count -eq 0) {
        return
    }

    $healthIsAgyPocket = $false
    $prevHealthPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $h = Invoke-RestMethod -Uri "$LocalBaseUrl/api/health" -TimeoutSec 2
        if ($h -and $h.service -eq "agypocket") {
            $healthIsAgyPocket = $true
        }
    } catch {} finally {
        $ErrorActionPreference = $prevHealthPref
    }

    $tunnelKilled = $false
    foreach ($p in $listenerPids) {
        $proc = $null
        $parentProc = $null
        $fallbackProc = $null
        $prevCimPref = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $p" -ErrorAction SilentlyContinue
            if ($proc -and $proc.ParentProcessId -gt 0) {
                $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue
            }
            if (-not $proc) {
                $fallbackProc = Get-Process -Id $p -ErrorAction SilentlyContinue
            }
        } catch {} finally {
            $ErrorActionPreference = $prevCimPref
        }

        if (-not $proc -and -not $fallbackProc) {
            continue
        }

        $procName = if ($proc -and $proc.Name) { [string]$proc.Name } elseif ($fallbackProc -and $fallbackProc.ProcessName) { [string]$fallbackProc.ProcessName } else { "unknown" }
        $procCmd = if ($proc -and $proc.CommandLine) { [string]$proc.CommandLine } else { "" }
        $parentName = if ($parentProc -and $parentProc.Name) { [string]$parentProc.Name } else { "" }
        $parentCmd = if ($parentProc -and $parentProc.CommandLine) { [string]$parentProc.CommandLine } else { "" }

        $isAgyPocket = ($procCmd -match 'app\.main:app|agy-pocket') -or ($parentCmd -match 'app\.main:app|agy-pocket') -or $healthIsAgyPocket
        if ($isAgyPocket) {
            Write-Host "[清理] 检测到旧版 AgyPocket 后台进程 (PID $p) 占用端口 $TargetPort，正在安全终止..." -ForegroundColor Yellow
            if (-not $tunnelKilled) {
                $prevKillPref = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                try { Invoke-RestMethod -Uri "$LocalBaseUrl/api/tunnel/kill" -Method Post -TimeoutSec 2 | Out-Null } catch {} finally { $ErrorActionPreference = $prevKillPref }
                $tunnelKilled = $true
            }
            if ($parentProc -and $parentProc.ProcessId -gt 0 -and $parentProc.ProcessId -ne $PID -and ($parentName -match '^python') -and (($parentCmd -match 'app\.main:app|agy-pocket') -or ($procCmd -match 'app\.main:app|agy-pocket'))) {
                Stop-ProcessTreeSafe -TargetPid ([int]$parentProc.ProcessId)
            }
            Stop-ProcessTreeSafe -TargetPid $p
        } else {
            Write-Host "[错误] 端口 $TargetPort 已被其他程序占用 ($procName, PID $p)，请先关闭占用程序或修改 config\settings.json 中的 port。" -ForegroundColor Red
            Pause
            exit 1
        }
    }

    $portCleared = $false
    for ($i = 0; $i -lt 15; $i++) {
        $remaining = @(Get-PortListenerPids -TargetPort $TargetPort)
        if ($remaining.Count -eq 0) {
            $portCleared = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $portCleared) {
        $remaining = @(Get-PortListenerPids -TargetPort $TargetPort)
        Write-Host "[错误] 无法释放端口 $TargetPort（仍被 PID $($remaining -join ', ') 占用），请手动关闭相关进程后重试。" -ForegroundColor Red
        Pause
        exit 1
    }
}

function Show-PairingAndUrl {
    param([string]$PublicUrl)
    try {
        $pairResp = Invoke-RestMethod -Uri "$BaseLocal/api/auth/pair-token" -Method Post -TimeoutSec 5
        $relPath = if ($pairResp.qr_path) { [string]$pairResp.qr_path } else { [string]$pairResp.pair_path }
        $pairFull = "$PublicUrl$relPath"

        & $VenvPy -c "
import sys, qrcode
url = sys.argv[1]
png = sys.argv[2]
qr = qrcode.QRCode(border=2)
qr.add_data(url)
qr.make(fit=True)
qr.make_image(fill_color='black', back_color='white').save(png)
qr.print_ascii(invert=True)
" $pairFull $QrPngPath

        $modeLabel = if ($pairResp.mode) { [string]$pairResp.mode } else { $ConnectionMode }
        $devLabel = if ($pairResp.device_name) { [string]$pairResp.device_name } else { $DeviceName }

        Write-Host ""
        Write-Host "-----------------------------------------------------" -ForegroundColor DarkCyan
        Write-Host "设备名称: $devLabel   |   连接模式: $modeLabel" -ForegroundColor Cyan
        Write-Host "【方式 1】手机手动输入 / 复制粘贴以下纯文本网址（需输口令）：" -ForegroundColor Green
        Write-Host "  $PublicUrl" -ForegroundColor White
        Write-Host ""
        Write-Host "【方式 2】AgyPocket App / 浏览器直接扫码上方二合一二维码（2分钟有效，免输密码直进）：" -ForegroundColor Yellow
        Write-Host "  配对链接: $pairFull" -ForegroundColor DarkGray
        Write-Host "  二维码图片已同步保存至: $QrPngPath" -ForegroundColor DarkGray
        Write-Host "-----------------------------------------------------" -ForegroundColor DarkCyan
        Write-Host "快捷键：[R] 刷新二维码  [O] 打开图片  [M] 切换 fixed/temp  [U] 更新外部地址  [N] 重建隧道  [K] 注销全部设备  [Q] 彻底停止" -ForegroundColor Cyan
        Write-Host "提示：直接点窗口右上角 [×] 关闭本窗口时，后端与隧道会保持后台常驻不断线；下次启动自动复用。" -ForegroundColor DarkGray
    } catch {
        Write-Host "[警告] 生成配对码失败: $_" -ForegroundColor Red
    }
}

try {
    $reusableHealth = $null
    $prevReusePref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $cand = Invoke-RestMethod -Uri "$BaseLocal/api/health" -TimeoutSec 2
        if ($cand -and $cand.ok -and $cand.service -eq "agypocket" -and $cand.version -eq $ExpectedVersion) {
            $reusableHealth = $cand
        }
    } catch {} finally {
        $ErrorActionPreference = $prevReusePref
    }

    if ($reusableHealth) {
        $bindOk = $true
        if ($NeedLanBind) {
            $bindOk = $false
            try {
                $boundAny = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -eq "0.0.0.0" -or $_.LocalAddress -eq "::" }
                if ($boundAny) { $bindOk = $true }
            } catch {}
        }
        if ($bindOk) {
            $ReusedExisting = $true
            $StartedOwnServer = $true
            if ($reusableHealth.pid) { $ServerActualPid = [int]$reusableHealth.pid }
            Write-Host "[1/3] 检测到同版本 AgyPocket (v$ExpectedVersion, PID $ServerActualPid) 已在后台运行，直接复用！" -ForegroundColor Green
        } else {
            $reusableHealth = $null
        }
    }
    if (-not $reusableHealth) {
        Clear-StalePortOwner -TargetPort $Port -LocalBaseUrl $BaseLocal

        Write-Host "[1/3] 启动 AgyPocket 本地安全网关 (${ListenHost}:$Port)..." -ForegroundColor Cyan
        if ($NeedLanBind) {
            Write-Host "[提示] 已启用局域网/虚拟局域网监听 (0.0.0.0:$Port)，若手机仍连不上请放行 Windows 防火墙端口 $Port。" -ForegroundColor DarkGray
        }
        $InstanceId = [guid]::NewGuid().ToString("N")
        $env:AGYPOCKET_INSTANCE_ID = $InstanceId
        try {
            $ServerProc = Start-Process -FilePath $VenvPy `
                -ArgumentList "-m", "uvicorn", "app.main:app", "--host", $ListenHost, "--port", "$Port" `
                -WorkingDirectory $BackendDir `
                -RedirectStandardOutput $LogOut `
                -RedirectStandardError $LogErr `
                -WindowStyle Hidden `
                -PassThru
        } finally {
            Remove-Item Env:AGYPOCKET_INSTANCE_ID -ErrorAction SilentlyContinue
        }

        $healthy = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            if ($ServerProc.HasExited) {
                Write-Host "[错误] 后端进程启动后立即退出，错误日志如下：" -ForegroundColor Red
                if (Test-Path $LogErr) {
                    try {
                        Get-Content -Path $LogErr -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed }
                    } catch {}
                }
                exit 1
            }
            try {
                $h = Invoke-RestMethod -Uri "$BaseLocal/api/health" -TimeoutSec 2
                if ($h.ok -and $h.instance_id -eq $InstanceId) {
                    $healthy = $true
                    $StartedOwnServer = $true
                    if ($h.pid) { $ServerActualPid = [int]$h.pid }
                    break
                }
            } catch {}
        }
        if (-not $healthy) {
            Write-Host "[错误] 后端服务启动超时，请查看 $LogErr" -ForegroundColor Red
            exit 1
        }
    }

    $PublicUrl = ""
    if ($TunnelMode -eq "external" -and $ExternalUrl) {
        Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/start" -Method Post -TimeoutSec 5 | Out-Null
        $PublicUrl = $ExternalUrl
        Write-Host "[2/3] 使用外部 / 局域网接入地址: $PublicUrl" -ForegroundColor Green
    } else {
        $st = Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/status" -TimeoutSec 3
        $canReuseTunnel = $false
        if ($ReusedExisting -and $st.status -eq "running" -and $st.connected -and $st.public_url) {
            if ($st.metrics_addr) {
                $prevReadyPref = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                try {
                    $readyResp = Invoke-WebRequest -Uri "http://$($st.metrics_addr)/ready" -UseBasicParsing -TimeoutSec 2
                    if ($readyResp.StatusCode -eq 200) { $canReuseTunnel = $true }
                } catch {} finally {
                    $ErrorActionPreference = $prevReadyPref
                }
            } else {
                $canReuseTunnel = $true
            }
        }

        if ($canReuseTunnel) {
            $PublicUrl = $st.public_url
            Write-Host "[2/3] 直接复用已在线的 Cloudflare 隧道: $PublicUrl" -ForegroundColor Green
        } else {
            $needRestart = ($st.status -in @("degraded", "error")) -or ($st.status -eq "running" -and -not $st.connected) -or ($ReusedExisting -and $st.status -eq "running")
            if ($needRestart) {
                Write-Host "[2/3] 检测到隧道需刷新，正在重建 Cloudflare 隧道..." -ForegroundColor Cyan
                Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/restart" -Method Post -TimeoutSec 8 | Out-Null
            } else {
                Write-Host "[2/3] 正在启动 Cloudflare 隧道..." -ForegroundColor Cyan
                Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/start" -Method Post -TimeoutSec 5 | Out-Null
            }

            for ($i = 0; $i -lt 45; $i++) {
                Start-Sleep -Milliseconds 800
                $st = Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/status" -TimeoutSec 3
                if ($st.public_url) {
                    $PublicUrl = $st.public_url
                    break
                }
                if ($st.status -eq "error") {
                    Write-Host "[错误] Cloudflare 隧道启动失败: $($st.last_error)" -ForegroundColor Red
                    exit 1
                }
            }

            if (-not $PublicUrl) {
                Write-Host "[错误] 未能在预期时间内获取到 Cloudflare 隧道网址，请检查网络连接或改用 external 模式。" -ForegroundColor Red
                exit 1
            }
        }
    }

    Write-Host "[3/3] 通道已就绪！生成接入地址与二维码..." -ForegroundColor Green
    Show-PairingAndUrl -PublicUrl $PublicUrl
    $ReachedInteractive = $true

    $healthTicks = 0
    while ($true) {
        if ($ServerProc) {
            if ($ServerProc.HasExited) {
                Write-Host "[异常] 后端进程意外退出。" -ForegroundColor Red
                break
            }
        } elseif ($ReusedExisting) {
            $healthTicks++
            if ($healthTicks -ge 10) {
                $healthTicks = 0
                $stillAlive = $false
                $prevLoopPref = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                try {
                    $chk = Invoke-RestMethod -Uri "$BaseLocal/api/health" -TimeoutSec 2
                    if ($chk -and $chk.ok) { $stillAlive = $true }
                } catch {} finally {
                    $ErrorActionPreference = $prevLoopPref
                }
                if (-not $stillAlive) {
                    Write-Host "[异常] 后台后端服务已停止。" -ForegroundColor Red
                    break
                }
            }
        }
        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            switch ($key.Key) {
                "R" {
                    Write-Host "`n[操作] 正在刷新 2 分钟一次性二合一配对码..." -ForegroundColor Cyan
                    Show-PairingAndUrl -PublicUrl $PublicUrl
                }
                "O" {
                    if (Test-Path $QrPngPath) { Start-Process $QrPngPath }
                }
                "M" {
                    $ConnectionMode = if ($ConnectionMode -eq "fixed") { "temp" } else { "fixed" }
                    Save-SettingsFields -Fields @{ connection_mode = $ConnectionMode }
                    Write-Host "`n[模式] 已切换连接模式为: $ConnectionMode，正在刷新配对码..." -ForegroundColor Cyan
                    Show-PairingAndUrl -PublicUrl $PublicUrl
                }
                "U" {
                    Write-Host ""
                    $rawExt = Read-Host "请输入新的外部/局域网地址 (如 https://node.example.com:8443，留空取消)"
                    $trimmedExt = ([string]$rawExt).Trim()
                    if ($trimmedExt) {
                        $newExt = Normalize-ExternalUrl -RawInput $trimmedExt
                        if ($newExt) {
                            $TunnelMode = "external"
                            $ExternalUrl = $newExt
                            $PublicUrl = $newExt
                            Save-SettingsFields -Fields @{ tunnel_mode = "external"; external_public_url = $ExternalUrl }
                            try { Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/start" -Method Post -TimeoutSec 5 | Out-Null } catch {}
                            Write-Host "[完成] 已更新接入地址为 $PublicUrl，正在刷新二维码..." -ForegroundColor Green
                            if ($newExt -match '^https?://(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|100\.)' -and $ListenHost -eq "127.0.0.1") {
                                Write-Host "[提示] 当前服务仅监听 127.0.0.1，如需局域网直连请按 [Q] 退出后重新打开启动器。" -ForegroundColor Yellow
                            }
                            Show-PairingAndUrl -PublicUrl $PublicUrl
                        } else {
                            Write-Host "[警告] 未能识别的地址格式，请提供有效域名或 IP 地址。" -ForegroundColor Yellow
                        }
                    }
                }
                "N" {
                    if ($TunnelMode -eq "external" -and $ExternalUrl) {
                        Write-Host "`n[提示] 当前使用外部地址 ($PublicUrl)，已刷新配对二维码。" -ForegroundColor Cyan
                        Show-PairingAndUrl -PublicUrl $PublicUrl
                    } else {
                        Write-Host "`n[操作] 正在强制重建隧道..." -ForegroundColor Cyan
                        try {
                            Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/restart" -Method Post -TimeoutSec 8 | Out-Null
                            $newUrl = ""
                            for ($j = 0; $j -lt 35; $j++) {
                                Start-Sleep -Milliseconds 800
                                $st2 = Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/status" -TimeoutSec 3
                                if ($st2.public_url) { $newUrl = $st2.public_url; break }
                                if ($st2.status -eq "error") { throw "隧道重建失败: $($st2.last_error)" }
                            }
                            if (-not $newUrl) { throw "隧道重建超时" }
                            $PublicUrl = $newUrl
                            Show-PairingAndUrl -PublicUrl $PublicUrl
                        } catch {
                            Write-Host "[警告] 重建隧道失败: $_" -ForegroundColor Red
                        }
                    }
                }
                "K" {
                    Invoke-RestMethod -Uri "$BaseLocal/api/auth/revoke-all" -Method Post -TimeoutSec 3 | Out-Null
                    Write-Host "`n[安全] 已强制注销所有手机设备会话！" -ForegroundColor Yellow
                }
                "Q" {
                    $ExplicitShutdown = $true
                    Write-Host "`n[退出] 正在切断隧道并彻底停止后台服务..." -ForegroundColor Yellow
                    break
                }
            }
            if ($key.Key -eq "Q") { break }
        }
        Start-Sleep -Milliseconds 200
    }
}
finally {
    $shouldTearDown = $ExplicitShutdown -or (-not $ReachedInteractive -and -not $ReusedExisting)
    if ($shouldTearDown) {
        Write-Host "正在清理隧道与本地服务..." -ForegroundColor DarkGray
        if ($StartedOwnServer) {
            $prevKillPref = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try { Invoke-RestMethod -Uri "$BaseLocal/api/tunnel/kill" -Method Post -TimeoutSec 2 | Out-Null } catch {} finally { $ErrorActionPreference = $prevKillPref }
        }
        if ($ServerProc) {
            Stop-ProcessTreeSafe -TargetPid $ServerProc.Id
        }
        if ($ServerActualPid -and ((-not $ServerProc) -or ($ServerActualPid -ne $ServerProc.Id))) {
            Stop-ProcessTreeSafe -TargetPid $ServerActualPid
        }
        Write-Host "已彻底停止后台服务与隧道。" -ForegroundColor Green
    } else {
        Write-Host "后台服务保持常驻运行。" -ForegroundColor DarkGray
    }
}
