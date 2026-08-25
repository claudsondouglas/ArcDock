#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

npm test

while IFS= read -r file; do
  node --check "$file"
done < <(find . -type f -name '*.js' -not -path './node_modules/*' -print)

node scripts/check-relative-imports.mjs
xmllint --noout schemas/org.gnome.shell.extensions.arcdock.gschema.xml

schema_build_dir="$(mktemp -d)"
trap 'rm -rf "$schema_build_dir"' EXIT
cp schemas/org.gnome.shell.extensions.arcdock.gschema.xml "$schema_build_dir/"
glib-compile-schemas --strict "$schema_build_dir"
