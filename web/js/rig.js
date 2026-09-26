// Fractal Rig web UI — rig.js: Rig tab: fleet table, diagnostics cards, update/restart/reboot actions
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ status / debugging tab
const kv = rows => `<table class="kvt">${rows.filter(r => r).map(([k, v, cls]) => `<tr><td>${k}</td><td class="${cls || ''}">${v == null || v === '' ? '<span class="mute">—</span>' : v}</td></tr>`).join('')}</table>`;
const fmtAge = s => s == null ? '—' : s < 60 ? s.toFixed(0) + 's' : s < 3600 ? (s / 60).toFixed(0) + 'm' : (s / 3600).toFixed(1) + 'h';
const yesno = b => b ? '<span class="ok">yes</span>' : '<span class="bad">no</span>';
function throttleDecode(str) {
  if (!str) return null;
  const m = /0x([0-9a-f]+)/i.exec(str); if (!m) return esc(str);
  const v = parseInt(m[1], 16); if (!v) return '<span class="ok">0x0 — healthy</span>';
  const bits = {0: 'UNDER-VOLTAGE NOW', 1: 'freq capped now', 2: 'throttled now', 3: 'soft temp limit now', 16: 'under-voltage occurred', 17: 'freq cap occurred', 18: 'throttling occurred', 19: 'soft temp limit occurred'};
  const on = Object.entries(bits).filter(([b]) => v & (1 << b)).map(([, n]) => n);
  return `<span class="${v & 0xF ? 'bad' : 'warn'}">${str} — ${on.join(', ')}</span>`;
}
let stBuilt = false;
function projCell(n, h) {   // Projectors table: power dot · source · ⏻ · input menu · ⚙ — two-way over RS-232 / PJLink from that Pi
  const p = h.proj || {}; const pw = p.power || 'unknown';
  const dot = pw === 'on' ? 'ok' : pw === 'warming' || pw === 'cooling' ? 'warn' : pw === 'off' ? 'off' : '';
  const label = pw === 'unknown' ? (p.port === null && p.msg && /no USB|not reachable/.test(p.msg) ? 'no RS-232' : '?') : pw;
  return `<i class="hdot ${dot}" title="${esc(p.msg || 'not polled yet')}"></i> <span class="mono" style="font-size:11px">${esc(label)}${p.source ? ' · ' + esc(p.source) : ''}</span> <button class="btn small" data-pj="${esc(n)}" data-cmd="${pw === 'on' ? 'off' : 'on'}" title="${pw === 'on' ? 'power off' : 'power on'}">⏻</button><select class="btn small" data-pjin="${esc(n)}" title="input"><option value="">in…</option><option value="hdmi1">HDMI 1</option><option value="hdmi2">HDMI 2</option><option value="blank">blank</option><option value="unblank">unblank</option><option value="status">re-read</option></select><button class="btn small" data-pj="${esc(n)}" data-cmd="config" title="protocol / port">⚙</button>`;
}
async function projAct(name, cmd, el) {
  if (cmd === 'config') {
    let cur = {}; try { cur = (await (await fetch(`/api/rig/${encodeURIComponent(name)}/projector`)).json()).config || {}; } catch (e) {}
    const v = await ui.dialog({title: `${name} · projector control`, text: 'How this Pi talks to its projector. ViewSonic V52HD / PX / PA: RS-232, 19200 8N1, via a USB→RS-232 lead. PJLink: over the LAN, needs the projector\'s IP.',
      fields: [{key: 'protocol', label: 'Protocol', type: 'select', value: cur.protocol || 'viewsonic', options: [['viewsonic', 'ViewSonic RS-232 (hex, 19200)'], ['pjlink', 'PJLink over LAN (TCP 4352)']]},
               {key: 'port', label: 'Serial port', value: cur.port || 'auto', hint: 'auto = first USB→RS-232 adapter found'}, {key: 'baud', label: 'Baud', value: cur.baud || 19200},
               {key: 'host', label: 'PJLink host (IP)', value: cur.host || ''}], ok: 'Save'});
    if (!v) return; const r = await (await fetch(`/api/rig/${encodeURIComponent(name)}/projector/config`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({protocol: v.protocol, port: v.port, baud: +v.baud || 19200, host: v.host})})).json();
    ui.toast(r.ok ? `${esc(name)}: projector control saved` : `${esc(name)}: ${esc(r.msg || 'failed')}`, r.ok ? 'ok' : 'bad'); return;
  }
  if (cmd === 'off' && !await ui.confirm(`Power off the projector on ${name}?`, {ok: 'Power off'})) return;
  if (el) el.disabled = true;
  try { const r = await (await fetch(`/api/rig/${encodeURIComponent(name)}/projector`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({cmd})})).json();
    ui.toast(`${esc(name)} projector ${esc(cmd)}: ${esc(r.msg || (r.ok ? 'ok' : 'failed'))}`, r.ok ? 'ok' : 'warn', 3500); }
  catch (e) { ui.toast(`${esc(name)}: request failed`, 'bad'); }
  if (el) setTimeout(() => { el.disabled = false; }, 1500);
}
async function projAll(cmd) {
  const names = Object.keys(S.fleet || {}); if (!names.length) return ui.alert('No renderers online.');
  if (!await ui.confirm(`${cmd === 'on' ? 'Power on' : cmd === 'off' ? 'Power off' : cmd} the projector on ${names.length === 1 ? names[0] : names.length + ' Pis (' + names.join(', ') + ')'}?`, {ok: cmd === 'off' ? 'Power off' : 'Go'})) return;
  const r = await (await fetch(`/api/rig/projectors/${encodeURIComponent(cmd)}`, {method: 'POST'})).json();
  ui.toast('Projectors ' + cmd + ': ' + Object.entries(r.results || {}).map(([k, v]) => `${esc(k)} → ${esc(v)}`).join(' · '), 'ok', 5000);
}
$('proj-all-on').onclick = () => projAll('on'); $('proj-all-off').onclick = () => projAll('off');
function rigHealth(n, h) {   // one verdict per renderer, shared by the Projectors table and the health tiles
  const why = []; const vmis = h.version && h.version !== ($('pill-ver').textContent || '').replace('v', '');
  if (h.age > 3) why.push('no heartbeat for ' + h.age + ' s'); if (h.fps && h.fps < 45) why.push(h.fps.toFixed(0) + ' fps'); if (h.loss_rate > 5) why.push('losing packets now'); else if (h.lost) why.push(h.lost + ' packets lost in total');
  if (h.temp > 75) why.push(h.temp.toFixed(0) + ' °C'); if (h.hb_worst > 3) why.push('heartbeat gaps ' + h.hb_worst + ' s (LAN?)'); if (vmis) why.push('version ' + h.version + ' ≠ master');
  const bad = h.age > 3 || (h.fps && h.fps < 45) || h.loss_rate > 5 || h.temp > 75 || h.hb_worst > 3;
  return {cls: bad ? 'bad' : why.length ? 'warn' : 'ok', why, vmis};
}
function healthTiles(d, cfg, fl) {
  const t = []; const tile = (l, v, s, cls) => t.push(`<div class="ht ${cls || ''}"><span class="l">${l}</span><b>${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`);
  const target = cfg.tick_hz || 60;
  const online = fl.filter(([, h]) => h.age <= 3), verdicts = fl.map(([n, h]) => rigHealth(n, h));
  const nbad = verdicts.filter(v => v.cls === 'bad').length, nwarn = verdicts.filter(v => v.cls === 'warn').length;
  tile('Projectors', `${online.length}${fl.length !== online.length ? ' / ' + fl.length : ''}`, fl.length ? (nbad ? nbad + ' faulty' : nwarn ? nwarn + ' with warnings' : 'all healthy') : 'none heard', !fl.length ? 'warn' : nbad ? 'bad' : nwarn ? 'warn' : 'ok');
  tile('Master tick', S.tick_hz ? `${S.tick_hz} Hz` : '—', `target ${target} · worst gap ${S.tick_gap_ms != null ? S.tick_gap_ms + ' ms' : '?'}`, !S.tick_hz ? '' : S.tick_hz < target * 0.9 || S.tick_gap_ms > 50 ? 'bad' : S.tick_gap_ms > 25 ? 'warn' : 'ok');
  const lostNow = fl.reduce((a, [, h]) => a + (h.loss_rate || 0), 0), lostTot = fl.reduce((a, [, h]) => a + (h.lost || 0), 0);
  tile('Multicast loss', fl.length ? (lostNow > 0.5 ? lostNow.toFixed(0) + ' / 10 s' : 'none') : '—', `${S.packets_sent || 0} sent · ${lostTot} missed in total`, !fl.length ? '' : lostNow > 5 ? 'bad' : lostTot ? 'warn' : 'ok');
  const hbw = fl.length ? Math.max(...fl.map(([, h]) => h.hb_worst || 0)) : null;
  tile('LAN jitter', hbw == null ? '—' : hbw.toFixed(1) + ' s', 'worst heartbeat gap (1.0 = perfect)', hbw == null ? '' : hbw > 3 ? 'bad' : hbw > 1.8 ? 'warn' : 'ok');
  const fmin = fl.length ? Math.min(...fl.map(([, h]) => h.fps || 0)) : null;
  tile('Slowest projector', fmin == null ? '—' : fmin.toFixed(0) + ' fps', fl.length ? fl.map(([n, h]) => `${n} ${h.fps.toFixed(0)}`).join(' · ') : '', fmin == null ? '' : fmin < 45 ? 'bad' : fmin < 55 ? 'warn' : 'ok');
  const hot = fl.filter(([, h]) => h.temp > 0).sort((a, b) => b[1].temp - a[1].temp)[0];
  const mt = d.cpu_temp, hottest = hot && (!mt || hot[1].temp > mt) ? [hot[0], hot[1].temp] : (mt ? ['master', mt] : null);
  tile('Hottest Pi', hottest ? hottest[1].toFixed(0) + ' °C' : '—', hottest ? hottest[0] + (d.throttled && !/0x0\b/.test(d.throttled) ? ' · master THROTTLED' : '') : '', !hottest ? '' : hottest[1] > 75 || (d.throttled && !/0x0\b/.test(d.throttled)) ? 'bad' : hottest[1] > 65 ? 'warn' : 'ok');
  const pon = fl.filter(([, h]) => h.proj && h.proj.power === 'on').length, pknown = fl.filter(([, h]) => h.proj && h.proj.power && h.proj.power !== 'unknown').length;
  tile('Projector power', fl.length ? `${pon} / ${fl.length} on` : '—', pknown < fl.length ? `${fl.length - pknown} not reporting (RS-232 lead?)` : pon === fl.length ? 'all lit' : 'some off', !fl.length ? '' : pknown < fl.length ? 'warn' : pon === fl.length ? 'ok' : 'warn');
  tile('Master load', d.load ? esc(String(d.load).split(' ')[0]) : '—', `${esc(d.mem || '')}${d.uptime_s ? ' · up ' + fmtAge(d.uptime_s) : ''}`, d.load && +String(d.load).split(' ')[0] > 3 ? 'warn' : d.load ? 'ok' : '');
  tile('This UI', BR.rtt == null ? '—' : BR.rtt + ' ms', `round-trip · ${BR.snapHz || '?'} snapshots/s · ${BR.reconnects} reconnects`, BR.rtt == null ? '' : BR.rtt > 150 ? 'bad' : BR.rtt > 80 ? 'warn' : 'ok');
  const c = S.cloud; tile('Cloud', !c || !c.configured ? 'off' : !c.enabled ? 'paused' : c.online ? 'synced' : 'offline', c ? `${c.pending || 0} queued · last ${c.last_sync ? new Date(c.last_sync * 1000).toLocaleTimeString() : 'never'}` : '', !c || !c.configured || !c.enabled ? '' : c.online ? 'ok' : 'warn');
  const led = (S.outputs || {}).led || {}; tile('LED output', led.enabled ? `${led.pixels || 0} px` : 'off', led.enabled ? `${(led.strips || []).length} zones · ${led.fps || 0} fps · ${Object.keys(led.errors || {}).length ? Object.keys(led.errors).length + ' errors' : 'ok'}` : '', led.enabled ? (Object.keys(led.errors || {}).length ? 'bad' : 'ok') : '');
  const tp = S.tempo_source; tile('Tempo', S.bpm ? S.bpm.toFixed(1) : '—', {prodj: 'Pro DJ Link', link: 'Ableton Link', tap: 'tap / manual', audio: 'audio onset', none: 'no tempo'}[tp] || tp, S.bpm ? (tp === 'prodj' || tp === 'link' ? 'ok' : 'warn') : 'warn');
  const vers = new Set(fl.map(([, h]) => h.version).filter(Boolean)); const mv = ($('pill-ver').textContent || '').replace('v', '');
  tile('Versions', vers.size <= 1 && (!vers.size || vers.has(mv)) ? 'in step' : 'MISMATCH', `master v${mv}${vers.size ? ' · Pis ' + [...vers].join(', ') : ''}`, vers.size <= 1 && (!vers.size || vers.has(mv)) ? 'ok' : 'bad');
  return t.join('');
}
function renderStatus() {
  const d = S.diag || {}, now = Date.now() / 1000, cfg = d.config || {};
  const cards = [];
  // ---- summary line
  const problems = [];
  if (!S.live) problems.push('not connected to a master (demo mode)');
  if (S.live && S.tick_hz && S.tick_hz < (cfg.tick_hz || 60) * 0.9) problems.push(`master tick rate low (${S.tick_hz} Hz)`);
  if (S.live && S.tick_gap_ms > 50) problems.push(`master tick gap ${S.tick_gap_ms} ms`);
  if (d.throttled && !/0x0\b/.test(d.throttled)) problems.push('master Pi throttled / under-voltage');
  if (d.cpu_temp > 75) problems.push(`master CPU ${d.cpu_temp}°C`);
  const fl = Object.entries(S.fleet || {});
  fl.forEach(([n, h]) => { if (h.fps && h.fps < 45) problems.push(`${n}: ${h.fps.toFixed(0)} fps`); if (h.lost > 0) problems.push(`${n}: ${h.lost} packets lost`); if (h.temp > 75) problems.push(`${n}: ${h.temp}°C`); if (h.age > 3) problems.push(`${n}: last heartbeat ${h.age}s ago`); });
  if (S.live && fl.length === 0) problems.push('no renderers heard');
  if (S.live && S.sources.prodj && S.sources.prodj.enabled && !S.sources.prodj.ok) problems.push('Pro DJ Link enabled but not locked');
  if (BR.rtt > 100) problems.push(`UI round-trip ${BR.rtt} ms`);
  $('st-summary').innerHTML = problems.length ? '<b>Attention:</b> ' + problems.map(esc).join(' · ') : '<span class="ok">All green</span> — master ticking, ' + fl.length + ' renderer' + (fl.length === 1 ? '' : 's') + ' heard, no faults flagged.';

  // ---- browser / connection
  cards.push(['This browser & link', kv([
    ['Mode', S.live ? '<span class="ok">live</span>' : '<span class="warn">demo (no master)</span>'],
    ['WebSocket', BR.wsUrl ? esc(BR.wsUrl) : '—'],
    ['Connected for', S.live ? fmtAge((Date.now() - BR.connectedAt) / 1000) : '—'],
    ['Reconnects this page', BR.reconnects],
    ['UI round-trip', BR.rtt == null ? null : `${BR.rtt} ms (worst ${BR.rttMax})`, BR.rtt > 100 ? 'warn' : 'ok'],
    ['Clock skew browser−master', BR.clockSkew == null ? null : BR.clockSkew + ' ms', Math.abs(BR.clockSkew) > 2000 ? 'warn' : ''],
    ['Snapshots received', BR.snapHz ? BR.snapHz + ' Hz (target 15)' : '—', BR.snapHz && BR.snapHz < 10 ? 'warn' : ''],
    ['Preview fps', BR.previewFps || '—'],
    ['WebGL renderer', BR.gl ? esc(BR.glVendor + ' · ' + BR.gl) : '<span class="bad">no WebGL2</span>'],
    ['Page version', document.getElementById('pill-ver').textContent + (d.app && ('v' + d.app) !== $('pill-ver').textContent ? ` <span class="warn">master is v${d.app}</span>` : '')],
    ['User agent', esc(navigator.userAgent)],
    ['Page errors', BR.errors.length ? BR.errors.map(esc).join('<br>') : '<span class="ok">none</span>'],
  ])]);

  if (S.live) {
    cards.push(['Master system', kv([
      ['Host', esc(d.host || '')], ['Model', esc(d.pi_model || d.machine || '')], ['OS', esc(d.os || '')],
      ['IP addresses', (d.ips || []).map(esc).join('<br>')],
      ['Master uptime', fmtAge(S.uptime)], ['System uptime', fmtAge(d.uptime_s)],
      ['Load (1/5/15)', esc(d.load || '')],
      ['CPU temp', d.cpu_temp == null ? null : d.cpu_temp + ' °C', d.cpu_temp > 75 ? 'bad' : d.cpu_temp > 65 ? 'warn' : 'ok'],
      ['Throttle flags', d.has_vcgencmd ? throttleDecode(d.throttled) : '<span class="mute">not a Pi (no vcgencmd)</span>'],
      ['Memory used', esc(d.mem || '')], ['Python', esc(d.python || '')], ['App / PID', `v${esc(d.app || '?')} · pid ${d.pid || '?'}`],
      ['Time on master', esc(d.time || '')],
    ])]);
    const target = cfg.tick_hz || 60;
    cards.push(['Clock & broadcast', kv([
      ['Animation clock t', S.t.toFixed(2) + ' s'], ['Clock speed', S.clock_speed],
      ['Tick rate', S.tick_hz ? `${S.tick_hz} Hz (target ${target})` : '—', S.tick_hz && S.tick_hz < target * 0.9 ? 'bad' : 'ok'],
      ['Worst tick gap (1 s window)', S.tick_gap_ms != null ? S.tick_gap_ms + ' ms' : null, S.tick_gap_ms > 50 ? 'bad' : S.tick_gap_ms > 25 ? 'warn' : 'ok'],
      ['Packets sent', S.packets_sent], ['Sequence', S.seq],
      ['Multicast group', `${cfg.multicast_group}:${cfg.multicast_port} ttl 1`],
      ['Send interface', cfg.multicast_iface || 'default route'],
      ['Group joined locally (IGMP)', d.igmp_joined == null ? null : (d.igmp_joined ? `<span class="ok">yes (${d.igmp_joined} iface)</span>` : '<span class="warn">no — local renderer not running?</span>')],
      ['Heartbeat port', 'udp/' + (cfg.heartbeat_port || 5006)], ['Web UI clients', d.ws_clients],
      ['Tempo', S.bpm ? `${S.bpm.toFixed(2)} BPM · ${S.tempo_source} · bar beat ${S.bar_beat || '?'}` : 'none'],
      ['beat_t', S.beat_t ? S.beat_t.toFixed(3) : null],
    ])]);
  }

  // ---- sources detail
  const sr = S.sources || {}, pr = S.prodj_raw || {};
  const srcRows = Object.keys(SOURCE_META).map(n => {
    const st = sr[n] || {}; const dot = !st.enabled ? 'mute' : st.ok ? 'ok' : 'warn';
    let extra = '';
    if (n === 'midi') extra = `<br><span class="mute">ports:</span> ${(d.midi_ports || []).length ? d.midi_ports.map(esc).join(', ') : 'none'}${st.last ? `<br><span class="mute">last:</span> ${esc(st.last)}` : ''}${S.last_cc != null ? ` · learn CC ${S.last_cc}` : ''}`;
    if (n === 'audio') extra = `<br><span class="mute">devices:</span> ${(d.audio_devices || []).length ? d.audio_devices.map(x => esc(x.index + ': ' + x.name)).join(', ') : 'none'}<br><span class="mute">selected:</span> ${S.audio_device == null ? 'default' : esc(S.audio_device)} · energy ${(S.out.energy || 0).toFixed(2)} bass ${(S.out.bass || 0).toFixed(2)}`;
    if (n === 'osc') extra = `<br><span class="mute">port:</span> udp/${cfg.osc_port || 9000}${st.last ? `<br><span class="mute">last:</span> ${esc(st.last)} (${fmtAge(now - st.seen)} ago)` : '<br><span class="mute">no messages yet</span>'}`;
    if (n === 'prodj') extra = `<br><span class="mute">raw:</span> ${pr.packets || 0} Pioneer pkts · ${pr.beats || 0} beats · ${pr.other || 0} other · ${pr.bad || 0} non-Pioneer${pr.last_seen ? ` · last ${esc(pr.last_type)} from ${esc(pr.last_from)} ${fmtAge(now - pr.last_seen)} ago` : ''}<br><span class="mute">follow:</span> ${S.prodj_follow ? 'deck ' + S.prodj_follow : 'auto'}`;
    if (n === 'auto') extra = `<br><span class="mute">drifting:</span> ${PARAMS.filter(p => S.auto[p.key]).map(p => p.key).join(', ') || 'none'} · depth ${(+S.auto_depth).toFixed(2)} · rate ${(+S.auto_rate).toFixed(3)}`;
    return [`<span class="${dot}">●</span> ${SOURCE_META[n].label}`, `${st.enabled ? (st.ok ? '<span class="ok">linked</span>' : '<span class="warn">waiting</span>') : '<span class="mute">off</span>'} · ${esc(st.detail || '')}${extra}`];
  });
  let prodjHint = '';
  if (S.live && sr.prodj && sr.prodj.enabled && !sr.prodj.ok) {
    prodjHint = pr.packets ? (pr.beats ? '<div class="hint">Beat packets are arriving but no lock — check the deck is <b>playing</b> and follow-mode isn\'t pinned to a silent deck.</div>'
      : '<div class="hint">Pioneer traffic seen but <b>no beat packets</b> (type 0x28). Status/keep-alive only means the deck is idle, or beats are on another port/segment.</div>')
      : '<div class="hint"><b>No Pioneer packets at all</b> on udp/50001. Same switch as the LINK port? Same subnet (169.254.x.x vs DHCP)? Try <code>sudo tcpdump -ni any udp port 50001</code> on the master.</div>';
  }
  $('st-sources').innerHTML = kv(srcRows) + prodjHint;
  $('health').innerHTML = healthTiles(d, cfg, fl);

  // ---- decks
  const decks = Object.entries(S.decks || {});
  if (decks.length) cards.push(['Pro DJ Link decks', `<div class="tablewrap"><table><thead><tr><th>deck</th><th>bpm</th><th>beat</th><th>ip</th><th>last beat</th></tr></thead><tbody>${decks.map(([k, x]) => `<tr><td>${esc(k)}</td><td>${x.bpm}</td><td>${x.beat}</td><td>${esc(x.ip || '')}</td><td class="${now - x.seen > 5 ? 'warn' : 'ok'}">${fmtAge(now - x.seen)} ago</td></tr>`).join('')}</tbody></table></div>`]);

  // ---- fleet detail
  // ---- projectM
  if (S.live) { const pm = S.pm || {}; const au = pm.audio || {};
    cards.push(['Milkdrop', kv([
      ['Preset dir', esc(pm.dir || '')], ['Presets on master', pm.count ? pm.count : '<span class="warn">0 — run setup/install-projectm.sh</span>'],
      ['Current', pm.count ? `#${pm.index} · ${esc(pm.name || '')}` : null],
      ['Auto-cycle', pm.cycle_bars ? `every ${pm.cycle_bars} bars · ${pm.shuffle ? 'shuffle' : 'sequential'}` : 'off'],
      ['PCM stream to Pis', pm.audio ? `${au.packets} pkts → ${esc(au.dest)} @ ${au.rate} Hz · last ${au.last_age}s ago` : '<span class="mute">off (audio input not running) — Pis synthesize a beat-locked signal</span>'],
      ['Renderers with projectM', fl.filter(([, h]) => h.pm_presets > 0).length + ' / ' + fl.length],
    ])]); }

  // ---- outputs
  if (S.live) { const o = S.outputs || {}, r = o.resolume || {}, l = o.led || {}, lk = S.sources.link || {};
    cards.push(['Outputs', kv([
      ['Ableton Link', lk.enabled ? `${lk.ok ? '<span class="ok">' + lk.peers + ' peers</span>' : '<span class="warn">no peers</span>'} · ${lk.tempo || '—'} BPM · ${(o.link || {}).mode}` : '<span class="mute">off</span>'],
      ['OSC → Resolume', r.enabled ? `${esc(r.host)}:${r.port} · ${r.sent} sent · last ${esc(r.last || '—')}` : '<span class="mute">off</span>'],
      ['LED output', l.enabled ? `${l.pixels} px · ${(l.strips || []).length} strips · ${l.fps} fps · ${l.packets} pkts · ${Object.keys(l.errors || {}).length ? '<span class="bad">errors</span>' : '<span class="ok">ok</span>'}` : '<span class="mute">off</span>'],
      ['Thumbnails', Object.entries(o.thumbs || {}).map(([n, t]) => `${esc(n)} ${t.fps}fps`).join(' · ') || '<span class="mute">none</span>'],
      ['NDI', fl.map(([n, h]) => `${esc(n)}: ${esc((h.ndi || 'ndi:none').replace('ndi:', ''))}`).join(' · ') || '—'],
    ])]); }

  // ---- config + log
  if (S.live) cards.push(['Master config (effective)', `<pre class="diag">${esc(JSON.stringify(cfg, null, 1))}</pre>`]);
  cards.push(['Log (last 60)', `<pre class="diag">${(S.log || []).slice().reverse().map(esc).join('\n') || '—'}</pre>`]);
  cards.push(['Self-test on a Pi', `<pre class="diag">cd ~/fractal-rig &amp;&amp; bash setup/selftest.sh
sudo bash setup/install-projectm.sh   # optional: add Milkdrop presets (scene 8)</pre><div class="hint">Checks build, groups, SDL/GLES, multicast reception + rate, master IP, Pro DJ Link traffic, MIDI &amp; audio devices, temperature/throttling, service status and recent fps — pass/fail per line.</div>`]);

  $('st-grid').innerHTML = cards.map(([title, html, wide]) => `<div class="card${wide ? ' wide' : ''}"><h2>${title}</h2>${html}</div>`).join('');
}
$('diag-copy').onclick = async () => {
  const blob = {when: new Date().toISOString(), live: S.live, browser: BR, state: {t: S.t, seq: S.seq, bpm: S.bpm, tempo_source: S.tempo_source, tick_hz: S.tick_hz, tick_gap_ms: S.tick_gap_ms, packets_sent: S.packets_sent, uptime: S.uptime, out: S.out, auto: S.auto}, sources: S.sources, prodj_raw: S.prodj_raw, decks: S.decks, fleet: S.fleet, diag: S.diag, log: S.log};
  try { await navigator.clipboard.writeText(JSON.stringify(blob, null, 1)); $('diag-copy').textContent = 'Copied ✓'; } catch (e) { $('diag-copy').textContent = 'Copy failed'; }
  setTimeout(() => $('diag-copy').textContent = 'Copy diagnostics JSON', 1500);
};
$('diag-refresh').onclick = () => { renderStatus(); };

// ------------------------------------------------------------ rig maintenance (update / restart / reboot)
async function rigAct(name, act, btn) {
  const label = {update: 'pull the latest from GitHub and reinstall', restart: 'restart the renderer', reboot: 'REBOOT'}[act] || act;
  if (!await ui.confirm(`${name === 'self' ? 'master' : name}: ${label}?`, {ok: act, danger: act === 'reboot'})) return;
  if (btn) { btn.disabled = true; btn.textContent = act + '…'; }
  try { const j = await (await fetch(`/api/rig/${encodeURIComponent(name)}/${act}`, {method: 'POST'})).json(); logLocal(`${name}: ${j.msg || (j.ok ? 'ok' : 'failed')}`); if (!j.ok) ui.alert(j.msg || 'failed'); else ui.toast(`${esc(name === 'self' ? 'master' : name)}: ${esc(j.msg || 'ok')}`, 'ok', 4000); }
  catch (e) { ui.alert('Request failed: ' + e.message); }
  if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = act; }, 4000);
}
$('rig-update-master').onclick = () => rigAct('self', 'update');
$('rig-restart-master').onclick = () => rigAct('self', 'restart');
$('rig-restart-renderer').onclick = () => rigAct('self', 'restart-renderer');
$('rig-update-all').onclick = async () => {
  const names = Object.keys(S.fleet || {}); if (!await ui.confirm(`Projectors go dark for a couple of minutes while they rebuild.`, {title: `Update the master and ${names.length} renderer${names.length === 1 ? '' : 's'} (${names.join(', ') || 'none online'}) from GitHub?`, ok: 'Update everything'})) return;
  for (const n of names) { try { const j = await (await fetch(`/api/rig/${encodeURIComponent(n)}/update`, {method: 'POST'})).json(); logLocal(`${n}: ${j.msg}`); } catch (e) { logLocal(`${n}: failed`); } }
  await fetch('/api/rig/self/update', {method: 'POST'}); logLocal('master: updating…');
};
$('rig-log').onclick = async () => { const o = $('rig-log-out'); o.style.display = o.style.display === 'none' ? 'block' : 'none'; if (o.style.display === 'block') { o.textContent = 'loading…'; try { o.textContent = await (await fetch('/api/rig/self/update.log')).text(); } catch (e) { o.textContent = 'no log'; } o.scrollTop = o.scrollHeight; } };
