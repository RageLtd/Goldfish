#!/bin/bash
#
# ensure-binary.sh - Downloads goldfish binary, llama-server, and GGUF models
# Called by SessionStart hook before running context loading
#
# Phase 1: Download goldfish binary (if missing or outdated)
# Phase 2: Download llama-server from ggml-org/llama.cpp (if missing or outdated)
# Phase 3: Download GGUF models (if missing or outdated)
#

set -e

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="RageLtd/Goldfish"
LLAMA_REPO="ggml-org/llama.cpp"
DATA_DIR="${HOME}/.goldfish"
BIN_DIR="${DATA_DIR}/bin"
MODEL_DIR="${DATA_DIR}/models"
VERSION_FILE="${DATA_DIR}/.version"
LLAMA_SERVER_VERSION_FILE="${DATA_DIR}/.llama-server-version"

# ============================================================================
# Platform Detection
# ============================================================================

case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *)
        echo "[goldfish] ERROR: Unsupported OS: $(uname -s)" >&2
        exit 1
        ;;
esac

case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)
        echo "[goldfish] ERROR: Unsupported architecture: $(uname -m)" >&2
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
        echo "[goldfish] ERROR: Neither curl nor wget found" >&2
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

# Fetch the latest release tag from ggml-org/llama.cpp
get_latest_llama_tag() {
    local headers
    headers=$(head_request "https://github.com/${LLAMA_REPO}/releases/latest")
    echo "$headers" | grep -i '^location:' | sed 's|.*/tag/||' | tr -d '[:space:]'
}

# Map OS/ARCH to llama.cpp release tarball naming convention
get_llama_platform_suffix() {
    case "${OS}-${ARCH}" in
        darwin-arm64) echo "macos-arm64" ;;
        darwin-x64)   echo "macos-x64" ;;
        linux-x64)    echo "ubuntu-x64" ;;
        *)
            echo "[goldfish] ERROR: No llama.cpp release for ${OS}-${ARCH}" >&2
            exit 1
            ;;
    esac
}

# ============================================================================
# Phase 1: goldfish binary
# ============================================================================

phase1_goldfish() {
    local binary="${BIN_DIR}/goldfish"
    local latest_tag
    latest_tag=$(get_latest_tag)
    local stored_version
    stored_version=$(get_stored_version)

    # Skip if binary exists and version matches
    if [ -x "$binary" ] && [ -n "$latest_tag" ] && [ "$latest_tag" = "$stored_version" ]; then
        return 0
    fi

    echo "[goldfish] Downloading goldfish binary (${PLATFORM})..." >&2

    mkdir -p "$BIN_DIR"
    local url="https://github.com/${REPO}/releases/latest/download/goldfish-${PLATFORM}"
    download "$url" "$binary"
    chmod +x "$binary"

    # Store version
    mkdir -p "$DATA_DIR"
    echo "$latest_tag" > "$VERSION_FILE"

    echo "[goldfish] goldfish binary installed" >&2
}

# ============================================================================
# Phase 2: llama-server binary (from ggml-org/llama.cpp)
# ============================================================================

phase2_llama_server() {
    local stored_llama_version=""
    if [ -f "$LLAMA_SERVER_VERSION_FILE" ]; then
        stored_llama_version=$(cat "$LLAMA_SERVER_VERSION_FILE")
    fi

    # Skip if binary exists and version is stored (re-check on new releases)
    if [ -x "${BIN_DIR}/llama-server" ] && [ -n "$stored_llama_version" ]; then
        local latest_llama_tag
        latest_llama_tag=$(get_latest_llama_tag)
        if [ -n "$latest_llama_tag" ] && [ "$latest_llama_tag" = "$stored_llama_version" ]; then
            return 0
        fi
    fi

    local latest_llama_tag
    latest_llama_tag=$(get_latest_llama_tag)

    if [ -z "$latest_llama_tag" ]; then
        echo "[goldfish] ERROR: Could not determine latest llama.cpp release" >&2
        exit 1
    fi

    local platform_suffix
    platform_suffix=$(get_llama_platform_suffix)

    echo "[goldfish] Downloading llama-server ${latest_llama_tag} (${platform_suffix})..." >&2

    mkdir -p "$BIN_DIR"
    # Release tarballs are named like: llama-b5678-bin-macos-arm64.tar.gz
    local tag_number="${latest_llama_tag}"
    local url="https://github.com/${LLAMA_REPO}/releases/download/${latest_llama_tag}/llama-${tag_number}-bin-${platform_suffix}.tar.gz"
    local tmp_tar
    tmp_tar=$(mktemp "${TMPDIR:-/tmp}/llama-server-XXXXXX")
    mv "$tmp_tar" "${tmp_tar}.tar.gz"
    tmp_tar="${tmp_tar}.tar.gz"

    download "$url" "$tmp_tar"

    # Extract only llama-server binary (may be nested in build/bin/)
    local tmp_extract
    tmp_extract=$(mktemp -d "${TMPDIR:-/tmp}/llama-server-extract-XXXXXX")
    tar xzf "$tmp_tar" -C "$tmp_extract"

    # Find llama-server in extracted contents (handles varying directory structure)
    local server_bin
    server_bin=$(find "$tmp_extract" -name "llama-server" -type f | head -1)

    if [ -z "$server_bin" ]; then
        echo "[goldfish] ERROR: llama-server binary not found in release tarball" >&2
        rm -rf "$tmp_tar" "$tmp_extract"
        exit 1
    fi

    cp "$server_bin" "${BIN_DIR}/llama-server"
    chmod +x "${BIN_DIR}/llama-server"

    # Copy shared libraries (.dylib on macOS, .so on Linux) from same directory
    local server_dir
    server_dir=$(dirname "$server_bin")
    find "$server_dir" \( -name "*.dylib" -o -name "*.so" -o -name "*.so.*" \) -exec cp {} "${BIN_DIR}/" \;

    # Create versioned soname symlinks (e.g. libmtmd.so.0 -> libmtmd.so)
    for lib in "${BIN_DIR}"/*.so; do
        [ -f "$lib" ] || continue
        local soname
        soname=$(objdump -p "$lib" 2>/dev/null | awk '/SONAME/{print $2}')
        if [ -n "$soname" ] && [ ! -e "${BIN_DIR}/${soname}" ]; then
            ln -s "$(basename "$lib")" "${BIN_DIR}/${soname}"
        fi
    done

    rm -rf "$tmp_tar" "$tmp_extract"

    # Store version
    mkdir -p "$DATA_DIR"
    echo "$latest_llama_tag" > "$LLAMA_SERVER_VERSION_FILE"

    echo "[goldfish] llama-server installed (${latest_llama_tag})" >&2
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
    echo "[goldfish] Downloading model ${filename}..." >&2

    download "$url" "$dest"

    # Store ETag for future checks
    if [ -n "$remote_etag" ]; then
        echo "$remote_etag" > "$etag_file"
    fi

    echo "[goldfish] Model ${filename} installed" >&2
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

phase1_goldfish
phase2_llama_server
phase3_models

# Output valid hook JSON (Claude Code requires JSON on stdout from hook commands)
echo '{"continue":true,"suppressOutput":true}'
