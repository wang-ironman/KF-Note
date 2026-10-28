param([switch]$TestApk)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskEnvPath = Join-Path $taskRoot '.tools/android-env.json'
if (!(Test-Path -LiteralPath $taskEnvPath)) { throw '请先运行 scripts/setup-android.ps1 准备项目内构建环境' }
$taskEnv = Get-Content -LiteralPath $taskEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskOldJava = $env:JAVA_HOME
$taskOldAndroid = $env:ANDROID_HOME
$taskOldGradle = $env:GRADLE_USER_HOME
$taskOldAndroidUser = $env:ANDROID_USER_HOME
$taskOldJavaOptions = $env:JAVA_TOOL_OPTIONS
Push-Location $taskRoot
try {
    & node scripts/build-android-assets.mjs
    if ($LASTEXITCODE -ne 0) { throw '安卓页面打包失败' }
    $env:JAVA_HOME = $taskEnv.javaHome
    $env:ANDROID_HOME = $taskEnv.sdkRoot
    $env:GRADLE_USER_HOME = Join-Path $taskRoot '.tools/gradle-cache'
    $env:ANDROID_USER_HOME = Join-Path $taskRoot '.tools/android-user'
    $taskJavaTemp = Join-Path $taskRoot '.tools/jvm-tmp'
    New-Item -ItemType Directory -Path $taskJavaTemp -Force | Out-Null
    # Avoid Windows app-hosted/short-name TEMP paths for the JVM's local sockets.
    $env:JAVA_TOOL_OPTIONS = "$taskOldJavaOptions `"-Djava.io.tmpdir=$taskJavaTemp`" `"-Djdk.net.unixdomain.tmpdir=$taskJavaTemp`"".Trim()
    $taskKeyStore = Join-Path $taskRoot '.tools/debug.keystore'
    if (!(Test-Path -LiteralPath $taskKeyStore)) {
        & (Join-Path $taskEnv.javaHome 'bin/keytool.exe') -genkeypair -keystore $taskKeyStore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=KF Note Debug,O=KFNote,C=CN'
        if ($LASTEXITCODE -ne 0) { throw '生成项目调试签名失败' }
    }
    $taskArgs = @('-p', (Join-Path $taskRoot 'android'), '--no-daemon', '--console=plain', 'assembleDebug')
    if ($TestApk) { $taskArgs += 'assembleDebugAndroidTest' }
    & $taskEnv.gradleExecutable @taskArgs
    if ($LASTEXITCODE -ne 0) { throw '安卓构建失败' }
    $taskApkDir = Join-Path $taskRoot 'artifacts'
    New-Item -ItemType Directory -Path $taskApkDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot 'android/app/build/outputs/apk/debug/app-debug.apk') -Destination (Join-Path $taskApkDir '看房日记-0.1.5-debug.apk') -Force
    Write-Output '已生成 artifacts/看房日记-0.1.5-debug.apk（测试安装包）'
} finally {
    Pop-Location
    $env:JAVA_HOME = $taskOldJava
    $env:ANDROID_HOME = $taskOldAndroid
    $env:GRADLE_USER_HOME = $taskOldGradle
    $env:ANDROID_USER_HOME = $taskOldAndroidUser
    $env:JAVA_TOOL_OPTIONS = $taskOldJavaOptions
}
