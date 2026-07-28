#!/usr/bin/env pwsh

param(
  [string]$CodexHome = $env:CODEX_HOME,
  [string]$PythonExecutable,
  [string]$NpmExecutable,
  [switch]$Force,
  [switch]$SkipDependencies
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$SkillRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $CodexHome) { $CodexHome = Join-Path $env:USERPROFILE ".codex" }
$SkillsDir = Join-Path $CodexHome "skills"
$ParentName = "netease-finance-topic-ops"
$ChildNames = @("mx-finance-search", "tencent-news", "wechat-article-search", "news-aggregator-skill", "toutiao-news-trends", "a-stock-analysis")

function Copy-SkillSafe([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source "SKILL.md"))) { throw "Invalid skill source: $Source" }
  $sourceResolved = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
  $destinationResolved = $null
  if (Test-Path -LiteralPath $Destination) { $destinationResolved = (Resolve-Path -LiteralPath $Destination).Path.TrimEnd('\') }
  if ($destinationResolved -and $sourceResolved -eq $destinationResolved) { return }
  if (Test-Path -LiteralPath $Destination) {
    $resolvedSkills = (Resolve-Path -LiteralPath $SkillsDir).Path.TrimEnd('\')
    if (-not $destinationResolved.StartsWith($resolvedSkills + '\')) { throw "Refusing to update path outside skills directory: $Destination" }
    if ($Force) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
      Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
      return
    }
    Get-ChildItem -Force -LiteralPath $Source | Copy-Item -Destination $Destination -Recurse -Force
    return
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
}

New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
$ParentDestination = Join-Path $SkillsDir $ParentName
Copy-SkillSafe $SkillRoot $ParentDestination

$Bundled = Join-Path $ParentDestination "assets\bundled-skills"
foreach ($name in $ChildNames) {
  Copy-SkillSafe (Join-Path $Bundled $name) (Join-Path $SkillsDir $name)
}

if (-not $SkipDependencies) {
  $Python = $PythonExecutable
  if (-not $Python) { $Python = (Get-Command python -ErrorAction SilentlyContinue).Source }
  if (-not $Python) { $Python = (Get-Command py -ErrorAction SilentlyContinue).Source }
  if (-not $Python) { throw "Python 3.10+ was not found in PATH." }
  & $Python -m pip install -r (Join-Path $ParentDestination "requirements-portable.txt")
  if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

  $Npm = $NpmExecutable
  if (-not $Npm) { $Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }
  if (-not $Npm) { $Npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
  if (-not $Npm) { throw "npm was not found in PATH." }
  Push-Location (Join-Path $SkillsDir "wechat-article-search")
  try {
    & $Npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed for wechat-article-search." }
  } finally { Pop-Location }
}

Write-Host "Installed parent skill and $($ChildNames.Count) child skills to $SkillsDir"
Write-Host "Next: configure credentials, restart Codex, load workspace dependencies, then run scripts/ensure_ready.py with the loaded runtime paths."
