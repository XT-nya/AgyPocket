$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SdkRoot = if ($env:ANDROID_HOME) {
    $env:ANDROID_HOME
} elseif ($env:ANDROID_SDK_ROOT) {
    $env:ANDROID_SDK_ROOT
} else {
    Join-Path $env:LOCALAPPDATA "Android\Sdk"
}

$JdkHome = if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\javac.exe"))) {
    $env:JAVA_HOME
} elseif (Test-Path "C:\Program Files\Java\jdk-17\bin\javac.exe") {
    "C:\Program Files\Java\jdk-17"
} else {
    throw "JDK 17 not found. Please install JDK 17 or set JAVA_HOME."
}

$env:JAVA_HOME = $JdkHome
$Javac = Join-Path $JdkHome "bin\javac.exe"
$Keytool = Join-Path $JdkHome "bin\keytool.exe"

$AndroidJar = Join-Path $SdkRoot "platforms\android-35\android.jar"
$BuildTools = Join-Path $SdkRoot "build-tools\35.0.0"
$Aapt2 = Join-Path $BuildTools "aapt2.exe"
$D8 = Join-Path $BuildTools "d8.bat"
$ZipAlign = Join-Path $BuildTools "zipalign.exe"
$ApkSigner = Join-Path $BuildTools "apksigner.bat"

foreach ($req in @($Javac, $Keytool, $AndroidJar, $Aapt2, $D8, $ZipAlign, $ApkSigner)) {
    if (-not (Test-Path $req)) {
        throw "Required build tool missing: $req"
    }
}

$LibsDir = Join-Path $ProjectDir "libs"
$ZxingJar = Join-Path $LibsDir "zxing-core-3.5.3.jar"
$ZxingUrl = "https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar"
New-Item -ItemType Directory -Force -Path $LibsDir | Out-Null

if (-not (Test-Path $ZxingJar) -or ((Get-Item $ZxingJar).Length -lt 100000)) {
    Write-Host "[0/6] Downloading zxing-core-3.5.3.jar from Maven Central..."
    Invoke-WebRequest -Uri $ZxingUrl -OutFile $ZxingJar -UseBasicParsing -TimeoutSec 60
    if (-not (Test-Path $ZxingJar) -or ((Get-Item $ZxingJar).Length -lt 100000)) {
        throw "Failed to download valid zxing-core-3.5.3.jar from $ZxingUrl"
    }
}

$BuildDir = Join-Path $ProjectDir "build"
$DistDir = Join-Path $ProjectDir "dist"
$ResOut = Join-Path $BuildDir "res"
$GenOut = Join-Path $BuildDir "gen"
$ClassesOut = Join-Path $BuildDir "classes"
$DexOut = Join-Path $BuildDir "dex"
$Keystore = Join-Path $ProjectDir "agypocket.jks"
$OutApk = Join-Path $DistDir "AgyPocket.apk"

$KsPass = if ($env:AGYPOCKET_KS_PASS) { $env:AGYPOCKET_KS_PASS } else { "agypocket-local-dev" }
$KeyPass = if ($env:AGYPOCKET_KEY_PASS) { $env:AGYPOCKET_KEY_PASS } else { $KsPass }
$KsAlias = if ($env:AGYPOCKET_KS_ALIAS) { $env:AGYPOCKET_KS_ALIAS } else { "agypocket" }
if (-not $env:AGYPOCKET_KS_PASS) {
    Write-Host "[Info] AGYPOCKET_KS_PASS not set; using local debug keystore passphrase." -ForegroundColor DarkGray
}

if (Test-Path $BuildDir) {
    Remove-Item -Recurse -Force $BuildDir
}
New-Item -ItemType Directory -Force -Path $ResOut, $GenOut, $ClassesOut, $DexOut, $DistDir | Out-Null

if (-not (Test-Path $Keystore)) {
    Write-Host "[1/6] Generating local developer signing keystore..."
    & $Keytool -genkeypair -v -keystore $Keystore -storepass $KsPass -keypass $KeyPass `
        -alias $KsAlias -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=AgyPocket, OU=Mobile, O=AgyPocket, L=Local, ST=Local, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed with exit code $LASTEXITCODE" }
}

Write-Host "[2/6] Compiling Android resources with aapt2..."
$CompiledRes = Join-Path $ResOut "compiled.zip"
& $Aapt2 compile --dir (Join-Path $ProjectDir "res") -o $CompiledRes
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed with exit code $LASTEXITCODE" }

Write-Host "[3/6] Linking resources and manifest..."
$UnalignedApk = Join-Path $BuildDir "unaligned.apk"
& $Aapt2 link -o $UnalignedApk -I $AndroidJar `
    --manifest (Join-Path $ProjectDir "AndroidManifest.xml") `
    --java $GenOut `
    --min-sdk-version 24 --target-sdk-version 35 `
    --version-code 2 --version-name "2.1.0" `
    $CompiledRes
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed with exit code $LASTEXITCODE" }

Write-Host "[4/6] Compiling Java sources..."
$JavaFiles = @(
    Get-ChildItem -Path (Join-Path $ProjectDir "src"), $GenOut -Filter "*.java" -Recurse |
    ForEach-Object { $_.FullName }
)
if ($JavaFiles.Count -eq 0) { throw "No Java files found." }
$Classpath = "$AndroidJar;$ZxingJar"
& $Javac --release 11 -encoding UTF-8 -Xlint:deprecation -classpath $Classpath -d $ClassesOut @JavaFiles
if ($LASTEXITCODE -ne 0) { throw "javac failed with exit code $LASTEXITCODE" }

Write-Host "[5/6] Translating bytecode + zxing-core to DEX with d8..."
$ClassFiles = @(
    Get-ChildItem -Path $ClassesOut -Filter "*.class" -Recurse |
    ForEach-Object { $_.FullName }
)
& $D8 --release --min-api 24 --lib $AndroidJar --output $DexOut @ClassFiles $ZxingJar
if ($LASTEXITCODE -ne 0) { throw "d8 failed with exit code $LASTEXITCODE" }

$DexFile = Join-Path $DexOut "classes.dex"
if (-not (Test-Path $DexFile)) { throw "classes.dex was not generated." }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [System.IO.Compression.ZipFile]::Open($UnalignedApk, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $Archive,
        $DexFile,
        "classes.dex",
        [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
} finally {
    $Archive.Dispose()
}

Write-Host "[6/6] Zipaligning and signing APK..."
$AlignedApk = Join-Path $BuildDir "aligned.apk"
& $ZipAlign -f -p 4 $UnalignedApk $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed with exit code $LASTEXITCODE" }

& $ApkSigner sign --ks $Keystore --ks-pass "pass:$KsPass" --ks-key-alias $KsAlias `
    --key-pass "pass:$KeyPass" --out $OutApk $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed with exit code $LASTEXITCODE" }

& $ApkSigner verify --verbose $OutApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed with exit code $LASTEXITCODE" }

$Info = Get-Item $OutApk
$Hash = (Get-FileHash -Path $OutApk -Algorithm SHA256).Hash
Write-Host ""
Write-Host "BUILD SUCCESSFUL!"
Write-Host "APK Path : $($Info.FullName)"
Write-Host "APK Size : $([math]::Round($Info.Length / 1KB, 2)) KB ($($Info.Length) bytes)"
Write-Host "SHA-256  : $Hash"
