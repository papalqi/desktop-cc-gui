param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$utf8 = [Text.UTF8Encoding]::new($false)
$auto = Get-Content -Encoding UTF8 -LiteralPath $Request -Raw | ConvertFrom-Json
if ($auto.id -notmatch '^[a-f0-9]{32}$' -or $auto.version -notmatch '^\d+\.\d+\.\d+$' -or $auto.token -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid self-update request' }
$installed = [IO.Path]::GetFullPath($auto.installed)
$appHome = [IO.Path]::GetFullPath($auto.appHome)
$stage = [IO.Path]::GetFullPath($PSScriptRoot)
if ([IO.Path]::GetFileName($installed) -ne 'ccgui-next.exe' -or -not $stage.StartsWith((Join-Path $appHome 'updates') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Self-update paths differ' }
$manifest = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $auto.version) { throw 'Self-update version differs' }
foreach ($name in @('package.zip','install-windows.ps1','install-self-update.ps1')) {
    $file = @($manifest.files | Where-Object { $_.name -eq $name })
    $path = Join-Path $stage $name
    if ($file.Count -ne 1 -or (Get-Item -LiteralPath $path).Length -ne $file[0].bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file[0].sha256) { throw 'Staged self-update file differs' }
}
$launchPath = Join-Path $stage 'launch-ok.json'
$launchDeadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not (Test-Path -LiteralPath $launchPath) -and [DateTime]::UtcNow -lt $launchDeadline) { Start-Sleep -Milliseconds 100 }
if (-not (Test-Path -LiteralPath $launchPath) -or (Get-Content -Encoding UTF8 -LiteralPath $launchPath -Raw | ConvertFrom-Json).token -ne $auto.token) { throw 'Updater process handoff was not acknowledged' }
$pendingPath = Join-Path $appHome 'updates\pending.json'
$statePath = Join-Path $appHome 'updates\state.json'
$installer = Join-Path $stage 'install-windows.ps1'
$requestPath = Join-Path $stage 'request.json'
$receiptPath = Join-Path $stage 'receipt.json'
$step = 'prepare'
$taskName = $null

function Write-Json([string]$Path, $Value) {
    $temporary = $Path + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12 -Compress), $utf8)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function App-Process {
    $processes = @(Get-Process -Name ccgui-next -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installed } | ForEach-Object { [pscustomobject]@{ProcessId=$_.Id;ExecutablePath=$_.Path} })
    if ($processes.Count -ne 1) { throw 'Expected one installed app process' }
    return $processes[0]
}

function Invoke-Local([string]$Command, $Arguments, [int]$TimeoutMs = 5000) {
    $settings = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $appHome 'settings.json') -Raw | ConvertFrom-Json
    $token = [Uri]::EscapeDataString($settings.webAccessToken)
    $process = App-Process
    $ports = @(& (Join-Path $env:SystemRoot 'System32/netstat.exe') -ano -p tcp | ForEach-Object {
        if ($_ -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[2] -eq $process.ProcessId) { [int]$Matches[1] }
    } | Select-Object -Unique)
    $attemptDeadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    foreach ($port in $ports) {
        $remaining = [int]($attemptDeadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remaining -le 0) { break }
        $socket = [Net.WebSockets.ClientWebSocket]::new()
        $timeout = [Threading.CancellationTokenSource]::new($remaining)
        try {
            $null = $socket.ConnectAsync([Uri]("ws://127.0.0.1:$port/ws?token=$token"), $timeout.Token).GetAwaiter().GetResult()
            $json = @{type='invoke'; id='self-update'; cmd=$Command; args=$Arguments} | ConvertTo-Json -Depth 8 -Compress
            $bytes = $utf8.GetBytes($json)
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
                    $frame = $utf8.GetString($message.ToArray()) | ConvertFrom-Json
                } finally { $message.Dispose() }
                if ($frame.type -eq 'response' -and $frame.id -eq 'self-update') {
                    if (-not $frame.ok) { throw 'Self-update bridge command failed' }
                    return $frame.payload
                }
            }
        } catch { } finally { $socket.Dispose(); $timeout.Dispose() }
    }
    throw 'Local self-update bridge did not respond'
}

function Record-Result([string]$Status, [string]$Failure) {
    $info = Get-Content -Encoding UTF8 -LiteralPath $statePath -Raw | ConvertFrom-Json
    $info.phase = $Status
    $info.error = $Failure
    if ($Status -eq 'failed') {
        $info.failedVersion = $auto.version
        $failed = @($info.failedVersions) + $auto.version | Where-Object { $_ } | Select-Object -Unique
        $info | Add-Member -MemberType NoteProperty -Name failedVersions -Value @($failed) -Force
    }
    Write-Json $statePath $info
    Write-Json $receiptPath ([ordered]@{version=$auto.version; status=$Status; step=$step; failure=$Failure; timestamp=[DateTime]::UtcNow.ToString('o')})
}

function Report-Result([string]$Status) {
    try {
        $settings = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $appHome 'settings.json') -Raw | ConvertFrom-Json
        $headers = @{Authorization=('Bearer ' + $settings.webRelayKey)}
        $body = @{version=$auto.version; status=$Status; step=$step} | ConvertTo-Json -Compress
        $null = Invoke-WebRequest -UseBasicParsing -Uri ($settings.webRelayUrl.TrimEnd('/') + '/update/result') -Method POST -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 10
    } catch { } # The durable receipt is retried by the executor after reconnect.
}

function Hub-Ready {
    $settings = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $appHome 'settings.json') -Raw | ConvertFrom-Json
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($settings.webRelayUrl.TrimEnd('/') + '/update/health') -Headers @{Authorization=('Bearer ' + $settings.webRelayKey)} -TimeoutSec 5
    $health = $response.Content | ConvertFrom-Json
    return $health.ready -eq $true -and $health.version -eq $auto.version -and @($health.capabilities).Contains('self_update')
}

function Get-RollbackCredential {
    $settings = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $appHome 'settings.json') -Raw | ConvertFrom-Json
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($settings.webRelayUrl.TrimEnd('/') + '/update/recovery') -Method POST -Headers @{Authorization=('Bearer ' + $settings.webRelayKey)} -ContentType 'application/json' -Body (@{version=$auto.version} | ConvertTo-Json -Compress) -TimeoutSec 5
        if ($response.StatusCode -eq 204) { return $null }
        $credential = $response.Content | ConvertFrom-Json
        if ($credential.token -notmatch '^[A-Za-z0-9_-]{43}$' -or $credential.fromVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid rollback credential' }
        return $credential
    } catch {
        # A v0 Hub or an already-v1 backup needs no legacy recovery credential.
        if ($_.Exception.Response.StatusCode -eq 404) { return $null }
        throw
    }
}

function Invoke-AutoUpdate {
    $changed = $false
    $rolledBack = $false
    $rollbackCredential = $null
    try {
        $taskService = New-Object -ComObject Schedule.Service
        $taskService.Connect()
        $taskFolder = $taskService.GetFolder('\')
        $tasks = @($taskService.GetRunningTasks(1) | ForEach-Object { $taskFolder.GetTask($_.Path) } | Where-Object { $_.State -eq 4 -and $_.Definition.Actions.Count -eq 1 -and $_.Definition.Actions.Item(1).Type -eq 0 -and $_.Definition.Actions.Item(1).Path.Trim('"') -eq $installed })
        if ($tasks.Count -ne 1 -or $tasks[0].Path -ne ('\' + $tasks[0].Name)) { throw 'Expected one root scheduled task for this installation' }
        $taskName = $tasks[0].Name
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $stage 'package.zip'))
        try {
            $entry = $zip.GetEntry('ccgui-next.exe')
            if ($null -eq $entry) { throw 'Executable missing from signed archive' }
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $exeHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') } finally { $sha.Dispose(); $stream.Dispose() }
        } finally { $zip.Dispose() }
        $id = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-') + $auto.id.Substring(0,8)
        $archive = @($manifest.files | Where-Object { $_.name -eq 'package.zip' })[0]
        Write-Json $requestPath @{id=$id; task=$taskName; archiveHash=$archive.sha256; exeHash=$exeHash}
        $baseline = & $installer -Action prepare -Request $requestPath | ConvertFrom-Json
        $rollbackCredential = Get-RollbackCredential
        Write-Json $pendingPath @{version=$auto.version; token=$auto.token; id=$id; staged=$stage}
        $step = 'apply'
        $changed = $true
        # Reserve a final probe (11s), stop/start rollback (40s), and relay recovery (5s).
        $deadline = [DateTime]::UtcNow.AddSeconds(64)
        $null = & $installer -Action apply -Request $requestPath
        $step = 'self-check'
        do {
            try {
                $check = Invoke-Local 'relay_update_check' @{}
                if ($check.version -eq $auto.version -and $check.healthy -eq $true -and (Hub-Ready)) {
                    $null = Invoke-Local 'relay_update_complete' @{version=$auto.version; token=$auto.token}
                    Record-Result 'installed' $null
                    Report-Result 'installed'
                    return
                }
            } catch { }
            Start-Sleep -Seconds 1
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'Updated app did not pass its self-check'
    } catch {
        $failure = $step + ': ' + $_.Exception.GetType().Name
        Record-Result 'failed' $failure
        if (Test-Path -LiteralPath $pendingPath) {
            $pending = Get-Content -Encoding UTF8 -LiteralPath $pendingPath -Raw | ConvertFrom-Json
            if ($pending.token -eq $auto.token) { Remove-Item -LiteralPath $pendingPath }
        }
        if ($changed -and (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $baseline.oldHash) {
            $step = 'rollback'
            try { $null = & $installer -Action rollback -Request $requestPath; $rolledBack = $true }
            catch { Record-Result 'failed' 'rollback failed; backup retained'; Report-Result 'failed'; throw }
        }
        if ($changed -and $_.Exception.Message -like 'Update failed and backup restored:*') { $rolledBack = $true }
        if ($rolledBack -and $null -ne $rollbackCredential) {
            $step = 'rollback'
            $settings = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $appHome 'settings.json') -Raw | ConvertFrom-Json
            $relayDeadline = [DateTime]::UtcNow.AddSeconds(5)
            do {
                $remaining = [Math]::Max(1,[int]($relayDeadline - [DateTime]::UtcNow).TotalMilliseconds)
                try { $null = Invoke-Local 'web_relay_start' @{url=$settings.webRelayUrl;key=$rollbackCredential.token} $remaining; break }
                catch { if ([DateTime]::UtcNow -ge $relayDeadline) { throw } }
                Start-Sleep -Milliseconds 100
            } while ($true)
            Record-Result 'failed' $failure
        }
        try { $null = Invoke-Local 'relay_update_abort' @{version=$auto.version; token=$auto.token} } catch { }
        Report-Result 'failed'
        throw $failure
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-AutoUpdate }
