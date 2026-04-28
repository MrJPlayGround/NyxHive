#!/usr/bin/env bash
# NyxHive — Remote Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AgentNyxAI/NyxHive/master/scripts/remote-install.sh | bash

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

INSTALL_DIR="${NYXHIVE_INSTALL_DIR:-$HOME/.nyxhive/app}"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  NyxHive${NC} — Installer"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# --- Check prerequisites ---

echo -e "${BOLD}Checking prerequisites...${NC}"
echo ""

# Bun
if command -v bun &>/dev/null; then
  BUN_VERSION="$(bun --version 2>/dev/null || echo 'unknown')"
  echo -e "  ${GREEN}✓${NC} bun ($BUN_VERSION)"
else
  echo -e "  ${YELLOW}✗${NC} bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo -e "  ${GREEN}✓${NC} bun installed"
fi

# Git
if command -v git &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} git"
else
  echo -e "  ${RED}✗ git is required but not installed.${NC}"
  exit 1
fi

# Claude CLI (optional, for CLI fallback)
if command -v claude &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} claude CLI"
else
  echo -e "  ${YELLOW}○${NC} claude CLI not found (optional — needed for agentic tasks)"
fi

echo ""

# --- Check existing installation ---

if [ -d "$INSTALL_DIR" ]; then
  echo -e "${YELLOW}Existing installation found at $INSTALL_DIR${NC}"
  read -rp "  Reinstall? [y/N]: " reinstall
  if [[ ! "$reinstall" =~ ^[yY] ]]; then
    echo "  Aborted."
    exit 0
  fi
  echo ""
fi

# --- Clone or download ---

echo -e "${BOLD}Installing NyxHive...${NC}"
echo ""

mkdir -p "$(dirname "$INSTALL_DIR")"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing clone..."
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  rm -rf "$INSTALL_DIR"
  git clone https://github.com/AgentNyxAI/NyxHive.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

echo -e "  ${GREEN}✓${NC} Source ready"

# --- Install dependencies ---

echo "  Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# --- Make scripts executable ---

chmod +x bin/nyxhive
chmod +x scripts/install.sh
chmod +x scripts/uninstall.sh 2>/dev/null || true

echo ""

# --- Run local install (symlink + PATH) ---

bash scripts/install.sh

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  NyxHive installed!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
SETUP_CMD="nyxhive"

# Check if nyxhive command is available
if ! command -v nyxhive &>/dev/null; then
  echo -e "  ${YELLOW}Note:${NC} Restart your terminal or run:"
  echo -e "    ${CYAN}source ~/.zshrc${NC}  (or ~/.bashrc)"
  echo ""
  if [ -x "$HOME/.local/bin/nyxhive" ]; then
    SETUP_CMD="$HOME/.local/bin/nyxhive"
  elif [ -x "/usr/local/bin/nyxhive" ]; then
    SETUP_CMD="/usr/local/bin/nyxhive"
  fi
fi

if [ "${NYXHIVE_SKIP_SETUP:-0}" != "1" ]; then
  echo -e "  ${BOLD}Starting setup...${NC}"
  echo ""
  "$SETUP_CMD" setup
else
  echo -e "  ${BOLD}Next steps:${NC}"
  echo -e "    ${CYAN}nyxhive setup${NC}       # Fresh install or move a repo"
  echo -e "    ${CYAN}nyxhive start${NC}       # Start your instance"
  echo ""
fi
