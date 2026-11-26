param(
    [switch]$CheckOnly
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Resolve-WindowsSystemProxy {
    try {
        $reg = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
        if ($reg.ProxyEnable -ne 1 -or [string]::IsNullOrWhiteSpace([string]$reg.ProxyServer)) {
            return ""
        }
        $raw = ([string]$reg.ProxyServer).Trim()
        if ($raw -match "://" -and $raw -notmatch "=") {
            return $raw
        }
        if ($raw -match "=") {
            $map = @{}
            foreach ($part in ($raw -split ";")) {
                if ($part -match "^(.*?)=(.*)$") {
                    $k = $matches[1].Trim().ToLower()
                    $v = $matches[2].Trim()
                    if ($k -and $v) { $map[$k] = $v }
                }
            }
            foreach ($key in @("https", "http", "socks")) {
                if ($map.ContainsKey($key)) {
                    $t = $map[$key]
                    if ($t -match "://") { return $t }
                    if ($key -eq "socks") { return "socks5://$t" }
                    return "http://$t"
                }
            }
            return ""
        }
        return "http://$raw"
    } catch {
        return ""
    }
}

$ProxyUrl = Resolve-WindowsSystemProxy
if ($ProxyUrl) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
    $env:http_proxy = $ProxyUrl
    $env:https_proxy = $ProxyUrl
    $env:ALL_PROXY = ""
    $env:all_proxy = ""
    $env:NO_PROXY = "127.0.0.1,localhost,::1"
    $env:no_proxy = "127.0.0.1,localhost,::1"
    Write-Host "[已自动加载 Windows 系统代理] $ProxyUrl" -ForegroundColor Green
} else {
    Write-Host "[提示] 未检测到开启的 Windows 系统代理，若连接 Google 超时请先开启代理软件。" -ForegroundColor Yellow
}

# Preflight network check to Google OAuth endpoint
$curlArgs = @("-sS", "-o", "NUL", "-w", "%{http_code}", "--max-time", "5")
if ($ProxyUrl) {
    $curlArgs += @("--proxy", $ProxyUrl)
}
$curlArgs += "https://oauth2.googleapis.com/token"
try {
    $httpCode = (& curl.exe @curlArgs 2>$null)
    if ($LASTEXITCODE -eq 0 -and $httpCode -match "^[234]\d\d$") {
        Write-Host "[网络自检通过] 已成功连通 Google OAuth 服务器 (HTTP $httpCode)" -ForegroundColor Green
    } else {
        Write-Host "[网络警告] 无法通过当前代理访问 Google OAuth 服务器 (curl exit=$LASTEXITCODE, http=$httpCode)" -ForegroundColor Red
        if ($CheckOnly) { exit 1 }
    }
} catch {
    Write-Host "[网络警告] 网络自检执行异常: $_" -ForegroundColor Red
    if ($CheckOnly) { exit 1 }
}

$AgyExe = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
if (-not (Test-Path $AgyExe)) {
    $cmdAgy = Get-Command agy -ErrorAction SilentlyContinue
    if ($cmdAgy) { $AgyExe = $cmdAgy.Source }
}
if (-not $AgyExe -or -not (Test-Path $AgyExe)) {
    Write-Host "[错误] 未找到 agy.exe，请先安装官方 agy CLI。" -ForegroundColor Red
    if (-not $CheckOnly) { Read-Host "按回车键退出" | Out-Null }
    exit 1
}

if ($CheckOnly) {
    Write-Host "CHECK_ONLY_OK" -ForegroundColor Cyan
    exit 0
}

Write-Host ""
Write-Host "正在启动 agy CLI 登录界面，请在浏览器登录后复制授权码粘贴到此处并回车..." -ForegroundColor Cyan
& $AgyExe
$rc = $LASTEXITCODE
if ($rc -ne 0) {
    Write-Host "`nagy CLI 退出码: $rc" -ForegroundColor Yellow
}
Read-Host "按回车键关闭窗口" | Out-Null
