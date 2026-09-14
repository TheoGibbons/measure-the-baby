param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\public\growth-data.json')
)

$ErrorActionPreference = 'Stop'
# Keep the existing Windows entry point on the same daily-LMS generator.
# Requires Python 3.8+; no third-party Python packages are needed.
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Install Python 3.8+ to refresh the WHO reference data.' }
& $python.Source (Join-Path $PSScriptRoot 'fetch-growth-data.py') --output $OutputPath
if ($LASTEXITCODE -ne 0) { throw 'WHO reference data generation failed.' }
