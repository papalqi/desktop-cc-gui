$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$helper = Join-Path $PSScriptRoot 'install-self-update.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-ScheduledTask {
    if ($scenario -eq 'non-executable-task') {
        [pscustomobject]@{ TaskPath='\'; TaskName='ComHandler'; State='Ready'; Actions=@([pscustomobject]@{ClassId='test'}) }
        [pscustomobject]@{ TaskPath='\'; TaskName='NoActions'; State='Ready'; Actions=@() }
    }
    [pscustomobject]@{ TaskPath='\'; TaskName='CCGUIRelay'; State='Running'; Actions=@([pscustomobject]@{Execute=$installed}) }
}
function Invoke-WebRequest { param([switch]$UseBasicParsing,$Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec)
    if ($Uri.EndsWith('/health')) { return @{Content=(@{ready=$true;version=$testVersion;capabilities=@('self_update')} | ConvertTo-Json -Compress)} }
    if ($Uri.EndsWith('/recovery')) {
        if ($state.recovery) { return @{StatusCode=200;Content=(@{token=('x'*43);fromVersion='1.2.0'} | ConvertTo-Json -Compress)} }
        return @{StatusCode=204}
    }
    $state.report = $Body | ConvertFrom-Json
    $state.reportKey = $Headers.Authorization
}

foreach ($scenario in @('success','non-executable-task','self-check-failure','legacy-rollback','delayed-relay','apply-restored','apply-failure','busy','tampered','handoff-mismatch')) {
    $testVersion = $(if ($scenario -in @('legacy-rollback','delayed-relay','apply-restored')) {'1.3.0'} else {'1.2.1'})
    $fixture = [IO.Path]::GetFullPath((Join-Path $env:TEMP ('ccgui-self-update-test-' + [Guid]::NewGuid().ToString('N'))))
    $unicodeName = [string][char]0x4E2D + [char]0x6587
    $appHome = Join-Path $fixture $unicodeName
    $appDir = Join-Path $fixture 'app'
    $stage = Join-Path $appHome 'updates\stage-id\staged'
    $package = Join-Path $fixture 'package'
    $state = @{stops=0; rollbacks=0; completes=0; aborts=0; relayRestarts=0; delays=$(if ($scenario -eq 'delayed-relay') {2} else {0}); recovery=($scenario -in @('legacy-rollback','delayed-relay','apply-restored')); busy=($scenario -eq 'busy'); failApply=($scenario -eq 'apply-failure'); failHealth=($scenario -in @('self-check-failure','legacy-rollback','delayed-relay')); failAfterApply=($scenario -eq 'apply-restored')}
    try {
        New-Item -ItemType Directory -Path $stage,$appDir,$package | Out-Null
        $installed = Join-Path $appDir 'ccgui-next.exe'
        [IO.File]::WriteAllText($installed, 'old-exe', $utf8)
        [IO.File]::WriteAllText((Join-Path $package 'ccgui-next.exe'), 'new-exe', $utf8)
        Compress-Archive -Path (Join-Path $package '*') -DestinationPath (Join-Path $stage 'package.zip')
        $fakeInstaller = @'
param($Action,$Request)
if ($Action -eq 'prepare') {
    Copy-Item -LiteralPath $installed -Destination ($installed + '.backup')
    @{oldHash=(Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash} | ConvertTo-Json -Compress
} elseif ($Action -eq 'apply') {
    if ($state.busy) { throw 'busy app was not stopped' }
    if ($state.failApply) { throw 'apply failed before stop' }
    $state.stops++
    [IO.File]::WriteAllText($installed, 'new-exe')
    if ($state.failAfterApply) {
        Copy-Item -LiteralPath ($installed + '.backup') -Destination $installed -Force
        throw 'Update failed and backup restored: simulated start failure'
    }
} elseif ($Action -eq 'rollback') {
    $state.rollbacks++
    Copy-Item -LiteralPath ($installed + '.backup') -Destination $installed -Force
}
'@
        [IO.File]::WriteAllText((Join-Path $stage 'install-windows.ps1'), $fakeInstaller, $utf8)
        Copy-Item -LiteralPath $helper -Destination (Join-Path $stage 'install-self-update.ps1')
        $files = @('package.zip','install-windows.ps1','install-self-update.ps1') | ForEach-Object { $path=Join-Path $stage $_; @{name=$_; bytes=(Get-Item -LiteralPath $path).Length; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()} }
        [IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), (@{version=$testVersion;files=@($files)} | ConvertTo-Json -Depth 8), $utf8)
        $request = Join-Path $stage 'auto-request.json'
        [IO.File]::WriteAllText($request, (@{installed=$installed;appHome=$appHome;version=$testVersion;id=('a'*32);token='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'} | ConvertTo-Json), $utf8)
        [IO.File]::WriteAllText((Join-Path $stage 'launch-ok.json'), (@{token=$(if ($scenario -eq 'handoff-mismatch') {'different-token'} else {'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})} | ConvertTo-Json), $utf8)
        [IO.File]::WriteAllText((Join-Path $appHome 'updates\state.json'), (@{version=$testVersion;phase='installing';error=$null;failedVersion=$null;deferredUntil=0;blackoutStart=$null;blackoutEnd=$null} | ConvertTo-Json), $utf8)
        [IO.File]::WriteAllText((Join-Path $appHome 'settings.json'), (@{webRelayUrl='http://test/m/PC6';webRelayKey='test-only-key'} | ConvertTo-Json), $utf8)
        if ($scenario -eq 'tampered') { Add-Content -LiteralPath (Join-Path $stage 'install-windows.ps1') -Value '#tampered' }
        $failure = $null
        try {
            . (Join-Path $stage 'install-self-update.ps1') -Request $request
            function Invoke-Local([string]$Command,$Arguments) {
                if ($Command -eq 'relay_update_check') { return @{version=$testVersion;healthy=(-not $state.failHealth)} }
                if ($Command -eq 'relay_update_complete') {
                    Assert ($Arguments.version -eq $testVersion -and $Arguments.token -eq $auto.token) 'completion receipt differs'
                    $state.completes++; Remove-Item -LiteralPath $pendingPath
                }
                if ($Command -eq 'relay_update_abort') { $state.aborts++ }
                if ($Command -eq 'web_relay_start') {
                    if ($state.delays -gt 0) { $state.delays--; throw 'bridge not listening yet' }
                    Assert ($state.recovery -and $Arguments.url -eq 'http://test/m/PC6' -and $Arguments.key -eq ('x'*43)) 'rollback relay credential differs'
                    Assert ((Get-Content -LiteralPath $installed -Raw) -eq 'old-exe') 'relay recovered before backup restoration'
                    $state.relayRestarts++
                    $localSettings = Get-Content -LiteralPath (Join-Path $appHome 'settings.json') -Raw | ConvertFrom-Json
                    $localSettings.webRelayKey = $Arguments.key
                    Write-Json (Join-Path $appHome 'settings.json') $localSettings
                }
            }
            function Start-Sleep { param($Seconds,$Milliseconds) if ($Seconds) { throw 'simulated self-check deadline' } }
            Invoke-AutoUpdate
        } catch { $failure = $_ }
        if ($scenario -in @('success','non-executable-task')) {
            Assert ($null -eq $failure) ('success failed: ' + $failure)
            Assert ($state.completes -eq 1 -and $state.rollbacks -eq 0) 'healthy update rolled back or failed to complete'
            Assert ((Get-Content -LiteralPath $installed -Raw) -eq 'new-exe') 'new executable was lost'
        } else {
            Assert ($null -ne $failure) "$scenario incorrectly succeeded"
            Assert ((Get-Content -LiteralPath $installed -Raw) -eq 'old-exe') "$scenario did not retain the old executable"
            Assert ($state.rollbacks -eq $(if ($scenario -in @('self-check-failure','legacy-rollback','delayed-relay')) {1} else {0})) "$scenario rollback count differs"
            if ($scenario -notin @('self-check-failure','legacy-rollback','delayed-relay','apply-restored')) { Assert ($state.stops -eq 0) "$scenario stopped the app" }
        }
        if ($scenario -notin @('tampered','handoff-mismatch')) {
            $receipt = Get-Content -LiteralPath (Join-Path $stage 'receipt.json') -Raw | ConvertFrom-Json
            Assert ($receipt.status -eq $(if ($scenario -in @('success','non-executable-task')) {'installed'} else {'failed'})) 'receipt status differs'
            Assert ($state.report.status -eq $receipt.status) 'Hub result was not reported'
            if ($scenario -notin @('success','non-executable-task')) {
                $info = Get-Content -LiteralPath (Join-Path $appHome 'updates\state.json') -Raw | ConvertFrom-Json
                Assert ($info.failedVersion -eq $testVersion) 'failed version would be retried'
            }
            Assert ($state.relayRestarts -eq $(if ($state.recovery) {1} else {0})) 'rollback connection was not restored exactly once'
            if ($state.recovery) { Assert ($state.reportKey -eq ('Bearer ' + ('x'*43)) -and $state.report.step -eq 'rollback') 'rollback result did not use its dedicated credential' }
            Assert (-not (Test-Path -LiteralPath (Join-Path $appHome 'updates\pending.json'))) 'pending update survived completion or rollback'
        }
        Write-Output "PASS self-update: $scenario"
    } finally {
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if (-not $fixture.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup escaped TEMP' }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
