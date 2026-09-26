// Fractal Rig web UI — palettes.js: palette presets + palette lock (Control tab)
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ palettes (colour group presets) + lock
function renderPalettes() {
  const pals = S.palettes || {};
  $('palette-lock').className = 'btn small' + (S.palette_lock ? ' active' : ''); $('palette-lock').textContent = S.palette_lock ? '🔒 locked' : '🔓 lock';
  const sw = p => { const h = (p.hue || 0) * 360, h2 = ((p.hue || 0) + (p.hue_spread || 1) * 0.35) * 360, l = 30 + 20 * Math.min(1, p.brightness || 1); return `linear-gradient(90deg, hsl(${h} 70% ${l}%), hsl(${h2 % 360} 70% ${l}%))`; };
  listBox($('palettes'), {kind: 'palette', placeholder: 'filter palettes…',
    rows: Object.keys(pals).map(n => ({id: n, label: n, color: sw(pals[n]), bar: true, cur: n === S.palette_current, sub: `${Math.round((pals[n].hue || 0) * 360)}°`})),
    empty: 'no palettes yet — save the current colours under a name',
    onPick: n => send({palette: {load: n, fade_bars: +$('palette-fade').value}}), onDel: n => send({palette: {delete: n}})});
}
$('palette-lock').onclick = () => send({palette: {lock: !S.palette_lock}});
$('palette-save').onclick = () => { const n = $('palette-name').value.trim(); if (!n) return; send({palette: {save: n}}); $('palette-name').value = ''; };
