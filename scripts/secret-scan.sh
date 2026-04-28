#!/bin/bash
# Pre-commit hook: scan staged files for accidental secrets.
# Install: cp scripts/secret-scan.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Or: ln -sf ../../scripts/secret-scan.sh .git/hooks/pre-commit

set -euo pipefail

# Patterns that should never appear in committed files
PATTERNS=(
  'xoxb-[0-9]'                          # Slack bot token
  'xoxp-[0-9]'                          # Slack user token
  'xapp-[0-9]'                          # Slack app token
  'sk-[a-zA-Z0-9]{20,}'                 # OpenAI/Anthropic API key
  'ghp_[a-zA-Z0-9]{36}'                 # GitHub PAT
  'glpat-[a-zA-Z0-9_-]{20}'             # GitLab PAT
  'AKIA[0-9A-Z]{16}'                    # AWS access key
  'password\s*[:=]\s*["\x27][^"\x27]+'  # password = "..." or password: "..."
  '\bapi[_-]?key\s*[:=]\s*["\x27][^"\x27]{8,}' # api_key = "..." with 8+ char value
)

# Files to skip
SKIP_PATTERNS='\.test\.|secret-scan\.sh|input-sanitizer\.ts|\.snap$'

FOUND=0
STAGED=$(git diff --cached --name-only --diff-filter=ACM)

for file in $STAGED; do
  # Skip binary files and test files
  if [[ "$file" =~ $SKIP_PATTERNS ]]; then
    continue
  fi

  content=$(git show ":$file" 2>/dev/null || true)
  if [[ -z "$content" ]]; then
    continue
  fi

  for pattern in "${PATTERNS[@]}"; do
    matches=$(echo "$content" | grep -nE "$pattern" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      echo "SECRET DETECTED in $file:"
      echo "$matches" | sed -E 's/(=|:)[[:space:]]*["'\'']?[^"'\''[:space:]]+/\1 [REDACTED]/g' | head -3
      echo ""
      FOUND=1
    fi
  done
done

if [[ $FOUND -eq 1 ]]; then
  echo "---"
  echo "Commit blocked: potential secrets detected in staged files."
  echo "If these are false positives, use: git commit --no-verify"
  exit 1
fi
