#!/bin/bash
# Fails if any tracked source or doc contains an em/en dash or an AI-attribution
# line. Zero dependencies so it runs the same locally and in CI. Deeper prose
# scanning is a local pre-push step with the humanizer; this is the hard floor.
set -uo pipefail
cd "$(dirname "$0")/.."

# This script is excluded from its own scan: its patterns necessarily contain
# the very strings it searches for, which would otherwise self-flag.
# Untracked-but-not-ignored files are scanned too, so a fresh file fails the
# local run the same way it would fail CI once staged.
globs=('*.js' '*.mjs' '*.css' '*.html' '*.md' '*.py' '*.sh' '*.json' '*.toml'
  ':!:app/vendor/**' ':!:tools/check-clean.sh')
files=$( (git ls-files -- "${globs[@]}"; git ls-files --others --exclude-standard -- "${globs[@]}") | sort -u )

fail=0

dash=$(printf '%s\n' "$files" | xargs -r grep -lP '\x{2013}|\x{2014}' 2>/dev/null || true)
if [ -n "$dash" ]; then
  echo "em/en dash found in:"; printf '  %s\n' $dash; fail=1
fi

attr=$(printf '%s\n' "$files" | xargs -r grep -liE 'co-authored-by|generated with (claude|ai)|🤖' 2>/dev/null || true)
if [ -n "$attr" ]; then
  echo "AI attribution found in:"; printf '  %s\n' $attr; fail=1
fi

# Any file we serve whose name matches a generic ad/tracker filter rule is
# blocked for every visitor running a default blocker. A file named beacon.js in another project walked
# into EasyPrivacy's bare /beacon.js rule and took the whole app down, because
# main.js imports it statically and sw.js precaches it. Snapshot of the rules
# and how to refresh it: tools/adblock-generic-rules.txt.
rules=tools/adblock-generic-rules.txt
if [ -f "$rules" ]; then
  hits=$(while read -r f; do
           grep -qxF "/$(basename "$f")" "$rules" && echo "$f"
         done < <(find app -type f -not -path 'app/vendor/*'))
  if [ -n "$hits" ]; then
    echo "served file matches a generic ad-blocker rule (rename it):"
    printf '  %s\n' $hits; fail=1
  fi
else
  echo "missing $rules, ad-blocker name check did NOT run"; fail=1
fi

# One version, five spellings. A release that bumps some but not all of them
# ships a wrapper that lies about what it is or a cache that never busts.
ver=$(grep -oE '"version": "[^"]+"' package.json | cut -d'"' -f4)
bad=0
grep -q "VERSION = \"$ver\"" app/js/main.js || { echo "app/js/main.js VERSION != $ver"; bad=1; }
grep -q "VERSION = \"sepia-v$ver\"" app/sw.js || { echo "app/sw.js VERSION != sepia-v$ver"; bad=1; }
grep -q "versionName = \"$ver\"" android/app/build.gradle.kts || { echo "gradle versionName != $ver"; bad=1; }
grep -q "^## $ver" CHANGELOG.md || { echo "CHANGELOG.md missing ## $ver"; bad=1; }
if [ "$bad" -eq 1 ]; then exit 1; fi
echo "version $ver consistent across package.json, main.js, sw.js, gradle, changelog"

if [ "$fail" -eq 0 ]; then echo "clean: no em/en dashes, no AI attribution"; fi
exit $fail
