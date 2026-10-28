[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tools'))
$downloads = Join-Path $toolsRoot 'downloads'
$jdkRoot = Join-Path $toolsRoot 'jdk-21'
$gradleRoot = Join-Path $toolsRoot 'gradle-8.13'
$sdkRoot = Join-Path $toolsRoot 'android-sdk'
$environmentFile = Join-Path $toolsRoot 'android-env.json'
$commandToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip'
$commandToolsSha256 = '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
$gradleUrl = 'https://downloads.gradle.org/distributions/gradle-8.13-bin.zip'

function Assert-UnderTools([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $prefix = $toolsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝访问 .tools 之外的路径：$full"
  }
  return $full
}

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-VerifiedArchive([string]$Url, [string]$FileName, [string]$ExpectedSha256, [long]$ExpectedSize = 0) {
  $archive = Assert-UnderTools (Join-Path $downloads $FileName)
  $partial = Assert-UnderTools ($archive + '.partial')
  if (Test-Path -LiteralPath $archive -PathType Leaf) {
    $actual = Get-FileSha256 $archive
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
      throw "缓存包校验失败，已保留原文件：$archive"
    }
    return $archive
  }
  if (Test-Path -LiteralPath $partial -PathType Leaf) {
    $partialLength = (Get-Item -LiteralPath $partial).Length
    if ($partialLength -gt 0 -and ($ExpectedSize -eq 0 -or $partialLength -eq $ExpectedSize)) {
      $partialHash = Get-FileSha256 $partial
      if ($partialHash -eq $ExpectedSha256.ToLowerInvariant()) {
        Move-Item -LiteralPath $partial -Destination $archive
        return $archive
      }
      if ($ExpectedSize -gt 0 -and $partialLength -eq $ExpectedSize) {
        throw "已下载缓存的长度正确但 SHA-256 不符：$partial；文件已保留。"
      }
    }
  }

  Write-Host "下载：$Url"
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw '未找到 curl.exe，无法安全下载 Android 工具包。'
  }
  $curlArgs = @('--location', '--fail', '--retry', '2', '--connect-timeout', '30', '--ssl-no-revoke', '--continue-at', '-', '--output', $partial, $Url)
  & curl.exe @curlArgs
  if ($LASTEXITCODE -ne 0) { throw "下载失败，已保留可续传的部分文件：$partial" }

  $actual = Get-FileSha256 $partial
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "SHA-256 校验失败：$FileName；期望 $ExpectedSha256，实际 $actual。下载文件已保留。"
  }
  if ($ExpectedSize -gt 0 -and (Get-Item -LiteralPath $partial).Length -ne $ExpectedSize) {
    throw "下载包长度不符：$FileName；文件已保留，期望 $ExpectedSize 字节。"
  }
  Move-Item -LiteralPath $partial -Destination $archive
  return $archive
}

function Get-JdkAsset {
  $uri = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
  Write-Host '查询 Adoptium 官方 JDK 21 发行信息…'
  $asset = (Invoke-RestMethod -Uri $uri -TimeoutSec 45 | Select-Object -First 1).binary.package
  if (-not $asset.link -or $asset.checksum -notmatch '^[a-fA-F0-9]{64}$' -or $asset.name -notmatch '\.zip$') {
    throw 'Adoptium API 未返回有效的 JDK 21 Windows x64 ZIP 及 SHA-256。'
  }
  return $asset
}

function Expand-IfMissing([string]$Archive, [string]$Destination, [string]$ExpectedExecutable) {
  $destinationPath = Assert-UnderTools $Destination
  $executable = Join-Path $destinationPath $ExpectedExecutable
  if (Test-Path -LiteralPath $executable -PathType Leaf) { return }
  New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
  Write-Host "展开：$(Split-Path -Leaf $Archive)"
  Expand-Archive -LiteralPath $Archive -DestinationPath $destinationPath -Force
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "解压后找不到预期程序：$executable"
  }
}

function Find-JavaHome {
  $candidate = Get-ChildItem -LiteralPath $jdkRoot -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe') } |
    Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  return $null
}

function Invoke-SdkManager([string]$SdkManager, [string]$SdkRoot, [string[]]$SdkArguments) {
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $env:ComSpec
  $quotedSdkManager = '"' + $SdkManager.Replace('"', '""') + '"'
  $argumentText = @("--sdk_root=$SdkRoot") + $SdkArguments |
    ForEach-Object { '"' + $_.Replace('"', '""') + '"' }
  $psi.Arguments = '/d /s /c "' + $quotedSdkManager + ' ' + ($argumentText -join ' ') + '"'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.CreateNoWindow = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $psi
  if (-not $process.Start()) { throw '无法启动 sdkmanager。' }
  for ($i = 0; $i -lt 40; $i++) { $process.StandardInput.WriteLine('y') }
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "sdkmanager 失败，退出码 $($process.ExitCode)。请检查上方的实际许可或下载提示。" }
}

New-Item -ItemType Directory -Path $toolsRoot, $downloads -Force | Out-Null
$oldEnvironment = @{
  JAVA_HOME = $env:JAVA_HOME
  ANDROID_HOME = $env:ANDROID_HOME
  ANDROID_SDK_ROOT = $env:ANDROID_SDK_ROOT
  ANDROID_USER_HOME = $env:ANDROID_USER_HOME
  GRADLE_HOME = $env:GRADLE_HOME
  GRADLE_USER_HOME = $env:GRADLE_USER_HOME
  Path = $env:Path
}

try {
  $jdkAsset = Get-JdkAsset
  $jdkArchive = Get-VerifiedArchive $jdkAsset.link $jdkAsset.name $jdkAsset.checksum ([long]$jdkAsset.size)
  if (-not (Find-JavaHome)) {
    New-Item -ItemType Directory -Path $jdkRoot -Force | Out-Null
    Write-Host '解压 JDK 21…'
    Expand-Archive -LiteralPath $jdkArchive -DestinationPath $jdkRoot -Force
  }
  $javaHome = Find-JavaHome
  if (-not $javaHome) { throw 'JDK ZIP 已解压，但找不到 bin\java.exe。' }

  Write-Host '读取 Gradle 8.13 官方 SHA-256…'
  $gradleHashText = (Invoke-RestMethod -Uri "$gradleUrl.sha256" -TimeoutSec 45).ToString().Trim()
  $gradleSha256 = ($gradleHashText -split '\s+')[0].ToLowerInvariant()
  if ($gradleSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Gradle 官方 SHA-256 响应格式无效。' }
  $gradleArchive = Get-VerifiedArchive $gradleUrl 'gradle-8.13-bin.zip' $gradleSha256
  Expand-IfMissing $gradleArchive $gradleRoot 'gradle-8.13\bin\gradle.bat'
  $gradleHome = Join-Path $gradleRoot 'gradle-8.13'
  $gradleExecutable = Join-Path $gradleHome 'bin\gradle.bat'

  $sdkManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
  if (-not (Test-Path -LiteralPath $sdkManager -PathType Leaf)) {
    $commandToolsArchive = Get-VerifiedArchive $commandToolsUrl 'commandlinetools-win-15859902_latest.zip' $commandToolsSha256
    $stage = Assert-UnderTools (Join-Path $toolsRoot 'android-commandline-stage')
    $stagedManager = Join-Path $stage 'cmdline-tools\bin\sdkmanager.bat'
    if (-not (Test-Path -LiteralPath $stagedManager -PathType Leaf)) {
      Write-Host '解压 Android SDK 命令行工具…'
      New-Item -ItemType Directory -Path $stage -Force | Out-Null
      Expand-Archive -LiteralPath $commandToolsArchive -DestinationPath $stage -Force
    }
    if (-not (Test-Path -LiteralPath $stagedManager -PathType Leaf)) { throw '命令行工具 ZIP 中缺少 sdkmanager.bat。' }
    New-Item -ItemType Directory -Path (Join-Path $sdkRoot 'cmdline-tools') -Force | Out-Null
    $latestTools = Join-Path $sdkRoot 'cmdline-tools\latest'
    [void](Assert-UnderTools $latestTools)
    if (Test-Path -LiteralPath $latestTools) { throw "SDK 的 latest 命令行工具目录已存在但无法运行：$latestTools" }
    Move-Item -LiteralPath (Join-Path $stage 'cmdline-tools') -Destination $latestTools
    $sdkManager = Join-Path $latestTools 'bin\sdkmanager.bat'
  }
  foreach ($path in @($sdkManager, $javaHome, $gradleExecutable)) { [void](Assert-UnderTools $path) }
  if (-not (Test-Path -LiteralPath $sdkManager -PathType Leaf)) { throw "sdkmanager 不存在：$sdkManager" }

  $env:JAVA_HOME = $javaHome
  $env:ANDROID_HOME = $sdkRoot
  $env:ANDROID_SDK_ROOT = $sdkRoot
  $env:ANDROID_USER_HOME = Join-Path $toolsRoot 'android-user'
  $env:GRADLE_HOME = $gradleHome
  $env:GRADLE_USER_HOME = Join-Path $toolsRoot 'gradle-cache'
  $env:Path = (Join-Path $javaHome 'bin') + ';' + (Join-Path $gradleHome 'bin') + ';' + (Join-Path $sdkRoot 'platform-tools') + ';' + $oldEnvironment.Path

  $sdkPackagesPresent = @(
    (Join-Path $sdkRoot 'platforms\android-36\android.jar'),
    (Join-Path $sdkRoot 'build-tools\35.0.0\aapt2.exe'),
    (Join-Path $sdkRoot 'platform-tools\adb.exe')
  ) | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
  if ($sdkPackagesPresent.Count -gt 0) {
    Write-Host '接受 sdkmanager 实际展示的 Android SDK 许可…'
    Invoke-SdkManager $sdkManager $sdkRoot @('--licenses')
    Write-Host '安装平台、Build Tools 与 ADB…'
    Invoke-SdkManager $sdkManager $sdkRoot @('platforms;android-36', 'build-tools;35.0.0', 'platform-tools')
  } else {
    Write-Host '必需 SDK 包已齐全，跳过重复安装。'
  }

  $adbExecutable = Join-Path $sdkRoot 'platform-tools\adb.exe'
  $requiredPaths = @(
    (Join-Path $javaHome 'bin\java.exe'),
    $gradleExecutable,
    $adbExecutable,
    (Join-Path $sdkRoot 'platforms\android-36\android.jar'),
    (Join-Path $sdkRoot 'build-tools\35.0.0\aapt2.exe'),
    (Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat')
  )
  foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "安装完成后缺少必需文件：$path" }
  }

  Write-Host '验证 Java、Gradle 与 ADB…'
  & (Join-Path $javaHome 'bin\java.exe') -version
  if ($LASTEXITCODE -ne 0) { throw '本地 Java 21 无法启动。' }
  [void](Assert-UnderTools $env:GRADLE_USER_HOME)
  New-Item -ItemType Directory -Path $env:GRADLE_USER_HOME -Force | Out-Null
  & $gradleExecutable --version
  if ($LASTEXITCODE -ne 0) { throw '本地 Gradle 8.13 无法启动。' }
  & $adbExecutable version
  if ($LASTEXITCODE -ne 0) { throw '本地 adb 无法启动。' }

  $environment = [ordered]@{
    javaHome = [IO.Path]::GetFullPath($javaHome)
    sdkRoot = [IO.Path]::GetFullPath($sdkRoot)
    gradleExecutable = [IO.Path]::GetFullPath($gradleExecutable)
    adbExecutable = [IO.Path]::GetFullPath($adbExecutable)
    javaVersion = $jdkAsset.name
    gradleVersion = '8.13'
    commandLineTools = '15859902'
  }
  $envTemp = Assert-UnderTools ($environmentFile + '.tmp')
  [void](Assert-UnderTools $environmentFile)
  $json = $environment | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($envTemp, $json, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $envTemp -Destination $environmentFile -Force

  Write-Host "Android 工具链已就绪：$environmentFile"
  Write-Host '只读探测 Windows Hypervisor Launch Type / 虚拟化能力…'
  try {
    systeminfo.exe | Select-String 'Hyper-V Requirements|Virtualization Enabled In Firmware|A hypervisor has been detected' | ForEach-Object { Write-Host $_.Line }
  } catch { Write-Host "systeminfo 探测不可用：$($_.Exception.Message)" }
  $emulator = Join-Path $sdkRoot 'emulator\emulator.exe'
  if (Test-Path -LiteralPath $emulator -PathType Leaf) {
    & $emulator -accel-check
    Write-Host "emulator -accel-check 退出码：$LASTEXITCODE"
  } else {
    Write-Host '尚未安装 Android Emulator / 系统镜像；等待 APK 构建完成后再做模拟器探测。'
  }
} finally {
  $env:JAVA_HOME = $oldEnvironment.JAVA_HOME
  $env:ANDROID_HOME = $oldEnvironment.ANDROID_HOME
  $env:ANDROID_SDK_ROOT = $oldEnvironment.ANDROID_SDK_ROOT
  $env:ANDROID_USER_HOME = $oldEnvironment.ANDROID_USER_HOME
  $env:GRADLE_HOME = $oldEnvironment.GRADLE_HOME
  $env:GRADLE_USER_HOME = $oldEnvironment.GRADLE_USER_HOME
  $env:Path = $oldEnvironment.Path
}
