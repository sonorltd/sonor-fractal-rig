// Fractal Rig web UI — perform.js: Perform mode: rail pages, big touch controls (SHOW/PRESETS/CLIPS/FEEL/COLOUR/CUES/SHOWS/LEDS)
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ performance mode (big touch controls)
let perfOn = false, pfBlackPrev = null, pfFreezePrev = null;
function perfEnter(on) {
  perfOn = on; $('perf').hidden = !on; document.body.classList.toggle('perf', on);
  try { localStorage.setItem('frx.perf', on ? '1' : '0'); } catch (e) {}
  if (on) { buildPerf(); renderPerf(); }
}
$('perf-enter').onclick = () => perfEnter(true);
$('preset-filter').querySelectorAll('button').forEach(b => b.onclick = () => { presetFilter = b.dataset.f; $('preset-filter').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); renderControls(); });
$('out-res').onchange = () => send({set: {out_res: +$('out-res').value}});
$('perf-exit').onclick = () => perfEnter(false);
let pfCur = 0;
function pfPage(i) {
  pfCur = i;
  $('pf-pages').querySelectorAll('.ppage').forEach(p => p.classList.toggle('on', +p.dataset.pg === i));
  $('pf-tabs').querySelectorAll('button[data-pg]').forEach(b => b.classList.toggle('active', +b.dataset.pg === i));
  try { localStorage.setItem('frx.perfpage', String(i)); } catch (e) {}
  const pp = PERF_PAGES.find(p => p.pg === i); if (pp && pp.open) pp.open();
  renderPerf();
}
$('pf-tabs').querySelectorAll('button[data-pg]').forEach(b => b.onclick = () => pfPage(+b.dataset.pg));
const pfCurPage = () => $('pf-pages').querySelector('.ppage.on');
$('pf-up').onclick = () => { const p = pfCurPage(); if (p) p.scrollBy({top: -p.clientHeight * 0.8, behavior: 'smooth'}); };
$('pf-down').onclick = () => { const p = pfCurPage(); if (p) p.scrollBy({top: p.clientHeight * 0.8, behavior: 'smooth'}); };
$('pf-black-rail').onclick = () => $('pf-blackout').click();
try { const pp = +localStorage.getItem('frx.perfpage'); if (PERF_PAGES.some(p => p.pg === pp)) pfPage(pp); } catch (e) {}
// presets: save / update from Perform
let pfLastPreset = null, pfPresetFilter = 'engine';
$('pf-preset-filter').querySelectorAll('button').forEach(b => b.onclick = () => { pfPresetFilter = b.dataset.f; $('pf-preset-filter').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); renderPerf(); });
$('pf-preset-save').onclick = () => { const n = prompt('Name for this look'); if (n && n.trim()) { send({preset: {save: n.trim()}}); pfLastPreset = n.trim(); } };
$('pf-preset-update').onclick = () => { if (!pfLastPreset) return alert('load or save a look first'); if (confirm(`Overwrite "${pfLastPreset}" with the current look?`)) send({preset: {save: pfLastPreset}}); };
// clips page extras
$('pf-vid-loop').onclick = () => send({video: {loop: !(S.base.video_loop > 0.5)}});
$('pf-vid-barsync').onclick = () => send({video: {bar_sync: !S.video.bar_sync}});
$('pf-vid-cycle').onclick = () => { const order = ['end', 'bars', 'off']; send({video: {cycle: order[(order.indexOf(S.video.cycle) + 1) % 3]}}); };
$('pf-live-go').onclick = () => send({video: {live: 1}});
$('perf').querySelectorAll('[data-pfeed]').forEach(b => b.onclick = () => send({set: {live_mix: +b.dataset.pfeed}}));
$('pf-live-stop').onclick = () => { send({video: {live_stop: 1}}); setTimeout(() => fetchMedia(true), 800); };
// shows page
let PF_SHOWS = null;
async function pfShowsFetch() { if (!S.live) { $('pf-shows').innerHTML = '<span class="hint">shows live on the master</span>'; return; } try { PF_SHOWS = await (await fetch('/api/shows')).json(); } catch (e) { return; } pfRenderShows(); }
function pfRenderShows() {
  if (!PF_SHOWS) return; const sF = favList('show'); let list = PF_SHOWS.list || []; list = list.filter(x => sF.includes(x.name)).concat(list.filter(x => !sF.includes(x.name)));
  $('pf-shows').innerHTML = list.map(sh => `<button class="pbtn pf-show ${sh.name === PF_SHOWS.last ? 'active' : ''}" data-s="${esc(sh.name)}">${sF.includes(sh.name) ? '★ ' : ''}${esc(sh.name)}<small>${sh.venue ? esc(sh.venue) + ' · ' : ''}${sh.projectors.length} projector${sh.projectors.length === 1 ? '' : 's'} · ${MODE_NAMES[Math.round(sh.scene || 0)] || ''}</small></button>`).join('') || '<span class="hint">no shows saved yet — set the rig up and press SAVE</span>';
  $('pf-shows').querySelectorAll('[data-s]').forEach(b => b.onclick = async () => { if (!confirm(`Load show "${b.dataset.s}"? This changes the whole rig.`)) return; b.textContent = 'loading…'; await fetch(`/api/shows/${encodeURIComponent(b.dataset.s)}/load`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}); pfShowsFetch(); });
  $('pf-show-cur').textContent = PF_SHOWS.last || 'none loaded';
}
$('pf-show-update').onclick = async () => { const n = PF_SHOWS && PF_SHOWS.last; if (!n) return alert('no show loaded — use SAVE'); if (!confirm(`Overwrite show "${n}" with the rig as it is now?`)) return; await fetch(`/api/shows/${encodeURIComponent(n)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({update: true})}); pfShowsFetch(); };
$('pf-show-save').onclick = async () => { const n = prompt('Name for this show (venue / scenario)'); if (!n || !n.trim()) return; await fetch(`/api/shows/${encodeURIComponent(n.trim())}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({update: true})}); pfShowsFetch(); };
// LEDs page
let PF_LEDC = null, pfLedBlackPrev = null;
async function pfLedcFetch() { if (!S.live) { $('pf-ledc').innerHTML = '<span class="hint">saved on the master</span>'; return; } try { PF_LEDC = (await (await fetch('/api/led/configs')).json()).configs || []; } catch (e) { return; } pfRenderLedc(); }
function pfRenderLedc() {
  if (!PF_LEDC) return; const f = favList('led_config'); const list = PF_LEDC.filter(x => f.includes(x.name)).concat(PF_LEDC.filter(x => !f.includes(x.name)));
  $('pf-ledc').innerHTML = list.map(c => `<button class="pbtn pf-show" data-l="${esc(c.name)}">${f.includes(c.name) ? '★ ' : ''}${esc(c.name)}<small>${c.strips} zone${c.strips === 1 ? '' : 's'} · ${c.pixels} px</small></button>`).join('') || '<span class="hint">no saved LED configurations — lay zones out on the LEDs tab and save them</span>';
  $('pf-ledc').querySelectorAll('[data-l]').forEach(b => b.onclick = async () => { if (!confirm(`Load LED configuration "${b.dataset.l}"? It replaces the current zones.`)) return; b.textContent = 'loading…'; await fetch(`/api/led/configs/${encodeURIComponent(b.dataset.l)}/load`, {method: 'POST'}); LED.dirty = false; LED.pending = null; LED.sig = ''; pfLedcFetch(); });
}
$('pf-led-toggle').onclick = () => send({led: {enabled: !(S.outputs.led && S.outputs.led.enabled)}});
$('pf-led-blackout').onclick = () => { const led = S.outputs.led || {}; if (pfLedBlackPrev == null) { pfLedBlackPrev = led.brightness == null ? 0.8 : led.brightness; send({led: {brightness: 0}}); } else { send({led: {brightness: pfLedBlackPrev || 0.8}}); pfLedBlackPrev = null; } };
$('pf-led-bri').oninput = () => { const r = $('pf-led-bri'); r.dataset.touch = performance.now(); r.parentElement.querySelector('.v').textContent = (+r.value).toFixed(2); send({led: {brightness: +r.value}}); };
$('pf-led-test').querySelectorAll('button').forEach(b => b.onclick = () => send({led: {test: b.dataset.t}}));
$('pf-tap').onclick = () => send({tap: 1});
$('pf-beat1').onclick = () => send({beat1: 1});
$('pf-eng-shader').onclick = () => send({set: {mode: lastShaderMode}});
$('pf-eng-pm').onclick = () => send({set: {mode: 8}});
$('pf-eng-video').onclick = () => send({video: {play: S.video.index === 255 ? 255 : Math.max(0, S.video.index || 0)}});
$('pf-vid-prev').onclick = () => send({video: {prev: 1}}); $('pf-vid-next').onclick = () => send({video: {next: 1}}); $('pf-vid-restart').onclick = () => send({video: {restart: 1}});
$('pf-blackout').onclick = () => { if (pfBlackPrev == null) { pfBlackPrev = S.base.brightness; send({set: {brightness: 0}}); } else { send({set: {brightness: pfBlackPrev || 1}}); pfBlackPrev = null; } };
$('pf-freeze').onclick = () => { if (pfFreezePrev == null) { pfFreezePrev = S.clock_speed; send({clock_speed: 0}); } else { send({clock_speed: pfFreezePrev || 1}); pfFreezePrev = null; } };
$('pf-autotoggle').onclick = () => send({source: {name: 'auto', enabled: !S.auto_enabled}});
$('pf-pm-prev').onclick = () => send({pm: {prev: 1}}); $('pf-pm-next').onclick = () => send({pm: {next: 1}}); $('pf-pm-random').onclick = () => send({pm: {random: 1}});
$('pf-pm-hold').onclick = () => $('pm-hold').click(); $('pf-pm-fav').onclick = () => $('pm-favtoggle').click();
$('perf').querySelectorAll('input[data-pk]').forEach(r => r.oninput = () => { r.dataset.touch = performance.now(); r.parentElement.querySelector('.v').textContent = (+r.value).toFixed(2); send({set: {[r.dataset.pk]: +r.value}}); });
$('perf').querySelectorAll('input[data-mk]').forEach(r => r.oninput = () => { r.dataset.touch = performance.now(); r.parentElement.querySelector('.v').textContent = (+r.value).toFixed(2); send({[r.dataset.mk]: +r.value}); });
$('perf').querySelectorAll('[data-nudge]').forEach(b => b.onclick = () => { const k = b.dataset.nudge, p = PARAMS[idx[k]]; send({set: {[k]: Math.max(p.min, Math.min(p.max, (S.base[k] || 0) + +b.dataset.d))}}); });
let perfBuilt = false;
function buildPerf() {
  $('pf-scenes').innerHTML = MODE_NAMES.slice(0, 8).map((n, i) => `<button class="pbtn" data-m="${i}">${n}</button>`).join('');
  $('pf-scenes').querySelectorAll('button').forEach(b => b.onclick = () => send({set: {mode: +b.dataset.m}}));
  $('pf-hues').innerHTML = [0, .08, .16, .25, .33, .42, .5, .58, .66, .75, .83, .92].map(h => `<button class="pbtn" data-h="${h}" style="background:hsl(${h * 360} 70% 22%);border-color:hsl(${h * 360} 70% 40%)">${Math.round(h * 360)}°</button>`).join('');
  $('pf-hues').querySelectorAll('button').forEach(b => b.onclick = () => send({set: {hue: +b.dataset.h}}));
  perfBuilt = true;
}
function renderPerf() {
  if (!perfOn) return;
  $('pf-bpm').textContent = S.bpm ? S.bpm.toFixed(1) : '—';
  $('pf-src').textContent = $('tempo-label').textContent;
  const on8 = Math.round(S.base.mode) === 8;
  const on9p = Math.round(S.base.mode) === 9;
  $('pf-eng-shader').className = 'pbtn eng' + ((on8 || on9p) ? '' : ' active'); $('pf-eng-pm').className = 'pbtn eng' + (on8 ? ' active' : ''); $('pf-eng-video').className = 'pbtn eng' + (on9p ? ' active' : '');
  $('pf-eng-pm-sub').textContent = on8 && S.pm.name ? shortName(S.pm.name).slice(0, 28) : 'milkdrop presets'; $('pf-eng-video-sub').textContent = on9p && S.video.name ? S.video.name : 'clips · LIVE feed';
  // Show page: scene grid for the shader engine, quick controls for the other two
  const engP = engineOf(S.base.mode); $('pf-scenes').style.display = engP === 'shader' ? '' : 'none'; $('pf-scenes-label').textContent = engP === 'shader' ? 'Scene' : engP === 'pm' ? 'Milkdrop' : 'Video';
  const qsig = engP + '|' + (S.pm.name || '') + '|' + (S.video.name || '');
  if ($('pf-engine-quick').dataset.sig !== qsig) { $('pf-engine-quick').dataset.sig = qsig;
    $('pf-engine-quick').innerHTML = engP === 'pm' ? `<button class="pbtn" data-q="pm-prev">◀ PREV</button><button class="pbtn primary" data-q="pm-random">RANDOM<small>${esc(shortName(S.pm.name || '').slice(0, 26))}</small></button><button class="pbtn" data-q="pm-next">NEXT ▶</button>`
      : engP === 'video' ? `<button class="pbtn" data-q="vid-prev">◀ PREV</button><button class="pbtn primary" data-q="vid-restart">↻ RESTART<small>${esc(S.video.name || '')}</small></button><button class="pbtn" data-q="vid-next">NEXT ▶</button>` : '';
    $('pf-engine-quick').querySelectorAll('[data-q]').forEach(b => b.onclick = () => ({'pm-prev': () => send({pm: {prev: 1}}), 'pm-random': () => send({pm: {random: 1}}), 'pm-next': () => send({pm: {next: 1}}), 'vid-prev': () => send({video: {prev: 1}}), 'vid-restart': () => send({video: {restart: 1}}), 'vid-next': () => send({video: {next: 1}})})[b.dataset.q]()); }
  const clips = (S.media.clips || []), csig = clips.map(c => c.name).join('|') + '#' + S.video.index + on9p;
  if ($('pf-clips').dataset.sig !== csig) { $('pf-clips').dataset.sig = csig; $('pf-clips').innerHTML = clips.slice(0, 24).map((c, i) => `<button class="pbtn pf-clip ${on9p && i === S.video.index ? 'active' : ''}" data-c="${i}">${c.thumb ? `<i class="bg" style="background-image:url(${c.thumb})"></i>` : ''}<span>${esc(c.name)}</span></button>`).join('') + `<button class="pbtn pf-clip ${on9p && S.video.index === 255 ? 'active' : ''}" data-c="255"><span>● LIVE</span></button>` || ''; $('pf-clips').querySelectorAll('[data-c]').forEach(b => b.onclick = () => send({video: {play: +b.dataset.c}})); }
  $('pf-scenes').querySelectorAll('button').forEach(b => b.className = 'pbtn' + (+b.dataset.m === Math.round(S.base.mode) ? ' active' : ''));
  $('pf-blackout').className = 'pbtn danger' + (S.base.brightness === 0 ? ' active' : ''); $('pf-freeze').className = 'pbtn' + (S.clock_speed === 0 ? ' active' : ''); $('pf-autotoggle').className = 'pbtn' + (S.auto_enabled ? ' active' : '');
  const engPP = engineOf(S.base.mode); const pfv = favList('preset');
  let names = Object.keys(S.presets || {}).filter(n => pfPresetFilter === 'all' || (pfPresetFilter === 'fav' ? pfv.includes(n) : engineOf(presetMode(n)) === engPP));
  names = names.filter(n => pfv.includes(n)).concat(names.filter(n => !pfv.includes(n)));   // favourites first, like every list on the site
  const psig = names.join('|') + '#' + pfLastPreset + pfPresetFilter + pfv.join(','); if ($('pf-presets').dataset.sig !== psig) { $('pf-presets').dataset.sig = psig; $('pf-presets').innerHTML = names.map(n => { const pr = (typeof S.presets[n] === 'object' && S.presets[n]) || {mode: presetMode(n)}; const sc = MODE_NAMES[Math.round(pr.mode || 0)] || ''; return `<button class="pbtn pf-preset ${n === pfLastPreset ? 'active' : ''}" data-p="${esc(n)}" style="border-left:5px solid var(--eng-${engineOf(presetMode(n))})">${pfv.includes(n) ? '★ ' : ''}${esc(n)}<small>${sc}${pr.pm_preset != null && Math.round(pr.mode) === 8 ? ' #' + Math.round(pr.pm_preset) : ''}</small></button>`; }).join('') || `<span class="hint">${pfPresetFilter === 'fav' ? 'no favourite looks yet — star them on the Control page' : Object.keys(S.presets || {}).length ? 'no ' + ENGINE_LABEL[engPP] + ' looks — tap "all" or save one' : 'no looks saved yet — set one up and press SAVE CURRENT LOOK'}</span>`; $('pf-presets').querySelectorAll('[data-p]').forEach(b => b.onclick = () => { pfLastPreset = b.dataset.p; send({preset: {load: b.dataset.p}}); renderPerf(); }); }
  $('pf-preset-last').textContent = pfLastPreset || 'nothing loaded yet';
  $('pf-scene-pill').textContent = (MODE_NAMES[Math.round(S.base.mode)] || '') + (on8 && S.pm.name ? ' · ' + shortName(S.pm.name) : on9p && S.video.name ? ' · ' + S.video.name : '');
  $('pf-vid-name').textContent = S.video.name ? (S.video.index === 255 ? 'LIVE feed' : `#${S.video.index} · ${S.video.name}`) + (S.video.duration ? ` · ${Math.floor(S.video.position)}s / ${Math.floor(S.video.duration)}s` : '') : 'no clip';
  $('pf-vid-loop').className = 'pbtn' + (S.base.video_loop > 0.5 ? ' active' : ''); $('pf-vid-barsync').className = 'pbtn' + (S.video.bar_sync ? ' active' : '');
  $('pf-vid-cycle').className = 'pbtn' + (S.video.cycle !== 'off' ? ' active' : ''); $('pf-vid-cycle-sub').textContent = S.video.cycle === 'end' ? 'when the clip ends' : S.video.cycle === 'bars' ? `every ${S.video.cycle_bars} bars` : 'off';
  const lv = S.video.live || {}; $('pf-live-go').className = 'pbtn huge' + (on9p && S.video.index === 255 ? ' active' : ''); $('pf-live-sub').textContent = lv.running ? (lv.source || 'feed running') : 'no feed running — start one on the Media tab';
  const list = S.pm_presets || [], nm = list[S.pm.index] || '';
  $('pf-pm-name').textContent = list.length ? `#${S.pm.index} · ${shortName(nm)}` : 'Milkdrop presets not available';
  $('pf-pm-hold').className = 'pbtn' + (S.pm.cycle_bars === 0 && pmHeld ? ' active' : ''); $('pf-pm-fav').textContent = (pmFavs.has(nm) ? '★' : '☆') + ' FAVOURITE';
  const favs = list.map((n, i) => [n, i]).filter(([n]) => pmFavs.has(n)); const fsig = favs.map(f => f[1]).join(',') + '|' + S.pm.index;
  if ($('pf-pm-favs').dataset.sig !== fsig) { $('pf-pm-favs').dataset.sig = fsig; $('pf-pm-favs').innerHTML = favs.map(([n, i]) => `<button class="pbtn pm-tile ${i === S.pm.index ? 'active' : ''}" data-i="${i}">${esc(shortName(n))}</button>`).join('') || '<span class="hint">star presets in the projectM panel and they appear here</span>'; $('pf-pm-favs').querySelectorAll('[data-i]').forEach(b => b.onclick = () => send({pm: {index: +b.dataset.i}})); }
  const palF = favList('palette'); let palN = Object.keys(S.palettes || {}); palN = palN.filter(n => palF.includes(n)).concat(palN.filter(n => !palF.includes(n)));
  const palSig = palN.join('|') + S.palette_current + palF.join(','); if ($('pf-palettes').dataset.sig !== palSig) { $('pf-palettes').dataset.sig = palSig;
    $('pf-palettes').innerHTML = palN.map(n => { const p = S.palettes[n], h = (p.hue || 0) * 360, h2 = ((p.hue || 0) + (p.hue_spread || 1) * 0.35) * 360; return `<button class="pbtn pm-tile ${n === S.palette_current ? 'active' : ''}" data-pal="${esc(n)}" style="background:linear-gradient(135deg, hsl(${h} 60% 22%), hsl(${h2 % 360} 60% 22%))">${palF.includes(n) ? '★ ' : ''}${esc(n)}</button>`; }).join('') || '<span class="hint">no palettes</span>';
    $('pf-palettes').querySelectorAll('[data-pal]').forEach(b => b.onclick = () => send({palette: {load: b.dataset.pal, fade_bars: 2}})); }
  $('pf-pal-lock').className = 'pbtn' + (S.palette_lock ? ' active' : ''); $('pf-pal-lock').firstChild.textContent = S.palette_lock ? '🔒 PALETTE LOCKED' : '🔓 PALETTE LOCK';
  const pled = S.outputs.led || {}, pz = pled.strips || [];
  $('pf-led-toggle').className = 'pbtn huge' + (pled.enabled ? ' active' : ''); $('pf-led-sub').textContent = pled.enabled ? `on · ${pled.pixels || 0} px · ${pz.length} zone${pz.length === 1 ? '' : 's'}${Object.keys(pled.errors || {}).length ? ' · ERRORS' : ''}` : 'off';
  $('pf-led-blackout').className = 'pbtn' + (pled.brightness === 0 ? ' active' : '');
  { const r = $('pf-led-bri'); if (!(r.dataset.touch && performance.now() - r.dataset.touch < 800)) { r.value = pled.brightness == null ? 0.8 : pled.brightness; r.parentElement.querySelector('.v').textContent = (+r.value).toFixed(2); } }
  $('pf-led-test').querySelectorAll('button').forEach(b => b.className = 'pbtn' + (b.dataset.t === (pled.test || 'off') ? ' active' : ''));
  const zsig = pz.map(z => z.name + (z.enabled === false ? 0 : 1)).join('|'); if ($('pf-led-zones').dataset.sig !== zsig) { $('pf-led-zones').dataset.sig = zsig;
    $('pf-led-zones').innerHTML = pz.map((z, i) => `<button class="pbtn ${z.enabled === false ? '' : 'active'}" data-z="${i}" style="border-left:5px solid ${zoneColor(i)}">${esc(z.name || 'zone ' + (i + 1))}<small>${z.count} px${z.ip ? ' · ' + esc(z.ip) : ''}</small></button>`).join('') || '<span class="hint">no zones yet</span>';
    $('pf-led-zones').querySelectorAll('[data-z]').forEach(b => b.onclick = () => { const list = (S.outputs.led.strips || []).map(z => Object.assign({}, z)); list[+b.dataset.z].enabled = list[+b.dataset.z].enabled === false; LED.dirty = false; LED.pending = null; send({led: {strips: list}}); }); }
  $('perf').querySelectorAll('input[data-pk]').forEach(r => { if (!(r.dataset.touch && performance.now() - r.dataset.touch < 800)) { r.value = S.base[r.dataset.pk]; r.parentElement.querySelector('.v').textContent = (+S.base[r.dataset.pk]).toFixed(2); } });
  $('perf').querySelectorAll('input[data-mk]').forEach(r => { if (!(r.dataset.touch && performance.now() - r.dataset.touch < 800)) { r.value = S[r.dataset.mk]; r.parentElement.querySelector('.v').textContent = (+S[r.dataset.mk]).toFixed(2); } });
  $('perf').querySelectorAll('[data-show]').forEach(sp => { const k = sp.dataset.show, p = PARAMS[idx[k]]; sp.textContent = fmt(S.base[k], p); });
}
