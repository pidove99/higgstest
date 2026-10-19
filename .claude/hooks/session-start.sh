#!/bin/bash
# Install shotkit (storyboard / prompt / critique skills) into ~/.claude for cloud sessions.
set -euo pipefail

# Only run in Claude Code cloud sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

SHOTKIT_REPO="https://github.com/whystrohm/shotkit.git"
SHOTKIT_REF="v3.1.0"
SHOTKIT_SRC="${HOME}/.cache/shotkit-${SHOTKIT_REF}"
INSTALLED_VERSION_FILE="${HOME}/.claude/shotkit-tools/VERSION"

# Validator dependencies.
python3 -m pip install -q --root-user-action=ignore pyyaml jsonschema

# Skip the install if this exact version is already in place.
if [ -f "${INSTALLED_VERSION_FILE}" ] && [ "$(head -n 1 "${INSTALLED_VERSION_FILE}")" = "${SHOTKIT_REF#v}" ]; then
  echo "shotkit ${SHOTKIT_REF} already installed"
  exit 0
fi

if [ ! -d "${SHOTKIT_SRC}/.git" ]; then
  rm -rf "${SHOTKIT_SRC}"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "${SHOTKIT_REF}" "${SHOTKIT_REPO}" "${SHOTKIT_SRC}"
fi

"${SHOTKIT_SRC}/install.sh" --force < /dev/null
