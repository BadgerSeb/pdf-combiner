# Opens a page of the app in headless Edge (invisible, own profile) and waits until the page
# saves a file named "done" through PUT /__out/done, or the time runs out. Used for tests.
#   powershell -File tools\run-page.ps1 -Url http://localhost:8123/tests/x.html -Out <folder> [-Seconds 120]
param([string]$Url, [string]$Out, [int]$Seconds = 120, [string]$Size = '1280,860')
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$done = Join-Path $Out 'done'
if (Test-Path $done) { Remove-Item $done }
$profile = Join-Path $env:TEMP ("pdfc-edge-" + [Guid]::NewGuid().ToString('N'))
$p = Start-Process $edge -ArgumentList '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    "--user-data-dir=`"$profile`"", "--window-size=$Size", $Url -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds($Seconds)
while (-not (Test-Path $done) -and (Get-Date) -lt $deadline -and -not $p.HasExited) { Start-Sleep -Milliseconds 300 }
$ok = Test-Path $done
# close this headless Edge (and its helper processes) only
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$profile*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
if ($ok) { Get-Content $done } else { "TIMEOUT or page never finished" }
