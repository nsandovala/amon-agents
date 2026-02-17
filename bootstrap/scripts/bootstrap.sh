#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"
TARGET_DIR="${2:-.}"

if [[ -z "$PROFILE" ]]; then
  echo "Uso: ./bootstrap.sh <profile> <target_dir>"
  echo "Profiles: node-next | python-radar | mixed"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

copy_common() {
  cp -R "$ROOT_DIR/common/." "$TARGET_DIR/"
}

copy_github() {
  mkdir -p "$TARGET_DIR/.github/workflows"
  cp "$ROOT_DIR/github/dependabot.yml" "$TARGET_DIR/.github/dependabot.yml" || true
}

copy_workflow() {
  local wf="$1"
  cp "$ROOT_DIR/github/workflows/$wf" "$TARGET_DIR/.github/workflows/$wf"
}

copy_common
copy_github

case "$PROFILE" in
  node-next)
    copy_workflow "node-ci.yml"
    copy_workflow "codeql.yml"
    ;;
  python-radar)
    copy_workflow "python-ci.yml"
    copy_workflow "codeql.yml"
    ;;
  mixed)
    copy_workflow "node-ci.yml"
    copy_workflow "python-ci.yml"
    copy_workflow "codeql.yml"
    ;;
  *)
    echo "Profile desconocido: $PROFILE"
    exit 1
    ;;
esac

echo "✅ Bootstrap aplicado ($PROFILE) en: $TARGET_DIR"
echo "Siguiente: revisa README y commitea."
