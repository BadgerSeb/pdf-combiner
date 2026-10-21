# UI test: serves the app, opens it in an invisible Edge, drops sample files on it, and takes
# screenshots in both themes (files, whole document, viewer, empty window).
#   powershell -ExecutionPolicy Bypass -File tests\ui-test.ps1 [-Out tests\out\ui] [-Files a.pdf,b.png]
param(
    [string]$Out = (Join-Path $PSScriptRoot 'out\ui'),
    [string[]]$Files = @('Line Card.pdf', 'Quote 1042 table.pdf', 'Coffee Tower Template - any thin # - steel - cut.DXF', 'notes.txt', 'badger.png'),
    [int]$Port = 8123
)
$root = Split-Path $PSScriptRoot
. (Join-Path $root 'tools\cdp.ps1')
New-Item -ItemType Directory -Force $Out | Out-Null
# small extra inputs made on the fly
Set-Content (Join-Path $PSScriptRoot 'samples\notes.txt') "Cut list for job 1042`r`n- 4x gusset 3/8 x 4 x 4`r`n- 25x bracket 11 ga" -Encoding utf8
Copy-Item (Join-Path $root 'assets\badger-logo.png') (Join-Path $PSScriptRoot 'samples\badger.png') -Force

$server = Start-Job -ScriptBlock { param($s, $p, $o) & powershell -ExecutionPolicy Bypass -File $s -Port $p -Out $o } -ArgumentList (Join-Path $root 'tools\serve.ps1'), $Port, $Out
Start-Sleep 2
$e = Start-Cdp -Width 1280 -Height 820
$log = New-Object System.Collections.Generic.List[string]
try {
    $scheme = { param($dark) Invoke-Cdp $e 'Emulation.setEmulatedMedia' @{ features = @(@{ name = 'prefers-color-scheme'; value = $(if ($dark) { 'dark' } else { 'light' }) }) } | Out-Null }
    & $scheme $true
    Invoke-Cdp $e 'Page.navigate' @{ url = "http://localhost:$Port/" } | Out-Null
    Start-Sleep 2
    Shot-Cdp $e (Join-Path $Out '1-welcome-dark.png')

    $names = ($Files | ForEach-Object { "'" + ($_ -replace "'", "\'") + "'" }) -join ','
    $n = Eval-Cdp $e "(async () => { const dt = new DataTransfer(); for (const n of [$names]) { const b = await (await fetch('tests/samples/' + encodeURIComponent(n))).blob(); dt.items.add(new File([b], n)); } window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return dt.files.length; })()"
    $log.Add("dropped $n files")
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        $status = Eval-Cdp $e "document.getElementById('status').textContent"
        if ($status -notmatch '^Getting') { break }
    }
    Start-Sleep 2
    $log.Add("status: $status")
    $log.Add("cards: " + (Eval-Cdp $e "[...document.querySelectorAll('.row')].map(r => r.querySelector('.name').textContent + ' - ' + r.querySelector('.l1').textContent + (r.querySelector('.l2').textContent ? ' / ' + r.querySelector('.l2').textContent : '')).join(' | ')"))
    Shot-Cdp $e (Join-Path $Out '2-files-dark.png')

    & $scheme $false
    Start-Sleep 1
    Shot-Cdp $e (Join-Path $Out '3-files-light.png')

    Eval-Cdp $e "document.getElementById('mode-all').click(); 1" | Out-Null
    Start-Sleep 3
    Shot-Cdp $e (Join-Path $Out '4-combined-light.png')
    $log.Add("tiles: " + (Eval-Cdp $e "document.querySelectorAll('.tile').length"))

    # skip page 2, rotate page 3, then open the viewer on page 1
    Eval-Cdp $e "(() => { const t = document.querySelectorAll('.tile'); t[1].querySelector('.page').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); t[2].querySelector('[data-act=right]').click(); return 1; })()" | Out-Null
    Start-Sleep 2
    Shot-Cdp $e (Join-Path $Out '5-skip-rotate-light.png')
    $log.Add("status after skip: " + (Eval-Cdp $e "document.getElementById('status').textContent"))
    Eval-Cdp $e "document.querySelector('.tile [data-act=view]').click(); 1" | Out-Null
    Start-Sleep 3
    & $scheme $true
    Start-Sleep 1
    Shot-Cdp $e (Join-Path $Out '6-viewer-dark.png')
    Eval-Cdp $e "document.querySelector('[data-a=close]').click(); 1" | Out-Null

    # save in every format through the real Save button; without the Save dialog API the app
    # falls back to downloads, which land in the output folder
    $dl = Join-Path $Out 'saved'
    New-Item -ItemType Directory -Force $dl | Out-Null
    Get-ChildItem $dl -File | Remove-Item
    Invoke-Cdp $e 'Page.setDownloadBehavior' @{ behavior = 'allow'; downloadPath = $dl } | Out-Null
    Eval-Cdp $e "delete window.showSaveFilePicker; delete window.showDirectoryPicker; window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m)); window.confirm = (m) => { window.__alerts.push('confirm: ' + m); return true; }; 1" | Out-Null
    $count = Eval-Cdp $e "(() => { document.getElementById('format').click(); const n = [...document.querySelectorAll('#format-menu button')].filter(b => !/dpi/.test(b.textContent)).length; document.getElementById('format-menu').hidden = true; return n; })()"
    foreach ($fmt in 0..($count - 1)) {
        $name = Eval-Cdp $e "(() => { document.getElementById('format').click(); const b = [...document.querySelectorAll('#format-menu button')].filter(b => !/dpi/.test(b.textContent))[$fmt]; b.click(); return b.textContent.trim(); })()"
        $fmt = "$fmt $name"
        Eval-Cdp $e "document.getElementById('save').click(); 1" | Out-Null
        for ($i = 0; $i -lt 120; $i++) {
            Start-Sleep -Milliseconds 500
            $st = Eval-Cdp $e "document.getElementById('status').textContent"
            $failed = Eval-Cdp $e "window.__alerts.length"
            if (($st -match 'Saved|^\s*$' -or $failed -gt 0) -and -not (Eval-Cdp $e "document.getElementById('save').disabled")) { break }
        }
        $log.Add("format ${fmt}: $st"); Write-Host "format ${fmt}: $st"
        $alerts = Eval-Cdp $e "window.__alerts.splice(0).join(' / ')"
        if ($alerts) { $log.Add("   alert: $alerts"); Write-Host "   alert: $alerts" }
    }
    Start-Sleep 2
    $log.Add("downloaded: " + ((Get-ChildItem $dl -File | ForEach-Object { "$($_.Name) ($([Math]::Round($_.Length / 1KB)) KB)" }) -join ', '))

    # the format menu
    Eval-Cdp $e "document.getElementById('format').click(); 1" | Out-Null
    Start-Sleep 1
    Shot-Cdp $e (Join-Path $Out '7-format-menu-dark.png')
    $log.Add("console errors: " + (Eval-Cdp $e "(window.__errors || []).join(' | ')"))
}
catch { $log.Add("ERROR: $_") }
finally {
    Stop-Cdp $e
    try { Invoke-RestMethod "http://localhost:$Port/__stop" -TimeoutSec 3 | Out-Null } catch { }
    Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
}
$log
