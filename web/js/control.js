// Fractal Rig web UI — control.js: Control tab: parameter sliders, scenes, engine tiles, presets list, Milkdrop preset browser
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ controls
let activeGroup = 'shape';
function buildControls() {
  $('modes').innerHTML = SHADER_MODES.map(i => `<button class="btn small" data-mode="${i}">${MODE_NAMES[i]}</button>`).join('');
  $('modes').querySelectorAll('button').forEach(b => b.onclick = () => send({set: {mode: +b.dataset.mode}}));
  const eng = engineOf(S.base.mode || 0), groups = ENGINE_GROUPS[eng];
  if (!groups.includes(activeGroup)) activeGroup = groups[0];
  $('modes').style.display = eng === 'shader' ? '' : 'none';
  $('tabs').innerHTML = groups.map(g => `<button data-g="${g}" class="${g === activeGroup ? 'active' : ''}">${g === 'projectm' ? (eng === 'video' ? 'post-pass' : 'projectM') : g}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { activeGroup = b.dataset.g; buildControls(); });
  $('params').innerHTML = PARAMS.filter(p => p.group === activeGroup && p.key !== 'mode').map(p => `
    <div class="param" data-key="${p.key}">
      <label title="${p.tip || ''}">${p.label}${p.tip ? `<small>${p.tip}</small>` : ''}</label>
      <input type="range" min="${p.min}" max="${p.max}" step="${p.kind === 'i' ? 1 : (p.max - p.min) / 1000}" value="${S.base[p.key]}">
      <span class="val"></span>
      <button class="auto ${S.auto[p.key] ? 'on' : ''}" title="auto-drift" ${p.kind === 'i' ? 'disabled' : ''}></button>
    </div>`).join('');
  $('params').querySelectorAll('.param').forEach(row => {
    const k = row.dataset.key, r = row.querySelector('input'), a = row.querySelector('.auto');
    r.oninput = () => { row.dataset.touch = performance.now(); send({set: {[k]: +r.value}}); };
    a.onclick = () => send({auto: {[k]: !S.auto[k]}});
  });
  $('learn-param').innerHTML = PARAMS.map(p => `<option value="${p.key}">${p.label}</option>`).join('');
  renderControls();
}
function fmt(v, p) { return p.kind === 'i' ? String(Math.round(v)) : (Math.abs(v) < 10 ? (+v).toFixed(3) : (+v).toFixed(1)); }
function renderControls() {
  $('params').querySelectorAll('.param').forEach(row => {
    const k = row.dataset.key, p = PARAMS[idx[k]], r = row.querySelector('input'), v = row.querySelector('.val'), a = row.querySelector('.auto');
    if (!(row.dataset.touch && performance.now() - row.dataset.touch < 800)) r.value = S.base[k];
    const drifting = S.auto[k] && Math.abs(S.out[k] - S.base[k]) > 1e-4;
    v.textContent = fmt(drifting ? S.out[k] : S.base[k], p); v.className = 'val' + (drifting ? ' live' : '');
    a.className = 'auto' + (S.auto[k] ? ' on' : '');
  });
  $('modes').querySelectorAll('button').forEach(b => b.className = 'btn small' + (+b.dataset.mode === Math.round(S.base.mode) ? ' active' : ''));
  if (document.activeElement !== $('out-res')) $('out-res').value = String(Math.round(S.base.out_res || 0));
  for (const k of ['clock_speed', 'auto_depth', 'auto_rate']) { if (document.activeElement !== $(k)) $(k).value = S[k]; $(k + '_v').textContent = (+S[k]).toFixed(2); }
  $('bpm').textContent = S.bpm ? S.bpm.toFixed(1) : '—';
  const src = {none: 'no tempo', prodj: 'Pro DJ Link', tap: 'tap / manual', audio: 'audio onset', link: 'Ableton Link'}[S.tempo_source] || S.tempo_source;
  $('tempo-label').textContent = src; $('tempo-dot').className = 'dot ' + (S.tempo_source === 'prodj' || S.tempo_source === 'link' ? 'ok' : S.bpm ? 'warn' : '');
  $('tempo-src').textContent = S.tempo_source === 'prodj' ? 'Locked to Pro DJ Link beat packets' : S.live ? 'Pro DJ Link: waiting for beat packets on udp/50001 · tap or type a BPM meanwhile' : 'Demo: tap or type a BPM';
  $('decks').innerHTML = Object.entries(S.decks || {}).map(([d, x]) => `<span class="pill">deck ${d} · ${x.bpm} · beat ${x.beat}</span>`).join('');
  const engNowP = engineOf(S.base.mode); const pnames = Object.keys(S.presets).filter(n => presetFilter === 'all' || engineOf(presetMode(n)) === engNowP);
  $('preset-count').textContent = `${pnames.length}${presetFilter === 'all' ? '' : ' / ' + Object.keys(S.presets).length}`;
  listBox($('presets'), {kind: 'preset', placeholder: 'filter looks…', favsFirst: true,
    rows: pnames.map(n => { const pe = engineOf(presetMode(n)); return {id: n, label: n, sub: MODE_NAMES[Math.round(presetMode(n))] || '', color: `var(--eng-${pe})`, cur: n === lastPresetLoaded, other: pe !== engNowP, title: `${ENGINE_LABEL[pe]} · ${MODE_NAMES[Math.round(presetMode(n))]}`}; }),
    empty: Object.keys(S.presets).length ? 'no ' + ENGINE_LABEL[engNowP] + ' looks yet — switch the filter to "all" or save one' : 'no looks saved yet — set one up and press Save current',
    onPick: n => { lastPresetLoaded = n; pfLastPreset = n; send({preset: {load: n}}); }, onDel: n => send({preset: {delete: n}})});
  const fl = Object.entries(S.fleet || {});
  $('pill-fleet').textContent = fl.length + (fl.length === 1 ? ' projector' : ' projectors');
  const nclips = (S.video && S.video.count != null) ? S.video.count : null;
  $('fleet').innerHTML = fl.length ? fl.map(([n, h]) => { const mm = h.media == null ? '—' : h.media < 0 ? '<span title="renderer built without libmpv — sudo apt install libmpv-dev, rebuild">no mpv</span>' : (nclips != null && h.media !== nclips ? `<span style="color:var(--warn)" title="master has ${nclips}, this Pi has ${h.media} — fractal-media-sync catching up?">${h.media}/${nclips}</span>` : `${h.media}`);
    const hs = rigHealth(n, h); const vmis = hs.vmis;
    return `<tr title="${esc(hs.why.join(' · ') || 'all good')}"><td><i class="hdot ${hs.cls}"></i></td><td>${esc(n)}</td><td style="white-space:nowrap">${projCell(n, h)}</td><td>${h.ip}</td><td ${vmis ? 'style="color:var(--warn)" title="not the master\'s version — update it"' : ''}>${h.version || '—'}</td><td class="${h.fps < 45 ? 'bad' : h.fps < 55 ? 'warn' : 'ok'}" title="lowest recently ${h.fps_min == null ? '?' : h.fps_min}">${h.fps.toFixed(0)}</td><td>${h.res}</td><td>${h.tile}</td><td class="${h.loss_rate > 5 ? 'bad' : h.lost ? 'warn' : 'ok'}" title="${h.lost} lost of ${h.packets} · ${h.loss_rate || 0} in the last ~10 s">${h.lost ? `${h.lost} (${h.loss_pct}%)` : '0'}</td><td class="${h.temp > 75 ? 'bad' : h.temp > 65 ? 'warn' : ''}">${h.temp == null || h.temp < 0 ? '—' : h.temp.toFixed(0) + '°'}</td><td class="${h.hb_worst > 3 ? 'bad' : h.hb_worst > 1.8 ? 'warn' : 'ok'}" title="worst heartbeat gap recently (1.0 s = perfect)">${h.hb_worst == null ? '—' : h.hb_worst.toFixed(1) + ' s'}</td><td>${mm}</td><td class="${h.age > 3 ? 'bad' : ''}">${h.age}s</td><td style="white-space:nowrap"><a class="btn small" href="http://${h.ip}:8082/" target="_blank" rel="noopener" title="status page">status</a> <button class="btn small" data-rig="${esc(n)}" data-act="update">update</button> <button class="btn small" data-rig="${esc(n)}" data-act="restart">restart</button> <button class="btn small" data-rig="${esc(n)}" data-act="reboot">reboot</button></td></tr>`; }).join('')
    : `<tr><td colspan="14" style="color:var(--muted)">${S.live ? 'no renderers heard yet — start ./fractal on a Pi on this LAN' : 'demo mode — no fleet'}</td></tr>`;
  $('fleet').querySelectorAll('[data-rig]').forEach(b => b.onclick = () => rigAct(b.dataset.rig, b.dataset.act, b));
  $('fleet').querySelectorAll('[data-pj]').forEach(b => b.onclick = () => projAct(b.dataset.pj, b.dataset.cmd, b));
  $('fleet').querySelectorAll('select[data-pjin]').forEach(sel => sel.onchange = () => { if (sel.value) projAct(sel.dataset.pjin, sel.value, sel); sel.value = ''; });
  $('fleet').querySelectorAll('select[data-pjout]').forEach(sel => sel.onchange = () => outputsSet(sel.dataset.pjout, sel.value, sel));
  $('last-cc').textContent = S.last_cc == null ? '—' : 'CC ' + S.last_cc;
  renderSources();
  renderPm();
  renderVideo();
  renderLog();
  if (!$('status').hidden) renderStatus();
  if (!$('outputs').hidden || !$('leds').hidden) renderOutputs();
  renderResolume();
  renderCues();
  renderMods();
  renderCloud();
  renderPalettes();
  renderPerf();
}
let srcBuilt = '', lastPresetLoaded = null;
function renderSources() {
  const names = Object.keys(SOURCE_META);
  const sig = names.map(n => n + (S.sources[n] ? S.sources[n].enabled : '') ).join('|') + (S.audio_devices || []).length + S.live;
  if (sig !== srcBuilt) {   // structure changed → rebuild controls
    srcBuilt = sig;
    $('sources').innerHTML = names.map(n => {
      const meta = SOURCE_META[n];
      let extra = '';
      if (n === 'audio' && S.live) extra = `<select id="audio-dev"><option value="">default input</option>${(S.audio_devices || []).map(d => `<option value="${d.index}">${esc(d.name)}</option>`).join('')}</select>`;
      if (n === 'xair' && S.live) extra = `<select id="xair-ch" title="which meter drives energy"><option value="lr">main L/R</option><option value="aux">aux in</option>${Array.from({length: 16}, (_, i) => `<option value="${i + 1}">ch ${i + 1}</option>`).join('')}</select><button class="btn small" id="xair-host" title="mixer IP (blank = find it by broadcast)">IP</button>`;
      if (n === 'link' && S.live) extra = `<select id="link-mode"><option value="follow">follow</option><option value="lead">lead</option></select>`;
      if (n === 'prodj' && S.live) extra = `<select id="prodj-follow"><option value="0">follow: auto</option><option value="1">deck 1</option><option value="2">deck 2</option><option value="3">deck 3</option><option value="4">deck 4</option></select>`;
      const toggle = n === 'web' ? '' : `<button class="toggle" data-src="${n}" title="enable / disable"></button>`;
      return `<div class="src" data-src="${n}"><i class="dot"></i><div class="name">${meta.label}<small>${meta.sub}</small></div><div class="detail"></div><div class="ctl">${extra}${toggle}</div></div>`;
    }).join('');
    $('sources').querySelectorAll('.toggle').forEach(b => b.onclick = () => {
      const n = b.dataset.src, on = !(S.sources[n] && S.sources[n].enabled);
      const msg = {source: {name: n, enabled: on}};
      if (n === 'audio' && on && $('audio-dev')) msg.source.device = $('audio-dev').value === '' ? null : +$('audio-dev').value;
      send(msg);
    });
    const ad = $('audio-dev'); if (ad) { ad.value = S.audio_device == null ? '' : String(S.audio_device); ad.onchange = () => { if (S.sources.audio.enabled) send({source: {name: 'audio', enabled: true, device: ad.value === '' ? null : +ad.value}}); }; }
    const xc = $('xair-ch'); if (xc) { xc.value = (S.sources.xair && S.sources.xair.channel) || (S.xair_source || 'lr'); xc.onchange = () => send({source: {name: 'xair', enabled: !!(S.sources.xair && S.sources.xair.enabled), channel: xc.value}}); }
    const xh = $('xair-host'); if (xh) xh.onclick = async () => { const v = await ui.dialog({title: 'X Air mixer address', text: 'Leave blank to find the mixer with a broadcast (same subnet). The rig only listens to its meters — nothing is written to the desk.', fields: [{key: 'host', label: 'Mixer IP', value: (S.sources.xair && S.sources.xair.host) || '', placeholder: '192.168.22.70'}], ok: 'Save'}); if (v) send({source: {name: 'xair', enabled: !!(S.sources.xair && S.sources.xair.enabled), host: v.host}}); };
    const lmS = $('link-mode'); if (lmS) { lmS.value = (S.outputs.link && S.outputs.link.mode) || 'follow'; lmS.onchange = () => send({source: {name: 'link', enabled: S.sources.link.enabled, mode: lmS.value}}); }
    const pf = $('prodj-follow'); if (pf) { pf.value = String(S.prodj_follow || 0); pf.onchange = () => send({source: {name: 'prodj', enabled: S.sources.prodj.enabled, follow: +pf.value}}); }
  }
  names.forEach(n => {
    const row = $('sources').querySelector(`.src[data-src="${n}"]`); if (!row) return;
    const st = S.sources[n] || {};
    const cls = !st.enabled ? '' : st.ok ? 'ok' : 'warn';
    row.querySelector('.dot').className = 'dot ' + cls;
    let d = esc(st.detail || '');
    if (n === 'web') d = S.live ? `<b>${esc(st.detail || 'connected')}</b>` : '<b>demo mode</b> — simulating locally';
    if (n === 'midi' && st.last) d += ` · <span class="last">${esc(st.last)}</span>`;
    if (n === 'osc' && st.last && st.seen && Date.now() / 1000 - st.seen < 10) d += ` · <span class="last">${esc(st.last)}</span>`;
    if (!S.live && n !== 'web' && n !== 'auto') d = st.enabled ? 'enabled — needs a master to link' : 'disabled';
    row.querySelector('.detail').innerHTML = d;
    const t = row.querySelector('.toggle'); if (t) t.className = 'toggle' + (st.enabled ? ' on' : '');
    const pf = row.querySelector('#prodj-follow'); if (pf && document.activeElement !== pf) pf.value = String(S.prodj_follow || 0);
  });
}
async function presetSaveDialog(defaults) {   // one save flow for looks — Control, Perform, anywhere else
  const eng = engineOf(S.base.mode); const v = await ui.saveAs({what: 'look', title: 'Save current look', text: `${ENGINE_LABEL[eng]} · ${MODE_NAMES[Math.round(S.base.mode)] || ''} — every parameter and which ones drift, recalled in one tap.`,
    name: defaults && defaults.name, existing: Object.keys(S.presets || {}), placeholder: 'e.g. Julia spiral (warm)'});
  if (!v) return null; send({preset: {save: v.name}}); ui.toast(`Look saved: <b>${esc(v.name)}</b>`, 'ok'); return v.name;
}
async function paletteSaveDialog() {
  const v = await ui.saveAs({what: 'palette', title: 'Save current colours as palette', text: 'Hue, spread, cycle, contrast, brightness and glow — recalls over any scene.', existing: Object.keys(S.palettes || {}), placeholder: 'e.g. Ember'});
  if (!v) return null; send({palette: {save: v.name}}); ui.toast(`Palette saved: <b>${esc(v.name)}</b>`, 'ok'); return v.name;
}
function renderLog() { if (!$('log')) return; $('log').innerHTML = (S.log || []).slice(-12).reverse().map(m => `<div>${esc(m)}</div>`).join(''); }

function buildPmList() {
  const list = S.pm_presets || [];
  $('pm-count').textContent = list.length ? list.length + ' presets' : (S.live ? 'no presets on master' : 'demo');
  const sel = $('pm-select');
  const MAX = 3000;   // keep the <select> sane; the search box covers the rest
  sel.innerHTML = list.slice(0, MAX).map((n, i) => `<option value="${i}">${i} · ${esc(n.replace(/\.milk$|\.prjm$/i, ''))}</option>`).join('') + (list.length > MAX ? `<option disabled>… ${list.length - MAX} more — use search</option>` : '');
  sel.onchange = () => send({pm: {index: +sel.value}});
  $('pm-hint').innerHTML = list.length ? '' : (S.live ? 'Master has no presets in <code>pm_preset_dir</code>. Run <code>sudo bash setup/install-projectm.sh</code> on every Pi (master included), then rescan.' : 'Demo mode — preset list comes from the master.');
}
let pmSearchT = null, pmFavOnly = false, pmHeld = 0;
const pmFavs = {has: n => isFav('pm', n), add: n => setFav('pm', n, true), delete: n => setFav('pm', n, false), get size() { return favList('pm').length; }};
const saveFavs = () => {};
function migratePmFavs() {   // older builds kept Milkdrop stars in this browser only — push them to the master once
  try { const old = JSON.parse(localStorage.getItem('frx.pmfav') || '[]'); if (old.length && S.live) { old.forEach(n => { if (!isFav('pm', n)) send({fav: {kind: 'pm', name: n, on: true}}); }); localStorage.removeItem('frx.pmfav'); logLocal(`${old.length} Milkdrop favourites moved to the master`); } } catch (e) {}
}
const shortName = n => (n || '').replace(/^.*\//, '').replace(/\.(milk|prjm)$/i, '');
$('pm-search').oninput = () => { clearTimeout(pmSearchT); pmSearchT = setTimeout(renderPmList, 120); };
$('pm-favonly').onclick = () => { pmFavOnly = !pmFavOnly; $('pm-favonly').className = 'btn small' + (pmFavOnly ? ' active' : ''); renderPmList(); };
$('pm-favtoggle').onclick = () => { const n = (S.pm_presets || [])[S.pm.index]; if (!n) return; if (pmFavs.has(n)) pmFavs.delete(n); else pmFavs.add(n); saveFavs(); renderPm(); renderPmList(); };
$('pm-hold').onclick = () => { if (S.pm.cycle_bars > 0) { pmHeld = S.pm.cycle_bars; send({pm: {cycle_bars: 0}}); } else if (pmHeld) { send({pm: {cycle_bars: pmHeld}}); pmHeld = 0; } };
let pmListSig = '';
function renderPmList() {
  const list = S.pm_presets || [], q = $('pm-search').value.trim().toLowerCase();
  const rows = []; const MAX = 400;
  list.forEach((n, i) => { if (rows.length >= MAX) return; if (pmFavOnly && !pmFavs.has(n)) return; if (q && !n.toLowerCase().includes(q)) return; rows.push(i); });
  const sig = rows.join(',') + '|' + S.pm.index + '|' + favList('pm').join(',');
  if (sig === pmListSig) return; pmListSig = sig;
  $('pm-browse').innerHTML = rows.map(i => `<div data-i="${i}" class="${i === S.pm.index ? 'cur' : ''}"><span class="n">#${i}</span><span>${esc(shortName(list[i]))}</span><span class="fav ${pmFavs.has(list[i]) ? 'on' : ''}" data-fav="${i}">★</span></div>`).join('') || `<div style="color:var(--muted)">${list.length ? 'no matches' : 'no presets'}</div>` + (list.length > MAX && rows.length >= MAX ? `<div style="color:var(--muted)">showing first ${MAX} — type to filter</div>` : '');
  $('pm-browse').querySelectorAll('div[data-i]').forEach(d => d.onclick = e => { if (e.target.dataset.fav != null) { const n = list[+e.target.dataset.fav]; if (pmFavs.has(n)) pmFavs.delete(n); else pmFavs.add(n); saveFavs(); pmListSig = ''; renderPmList(); return; } send({pm: {index: +d.dataset.i}}); });
  const cur = $('pm-browse').querySelector('.cur'); if (cur && !$('pm-browse').matches(':hover')) cur.scrollIntoView({block: 'nearest'});
}
let pmHist = [];
let wasOn8 = null, lastShaderMode = (() => { try { return +localStorage.getItem('frx.lastShader') || 0; } catch (e) { return 0; } })();

$('pm-prev').onclick = () => send({pm: {prev: 1}});
$('pm-next').onclick = () => send({pm: {next: 1}});
$('pm-random').onclick = () => send({pm: {random: 1}});
$('pm-rescan').onclick = () => send({pm: {rescan: 1}});
$('pm-cycle').onchange = () => send({pm: {cycle_bars: +$('pm-cycle').value}});
$('pm-shuffle').onclick = () => send({pm: {shuffle: !S.pm.shuffle}});
function renderPm() {
  const pm = S.pm || {}; const list = S.pm_presets || [];
  const name = list[pm.index] || pm.name || '—';
  if (document.activeElement !== $('pm-select')) $('pm-select').value = String(pm.index || 0);
  if (document.activeElement !== $('pm-cycle')) $('pm-cycle').value = pm.cycle_bars == null ? 16 : pm.cycle_bars;
  $('pm-shuffle').className = 'btn small' + (pm.shuffle ? ' active' : '');
  const on8 = Math.round(S.base.mode) === 8, on9 = Math.round(S.base.mode) === 9;
  $('pm-card').style.borderColor = on8 ? 'var(--accent)' : '';
  $('pm-card').classList.toggle('expanded', on8);
  document.body.classList.toggle('pm-mode', on8);
  const lvS = (S.video && S.video.live) || {}; const onRes = on9 && S.video.index === 255 && String(lvS.source || '').startsWith('ndi:');
  $('eng-shader').className = (on8 || on9) ? '' : 'active'; $('eng-pm').className = on8 ? 'active' : ''; $('eng-video').className = (on9 && !onRes) ? 'active' : ''; $('eng-resolume').className = onRes ? 'active' : '';
  $('eng-resolume-sub').textContent = onRes ? '▶ ' + lvS.source.slice(4) : lvS.running && String(lvS.source || '').startsWith('ndi:') ? 'feed ready: ' + lvS.source.slice(4) + ' — tap to show' : lvS.msg && /NDI|ndi/.test(lvS.msg) && !lvS.running ? lvS.msg.slice(0, 60) : "grab Resolume's NDI output and put it on every projector";
  const clipsN = (S.media.clips || []).length, feedTxt = lvS.running ? `<b>${esc(lvS.source || 'running')}</b>` : 'none';
  $('srcstrip').innerHTML = [`<span class="${lvS.running ? 'on' : ''}">LIVE feed · ${feedTxt}</span>`, `<span>clips · <b>${clipsN}</b>${S.video.playlist && S.video.playlist.length ? ` · playlist ${S.video.playlist.length}` : ''}</span>`,
    `<span class="${S.base.live_mix > 0.003 ? 'on' : ''}">feed mix · <b>${Math.round((S.base.live_mix || 0) * 100)} %</b></span>`, `<span class="${S.pm_presets.length ? '' : 'warn'}">milkdrop · <b>${S.pm_presets.length || 'no'}</b> presets</span>`,
    `<span class="${Object.keys(S.fleet || {}).length ? 'on' : 'warn'}">projectors · <b>${Object.keys(S.fleet || {}).length}</b></span>`].join('');
  $('eng-shader-sub').textContent = (on8 || on9) ? 'switch back to ' + MODE_NAMES[lastShaderMode] : MODE_NAMES[Math.round(S.base.mode)] + ' · fractals · plasma · tunnel · starfield · waves — pixel-synced';
  $('eng-pm-sub').textContent = list.length ? `${list.length} presets · ${pm.cycle_bars ? 'auto-cycle ' + pm.cycle_bars + ' bars' : 'manual'}` : 'real .milk presets on every Pi';
  $('pm-big-name').textContent = list.length ? shortName(name) : '—';
  $('pm-big-sub').textContent = list.length ? `#${pm.index} of ${list.length} · ${name.includes('/') ? name.split('/')[0] + ' pack' : ''}${pmFavs.has(name) ? ' · ★ favourite' : ''}` : '';
  $('pm-favtoggle').textContent = pmFavs.has(name) ? '★' : '☆';
  $('pm-hold').className = 'btn small' + (pm.cycle_bars === 0 && pmHeld ? ' active' : '');
  $('pm-hold').textContent = pm.cycle_bars === 0 && pmHeld ? 'held' : 'hold';
  if (list.length && (pmHist[0] !== pm.index)) { pmHist = [pm.index].concat(pmHist.filter(i => i !== pm.index)).slice(0, 8); $('pm-history').innerHTML = pmHist.length > 1 ? '<span style="font-size:11px;color:var(--muted);align-self:center">recent:</span>' + pmHist.slice(1).map(i => `<button class="btn small" data-h="${i}" title="${esc(list[i] || '')}">#${i} ${esc(shortName(list[i] || '').slice(0, 28))}</button>`).join('') : ''; $('pm-history').querySelectorAll('[data-h]').forEach(b => b.onclick = () => send({pm: {index: +b.dataset.h}})); }
  if (on8) renderPmList();
  // the engine's own card sits right under the preview; the other engines' cards are hidden (their summary lives on the Engine buttons)
  const previewCard = document.querySelector('.previewwrap').closest('.card'), pmCard = $('pm-card'), vCard = $('video-card');
  pmCard.hidden = !on8; vCard.hidden = !on9;
  if (on8 && pmCard.previousElementSibling !== previewCard) previewCard.after(pmCard);
  if (on9 && vCard.previousElementSibling !== previewCard) previewCard.after(vCard);
  if (!on8) $('pm-overlay').hidden = true;
  const engNow = engineOf(S.base.mode); if (engNow !== wasOn8) { wasOn8 = engNow; activeGroup = ENGINE_GROUPS[engNow][0]; buildControls(); }
  if (!on8 && !on9 && Math.round(S.base.mode) !== lastShaderMode) { lastShaderMode = Math.round(S.base.mode); try { localStorage.setItem('frx.lastShader', lastShaderMode); } catch (e) {} }
}
