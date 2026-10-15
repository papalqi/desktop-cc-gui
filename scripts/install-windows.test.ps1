$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module Microsoft.PowerShell.Utility
$installer = Join-Path $PSScriptRoot 'install-windows.ps1'
$passed = 0

# Real filesystem copies/extraction; only the scheduled task, process table,
# and local idle query are simulated. Never operate the host's real app task.
function Get-ScheduledTask { [pscustomobject]@{ Actions=@([pscustomobject]@{Execute=$installed}); State=$(if ($state.running) {'Running'} else {'Ready'}) } }
function Get-CimInstance { if ($state.running) { [pscustomobject]@{ ExecutablePath=$installed; ProcessId=$state.pid } } }
function Stop-ScheduledTask { $state.stops++; $state.running=$false }
function Start-ScheduledTask {
    $state.starts++
    if ($state.failStart -and $state.starts -eq 1) { throw 'Simulated start failure' }
    $state.running=$true
    $state.pid++
}
function Copy-Item {
    param($LiteralPath, $Destination, [switch]$Force, [switch]$Recurse)
    if ($state.failCopy -and $Destination -eq $installed) {
        $state.failCopy=$false
        Set-Content -LiteralPath $installed -Value 'partial-copy'
        throw 'Simulated partial copy failure'
    }
    Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

foreach ($scenario in @('success','busy','copy-failure','start-failure','rollback','rollback-busy')) {
    $fixture = Join-Path $env:TEMP ('ccgui-installer-test-' + [Guid]::NewGuid().ToString('N'))
    $fixture = [IO.Path]::GetFullPath($fixture)
    $app = Join-Path $fixture 'app'
    $stage = Join-Path $fixture 'stage'
    $package = Join-Path $fixture 'package'
    $state = @{ running=$true; pid=10; starts=0; stops=0; failCopy=$false; failStart=$false; busy=$false }
    try {
        foreach ($directory in @($app, $stage, $package)) { New-Item -ItemType Directory -Path $directory | Out-Null }
        $installed = Join-Path $app 'ccgui-next.exe'
        Set-Content -LiteralPath $installed -Value 'old-exe'
        Set-Content -LiteralPath (Join-Path $package 'ccgui-next.exe') -Value 'new-exe'
        foreach ($name in @('agent-catalogs','skills')) {
            New-Item -ItemType Directory -Path (Join-Path $app $name), (Join-Path $package $name) | Out-Null
            Set-Content -LiteralPath (Join-Path $app "$name\old.txt") -Value 'old-resource'
            Set-Content -LiteralPath (Join-Path $package "$name\new.txt") -Value 'new-resource'
        }
        Copy-Item -LiteralPath $installer -Destination (Join-Path $stage 'install-windows.ps1')
        Compress-Archive -Path (Join-Path $package '*') -DestinationPath (Join-Path $stage 'package.zip')
        $request = Join-Path $stage 'request.json'
        @{id='20261012-000000-abcd1234'; task='CCGUIRelay'; archiveHash=(Get-FileHash (Join-Path $stage 'package.zip')).Hash; exeHash=(Get-FileHash (Join-Path $package 'ccgui-next.exe')).Hash} | ConvertTo-Json | Set-Content -LiteralPath $request -Encoding UTF8
        . (Join-Path $stage 'install-windows.ps1') -Action prepare -Request $request
        function Assert-Idle { if ($state.busy) { throw 'App has active turns; app was not stopped' } }
        $null = Invoke-Install
        $Action = 'apply'
        $state.busy = $scenario -eq 'busy'
        $state.failCopy = $scenario -eq 'copy-failure'
        $state.failStart = $scenario -eq 'start-failure'
        $failure = $null
        try { $null = Invoke-Install } catch { $failure = $_ }
        if ($scenario -in @('busy','copy-failure','start-failure')) {
            Assert ($null -ne $failure) "$scenario unexpectedly succeeded"
            Assert ((Get-Content -LiteralPath $installed -Raw).Trim() -eq 'old-exe') "$scenario did not restore the executable"
            Assert $state.running "$scenario left the app stopped"
            Assert (Test-Path -LiteralPath (Join-Path $app 'skills\old.txt')) "$scenario lost the original resources"
            if ($scenario -eq 'busy') {
                Assert ($state.stops -eq 0) 'Busy app was stopped'
                Assert ($failure.ToString() -match 'was not stopped') 'Busy update reported an incorrect recovery outcome'
            }
        } else {
            if ($failure) { throw $failure }
            Assert ((Get-Content -LiteralPath $installed -Raw).Trim() -eq 'new-exe') 'New executable was not installed'
            Assert (Test-Path -LiteralPath (Join-Path $app 'skills\new.txt')) 'Packaged resources were not installed'
            Assert (-not (Test-Path -LiteralPath (Join-Path $app 'skills\old.txt'))) 'Old resource survived replacement'
            if ($scenario -eq 'rollback') {
                $Action = 'rollback'
                $null = Invoke-Install
                Assert ((Get-Content -LiteralPath $installed -Raw).Trim() -eq 'old-exe') 'Rollback did not restore executable'
                Assert (Test-Path -LiteralPath (Join-Path $app 'skills\old.txt')) 'Rollback did not restore resources'
                Assert (-not (Test-Path -LiteralPath (Join-Path $app 'skills\new.txt'))) 'Rollback left new resources behind'
            }
            if ($scenario -eq 'rollback-busy') {
                $Action = 'rollback'
                $state.busy=$true
                $previousStops=$state.stops
                $rollbackFailure=$null
                try { $null = Invoke-Install } catch { $rollbackFailure=$_ }
                Assert ($null -ne $rollbackFailure) 'Busy rollback unexpectedly succeeded'
                Assert ($state.stops -eq $previousStops) 'Busy rollback stopped the app'
                Assert ((Get-Content -LiteralPath $installed -Raw).Trim() -eq 'new-exe') 'Busy rollback changed the executable'
            }
            Assert $state.running 'App was not restarted'
        }
        $passed++
        Write-Output "PASS installer: $scenario"
    } finally {
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if (-not $fixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup escaped TEMP' }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
Write-Output "$passed installer scenarios passed"
