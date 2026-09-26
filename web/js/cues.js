// Fractal Rig web UI — cues.js: Cues tab: cue stack, editor, audio modulation
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ cues + modulation
let cueEdit = null;   // id of the cue open in the editor
const cueSummary = c => { const a = c.actions || {}; const parts = [];
  if (a.show) parts.push('show ' + a.show); if (a.preset) parts.push('preset ' + a.preset); if (a.scene != null) parts.push(MODE_NAMES[a.scene] || ('scene ' + a.scene));
  if (a.params && Object.keys(a.params).length) parts.push(Object.keys(a.params).length + ' params'); if (a.pm) parts.push('pm ' + (a.pm.random ? 'random' : a.pm.next ? 'next' : a.pm.name || a.pm.index)); if (a.video) parts.push('video ' + (a.video.live ? 'LIVE' : a.video.play != null ? a.video.play : a.video.next ? 'next' : 'restart'));
  if (a.live_mix != null) parts.push('feed ' + Math.round(a.live_mix * 100) + '%'); if (a.blackout) parts.push('BLACKOUT'); else if (a.brightness != null) parts.push('bright ' + a.brightness); if (a.auto) parts.push('auto ' + a.auto);
  const t = []; if (c.fade_bars) t.push('fade ' + c.fade_bars + ' bars'); if (c.follow_bars) t.push('→ ' + c.follow_bars + ' bars'); return (parts.join(' · ') || 'no actions') + (t.length ? '  [' + t.join(', ') + ']' : ''); };
function renderCues(force) {
  const cs = S.cues || [], st = S.cue || {}, pos = st.pos == null ? -1 : st.pos;
  const sig = JSON.stringify([cs, pos, cueEdit]);
  $('cue-pill').textContent = cs.length ? (pos >= 0 ? `cue ${pos + 1}/${cs.length}` + (st.follow_in != null ? ` · next in ${st.follow_in}s` : '') : `${cs.length} cues · at top`) : 'empty';
  $('cue-go-sub').textContent = cs.length ? (pos + 1 < cs.length ? `next: ${cs[pos + 1].name}` : `wraps to: ${cs[0].name}`) : 'add cues first';
  if ($('pf-cue-sub')) { $('pf-cue-sub').textContent = $('cue-go-sub').textContent + (st.follow_in != null ? ` · auto in ${st.follow_in}s` : ''); }
  if (!$('cues').hidden || force) {
    if ($('cue-list').dataset.sig !== sig) { $('cue-list').dataset.sig = sig;
      $('cue-list').innerHTML = cs.map((c, i) => `<div class="cue ${i === pos ? 'live' : ''} ${i === pos + 1 || (pos + 1 >= cs.length && i === 0 && cs.length > 1) ? 'next' : ''}" data-i="${i}"><div class="n">${i + 1}</div><div class="sw" style="background:${esc(c.colour || 'var(--line)')}"></div><div><div class="nm">${esc(c.name)}</div><div class="sum">${esc(cueSummary(c))}</div></div><div class="acts"><button class="btn small" data-up="${c.id}">▲</button><button class="btn small" data-down="${c.id}">▼</button><button class="btn small" data-edit="${c.id}">edit</button><button class="btn small" data-del="${c.id}">✕</button></div></div>`).join('') || '<span class="hint">no cues yet — set a look up, then "Capture current look as cue"; or add an empty cue and choose actions</span>';
      $('cue-list').querySelectorAll('.cue').forEach(el => el.onclick = e => { if (e.target.closest('button')) return; send({cue: {jump: +el.dataset.i}}); });
      $('cue-list').querySelectorAll('[data-up]').forEach(b => b.onclick = () => send({cue: {id: +b.dataset.up, move: -1}}));
      $('cue-list').querySelectorAll('[data-down]').forEach(b => b.onclick = () => send({cue: {id: +b.dataset.down, move: 1}}));
      $('cue-list').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (confirm('Delete this cue?')) { if (cueEdit === +b.dataset.del) cueEdit = null; send({cue: {delete: +b.dataset.del}}); } });
      $('cue-list').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { cueEdit = cueEdit === +b.dataset.edit ? null : +b.dataset.edit; renderCueEditor(); renderCues(true); });
    }
  }
  // perform tiles
  if (perfOn && $('pf-cues')) { const psig = JSON.stringify([cs.map(c => [c.name, c.colour]), pos]); if ($('pf-cues').dataset.sig !== psig) { $('pf-cues').dataset.sig = psig;
    $('pf-cues').innerHTML = cs.map((c, i) => `<button class="pbtn pf-show ${i === pos ? 'active' : ''}" data-j="${i}" style="border-left:6px solid ${esc(c.colour || 'var(--line)')}">${i + 1} · ${esc(c.name)}<small>${esc(cueSummary(c)).slice(0, 60)}</small></button>`).join('') || '<span class="hint">no cues — build the stack on the Cues tab</span>';
    $('pf-cues').querySelectorAll('[data-j]').forEach(b => b.onclick = () => send({cue: {jump: +b.dataset.j}})); } }
}
function renderCueEditor() {
  const c = (S.cues || []).find(x => x.id === cueEdit); const ed = $('cue-editor'); ed.hidden = !c; if (!c) return;
  const a = c.actions || {}; const presets = Object.keys(S.presets || {}); const clips = (S.media.clips || []).map(x => x.name); const shows = (SHOWS.list || []).map(x => x.name);
  const opt = (list, cur, none) => `<option value="">${none}</option>` + list.map(n => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
  ed.innerHTML = `
    <label>Name<input id="ce-name" value="${esc(c.name)}"></label>
    <label>Colour<input id="ce-colour" type="color" value="${esc(c.colour || '#4bb9d3')}"></label>
    <label>Fade (bars)<input id="ce-fade" type="number" min="0" max="64" step="0.5" value="${c.fade_bars || 0}"></label>
    <label>Auto-follow after (bars, 0 = manual)<input id="ce-follow" type="number" min="0" max="512" step="1" value="${c.follow_bars || 0}"></label>
    <label>Scene<select id="ce-scene"><option value="">keep</option>${MODE_NAMES.map((n, i) => `<option value="${i}" ${a.scene === i ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label>Preset (look)<select id="ce-preset">${opt(presets, a.preset, 'none')}</select></label>
    <label>Show (whole rig)<select id="ce-show">${opt(shows, a.show, 'none')}</select></label>
    <label>Milkdrop<select id="ce-pm"><option value="">keep</option><option value="random" ${a.pm && a.pm.random ? 'selected' : ''}>random preset</option><option value="next" ${a.pm && a.pm.next ? 'selected' : ''}>next preset</option>${(S.pm_presets || []).slice(0, 400).map(n => `<option value="name:${esc(n)}" ${a.pm && a.pm.name === n ? 'selected' : ''}>${esc(shortName(n))}</option>`).join('')}</select></label>
    <label>Video<select id="ce-video"><option value="">keep</option><option value="live" ${a.video && a.video.live ? 'selected' : ''}>LIVE feed</option><option value="next" ${a.video && a.video.next ? 'selected' : ''}>next clip</option><option value="restart" ${a.video && a.video.restart ? 'selected' : ''}>restart clip</option>${clips.map(n => `<option value="play:${esc(n)}" ${a.video && a.video.play === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <label>Feed mix (blank = keep)<input id="ce-mix" type="number" min="0" max="1" step="0.05" value="${a.live_mix != null ? a.live_mix : ''}"></label>
    <label>Brightness (blank = keep)<input id="ce-bright" type="number" min="0" max="2" step="0.05" value="${a.brightness != null ? a.brightness : ''}"></label>
    <label>Blackout<select id="ce-black"><option value="">no</option><option value="1" ${a.blackout ? 'selected' : ''}>yes — fade to black</option></select></label>
    <label>Auto-drift<select id="ce-auto"><option value="">keep</option><option value="on" ${a.auto === 'on' ? 'selected' : ''}>on</option><option value="off" ${a.auto === 'off' ? 'selected' : ''}>off</option></select></label>
    <label>Parameters in this cue: <b>${Object.keys(a.params || {}).length}</b><span class="row" style="gap:6px"><button class="btn small" id="ce-params-cap">replace with current look</button><button class="btn small" id="ce-params-clear">clear</button></span></label>
    <label>Notes<input id="ce-notes" value="${esc(c.notes || '')}"></label>
    <div class="row" style="gap:6px;align-items:flex-end"><button class="btn primary" id="ce-save">Save cue</button><button class="btn small" id="ce-fire">Fire now</button><button class="btn small" id="ce-close">Close</button></div>`;
  let params = Object.assign({}, a.params || {});
  const build = () => { const acts = {params}; const sc = $('ce-scene').value; if (sc !== '') acts.scene = +sc; if ($('ce-preset').value) acts.preset = $('ce-preset').value; if ($('ce-show').value) acts.show = $('ce-show').value;
    const pm = $('ce-pm').value; if (pm === 'random') acts.pm = {random: 1}; else if (pm === 'next') acts.pm = {next: 1}; else if (pm.startsWith('name:')) acts.pm = {name: pm.slice(5)};
    const v = $('ce-video').value; if (v === 'live') acts.video = {live: 1}; else if (v === 'next') acts.video = {next: 1}; else if (v === 'restart') acts.video = {restart: 1}; else if (v.startsWith('play:')) acts.video = {play: v.slice(5)};
    if ($('ce-mix').value !== '') acts.live_mix = +$('ce-mix').value; if ($('ce-bright').value !== '') acts.brightness = +$('ce-bright').value; if ($('ce-black').value) acts.blackout = true; if ($('ce-auto').value) acts.auto = $('ce-auto').value;
    return {name: $('ce-name').value.trim() || 'cue', colour: $('ce-colour').value, fade_bars: +$('ce-fade').value || 0, follow_bars: +$('ce-follow').value || 0, notes: $('ce-notes').value, actions: acts}; };
  $('ce-params-cap').onclick = () => { params = {}; PARAMS.forEach(p => { if (!['mode', 'video_t0', 'out_res'].includes(p.key)) params[p.key] = S.base[p.key]; }); $('ce-params-cap').textContent = `captured ${Object.keys(params).length} — save`; };
  $('ce-params-clear').onclick = () => { params = {}; $('ce-params-cap').textContent = 'cleared — save'; };
  $('ce-save').onclick = () => { send({cue: {id: c.id, update: build()}}); logLocal('cue saved: ' + $('ce-name').value); };
  $('ce-fire').onclick = () => { const i = (S.cues || []).findIndex(x => x.id === c.id); if (i >= 0) send({cue: {jump: i}}); };
  $('ce-close').onclick = () => { cueEdit = null; renderCueEditor(); renderCues(true); };
}
$('cue-go').onclick = () => send({cue: {go: true}}); $('cue-back').onclick = () => send({cue: {back: 1}}); $('cue-stopfollow').onclick = () => send({cue: {stop_follow: 1}});
$('cue-capture').onclick = () => { const n = prompt('Cue name', 'Cue ' + ((S.cues || []).length + 1)); if (n) send({cue: {capture: n}}); };
$('cue-add').onclick = () => send({cue: {add: {name: 'Cue ' + ((S.cues || []).length + 1), fade_bars: 1, actions: {}}}});
$('cue-reset').onclick = () => send({cue: {reset: 1}});
$('cue-clear').onclick = () => { if (confirm('Delete every cue?')) { cueEdit = null; send({cue: {clear: 1}}); } };
$('pf-cue-go').onclick = () => send({cue: {go: true}}); $('pf-cue-back').onclick = () => send({cue: {back: 1}}); $('pf-cue-stop').onclick = () => send({cue: {stop_follow: 1}});
$('pf-cue-capture').onclick = () => { const n = prompt('Cue name', 'Cue ' + ((S.cues || []).length + 1)); if (n) send({cue: {capture: n}}); };
$('pf-cue-reset').onclick = () => send({cue: {reset: 1}});
$('pf-pal-lock').onclick = () => send({palette: {lock: !S.palette_lock}});
$('pf-pal-save').onclick = () => { const n = prompt('Palette name'); if (n && n.trim()) send({palette: {save: n.trim()}}); };
// modulation editor
const MOD_SOURCES = ['energy', 'bass', 'beat'].concat(Array.from({length: 16}, (_, i) => 'band' + i));
let modDraft = null;
function modsList() { return modDraft || S.mods || []; }
function renderMods(force) {
  if ($('inputs').hidden && !force) return;
  const list = modsList(); const sig = JSON.stringify(list);
  if ($('mod-list').dataset.sig !== sig) { $('mod-list').dataset.sig = sig;
    $('mod-list').innerHTML = list.length ? '<div class="modrow" style="color:var(--muted);border-bottom:1px solid var(--line)"><span>parameter</span><span>source</span><span>amount</span><span>attack s</span><span>release s</span><span>on</span><span>level</span><span></span></div>' + list.map((m, i) => `<div class="modrow" data-i="${i}">
      <select data-k="key">${PARAMS.filter(p => p.kind === 'f' && !['video_t0'].includes(p.key)).map(p => `<option value="${p.key}" ${p.key === m.key ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
      <select data-k="src">${MOD_SOURCES.map(sn => `<option value="${sn}" ${sn === m.src ? 'selected' : ''}>${sn === 'beat' ? 'beat pulse' : sn.startsWith('band') ? 'band ' + (+sn.slice(4) + 1) + (['40 Hz', '', '', '100', '', '', '250', '', '', '1 k', '', '', '4 k', '', '', '16 k'][+sn.slice(4)] ? ' · ' + ['40 Hz', '', '', '100', '', '', '250', '', '', '1 k', '', '', '4 k', '', '', '16 k'][+sn.slice(4)] : '') : sn}</option>`).join('')}</select>
      <span class="row" style="gap:6px"><input type="range" data-k="amount" min="-1" max="1" step="0.01" value="${m.amount}" style="flex:1;accent-color:var(--accent2)"><span class="val" style="font-family:var(--mono);min-width:40px">${(+m.amount).toFixed(2)}</span></span>
      <input type="number" data-k="attack" min="0.001" max="2" step="0.01" value="${m.attack}"><input type="number" data-k="release" min="0.001" max="5" step="0.05" value="${m.release}">
      <input type="checkbox" data-k="enabled" ${m.enabled !== false ? 'checked' : ''}><div class="lvl"><i></i></div><button class="btn small" data-del="${i}">✕</button></div>`).join('') : '<span class="hint">nothing modulated yet</span>';
    $('mod-list').querySelectorAll('[data-k]').forEach(el => el.oninput = () => { const i = +el.closest('.modrow').dataset.i; modDraft = JSON.parse(JSON.stringify(modsList())); const k = el.dataset.k; modDraft[i][k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' || el.type === 'range') ? +el.value : el.value; if (k === 'amount') el.nextElementSibling.textContent = (+el.value).toFixed(2); clearTimeout(renderMods.t); renderMods.t = setTimeout(() => { send({mods: modDraft}); modDraft = null; }, 250); });
    $('mod-list').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const l = JSON.parse(JSON.stringify(modsList())); l.splice(+b.dataset.del, 1); modDraft = null; send({mods: l}); });
  }
  const lv = (S.cue && S.cue.mods) || []; $('mod-list').querySelectorAll('.modrow[data-i] .lvl i').forEach((el, i) => el.style.width = Math.round((lv[i] || 0) * 100) + '%');
}
$('mod-add').onclick = () => send({mods: modsList().concat([{key: 'zoom', src: 'bass', amount: 0.05, attack: 0.02, release: 0.3, enabled: true}])});
