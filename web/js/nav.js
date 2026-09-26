// Fractal Rig web UI — nav.js: the menus. TABS drives the header tab bar, PERF_PAGES drives the Perform rail.
// Adding a tab = a <section id="…"> in index.html + one line here. Looks live in css/nav.css.
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
const TABS = [
  // id = the section id (control = <main>), label = tab text, show() = what to refresh when the tab opens
  {id: 'control',  label: 'Control',  show: () => {}},
  {id: 'cues',     label: 'Cues',     show: () => { renderCues(true); cuelFetch(); }},
  {id: 'inputs',   label: 'Inputs',   show: () => {}},
  {id: 'outputs',  label: 'Outputs',  show: () => { renderOutputs(true); mapFetch(); if (S.live) ndiScan(); }},
  {id: 'media',    label: 'Media',    show: () => fetchMedia(true)},
  {id: 'resolume', label: 'Resolume', show: () => { renderOutputs(true); renderResolume(true); }},
  {id: 'leds',     label: 'LEDs',     show: () => { renderOutputs(true); renderZones(); drawLed(); ledcFetch(); $('strips-msg').innerHTML = ''; }},
  {id: 'status',   label: 'Rig',      show: () => renderStatus()},
  {id: 'shows',    label: 'Shows',    show: () => showsFetch()},
  {id: 'info',     label: 'Info',     show: () => {}},
];
const PERF_PAGES = [
  // pg = the data-pg of a .ppage in index.html (numbers are historical — the order HERE is the rail order)
  {pg: 0, label: 'SHOW',    hint: 'tempo · scene'},
  {pg: 1, label: 'PRESETS', hint: 'looks you saved'},
  {pg: 4, label: 'CLIPS',   hint: 'video · LIVE'},
  {pg: 2, label: 'FEEL',    hint: 'speed · pulse'},
  {pg: 3, label: 'COLOUR',  hint: 'hue · palettes'},
  {pg: 6, label: 'CUES',    hint: 'GO · BACK', open: () => cuelFetch()},
  {pg: 5, label: 'SHOWS',   hint: 'venue setups', open: () => pfShowsFetch()},
  {pg: 7, label: 'LEDS',    hint: 'pixels · configs', open: () => pfLedcFetch()},
];
let curView = 'control';
function showView(v) {
  if (!TABS.some(t => t.id === v)) v = 'control';
  curView = v;
  $('nav').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  document.querySelector('main').hidden = v !== 'control';
  TABS.forEach(t => { if (t.id !== 'control') $(t.id).hidden = t.id !== v; });
  (TABS.find(t => t.id === v).show || (() => {}))();
  try { localStorage.setItem('frx.view', v); } catch (e) {}
  window.scrollTo(0, 0);
}
$('nav').innerHTML = TABS.map(t => `<button data-view="${t.id}" class="${t.id === 'control' ? 'active' : ''}">${t.label}</button>`).join('');
$('nav').querySelectorAll('button').forEach(b => b.onclick = () => showView(b.dataset.view));
$('pill-fleet').onclick = () => showView('status');
// Perform rail: page buttons from PERF_PAGES, then the fixed tail (scroll arrows + BLACK) that index.html keeps
(() => { const rail = $('pf-tabs'); const tail = rail.querySelector('.spacer'); PERF_PAGES.forEach(p => { const b = document.createElement('button'); b.dataset.pg = p.pg; b.innerHTML = `${p.label}<small>${p.hint}</small>`; rail.insertBefore(b, tail); }); })();
