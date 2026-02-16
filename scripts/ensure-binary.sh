#!/bin/bash
#
# ensure-binary.sh - Downloads claude-mem binary, llama.cpp binaries, and GGUF models
# Called by SessionStart hook before running context loading
#
# Phase 1: Download claude-mem binary (if missing or outdated)
# Phase 2: Download llama.cpp binaries (if missing or outdated)
# Phase 3: Download GGUF models (if missing or outdated)
#

set -e

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="RageLtd/claude-mem"
DATA_DIR="${HOME}/.claude-mem"
BIN_DIR="${DATA_DIR}/bin"
MODEL_DIR="${DATA_DIR}/models"
VERSION_FILE="${DATA_DIR}/.version"

# ============================================================================
# Platform Detection
# ============================================================================

case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *)
        echo "[claude-mem] ERROR: Unsupported OS: $(uname -s)" >&2
        exit 1
        ;;
esac

case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)
        echo "[claude-mem] ERROR: Unsupported architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

PLATFORM="${OS}-${ARCH}"

# ============================================================================
# Helpers
# ============================================================================

download() {
    local url="$1"
    local dest="$2"
    if command -v curl &> /dev/null; then
        curl -fSL -o "$dest" "$url"
    elif command -v wget &> /dev/null; then
        wget -q -O "$dest" "$url"
    else
        echo "[claude-mem] ERROR: Neither curl nor wget found" >&2
        exit 1
    fi
}

head_request() {
    local url="$1"
    if command -v curl &> /dev/null; then
        curl -sI -L "$url" 2>/dev/null
    elif command -v wget &> /dev/null; then
        wget -qS --spider "$url" 2>&1
    else
        echo ""
    fi
}

# Fetch the latest release tag from GitHub (follows redirect)
get_latest_tag() {
    local headers
    headers=$(head_request "https://github.com/${REPO}/releases/latest")
    # The Location header contains the tag: .../releases/tag/v1.2.3
    echo "$headers" | grep -i '^location:' | sed 's|.*/tag/||' | tr -d '[:space:]'
}

# Read stored version from disk, or empty string if missing
get_stored_version() {
    if [ -f "$VERSION_FILE" ]; then
        cat "$VERSION_FILE"
    else
        echo ""
    fi
}

# ============================================================================
# Phase 1: claude-mem binary
# ============================================================================

phase1_claude_mem() {
    local binary="$PLUGIN_ROOT/bin/claude-mem"
    local latest_tag
    latest_tag=$(get_latest_tag)
    local stored_version
    stored_version=$(get_stored_version)

    # Skip if binary exists and version matches
    if [ -x "$binary" ] && [ -n "$latest_tag" ] && [ "$latest_tag" = "$stored_version" ]; then
        return 0
    fi

    echo "[claude-mem] Downloading claude-mem binary (${PLATFORM})..." >&2

    mkdir -p "$PLUGIN_ROOT/bin"
    local url="https://github.com/${REPO}/releases/latest/download/claude-mem-${PLATFORM}"
    download "$url" "$binary"
    chmod +x "$binary"

    # Store version (shared across phases 1+2)
    mkdir -p "$DATA_DIR"
    echo "$latest_tag" > "$VERSION_FILE"

    echo "[claude-mem] claude-mem binary installed" >&2
}

# ============================================================================
# Phase 2: llama.cpp binaries
# ============================================================================

phase2_llama_binaries() {
    local latest_tag
    latest_tag=$(get_latest_tag)
    local stored_version
    stored_version=$(get_stored_version)

    # Skip if binaries exist and version matches
    if [ -x "${BIN_DIR}/llama-completion" ] && [ -x "${BIN_DIR}/llama-embedding" ] \
       && [ -n "$latest_tag" ] && [ "$latest_tag" = "$stored_version" ]; then
        return 0
    fi

    echo "[claude-mem] Downloading llama.cpp binaries (${PLATFORM})..." >&2

    mkdir -p "$BIN_DIR"
    local url="https://github.com/${REPO}/releases/latest/download/llama-${PLATFORM}.tar.gz"
    local tmp_tar
    tmp_tar=$(mktemp "${TMPDIR:-/tmp}/llama-XXXXXX.tar.gz")

    download "$url" "$tmp_tar"
    tar xzf "$tmp_tar" -C "$BIN_DIR"
    rm -f "$tmp_tar"

    chmod +x "${BIN_DIR}/llama-completion" "${BIN_DIR}/llama-embedding"

    # Update version file (shared with phase 1)
    mkdir -p "$DATA_DIR"
    echo "$latest_tag" > "$VERSION_FILE"

    echo "[claude-mem] llama.cpp binaries installed" >&2
}

# ============================================================================
# Phase 3: GGUF models
# ============================================================================

download_model_if_needed() {
    local url="$1"
    local dest="$2"
    local etag_file="${dest}.etag"

    # Fetch remote ETag
    local headers
    headers=$(head_request "$url")
    local remote_etag
    remote_etag=$(echo "$headers" | grep -i '^x-linked-etag:\|^etag:' | head -1 | sed 's/^[^:]*: *//' | tr -d '[:space:]"')

    # Compare with stored ETag
    local stored_etag=""
    if [ -f "$etag_file" ]; then
        stored_etag=$(cat "$etag_file")
    fi

    # Skip if file exists and ETag matches
    if [ -f "$dest" ] && [ -n "$remote_etag" ] && [ "$remote_etag" = "$stored_etag" ]; then
        return 0
    fi

    local filename
    filename=$(basename "$dest")
    echo "[claude-mem] Downloading model ${filename}..." >&2

    download "$url" "$dest"

    # Store ETag for future checks
    if [ -n "$remote_etag" ]; then
        echo "$remote_etag" > "$etag_file"
    fi

    echo "[claude-mem] Model ${filename} installed" >&2
}

phase3_models() {
    mkdir -p "$MODEL_DIR"

    download_model_if_needed \
        "https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF/resolve/main/all-MiniLM-L6-v2-Q8_0.gguf" \
        "${MODEL_DIR}/all-MiniLM-L6-v2-Q8_0.gguf"

    download_model_if_needed \
        "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf" \
        "${MODEL_DIR}/Qwen3-0.6B-Q8_0.gguf"
}

# ============================================================================
# Main
# ============================================================================

phase1_claude_mem
phase2_llama_binaries
phase3_models

# Output valid hook JSON (Claude Code requires JSON on stdout from hook commands)
echo '{"continue":true,"suppressOutput":true}'
