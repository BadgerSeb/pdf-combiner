# Drives an invisible (headless) Edge through the DevTools protocol, for UI tests and screenshots.
# Dot-source it:   . tools\cdp.ps1
#   $e = Start-Cdp -Width 1280 -Height 820         # own temporary profile, never visible
#   Invoke-Cdp $e 'Page.navigate' @{ url = 'http://localhost:8123/' }
#   Eval-Cdp $e 'document.title'                    # runs JS (awaits promises), returns the value
#   Shot-Cdp $e 'C:\path\shot.png'
#   Stop-Cdp $e                                     # closes only this Edge
$ErrorActionPreference = 'Stop'

function Start-Cdp([int]$Width = 1280, [int]$Height = 820, [int]$Port = 0) {
    if ($Port -eq 0) {
        # a free port, so a leftover Edge from an earlier run can't get in the way
        $l = New-Object System.Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
        $l.Start(); $Port = $l.LocalEndpoint.Port; $l.Stop()
    }
    $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
    $profile = Join-Path $env:TEMP ("pdfc-cdp-" + [Guid]::NewGuid().ToString('N'))
    $p = Start-Process $edge -PassThru -WindowStyle Hidden -ArgumentList '--headless=new', '--disable-gpu', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions', "--remote-debugging-port=$Port", "--user-data-dir=`"$profile`"",
        "--window-size=$Width,$Height", '--hide-scrollbars', 'about:blank'
    $ws = $null
    for ($i = 0; $i -lt 50 -and -not $ws; $i++) {
        Start-Sleep -Milliseconds 200
        # 127.0.0.1, not localhost: Edge only listens on IPv4. Fresh profiles can open extra pages
        # (e.g. a sync notice), so take the blank tab this script asked for.
        try { $ws = ((curl.exe -s "http://127.0.0.1:$Port/json") -join "`n" | ConvertFrom-Json | ForEach-Object { $_ } | Where-Object { $_.type -eq 'page' -and $_.url -eq 'about:blank' } | Select-Object -First 1).webSocketDebuggerUrl } catch { }
    }
    if (-not $ws) {
        Stop-Cdp ([pscustomobject]@{ Client = $null; Profile = $profile })
        throw "Edge DevTools didn't start"
    }
    $client = New-Object System.Net.WebSockets.ClientWebSocket
    $client.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
    $client.ConnectAsync([Uri]$ws, [Threading.CancellationToken]::None).Wait()
    $e = [pscustomobject]@{ Client = $client; Id = 0; Profile = $profile; Process = $p }
    Invoke-Cdp $e 'Emulation.setDeviceMetricsOverride' @{ width = $Width; height = $Height; deviceScaleFactor = 1; mobile = $false } | Out-Null
    Invoke-Cdp $e 'Page.enable' | Out-Null
    return $e
}

function Invoke-Cdp($e, [string]$Method, $Params = @{}, [int]$TimeoutSec = 120) {
    $e.Id++
    $id = $e.Id
    $json = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $e.Client.SendAsync((New-Object ArraySegment[byte] (, $bytes)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $buf = New-Object byte[] 1048576
    while ((Get-Date) -lt $deadline) {
        $ms = New-Object IO.MemoryStream
        do {
            $r = $e.Client.ReceiveAsync((New-Object ArraySegment[byte] (, $buf)), [Threading.CancellationToken]::None)
            if (-not $r.Wait([TimeSpan]::FromSeconds($TimeoutSec))) { throw "CDP $Method timed out" }
            $ms.Write($buf, 0, $r.Result.Count)
        } while (-not $r.Result.EndOfMessage)
        $msg = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
        if ($msg.id -eq $id) {
            if ($msg.error) { throw "CDP $Method failed: $($msg.error.message)" }
            return $msg.result
        }
    }
    throw "CDP $Method timed out"
}

function Eval-Cdp($e, [string]$Js, [int]$TimeoutSec = 120) {
    $r = Invoke-Cdp $e 'Runtime.evaluate' @{ expression = $Js; awaitPromise = $true; returnByValue = $true } $TimeoutSec
    if ($r.exceptionDetails) { throw "JS error: " + ($r.exceptionDetails.exception.description, $r.exceptionDetails.text -ne $null)[0] }
    return $r.result.value
}

function Shot-Cdp($e, [string]$Path) {
    $r = Invoke-Cdp $e 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes($Path, [Convert]::FromBase64String($r.data))
}

function Stop-Cdp($e) {
    try { $e.Client.Dispose() } catch { }
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$($e.Profile)*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Remove-Item $e.Profile -Recurse -Force -ErrorAction SilentlyContinue
}
