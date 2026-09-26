// Fractal Rig web UI — cloud.js: Supabase status pill + settings card, saved LED configurations
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ cloud (Supabase) status + settings, LED configs
function renderCloud() {
  const c = S.cloud; const dot = $('cloud-dot'), lab = $('cloud-label');
  if (!c || !c.configured) { dot.className = 'dot'; lab.textContent = S.live ? 'cloud off' : 'cloud'; }
  else if (!c.enabled) { dot.className = 'dot'; lab.textContent = 'cloud paused'; }
  else if (c.online) { dot.className = 'dot ok'; lab.textContent = c.pending ? `syncing ${c.pending}` : 'cloud ✓'; }
  else { dot.className = 'dot warn'; lab.textContent = c.pending ? `offline · ${c.pending} queued` : 'offline'; }
  if ($('status').hidden) return;
  $('cloud-dot2').className = dot.className; $('cloud-state').textContent = !c || !c.configured ? 'not configured' : !c.enabled ? 'paused' : c.online ? 'connected' : 'offline (queued locally)';
  if (c && document.activeElement !== $('cloud-url') && !$('cloud-url').dataset.touched) $('cloud-url').value = c.url || '';
  if (c && document.activeElement !== $('cloud-rig') && !$('cloud-rig').dataset.touched) $('cloud-rig').value = c.rig || '';
  if (c && !$('cloud-enabled').dataset.touched) $('cloud-enabled').checked = !!c.enabled;
  $('cloud-detail').innerHTML = c ? `rig <b>${esc(c.rig || '')}</b> · key ${esc(c.key_hint || '—')} · last sync ${c.last_sync ? new Date(c.last_sync * 1000).toLocaleTimeString() : 'never'} · pulled ${c.pulled || 0} this session · queued ${c.pending || 0}${c.error ? ` · <span style="color:var(--warn)">${esc(c.error)}</span>` : ''}` : '';
}
['cloud-url', 'cloud-rig'].forEach(id => $(id).oninput = () => $(id).dataset.touched = '1'); $('cloud-enabled').onchange = () => $('cloud-enabled').dataset.touched = '1';
$('pill-cloud').onclick = () => { showView('status'); setTimeout(() => $('cloud-card').scrollIntoView({behavior: 'smooth'}), 100); };
$('cloud-save').onclick = async () => { const body = {url: $('cloud-url').value.trim(), rig_id: $('cloud-rig').value.trim(), enabled: $('cloud-enabled').checked}; if ($('cloud-key').value.trim()) body.key = $('cloud-key').value.trim();
  const r = await (await fetch('/api/cloud/config', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})).json(); ['cloud-url', 'cloud-rig', 'cloud-enabled'].forEach(id => delete $(id).dataset.touched); $('cloud-key').value = ''; logLocal('cloud: ' + (r.online ? 'connected' : 'saved — ' + (r.error || 'offline'))); };
$('cloud-sync').onclick = async () => { $('cloud-sync').disabled = true; const r = await (await fetch('/api/cloud/sync', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).json(); $('cloud-sync').disabled = false; logLocal('cloud sync: ' + (r.ok ? 'ok' : r.error || 'offline')); };
$('cloud-pull-all').onclick = async () => { if (!confirm('Pull every show, preset bank, cue stack, LED config and mapping that is newer in the cloud than on this Pi?')) return; const r = await (await fetch('/api/cloud/sync', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"full":true}'})).json(); logLocal('cloud pull: ' + (r.ok ? `done (${r.pulled} applied this session)` : r.error || 'offline')); showsFetch(); ledcFetch(); };
async function cloudMenu(sel, kind, localNames) {
  if (!S.live || !S.cloud || !S.cloud.enabled) { sel.style.display = 'none'; return; } sel.style.display = '';
  try { const j = await (await fetch('/api/cloud/list/' + kind)).json(); const rows = (j.rows || []).filter(r => !localNames.includes(r.name));
    sel.innerHTML = `<option value="">☁ from cloud… (${j.online ? rows.length + ' not on this Pi' : 'offline'})</option>` + rows.map(r => `<option value="${esc(r.name)}">${esc(r.name)} · ${new Date(r.updated_at).toLocaleDateString()}</option>`).join(''); } catch (e) {}
}
$('show-cloud').onchange = async () => { const n = $('show-cloud').value; $('show-cloud').value = ''; if (!n) return; const r = await fetch(`/api/cloud/fetch/show/${encodeURIComponent(n)}`, {method: 'POST'}); logLocal(r.ok ? `show "${n}" pulled from the cloud` : 'pull failed'); showsFetch(); };
// LED configs
let LEDC = [];
async function ledcFetch() { if (!S.live) { $('ledc-list').innerHTML = '<span class="hint">demo mode</span>'; return; } try { LEDC = (await (await fetch('/api/led/configs')).json()).configs || []; } catch (e) { return; } renderLedc(); cloudMenu($('ledc-cloud'), 'led_config', LEDC.map(x => x.name)); }
function renderLedc() {
  const lF = favList('led_config'); LEDC = LEDC.filter(x => lF.includes(x.name)).concat(LEDC.filter(x => !lF.includes(x.name)));
  $('ledc-list').innerHTML = LEDC.length ? LEDC.map(c => `<div class="show"><h4><span class="favstar ${lF.includes(c.name) ? 'on' : ''}" data-fav="${esc(c.name)}" title="favourite">★</span> ${esc(c.name)}</h4><div class="meta">${c.strips} zone${c.strips === 1 ? '' : 's'} · ${c.pixels} px · saved ${new Date(c.saved * 1000).toLocaleString()}</div>${c.notes ? `<div class="notes">${esc(c.notes)}</div>` : ''}<div class="acts"><button class="btn small primary" data-lload="${esc(c.name)}">LOAD</button><button class="btn small" data-lupd="${esc(c.name)}" title="overwrite with the current layout">Update</button><a class="btn small" href="/api/led/configs/${encodeURIComponent(c.name)}?download=1">Download</a><button class="btn small" data-ldel="${esc(c.name)}" style="margin-left:auto">✕</button></div></div>`).join('') : '<span class="hint">no saved LED configurations yet — lay the zones out below, then save them under a name</span>';
  $('ledc-list').querySelectorAll('[data-fav]').forEach(b => b.onclick = () => { toggleFav('led_config', b.dataset.fav); setTimeout(renderLedc, 300); });
  $('ledc-list').querySelectorAll('[data-lload]').forEach(b => b.onclick = async () => { if (!confirm(`Load LED configuration "${b.dataset.lload}"? It replaces the current zones.`)) return; await fetch(`/api/led/configs/${encodeURIComponent(b.dataset.lload)}/load`, {method: 'POST'}); LED.dirty = false; LED.pending = null; LED.sig = ''; LED.hist = []; ledSel = null; logLocal('LED configuration loaded: ' + b.dataset.lload); });
  $('ledc-list').querySelectorAll('[data-lupd]').forEach(b => b.onclick = async () => { if (!confirm(`Overwrite "${b.dataset.lupd}" with the current layout?`)) return; await fetch(`/api/led/configs/${encodeURIComponent(b.dataset.lupd)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}); ledcFetch(); });
  $('ledc-list').querySelectorAll('[data-ldel]').forEach(b => b.onclick = async () => { if (!confirm(`Delete LED configuration "${b.dataset.ldel}"?`)) return; await fetch(`/api/led/configs/${encodeURIComponent(b.dataset.ldel)}`, {method: 'DELETE'}); ledcFetch(); });
}
$('ledc-save').onclick = async () => { const n = $('ledc-name').value.trim(); if (!n) return alert('give it a name'); if (LED.dirty || LED.pending) { ledApply(); await new Promise(r => setTimeout(r, 600)); }   // make sure the master has the layout we see
  await fetch(`/api/led/configs/${encodeURIComponent(n)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({notes: $('ledc-notes').value.trim()})}); $('ledc-name').value = ''; logLocal('LED configuration saved: ' + n); ledcFetch(); };
$('ledc-import').onchange = async () => { const f = $('ledc-import').files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); if (!d.led) throw new Error('no "led" block'); const n = prompt('Import as', d.name || f.name.replace(/\.fractalleds\.json$|\.json$/i, '')); if (n) { await fetch(`/api/led/configs/${encodeURIComponent(n)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({import: d})}); ledcFetch(); } } catch (e) { alert('not an LED configuration file: ' + e.message); } $('ledc-import').value = ''; };
$('ledc-cloud').onchange = async () => { const n = $('ledc-cloud').value; $('ledc-cloud').value = ''; if (!n) return; const r = await fetch(`/api/cloud/fetch/led_config/${encodeURIComponent(n)}`, {method: 'POST'}); logLocal(r.ok ? `LED configuration "${n}" pulled from the cloud` : 'pull failed'); ledcFetch(); };
