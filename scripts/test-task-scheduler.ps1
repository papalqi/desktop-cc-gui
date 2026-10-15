# In-memory Task Scheduler facade. Test scripts never change real tasks.
function New-TestTask([string]$Name, [string]$Path, [int]$Type = 0, [int]$Count = 1) {
    $actions = [pscustomobject]@{Count=$Count; Action=[pscustomobject]@{Type=$Type;Path=$installed}}
    $actions | Add-Member ScriptMethod Item { param($Index) if ($Index -ne 1 -or $this.Count -ne 1) { throw 'Invalid action index' }; $this.Action }
    $entry = [pscustomobject]@{Name=$Name;Path=$Path;Definition=[pscustomobject]@{Actions=$actions}}
    $entry | Add-Member ScriptProperty State { if ($state.running) {4} else {3} }
    $entry | Add-Member ScriptMethod Stop { param($Flags) $state.stops++; $state.running=$false }
    $entry | Add-Member ScriptMethod Run {
        param($Parameters)
        $state.starts++
        if ($state.failStart -and $state.starts -eq 1) { throw 'Simulated start failure' }
        $state.running=$true
        $state.pid++
    }
    $entry
}
function New-Object {
    param([string]$TypeName, [object[]]$ArgumentList, [string]$ComObject)
    if ($ComObject -ne 'Schedule.Service') { return Microsoft.PowerShell.Utility\New-Object @PSBoundParameters }
    $folder = [pscustomobject]@{}
    $folder | Add-Member ScriptMethod GetTask {
        param($Path)
        $found = @($mockTasks | Where-Object { $_.Path -eq $Path -or $_.Name -eq $Path })
        if ($found.Count -ne 1) { throw 'Task does not exist' }
        $found[0]
    }
    $service = [pscustomobject]@{Folder=$folder}
    $service | Add-Member ScriptMethod Connect {}
    $service | Add-Member ScriptMethod GetFolder { param($Path) if ($Path -ne '\') { throw 'Unexpected task folder' }; $this.Folder }
    $service | Add-Member ScriptMethod GetRunningTasks {
        param($Flags)
        if ($Flags -ne 1) { throw 'Hidden running tasks must be included' }
        @($mockTasks | Where-Object { $_.State -eq 4 })
    }
    $service
}
