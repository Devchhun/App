<#
.SYNOPSIS
  Stages a portable, self-contained Python runtime with the local AI worker's
  dependencies pre-installed, for bundling into the production Windows
  installer via electron-builder's `extraResources` (see electron-builder.yml).

.DESCRIPTION
  Downloads the official Windows "embeddable" CPython build (no installer,
  just a zip), bootstraps pip into it (embeddable builds don't include pip
  by default and ship with site-packages disabled), and installs
  python-worker/requirements.txt into it.

  Run this BEFORE `npm run dist:win` to produce a fully self-contained
  installer that does not require the end user to have Python installed.
  Without running this script, the app falls back to using system Python +
  an app-managed venv (see app/main/ai/pythonRuntime.ts / provisionVenv.ts) --
  that fallback is what `npm run dev` and a plain `dist:win` use.

.NOTES
  Pin PYTHON_VERSION to the same version used for local dev/testing
  (python-worker/requirements.txt's pinned versions were verified against
  it) so prebuilt native wheels (ctranslate2, onnxruntime, av) are ABI
  compatible.
#>

$ErrorActionPreference = 'Stop'

$PythonVersion = '3.11.9'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $RepoRoot 'resources\python-runtime'
$RequirementsPath = Join-Path $RepoRoot 'python-worker\requirements.txt'
$TempDir = Join-Path $env:TEMP "portable-python-build-$([guid]::NewGuid().ToString('N').Substring(0,8))"

Write-Host "== Staging portable Python $PythonVersion into $TargetDir ==" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
# Clear any previous contents (e.g. the .gitkeep placeholder) so re-runs are clean.
Get-ChildItem -Path $TargetDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

try {
    $embedZipUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    $embedZipPath = Join-Path $TempDir 'python-embed.zip'
    Write-Host "Downloading $embedZipUrl"
    Invoke-WebRequest -Uri $embedZipUrl -OutFile $embedZipPath

    Write-Host "Extracting to $TargetDir"
    Expand-Archive -Path $embedZipPath -DestinationPath $TargetDir -Force

    # Embeddable Python disables site-packages by default via a `._pth` file
    # that pins sys.path to only the stdlib zip + the exe's own directory.
    # Re-enable `import site` (and thus Lib\site-packages) so pip-installed
    # packages are importable.
    $pthFile = Get-ChildItem -Path $TargetDir -Filter 'python*._pth' | Select-Object -First 1
    if (-not $pthFile) {
        throw "Could not find python*._pth in $TargetDir after extraction"
    }
    Write-Host "Enabling site-packages in $($pthFile.Name)"
    $pthContent = Get-Content $pthFile.FullName
    $pthContent = $pthContent -replace '^#\s*import site', 'import site'
    if ($pthContent -notcontains 'import site') {
        $pthContent += 'import site'
    }
    Set-Content -Path $pthFile.FullName -Value $pthContent

    # Bootstrap pip (not included in the embeddable distribution).
    $getPipPath = Join-Path $TempDir 'get-pip.py'
    Write-Host 'Downloading get-pip.py'
    Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPipPath

    $embeddedPython = Join-Path $TargetDir 'python.exe'
    Write-Host 'Bootstrapping pip'
    & $embeddedPython $getPipPath --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw "get-pip.py failed with exit code $LASTEXITCODE" }

    Write-Host "Installing worker dependencies from $RequirementsPath"
    & $embeddedPython -m pip install --no-warn-script-location -r $RequirementsPath
    if ($LASTEXITCODE -ne 0) { throw "pip install failed with exit code $LASTEXITCODE" }

    Write-Host 'Verifying faster-whisper imports correctly in the portable runtime'
    & $embeddedPython -c "import faster_whisper, huggingface_hub; print('portable runtime OK:', faster_whisper.__file__)"
    if ($LASTEXITCODE -ne 0) { throw 'Verification import failed' }

    Write-Host "== Portable Python runtime staged successfully at $TargetDir ==" -ForegroundColor Green
}
finally {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
