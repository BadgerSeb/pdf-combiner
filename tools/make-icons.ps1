# Draws the app icon (same design as the desktop app: pages, red PDF band, Badger-orange "+")
# and writes icons\icon-192.png, icons\icon-512.png and icons\maskable-512.png.
param([string]$Out = (Join-Path (Split-Path $PSScriptRoot) 'icons'))
Add-Type -AssemblyName System.Drawing

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# Draws the 256-unit design into $g at scale $s, offset ($ox, $oy)
function Draw-Icon($g, [float]$s, [float]$ox, [float]$oy) {
    $g.TranslateTransform($ox, $oy)
    $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(110, 118, 130)), (6 * $s)
    $paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(226, 230, 236))
    $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(212, 43, 43))
    $orange = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(210, 88, 0))
    $p1 = New-RoundRect (70 * $s) (14 * $s) (150 * $s) (190 * $s) (14 * $s)
    $g.FillPath($back, $p1); $g.DrawPath($edge, $p1)
    $p2 = New-RoundRect (30 * $s) (46 * $s) (150 * $s) (190 * $s) (14 * $s)
    $g.FillPath($paper, $p2); $g.DrawPath($edge, $p2)
    $g.FillRectangle($red, 30 * $s + $edge.Width / 2, 150 * $s, 150 * $s - $edge.Width, 54 * $s)
    $font = New-Object System.Drawing.Font 'Segoe UI', ([float](40 * $s)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $g.DrawString('PDF', $font, $paper, (New-Object System.Drawing.RectangleF (30 * $s), (150 * $s), (150 * $s), (54 * $s)), $fmt)
    $line = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 205, 212))
    foreach ($ly in 78, 100, 122) { $g.FillRectangle($line, 52 * $s, $ly * $s, 106 * $s, 9 * $s) }
    $g.FillEllipse($orange, 164 * $s, 158 * $s, 88 * $s, 88 * $s)
    $plus = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (14 * $s)
    $g.DrawLine($plus, 208 * $s, 180 * $s, 208 * $s, 224 * $s)
    $g.DrawLine($plus, 186 * $s, 202 * $s, 230 * $s, 202 * $s)
    $g.ResetTransform()
}

function Save-Icon([int]$size, [string]$path, [bool]$maskable) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    if ($maskable) {
        # full-bleed dark steel square; the design sits inside the 80% safe zone
        $g.Clear([System.Drawing.Color]::FromArgb(27, 29, 32))
        $s = $size * 0.62 / 256
        Draw-Icon $g $s (($size - 256 * $s) / 2) (($size - 256 * $s) / 2)
    } else {
        Draw-Icon $g ($size / 256.0) 0 0
    }
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

New-Item -ItemType Directory -Force $Out | Out-Null
Save-Icon 192 (Join-Path $Out 'icon-192.png') $false
Save-Icon 512 (Join-Path $Out 'icon-512.png') $false
Save-Icon 512 (Join-Path $Out 'maskable-512.png') $true
Write-Host "Wrote icons to $Out"
