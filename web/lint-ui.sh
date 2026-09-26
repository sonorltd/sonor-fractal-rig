#!/usr/bin/env bash
# UI-drift guard for the Fractal Rig web UI. Run before every commit (CLAUDE.md rule); exits 1 on any hit.
#   bash web/lint-ui.sh
# What it enforces (the contract in js/ui.js):
#   1. no native window.prompt / confirm / alert — every dialog is ui.dialog / ui.confirm / ui.prompt / ui.alert
#   2. no hand-rolled card or tile templates — saved things render through ui.cards (tabs) / ui.tiles (Perform)
#   3. no inline <style> or <script> blocks in index.html — styles live in css/, behaviour in js/
#   4. no hard-coded colours in js/ or index.html — colours are tokens from css/theme.css
#   5. js/nav.js is the only place that lists tabs / Perform pages
cd "$(dirname "$0")" || exit 2
fail=0
hit() { echo "✗ $1"; shift; printf '    %s\n' "$@"; fail=1; }
r=$(grep -nP '(?<![.\w])(prompt|confirm|alert)\(' js/*.js); [ -n "$r" ] && hit "native dialog — use ui.* (js/ui.js)" "$r"
r=$(grep -n 'class="show\b' js/*.js | grep -v 'js/ui.js'); [ -n "$r" ] && hit "hand-rolled card template — use ui.cards" "$r"
r=$(grep -n 'class="pbtn[^"]*" data-' js/*.js | grep -v 'js/ui.js' | grep -v 'data-q=\|data-c=\|data-m=\|data-h=\|data-i=\|data-z=\|data-pfeed\|data-t='); [ -n "$r" ] && hit "hand-rolled Perform tile grid for a saved collection — use ui.tiles" "$r"
r=$(grep -n '<style\|<script>' index.html); [ -n "$r" ] && hit "inline <style>/<script> in index.html — put it in css/ or js/" "$r"
r=$(grep -nP 'style="[^"]*#[0-9a-fA-F]{6}\b' index.html | grep -v 'brandstrip\|<meta'); [ -n "$r" ] && hit "hard-coded colour in markup — use a var(--…) token from css/theme.css (canvas drawing code in js/ is exempt)" "$r"
r=$(grep -n 'data-view="' index.html js/*.js | grep -v 'js/nav.js'); [ -n "$r" ] && hit "tab list outside js/nav.js" "$r"
r=$(grep -n '<button data-pg=' index.html); [ -n "$r" ] && hit "Perform rail button in index.html — add it to PERF_PAGES in js/nav.js" "$r"
for f in js/*.js; do node -e "new Function(require('fs').readFileSync('$f','utf8'))" 2>/dev/null || hit "syntax error" "$f"; done
[ $fail = 0 ] && echo "✓ web UI lint clean ($(ls js/*.js | wc -l) modules, $(ls css/*.css | wc -l) stylesheets)"
exit $fail
