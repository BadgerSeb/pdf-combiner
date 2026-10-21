# Writes the version and the list of app files into sw.js, so browsers download the new version.
# Run by publish.ps1 before every push.
param([string]$Version = (Get-Date -Format 'yyyy.MM.dd-HHmm'))
$root = Split-Path $PSScriptRoot
$skip = '^(tests|tools|\.git)[\\/]|^vendor[\\/]pdfjs[\\/]types[\\/]|^(sw\.js|README\.md|\.gitignore|publish\.ps1|LICENSE.*)$'
$files = Get-ChildItem $root -Recurse -File |
    ForEach-Object { $_.FullName.Substring($root.Length + 1) } |
    Where-Object { $_ -notmatch $skip } |
    ForEach-Object { $_.Replace('\', '/') } | Sort-Object
$list = (@("'./'") + ($files | ForEach-Object { "'" + ($_ -replace "'", "\'") + "'" })) -join ', '
$sw = Join-Path $root 'sw.js'
$text = [IO.File]::ReadAllText($sw)
$text = [regex]::Replace($text, "const VERSION = '[^']*';", "const VERSION = '$Version';")
$text = [regex]::Replace($text, "const FILES = \[[^\]]*\];", "const FILES = [$list];")
[IO.File]::WriteAllText($sw, $text, (New-Object Text.UTF8Encoding $false))
Write-Host "sw.js: version $Version, $($files.Count + 1) files"
