#!/usr/bin/env bash
# NyxHive — Uninstaller

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${RED}NyxHive — Uninstall${NC}"
echo ""

# --- Remove symlink ---

for location in "/usr/local/bin/nyxhive" "$HOME/.local/bin/nyxhive"; do
  if [ -L "$location" ]; then
    rm -f "$location"
    echo -e "${GREEN}✓ Removed symlink: $location${NC}"
  fi
done

# --- Ask about data ---

NYXHIVE_HOME="${NYXHIVE_HOME:-$HOME/.nyxhive}"

if [ -d "$NYXHIVE_HOME" ]; then
  echo ""
  echo -e "${YELLOW}Data directory exists: $NYXHIVE_HOME${NC}"
  echo "  This contains your configs, databases, and env files."
  read -rp "  Delete data? [y/N]: " delete_data
  if [[ "$delete_data" =~ ^[yY] ]]; then
    # Keep the app dir if it's inside NYXHIVE_HOME
    if [ -d "$NYXHIVE_HOME/app" ]; then
      echo -e "${YELLOW}  Keeping $NYXHIVE_HOME/app/ (source code)${NC}"
      # Delete everything except app/
      find "$NYXHIVE_HOME" -mindepth 1 -maxdepth 1 ! -name 'app' -exec rm -rf {} +
    else
      rm -rf "$NYXHIVE_HOME"
    fi
    echo -e "${GREEN}✓ Data removed${NC}"
  else
    echo "  Data preserved at $NYXHIVE_HOME"
  fi
fi

echo ""
echo -e "${GREEN}NyxHive uninstalled.${NC}"
echo ""
