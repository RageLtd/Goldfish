#!/bin/bash
#
# ensure-binary.sh - Downloads claude-mem binary if not present
# Called by SessionStart hook before running context loading
#

set -e

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="$PLUGIN_ROOT/bin/claude-mem"
REPO="RageLtd/claude-mem"

# If binary exists and is executable, we're done
if [ -x "$BINARY" ]; then
    exit 0
fi

echo "[claude-mem] Binary not found, downloading..." >&2

# Detect OS
case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *)
        echo "[claude-mem] ERROR: Unsupported OS: $(uname -s)" >&2
        exit 1
        ;;
esac

# Detect architecture
case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)
        echo "[claude-mem] ERROR: Unsupported architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

BINARY_NAME="claude-mem-${OS}-${ARCH}"

# Get latest release URL
RELEASE_URL="https://github.com/${REPO}/releases/latest/download/${BINARY_NAME}"

echo "[claude-mem] Downloading ${BINARY_NAME}..." >&2

# Create bin directory if needed
mkdir -p "$PLUGIN_ROOT/bin"

# Download binary
if command -v curl &> /dev/null; then
    curl -fsSL -o "$BINARY" "$RELEASE_URL"
elif command -v wget &> /dev/null; then
    wget -q -O "$BINARY" "$RELEASE_URL"
else
    echo "[claude-mem] ERROR: Neither curl nor wget found" >&2
    exit 1
fi

# Make executable
chmod +x "$BINARY"

echo "[claude-mem] Binary installed successfully" >&2
