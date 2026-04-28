#!/usr/bin/env bash
# NyxHive — Local CLI installer
# Creates symlink and configures PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRAPPER="$PROJECT_ROOT/bin/nyxhive"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ ! -f "$WRAPPER" ]; then
  echo -e "${RED}Error: bin/nyxhive not found at $WRAPPER${NC}"
  exit 1
fi

chmod +x "$WRAPPER"

# --- Choose install location ---

INSTALL_TO=""
if [ -w "/usr/local/bin" ]; then
  INSTALL_TO="/usr/local/bin/nyxhive"
else
  INSTALL_TO="$HOME/.local/bin/nyxhive"
  mkdir -p "$HOME/.local/bin"
fi

# --- Check for existing installation ---

if [ -e "$INSTALL_TO" ]; then
  if [ -L "$INSTALL_TO" ]; then
    EXISTING_TARGET="$(readlink "$INSTALL_TO")"
    if [ "$EXISTING_TARGET" = "$WRAPPER" ]; then
      echo -e "${GREEN}✓ nyxhive already installed at $INSTALL_TO${NC}"
      exit 0
    fi
    echo -e "${YELLOW}Existing symlink found: $INSTALL_TO -> $EXISTING_TARGET${NC}"
    read -rp "  Replace? [Y/n]: " replace
    if [[ "$replace" =~ ^[nN] ]]; then
      exit 0
    fi
    rm -f "$INSTALL_TO"
  else
    echo -e "${RED}Error: $INSTALL_TO exists but is not a symlink.${NC}"
    echo "  Remove it manually if you want to proceed."
    exit 1
  fi
fi

# --- Create symlink ---

ln -sf "$WRAPPER" "$INSTALL_TO"
echo -e "${GREEN}✓ Symlink: $INSTALL_TO -> $WRAPPER${NC}"

# --- Ensure PATH includes install directory ---

INSTALL_BIN_DIR="$(dirname "$INSTALL_TO")"

if [[ ":$PATH:" != *":$INSTALL_BIN_DIR:"* ]]; then
  # Need to add to PATH
  SHELL_NAME="$(basename "$SHELL")"
  RC_FILE=""
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bash_profile" ]; then
        RC_FILE="$HOME/.bash_profile"
      else
        RC_FILE="$HOME/.bashrc"
      fi
      ;;
    *)    RC_FILE="$HOME/.profile" ;;
  esac

  EXPORT_LINE="export PATH=\"$INSTALL_BIN_DIR:\$PATH\""

  if [ -n "$RC_FILE" ] && ! grep -q "$INSTALL_BIN_DIR" "$RC_FILE" 2>/dev/null; then
    echo "" >> "$RC_FILE"
    echo "# NyxHive CLI" >> "$RC_FILE"
    echo "$EXPORT_LINE" >> "$RC_FILE"
    echo -e "${GREEN}✓ Added $INSTALL_BIN_DIR to PATH in $RC_FILE${NC}"
    echo -e "${YELLOW}  Restart your terminal or: source $RC_FILE${NC}"
  fi
fi

# --- Verify ---

if command -v nyxhive &>/dev/null; then
  echo -e "${GREEN}✓ nyxhive command available${NC}"
else
  echo -e "${YELLOW}○ nyxhive will be available after restarting your terminal${NC}"
fi
