#
# ensure-binary.ps1 - Downloads goldfish binary, llama-server, and GGUF models (Windows)
# Called by SessionStart hook before running context loading
#
# Phase 1: Download goldfish binary (if missing or outdated)
# Phase 2: Download llama-server from ggml-org/llama.cpp (if missing or outdated)
# Phase 3: Download GGUF models (if missing or outdated)
#

$ErrorActionPreference = "Stop"

$Repo = "RageLtd/Goldfish"
$LlamaRepo = "ggml-org/llama.cpp"
$DataDir = Join-Path $HOME ".goldfish"
$BinDir = Join-Path $DataDir "bin"
$ModelDir = Join-Path $DataDir "models"
$VersionFile = Join-Path $DataDir ".version"
$LlamaServerVersionFile = Join-Path $DataDir ".llama-server-version"

# ============================================================================
# Platform Detection
# ============================================================================

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($Arch) {
    "X64" { $ArchSuffix = "x64" }
    default {
        Write-Error "[goldfish] ERROR: Unsupported architecture: $Arch"
        exit 1
    }
}

$Platform = "windows-$ArchSuffix"

# ============================================================================
# Helpers
# ============================================================================

function Invoke-Download {
    param([string]$Url, [string]$Dest)
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

function Get-LatestTag {
    param([string]$RepoName)
    $ProgressPreference = "SilentlyContinue"
    try {
        $response = Invoke-WebRequest -Uri "https://github.com/$RepoName/releases/latest" `
            -MaximumRedirection 0 -ErrorAction SilentlyContinue -UseBasicParsing
    } catch {
        $response = $_.Exception.Response
    }
    if ($response -and $response.Headers -and $response.Headers.Location) {
        $location = $response.Headers.Location
        if ($location -is [array]) { $location = $location[0] }
        return ($location -split "/tag/")[-1]
    }
    # Fallback: follow redirect
    try {
        $response = Invoke-WebRequest -Uri "https://github.com/$RepoName/releases/latest" `
            -UseBasicParsing
        $finalUrl = $response.BaseResponse.ResponseUri.ToString()
        if (-not $finalUrl) { $finalUrl = $response.BaseResponse.RequestMessage.RequestUri.ToString() }
        return ($finalUrl -split "/tag/")[-1]
    } catch {
        return ""
    }
}

function Get-StoredVersion {
    param([string]$FilePath)
    if (Test-Path $FilePath) {
        return (Get-Content $FilePath -Raw).Trim()
    }
    return ""
}

function Get-LlamaPlatformSuffix {
    return "win-avx2-x64"
}

function Get-RemoteETag {
    param([string]$Url)
    $ProgressPreference = "SilentlyContinue"
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing
        $etag = $response.Headers["x-linked-etag"]
        if (-not $etag) { $etag = $response.Headers["etag"] }
        if ($etag -is [array]) { $etag = $etag[0] }
        return ($etag -replace '"', '').Trim()
    } catch {
        return ""
    }
}

# ============================================================================
# Phase 1: goldfish binary
# ============================================================================

function Install-Goldfish {
    $binary = Join-Path $BinDir "goldfish.exe"
    $latestTag = Get-LatestTag -RepoName $Repo
    $storedVersion = Get-StoredVersion -FilePath $VersionFile

    # Skip if binary exists and version matches
    if ((Test-Path $binary) -and $latestTag -and ($latestTag -eq $storedVersion)) {
        return
    }

    Write-Host "[goldfish] Downloading goldfish binary ($Platform)..." -ForegroundColor Cyan

    # Gracefully stop the running worker so we can replace the binary.
    # The next hook call will auto-start a new worker with the updated binary.
    $workerPort = if ($env:GOLDFISH_PORT) { $env:GOLDFISH_PORT } else { "3456" }
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:${workerPort}/shutdown" -Method Post `
            -TimeoutSec 5 -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
    } catch {}
    Start-Sleep -Seconds 1

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $url = "https://github.com/$Repo/releases/latest/download/goldfish-${Platform}.exe"
    Invoke-Download -Url $url -Dest $binary

    # Store version
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Set-Content -Path $VersionFile -Value $latestTag

    Write-Host "[goldfish] goldfish binary installed" -ForegroundColor Green
}

# ============================================================================
# Phase 2: llama-server binary (from ggml-org/llama.cpp)
# ============================================================================

function Install-LlamaServer {
    $storedLlamaVersion = Get-StoredVersion -FilePath $LlamaServerVersionFile
    $llamaServer = Join-Path $BinDir "llama-server.exe"

    # Skip if binary exists and version matches
    if ((Test-Path $llamaServer) -and $storedLlamaVersion) {
        $latestLlamaTag = Get-LatestTag -RepoName $LlamaRepo
        if ($latestLlamaTag -and ($latestLlamaTag -eq $storedLlamaVersion)) {
            return
        }
    }

    $latestLlamaTag = Get-LatestTag -RepoName $LlamaRepo

    if (-not $latestLlamaTag) {
        Write-Error "[goldfish] ERROR: Could not determine latest llama.cpp release"
        exit 1
    }

    $platformSuffix = Get-LlamaPlatformSuffix

    Write-Host "[goldfish] Downloading llama-server $latestLlamaTag ($platformSuffix)..." -ForegroundColor Cyan

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    # Release zips are named like: llama-b5678-bin-win-avx2-x64.zip
    $url = "https://github.com/$LlamaRepo/releases/download/$latestLlamaTag/llama-${latestLlamaTag}-bin-${platformSuffix}.zip"
    $tmpZip = Join-Path $env:TEMP "llama-server-$(Get-Random).zip"
    $tmpExtract = Join-Path $env:TEMP "llama-server-extract-$(Get-Random)"

    Invoke-Download -Url $url -Dest $tmpZip

    # Extract
    New-Item -ItemType Directory -Force -Path $tmpExtract | Out-Null
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force

    # Find llama-server.exe in extracted contents
    $serverBin = Get-ChildItem -Path $tmpExtract -Filter "llama-server.exe" -Recurse | Select-Object -First 1

    if (-not $serverBin) {
        Remove-Item -Path $tmpZip -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
        Write-Error "[goldfish] ERROR: llama-server.exe not found in release archive"
        exit 1
    }

    Copy-Item -Path $serverBin.FullName -Destination $llamaServer -Force

    # Copy DLLs from same directory
    $serverDir = $serverBin.DirectoryName
    Get-ChildItem -Path $serverDir -Filter "*.dll" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $BinDir -Force
    }

    # Cleanup
    Remove-Item -Path $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue

    # Store version
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Set-Content -Path $LlamaServerVersionFile -Value $latestLlamaTag

    Write-Host "[goldfish] llama-server installed ($latestLlamaTag)" -ForegroundColor Green
}

# ============================================================================
# Phase 3: GGUF models
# ============================================================================

function Install-ModelIfNeeded {
    param([string]$Url, [string]$Dest)
    $etagFile = "$Dest.etag"

    # Fetch remote ETag
    $remoteEtag = Get-RemoteETag -Url $Url

    # Compare with stored ETag
    $storedEtag = Get-StoredVersion -FilePath $etagFile

    # Skip if file exists and ETag matches
    if ((Test-Path $Dest) -and $remoteEtag -and ($remoteEtag -eq $storedEtag)) {
        return
    }

    $filename = Split-Path $Dest -Leaf
    Write-Host "[goldfish] Downloading model $filename..." -ForegroundColor Cyan

    Invoke-Download -Url $Url -Dest $Dest

    # Store ETag for future checks
    if ($remoteEtag) {
        Set-Content -Path $etagFile -Value $remoteEtag
    }

    Write-Host "[goldfish] Model $filename installed" -ForegroundColor Green
}

function Install-Models {
    New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null

    Install-ModelIfNeeded `
        -Url "https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF/resolve/main/all-MiniLM-L6-v2-Q8_0.gguf" `
        -Dest (Join-Path $ModelDir "all-MiniLM-L6-v2-Q8_0.gguf")

    Install-ModelIfNeeded `
        -Url "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf" `
        -Dest (Join-Path $ModelDir "Qwen3-0.6B-Q8_0.gguf")
}

# ============================================================================
# Main
# ============================================================================

Install-Goldfish
Install-LlamaServer
Install-Models

# Output valid hook JSON (Claude Code requires JSON on stdout from hook commands)
Write-Output '{"continue":true,"suppressOutput":true}'
