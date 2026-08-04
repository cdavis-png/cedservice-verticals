#!/bin/bash
set -e

REPO_URL="https://github.com/cdavis-png/cedservice-verticals.git"
TARGET="$HOME/cedservice-verticals"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo
echo "CED Service Verticals Bootstrap"
echo "Repository: $REPO_URL"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "Git is not installed. Install Xcode Command Line Tools when prompted:"
  xcode-select --install || true
  echo "After installation finishes, run this script again."
  exit 1
fi

if [ -d "$TARGET/.git" ]; then
  echo "Existing repository found at $TARGET"
  cd "$TARGET"
  git pull --rebase || true
else
  echo "Cloning repository..."
  git clone "$REPO_URL" "$TARGET"
fi

echo "Copying repository structure and files..."
rsync -av --exclude "install-on-mac.sh" --exclude "SETUP-ON-MAC.md" --exclude ".DS_Store" "$SOURCE_DIR/" "$TARGET/"

cd "$TARGET"

git add .
if git diff --cached --quiet; then
  echo "No new changes to commit."
else
  git commit -m "Initialize CED Service vertical platform structure"
  echo "Pushing to GitHub..."
  git push origin main
fi

echo
echo "Done."
echo "Repository folder: $TARGET"
echo "GitHub: https://github.com/cdavis-png/cedservice-verticals"
