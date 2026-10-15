param(
    [Parameter(Mandatory=$true)][ValidateSet('prepare','apply','rollback')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Request
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$requestData = Get-Content -Encoding UTF8 -LiteralPath $Request -Raw | ConvertFrom-Json
if ($requestData.id -notmatch '^\d{8}-\d{6}-[a-f0-9]{8}$') { throw 'Invalid update id' }
$task = Get-ScheduledTask -TaskName $requestData.task
if (@($task.Actions).Count -ne 1) { throw 'Expected one scheduled-task action' }
$installed = $task.Actions[0].Execute.Trim('"')
if (-not [IO.Path]::IsPathRooted($installed) -or [IO.Path]::GetFileName($installed) -ne 'ccgui-next.exe') {
    throw 'Scheduled task does not point to an installed CC GUI executable'
}
$appDir = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($installed))
$updateDir = Join-Path $appDir ('updates\' + $requestData.id)
$before = Join-Path $updateDir 'before'
$payload = Join-Path $updateDir 'payload'
$baselinePath = Join-Path $updateDir 'baseline.json'
$resourceDirs = @('agent-catalogs', 'skills')

function App-Processes {
    @(Get-CimInstance Win32_Process -Filter "name='ccgui-next.exe'" | Where-Object { $_.ExecutablePath -eq $installed })
}
function Wait-App([int]$Count) {
    for ($i=0; $i -lt 40; $i++) {
        $processes = @(App-Processes)
        if ($processes.Count -eq $Count) { return $processes }
        Start-Sleep -Milliseconds 500
    }
    throw "Expected $Count app instances after task transition"
}
function Stop-App {
    Stop-ScheduledTask -TaskName $requestData.task
    $null = Wait-App 0
}
function Assert-Idle {
    $processes = @(App-Processes)
    if ($processes.Count -eq 0) { return }
    if ($processes.Count -ne 1) { throw 'Cannot check active turns with multiple app instances' }
    $dataDir = Join-Path $env:USERPROFILE '.ccgui-next'
    $portable = Join-Path $appDir 'portable-data.json'
    if (Test-Path -LiteralPath $portable) {
        $candidate = (Get-Content -Encoding UTF8 -LiteralPath $portable -Raw | ConvertFrom-Json).appHome
        if ([IO.Path]::IsPathRooted($candidate) -and -not $candidate.StartsWith($env:USERPROFILE + '\', [StringComparison]::OrdinalIgnoreCase)) { $dataDir = $candidate }
    }
    $settings = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $dataDir 'settings.json') -Raw | ConvertFrom-Json
    $token = [Uri]::EscapeDataString($settings.webAccessToken)
    $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $processes[0].ProcessId | Select-Object -ExpandProperty LocalPort -Unique)
    $active = $null
    $queryFailure = 'No listening bridge port'
    foreach ($port in $ports) {
        $socket = [Net.WebSockets.ClientWebSocket]::new()
        $timeout = [Threading.CancellationTokenSource]::new(5000)
        try {
            $null = $socket.ConnectAsync([Uri]("ws://127.0.0.1:$port/ws?token=$token"), $timeout.Token).GetAwaiter().GetResult()
            $bytes = [Text.Encoding]::UTF8.GetBytes('{"type":"invoke","id":"deploy-check","cmd":"list_active_runs","args":{}}')
            $null = $socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $timeout.Token).GetAwaiter().GetResult()
            $buffer = New-Object byte[] 65536
            while ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
                $message = [IO.MemoryStream]::new()
                try {
                    do {
                        $part = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $timeout.Token).GetAwaiter().GetResult()
                        if ($part.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'Bridge closed' }
                        $message.Write($buffer, 0, $part.Count)
                    } while (-not $part.EndOfMessage)
                    $frame = [Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
                } finally { $message.Dispose() }
                if ($frame.type -eq 'response' -and $frame.id -eq 'deploy-check') {
                    if (-not $frame.ok) { throw 'Active-run query failed' }
                    $active = @($frame.payload).Count
                    break
                }
            }
        } catch { $queryFailure = $_.Exception.GetType().Name } finally { $socket.Dispose(); $timeout.Dispose() }
        if ($null -ne $active) { break }
    }
    if ($null -eq $active) { throw "Cannot verify active turns on the local bridge ($queryFailure); app was not stopped" }
    if ($active -ne 0) { throw "App has $active active turns; app was not stopped" }
}
function Start-App {
    Start-ScheduledTask -TaskName $requestData.task
    $processes = @(Wait-App 1)
    if ((Get-ScheduledTask -TaskName $requestData.task).State.ToString() -ne 'Running') {
        throw 'App process exists but its scheduled task is not running'
    }
    return $processes[0].ProcessId
}
function Move-Resource([string]$Source, [string]$Destination) {
    # Recursive moves must stay inside the verified installation directory.
    foreach ($path in @($Source, $Destination)) {
        if (-not [IO.Path]::GetFullPath($path).StartsWith($appDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Resource move escaped the installation directory'
        }
    }
    Move-Item -LiteralPath $Source -Destination $Destination
}
function Restore-App {
    Assert-Idle
    Stop-App
    Copy-Item -LiteralPath (Join-Path $before 'ccgui-next.exe') -Destination $installed -Force
    $failed = Join-Path $updateDir ('failed-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $failed | Out-Null
    foreach ($name in $resourceDirs) {
        $target = Join-Path $appDir $name
        if (Test-Path -LiteralPath $target) { Move-Resource $target (Join-Path $failed $name) }
        $backup = Join-Path $before $name
        if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $target -Recurse }
    }
    if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $baseline.oldHash) {
        throw 'Restored executable does not match the backup'
    }
    return Start-App
}

function Invoke-Install {
if ($Action -eq 'prepare') {
    $processes = @(App-Processes)
    if ($processes.Count -ne 1 -or $task.State.ToString() -ne 'Running') { throw 'Expected one running scheduled app' }
    $archive = Join-Path $PSScriptRoot 'package.zip'
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $requestData.archiveHash) { throw 'Uploaded archive mismatch' }
    New-Item -ItemType Directory -Path $updateDir | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $payload
    if ((Get-FileHash -LiteralPath (Join-Path $payload 'ccgui-next.exe') -Algorithm SHA256).Hash -ne $requestData.exeHash) { throw 'Payload executable mismatch' }
    foreach ($name in $resourceDirs) {
        if (-not (Test-Path -LiteralPath (Join-Path $payload $name) -PathType Container)) { throw "Missing packaged resource: $name" }
    }
    New-Item -ItemType Directory -Path $before | Out-Null
    Copy-Item -LiteralPath $installed -Destination (Join-Path $before 'ccgui-next.exe')
    foreach ($name in $resourceDirs) {
        $source = Join-Path $appDir $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $before $name) -Recurse }
    }
    $baseline = [ordered]@{ installed=$installed; oldPid=$processes[0].ProcessId; oldHash=(Get-FileHash -LiteralPath (Join-Path $before 'ccgui-next.exe') -Algorithm SHA256).Hash; newHash=$requestData.exeHash; task=$requestData.task }
    $baseline | ConvertTo-Json -Compress | Set-Content -LiteralPath $baselinePath -Encoding UTF8
    $baseline | ConvertTo-Json -Compress
    return
}

$baseline = Get-Content -Encoding UTF8 -LiteralPath $baselinePath -Raw | ConvertFrom-Json
if ($baseline.installed -ne $installed -or $baseline.task -ne $requestData.task) { throw 'Backup belongs to a different installation' }
if ($Action -eq 'rollback') {
    if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $baseline.newHash) { throw 'Installed app changed since this deployment' }
    $newPid = Restore-App
    [ordered]@{ rolledBack=$true; newPid=$newPid; sha256=$baseline.oldHash; backup=$before } | ConvertTo-Json -Compress
    return
}

$processes = @(App-Processes)
if ($processes.Count -ne 1 -or $processes[0].ProcessId -ne $baseline.oldPid -or (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $baseline.oldHash) {
    throw 'Installed app changed during update preparation'
}
$stopping = $false
try {
    Assert-Idle
    $stopping = $true
    Stop-App
    Copy-Item -LiteralPath (Join-Path $payload 'ccgui-next.exe') -Destination $installed -Force
    $replaced = Join-Path $updateDir 'replaced'
    New-Item -ItemType Directory -Path $replaced | Out-Null
    foreach ($name in $resourceDirs) {
        $target = Join-Path $appDir $name
        if (Test-Path -LiteralPath $target) { Move-Resource $target (Join-Path $replaced $name) }
        Copy-Item -LiteralPath (Join-Path $payload $name) -Destination $target -Recurse
    }
    if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $baseline.newHash) { throw 'Installed executable mismatch' }
    $newPid = Start-App
    [ordered]@{ updated=$true; oldPid=$baseline.oldPid; newPid=$newPid; sha256=$baseline.newHash; backup=$before } | ConvertTo-Json -Compress
} catch {
    $failure = $_
    if (-not $stopping) { throw $failure }
    try { $null = Restore-App } catch { throw "Update failed: $failure; rollback failed: $_; backup: $before" }
    throw "Update failed and backup restored: $failure"
}
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Install }
