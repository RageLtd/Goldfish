#!/bin/bash
#
# dev-install.sh - Build and install binary to local plugin cache for development
#
# Usage: bun run dev:install
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_CACHE="$HOME/.claude/plugins/cache/rageltd/claude-mem-bun/1.0.0"

echo "[dev] Building binary..."
cd "$PROJECT_ROOT"
bun run build

if [ ! -f "$PROJECT_ROOT/plugin/bin/claude-mem" ]; then
    echo "[dev] ERROR: Build failed - binary not found"
    exit 1
fi

echo "[dev] Installing to plugin cache..."
mkdir -p "$PLUGIN_CACHE/bin"
mkdir -p "$PLUGIN_CACHE/scripts"
mkdir -p "$PLUGIN_CACHE/skills"

# Copy binary
cp "$PROJECT_ROOT/plugin/bin/claude-mem" "$PLUGIN_CACHE/bin/claude-mem"
chmod +x "$PLUGIN_CACHE/bin/claude-mem"

# Copy scripts
cp "$PROJECT_ROOT/plugin/scripts/ensure-binary.sh" "$PLUGIN_CACHE/scripts/"
chmod +x "$PLUGIN_CACHE/scripts/ensure-binary.sh"

# Copy hooks
cp "$PROJECT_ROOT/plugin/hooks/hooks.json" "$PLUGIN_CACHE/hooks/hooks.json"

# Copy skills
cp -r "$PROJECT_ROOT/plugin/skills/"* "$PLUGIN_CACHE/skills/"

# Copy plugin.json
cp "$PROJECT_ROOT/plugin/.claude-plugin/plugin.json" "$PLUGIN_CACHE/.claude-plugin/plugin.json"

echo "[dev] Installed successfully!"
echo "[dev] Binary: $PLUGIN_CACHE/bin/claude-mem"
echo "[dev] Restart Claude Code to use the updated plugin"
