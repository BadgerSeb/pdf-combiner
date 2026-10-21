# Checks the installable/offline side: the service worker installs, caches every app file, controls
# the page after a reload, and the manifest is valid.
param([int]$Port = 8124)
$root = Split-Path $PSScriptRoot
. (Join-Path $root 'tools\cdp.ps1')
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'tools\stamp.ps1') -Version 'test'
$server = Start-Job -ScriptBlock { param($s, $p) & powershell -ExecutionPolicy Bypass -File $s -Port $p } -ArgumentList (Join-Path $root 'tools\serve.ps1'), $Port
Start-Sleep 2
$e = Start-Cdp
try {
    Invoke-Cdp $e 'Page.navigate' @{ url = "http://localhost:$Port/" } | Out-Null
    Start-Sleep 4
    Eval-Cdp $e "navigator.serviceWorker.ready.then(() => 1)" | Out-Null
    Invoke-Cdp $e 'Page.reload' @{} | Out-Null
    Start-Sleep 3
    "controlled after reload: " + (Eval-Cdp $e "!!navigator.serviceWorker.controller")
    "cached files: " + (Eval-Cdp $e "caches.open('pdf-combiner-test').then(c => c.keys()).then(k => k.length)")
    $m = Invoke-Cdp $e 'Page.getAppManifest' @{}
    "manifest errors: " + (($m.errors | ForEach-Object { $_.message }) -join '; ')
    "manifest name: " + ($m.data | ConvertFrom-Json).name
    try { $ids = Invoke-Cdp $e 'Page.getInstallabilityErrors' @{}; "installability errors: " + (($ids.installabilityErrors | ForEach-Object { $_.errorId }) -join ', ') } catch { "installability check not available: $_" }
}
finally {
    Stop-Cdp $e
    try { Invoke-RestMethod "http://localhost:$Port/__stop" -TimeoutSec 3 | Out-Null } catch { }
    Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
}
