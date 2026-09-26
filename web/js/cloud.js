// Fractal Rig web UI — cloud.js: Supabase status pill + settings card, saved LED configurations
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ cloud (Supabase) status + settings, LED configs
function renderCloud() {
  const c = S.cloud; const dot = $('cloud-dot'), lab = $('cloud-label');
  let cls = 'dot', txt = 'cloud', long = 'not configured';
  if (!c || !c.configured) { txt = S.live ? 'cloud off' : 'cloud'; long = S.live ? 'not configured (master/config.json)' : 'demo'; }
  else if (!c.enabled) { txt = 'cloud paused'; long = 'paused'; }
  else if (c.online) { cls = 'dot ok'; txt = c.pending ? `syncing ${c.pending}` : 'cloud ✓'; long = c.pending ? `connected · ${c.pending} queued` : 'connected'; }
  else { cls = 'dot warn'; txt = c.pending ? `offline · ${c.pending} queued` : 'offline'; long = c.pending ? `offline · ${c.pending} queued locally` : 'offline (saves queue locally)'; }
  dot.className = cls; lab.textContent = txt;
  $('pill-cloud').title = c ? `Supabase · rig ${c.rig || '?'} · last sync ${c.last_sync ? new Date(c.last_sync * 1000).toLocaleTimeString() : 'never'}${c.error ? ' · ' + c.error : ''} — click for the Rig tab` : 'Supabase sync';
  if ($('status').hidden) return;
  $('cloud-dot2').className = cls; $('cloud-state').textContent = long;
  $('cloud-detail').innerHTML = c && c.configured ? `Cloud: rig <b>${esc(c.rig || '')}</b> · ${esc(c.host || (c.url || '').replace(/^https?:\/\//, ''))} · last sync ${c.last_sync ? new Date(c.last_sync * 1000).toLocaleTimeString() : 'never'} · pulled ${c.pulled || 0} this session · queued ${c.pending || 0}${c.error ? ` · <span style="color:var(--warn)">${esc(c.error)}</span>` : ''}` : '';
}
$('pill-cloud').onclick = () => { showView('status'); const c = S.cloud; if (c) ui.toast(c.online ? `Supabase connected · rig <b>${esc(c.rig || '')}</b> · ${c.pending || 0} queued` : c.configured ? `Supabase offline — ${c.pending || 0} change${c.pending === 1 ? '' : 's'} queued on the Pi` : 'Cloud not configured', c.online ? 'ok' : 'warn'); };
$('cloud-sync').onclick = async () => { $('cloud-sync').disabled = true; try { const r = await (await fetch('/api/cloud/sync', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).json(); ui.toast(r.ok ? 'Cloud sync done' : 'Cloud sync: ' + (r.error || 'offline'), r.ok ? 'ok' : 'warn'); } catch (e) { ui.toast('Cloud sync failed', 'bad'); } $('cloud-sync').disabled = false; };
$('cloud-pull-all').onclick = async () => { if (!await ui.confirm('Pull every show, preset bank, cue stack, LED config and mapping that is newer in the cloud than on this Pi?', {ok: 'Pull'})) return; const r = await (await fetch('/api/cloud/sync', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"full":true}'})).json(); ui.toast(r.ok ? `Cloud pull done (${r.pulled} applied this session)` : 'Cloud pull: ' + (r.error || 'offline'), r.ok ? 'ok' : 'warn'); showsFetch(); ledcFetch(); };
async function cloudMenu(sel, kind, localNames) {
  if (!S.live || !S.cloud || !S.cloud.enabled) { sel.style.display = 'none'; return; } sel.style.display = '';
  try { const j = await (await fetch('/api/cloud/list/' + kind)).json(); const rows = (j.rows || []).filter(r => !localNames.includes(r.name));
    sel.innerHTML = `<option value="">☁ from cloud… (${j.online ? rows.length + ' not on this Pi' : 'offline'})</option>` + rows.map(r => `<option value="${esc(r.name)}">${esc(r.name)} · ${new Date(r.updated_at).toLocaleDateString()}</option>`).join(''); } catch (e) {}
}
$('show-cloud').onchange = async () => { const n = $('show-cloud').value; $('show-cloud').value = ''; if (!n) return; const r = await fetch(`/api/cloud/fetch/show/${encodeURIComponent(n)}`, {method: 'POST'}); logLocal(r.ok ? `show "${n}" pulled from the cloud` : 'pull failed'); showsFetch(); };
// LED configs — same card grid + save dialog as Shows (ui.cards / ui.saveAs)
let LEDC = [];
async function ledcFetch() { if (!S.live) { $('ledc-list').innerHTML = '<span class="hint">demo mode — configurations live on the master</span>'; return; } try { LEDC = (await (await fetch('/api/led/configs')).json()).configs || []; } catch (e) { $('ledc-list').innerHTML = '<span class="hint">could not load configurations</span>'; return; } renderLedc(); cloudMenu($('ledc-cloud'), 'led_config', LEDC.map(x => x.name)); }
function renderLedc(flash) {
  $('ledc-hint').textContent = LEDC.length ? `${LEDC.length} saved` : '';
  ui.cards($('ledc-list'), {kind: 'led_config', flash,
    items: LEDC.map(c => ({name: c.name, notes: c.notes, meta: `${c.strips} zone${c.strips === 1 ? '' : 's'} · ${c.pixels} px · saved ${new Date(c.saved * 1000).toLocaleString()}`})),
    actions: [{id: 'load', label: 'LOAD', primary: true}, {id: 'update', label: 'Update', title: 'overwrite with the current layout'}, {id: 'dl', label: 'Download', href: n => `/api/led/configs/${encodeURIComponent(n)}?download=1`}, {id: 'delete', label: '✕', right: true}],
    empty: 'No saved LED configurations yet — lay the zones out below, then press <b>Save current layout</b>.',
    onAction: async (act, name, btn) => {
      if (act === 'load') { if (!await ui.confirm('It replaces the current zones and output settings.', {title: `Load LED configuration "${name}"?`, ok: 'Load'})) return; btn.textContent = 'loading…'; await ledcLoad(name); renderLedc(); }
      if (act === 'update') { if (!await ui.confirm(`Overwrite "${name}" with the current layout?`, {ok: 'Overwrite'})) return; await ledcSave(name); }
      if (act === 'delete') { if (!await ui.confirm('', {title: `Delete LED configuration "${name}"?`, ok: 'Delete', danger: true})) return; await fetch(`/api/led/configs/${encodeURIComponent(name)}`, {method: 'DELETE'}); ui.toast(`Deleted ${esc(name)}`); ledcFetch(); }
    }});
}
async function ledcLoad(name) {   // shared by the LEDs tab and Perform
  await fetch(`/api/led/configs/${encodeURIComponent(name)}/load`, {method: 'POST'});
  LED.dirty = false; LED.pending = null; LED.sig = ''; LED.hist = []; ledSel = null; ui.toast(`LED configuration loaded: <b>${esc(name)}</b>`, 'ok'); logLocal('LED configuration loaded: ' + name);
}
async function ledcSave(name, notes) {
  if (LED.dirty || LED.pending) { ledApply(); await new Promise(r => setTimeout(r, 600)); }   // the master must hold the layout we see
  const r = await fetch(`/api/led/configs/${encodeURIComponent(name)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(notes == null ? {} : {notes})});
  if (!r.ok) { ui.alert('The master refused the save (' + r.status + ').'); return false; }
  ui.toast(`LED configuration saved: <b>${esc(name)}</b>`, 'ok'); logLocal('LED configuration saved: ' + name); await ledcFetch(); renderLedc(name); return true;
}
async function ledcSaveDialog(defaults) {   // shared by the LEDs tab and Perform
  if (!S.live) return ui.alert('Connect to a master first — the demo has nowhere to save.');
  const zs = LED.dirty || LED.pending ? LED.zones : ledServer(); const px = zs.reduce((a, z) => a + (+z.count || 0), 0);   // Perform never opens the editor, so read the master's list there
  const v = await ui.saveAs({what: 'LED configuration', title: 'Save current LED layout', text: `${zs.length} zone${zs.length === 1 ? '' : 's'} · ${px} px · brightness, gamma, fps and test state go with it.`,
    name: defaults && defaults.name, existing: LEDC.map(x => x.name), placeholder: 'e.g. Studio bar + booth',
    fields: [{key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'which controller is where'}]});
  if (!v) return null; return (await ledcSave(v.name, v.notes)) ? v.name : null;
}
$('ledc-save').onclick = () => ledcSaveDialog();
$('ledc-import').onchange = async () => { const f = $('ledc-import').files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); if (!d.led) throw new Error('no "led" block'); const n = await ui.prompt('Import LED configuration', {value: d.name || f.name.replace(/\.fractalleds\.json$|\.json$/i, ''), label: 'Import as'}); if (n) { await fetch(`/api/led/configs/${encodeURIComponent(n)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({import: d})}); ui.toast(`Imported <b>${esc(n)}</b>`, 'ok'); await ledcFetch(); renderLedc(n); } } catch (e) { ui.alert('Not an LED configuration file: ' + e.message); } $('ledc-import').value = ''; };
$('ledc-cloud').onchange = async () => { const n = $('ledc-cloud').value; $('ledc-cloud').value = ''; if (!n) return; const r = await fetch(`/api/cloud/fetch/led_config/${encodeURIComponent(n)}`, {method: 'POST'}); logLocal(r.ok ? `LED configuration "${n}" pulled from the cloud` : 'pull failed'); ledcFetch(); };
