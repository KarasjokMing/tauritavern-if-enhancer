# 手机端远程调试助手（Windows PowerShell）
#
# 用法：
#   .\tools\remote-connect.ps1                      # 连接 + 打印开机自检
#   .\tools\remote-connect.ps1 -Log tail            # 追加打印 TT 日志尾部
#   .\tools\remote-connect.ps1 -Install <仓库目录>   # 把扩展推到手机并重启 TT
#   .\tools\remote-connect.ps1 -Console on          # 打开前端控制台捕获（会自动重启 TT）
#   .\tools\remote-connect.ps1 -Console off         # 关闭前端控制台捕获
#
# 前提：手机已开启「无线调试」，并把 adb 加进 PATH（或放在默认安装位置）。

[CmdletBinding()]
param(
    [string]$Address = '192.168.31.29:39903',
    [ValidateSet('none', 'tail', 'all')][string]$Log = 'none',
    [string]$Install = '',
    [ValidateSet('', 'on', 'off')][string]$Console = '',
    [switch]$Restart,
    [string]$Package = 'com.tauritavern.client',
    [string]$Activity = 'com.tauritavern.client/.MainActivity'
)

$ErrorActionPreference = 'Continue'

function Resolve-Adb {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\platform-tools\adb.exe'),
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'),
        (Join-Path $env:ProgramFiles 'Android\platform-tools\adb.exe')
    )
    foreach ($path in $candidates) { if (Test-Path $path) { return $path } }
    throw 'ADB 未安装在常见位置，请先安装 Android platform-tools 并加入 PATH。'
}

$adb = Resolve-Adb
$dataRoot = "/sdcard/Android/data/$Package/data"
$tmp = Join-Path $env:TEMP 'tt-remote'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "adb = $adb"
& $adb start-server | Out-Null
& $adb connect $Address
$deviceText = (& $adb devices) -join "`n"
if ($deviceText -notmatch '(?m)^\S+\s+device\s*$') {
    Write-Warning '设备未就绪：请确认手机已开启无线调试，且地址端口正确。'
    Write-Host $deviceText
}

function Restart-App {
    & $adb shell "am force-stop $Package" | Out-Null
    Start-Sleep -Seconds 2
    & $adb shell "am start -n $Activity" | Out-Null
    Write-Host '已重启应用，等待 35 秒让前端加载完成…'
    Start-Sleep -Seconds 35
}

# ---------------------------------------------------------------- 安装扩展
if ($Install) {
    $dest = "$dataRoot/default-user/extensions/tauritavern-if-enhancer"
    $stage = Join-Path $env:TEMP 'tt-if-stage'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    robocopy $Install $stage /E /XD '.git' '.test-output' /NFL /NDL /NJH /NJS /NP | Out-Null
    & $adb shell "mkdir -p $dest" | Out-Null
    & $adb push "$stage/." "$dest/" | Select-Object -Last 1
    Write-Host '扩展已推送到手机。'
    Restart-App
}

# ---------------------------------------------------------------- 重启
if ($Restart) { Restart-App }

# ---------------------------------------------------------------- 控制台捕获
if ($Console) {
    $file = "$dataRoot/default-user/tauritavern-settings.json"
    $local = Join-Path $tmp 'tauritavern-settings.json'
    & $adb pull $file $local | Out-Null
    $json = Get-Content $local -Raw | ConvertFrom-Json
    $json.dev.frontend_console_capture = ($Console -eq 'on')
    $out = Join-Path $tmp 'tauritavern-settings-new.json'
    [System.IO.File]::WriteAllText($out, ($json | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
    & $adb push $out $file | Select-Object -Last 1
    Write-Host "前端控制台捕获已设置为 $($Console -eq 'on')"
    Restart-App
}

# ---------------------------------------------------------------- 自检快照
$settings = Join-Path $tmp 'settings.json'
& $adb pull "$dataRoot/default-user/settings.json" $settings | Out-Null
try {
    $box = (Get-Content $settings -Raw | ConvertFrom-Json).extension_settings.tt_if_enhancer
    Write-Host "`n===== 扩展设置 ====="
    if (-not $box) {
        Write-Warning '没有找到 extension_settings.tt_if_enhancer：扩展可能没有加载。'
    } else {
        Write-Host "  结构化输出是否已降级：$($box.jsonSchemaUnsupported -eq $true)"
        Write-Host "  导演规则是否注入：$($box.dialogueInjected -eq $true)"
        if ($box.diagnostics) {
            $d = $box.diagnostics
            Write-Host "  启动时间：$($d.at)"
            Write-Host "  模式条：$($d.modeBar)  按钮数：$($d.modeButtons)  文案：$($d.modeBarText)"
            Write-Host "  落点/输入框/发送区：$($d.dock) / $($d.textarea) / $($d.sendForm)"
            Write-Host "  酒馆助手：$($d.tavernHelper)  generateRaw：$($d.generateRaw)  TT Agent：$($d.agent)"
            Write-Host "  世界书后端：$($d.backend)   视口：$($d.viewport)   启动：$($d.boot)$(if ($d.error) { "  错误：$($d.error)" })"
        }
    }
} catch {
    Write-Warning "解析 settings.json 失败：$($_.Exception.Message)"
}

# ---------------------------------------------------------------- 日志
if ($Log -ne 'none') {
    $today = Get-Date -Format 'yyyy-MM-dd'
    $logFile = "/sdcard/Android/data/$Package/logs/tauritavern.log.$today"
    $local = Join-Path $tmp "tauritavern.log.$today"
    & $adb pull $logFile $local | Out-Null
    if (Test-Path $local) {
        Write-Host "`n===== 日志：$logFile ====="
        $lines = if ($Log -eq 'all') { Get-Content $local } else { Get-Content $local | Select-Object -Last 30 }
        $lines | ForEach-Object { $_ }
        $errors = Select-String -Path $local -Pattern 'ERROR frontend' -ErrorAction SilentlyContinue
        if ($errors) {
            Write-Host "`n===== 前端错误（$($errors.Count) 条）====="
            $errors | Select-Object -Last 10 | ForEach-Object { $_.Line }
        }
    }
}
