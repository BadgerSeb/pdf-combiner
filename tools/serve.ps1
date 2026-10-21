# A tiny local web server for trying the app and running its tests (Windows PowerShell 5.1, no installs).
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8123] [-Out <folder>]
# Then open http://localhost:8123/ . Test pages can save result files with PUT /__out/<name>
# (written into -Out). GET /__stop shuts the server down.
param(
    [int]$Port = 8123,
    [string]$Root = (Split-Path $PSScriptRoot),
    [string]$Out = (Join-Path $env:TEMP 'pdf-combiner-web-out')
)

$types = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'
    '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.wasm' = 'application/wasm'
    '.pdf' = 'application/pdf'; '.txt' = 'text/plain; charset=utf-8'; '.dxf' = 'text/plain; charset=utf-8'
    '.jpg' = 'image/jpeg'; '.webp' = 'image/webp'; '.avif' = 'image/avif'; '.gif' = 'image/gif'; '.tif' = 'image/tiff'; '.bmp' = 'image/bmp'
}

New-Item -ItemType Directory -Force $Out | Out-Null
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root on http://localhost:$Port/ (outputs to $Out)"
try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        try {
            # from the raw request, so encoded characters such as %23 (#) survive
            $path = [Uri]::UnescapeDataString(($req.RawUrl -split '\?')[0])
            if ($path -eq '/__stop') { $res.StatusCode = 200; $res.Close(); break }
            if ($req.HttpMethod -eq 'PUT' -and $path.StartsWith('/__out/')) {
                $name = [IO.Path]::GetFileName($path.Substring(7))
                $ms = New-Object IO.MemoryStream
                $req.InputStream.CopyTo($ms)
                [IO.File]::WriteAllBytes((Join-Path $Out $name), $ms.ToArray())
                $res.StatusCode = 204
                $res.Close()
                continue
            }
            if ($path.EndsWith('/')) { $path += 'index.html' }
            $file = [IO.Path]::GetFullPath((Join-Path $Root $path.TrimStart('/')))
            if (-not $file.StartsWith([IO.Path]::GetFullPath($Root)) -or -not (Test-Path $file -PathType Leaf)) {
                $res.StatusCode = 404
                $res.Close()
                continue
            }
            $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
            $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
            $res.Headers.Add('Cache-Control', 'no-store')
            $bytes = [IO.File]::ReadAllBytes($file)
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            $res.Close()
        }
        catch { try { $res.StatusCode = 500; $res.Close() } catch { } }
    }
}
finally { $listener.Stop() }
