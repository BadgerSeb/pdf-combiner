# Publishes the current files to GitHub Pages: stamps a new version into sw.js, commits, pushes.
# Everyone's copy (open in a browser or installed as an app) picks the update up by itself.
#   powershell -ExecutionPolicy Bypass -File publish.ps1 "What changed"
param([string]$Message = "Update")
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:Path = "$env:LOCALAPPDATA\Programs\Git\cmd;$env:LOCALAPPDATA\Programs\GitHub CLI;$env:Path"
Push-Location $root
try {
    $version = Get-Date -Format 'yyyy.MM.dd-HHmm'
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'tools\stamp.ps1') -Version $version
    git add -A
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) { Write-Host "Nothing changed; nothing to publish."; return }
    git commit -q -m "$Message ($version)"
    git push -q
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    $url = gh api "repos/{owner}/{repo}/pages" --jq .html_url 2>$null
    Write-Host "Published version $version$(if ($url) { " to $url" })"
    Write-Host "GitHub Pages usually updates within a minute or two."
}
finally { Pop-Location }
