#!/usr/bin/env bash
set -euo pipefail

# Release script for mstro
# Usage: ./bin/release.sh [major|minor|patch]
#
# This script:
# 1. Bumps the version in package.json
# 2. Updates CHANGELOG.md with git commits since last tag
# 3. Commits the changes
# 4. Creates a git tag
# 5. Pushes to GitHub (branch + tag)
#
# After push, run `npm publish` to publish to npmjs.

BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" != "major" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "patch" ]]; then
  echo "Usage: $0 [major|minor|patch]"
  exit 1
fi

# Ensure we're in the cli directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"
cd "$CLI_DIR"

# Ensure working directory is clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working directory is not clean. Commit or stash changes first."
  exit 1
fi

# Get current version
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Current version: $CURRENT_VERSION"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "New version: $NEW_VERSION"

# Get the last tag (or first commit if no tags)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)

# Generate changelog entry from git commits
CHANGELOG_ENTRY="## $NEW_VERSION ($(date +%Y-%m-%d))\n\n"
COMMITS=$(git log "$LAST_TAG"..HEAD --pretty=format:"- %s" --no-merges 2>/dev/null || git log --pretty=format:"- %s" --no-merges)

if [[ -z "$COMMITS" ]]; then
  CHANGELOG_ENTRY+="- Release $NEW_VERSION\n"
else
  CHANGELOG_ENTRY+="$COMMITS\n"
fi

# Update CHANGELOG.md
if [[ -f CHANGELOG.md ]]; then
  # Insert new entry after the header
  EXISTING=$(cat CHANGELOG.md)
  {
    echo "# Changelog"
    echo ""
    echo -e "$CHANGELOG_ENTRY"
    # Strip the first line (# Changelog) and any leading blank lines from existing
    echo "$EXISTING" | tail -n +2
  } > CHANGELOG.md
else
  {
    echo "# Changelog"
    echo ""
    echo -e "$CHANGELOG_ENTRY"
  } > CHANGELOG.md
fi

# Bump version in package.json (without npm creating a git tag)
npm version "$NEW_VERSION" --no-git-tag-version

echo ""
echo "Updated:"
echo "  - package.json: $CURRENT_VERSION -> $NEW_VERSION"
echo "  - CHANGELOG.md: added $NEW_VERSION entry"

# Commit and tag
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

echo ""
echo "Created commit and tag v$NEW_VERSION"

# Push
echo ""
read -rp "Push to origin? (y/N) " CONFIRM
if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
  git push origin HEAD
  git push origin "v$NEW_VERSION"
  echo ""
  echo "Pushed to GitHub. Now run 'npm publish' to publish to npmjs."
else
  echo ""
  echo "Skipped push. Run manually:"
  echo "  git push origin HEAD"
  echo "  git push origin v$NEW_VERSION"
  echo "  npm publish"
fi
