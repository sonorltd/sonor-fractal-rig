#!/usr/bin/env bash
# UI-drift guard for the Fractal Rig web UI. Run before every commit (CLAUDE.md rule); exits 1 on any hit.
#   bash web/lint-ui.sh
# What it enforces (the contract in js/ui.js):
#   1. no native window.prompt / confirm / alert — every dialog is ui.dialog / ui.confirm / ui.prompt / ui.alert
#   2. no hand-rolled card or tile templates — saved things render through ui.cards (tabs) / ui.tiles (Perform)
#   3. no inline <style> or <script> blocks in index.html — styles live in css/, behaviour in js/
#   4. no hard-coded colours in js/ or index.html — colours are tokens from css/theme.css
#   5. js/nav.js is the only place that lists tabs / Perform pages
#   6. the four version sites agree and Info → Version history has a row for it
#   7. js/library.js LIB_PACK matches renderer/shaders/lib (the Pages demo browses that list)
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
# 6. version sites in step (renderer, master, page pill, CLAUDE.md) and the Info version history has an entry for it
v_c=$(grep -oP '#define APP_VERSION "\K[0-9.]+' ../renderer/fractal.c); v_m=$(grep -oP 'APP_VERSION\s*=\s*"\K[0-9.]+' ../master/master.py | head -1); v_w=$(grep -oP 'id="pill-ver">v\K[0-9.]+' index.html); v_d=$(grep -oP '^# STUDIO - Fractal Rig \(v\K[0-9.]+' ../CLAUDE.md)
[ "$v_c" = "$v_m" ] && [ "$v_c" = "$v_w" ] && [ "$v_c" = "$v_d" ] || hit "version sites disagree — bump all four together" "renderer $v_c · master $v_m · page $v_w · CLAUDE.md $v_d"
grep -q "<tr><td>v$v_c</td>" index.html || hit "Info → Version history has no row for v$v_c" "add it to #i-history (newest first)"
# 7. the shader seed pack listed for the Pages demo (js/library.js LIB_PACK) is exactly renderer/shaders/lib
want=$(ls ../renderer/shaders/lib | grep -iE '\.(fs|frag|glsl)$' | LC_ALL=C sort | tr '\n' ' '); have=$(grep -oP "const LIB_PACK = \[\K[^\]]*" js/library.js | tr -d "'" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep . | LC_ALL=C sort | tr '\n' ' ')
[ "$want" = "$have" ] || hit "js/library.js LIB_PACK ≠ renderer/shaders/lib" "folder: $want" "list:   $have"
for f in js/*.js; do node -e "new Function(require('fs').readFileSync('$f','utf8'))" 2>/dev/null || hit "syntax error" "$f"; done
[ $fail = 0 ] && echo "✓ web UI lint clean ($(ls js/*.js | wc -l) modules, $(ls css/*.css | wc -l) stylesheets)"
exit $fail
