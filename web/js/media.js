// Fractal Rig web UI — media.js: video scene card + Media tab (uploads, playlist, LIVE feed)
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ video scene + media library
const fmtDur = d => { d = Math.max(0, Math.round(+d || 0)); const m = Math.floor(d / 60), s2 = d % 60; return (m ? m + ':' : '0:') + String(s2).padStart(2, '0'); };
const fmtMB = b => (b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1) + ' MB';
let mediaTimer = null, mediaLast = 0;
async function fetchMedia(force) {
  if (!S.live) { $('media-ffmpeg').textContent = 'demo — no master'; renderMedia(); return; }
  if (!force && performance.now() - mediaLast < 4000) return;
  mediaLast = performance.now();
  try { const r = await fetch('/api/media'); if (!r.ok) throw 0; S.media = await r.json(); } catch (e) { return; }
  renderMedia(); renderVideo();
}
function videoPos() {   // same maths as engine.video_position / the renderers, on the browser's extrapolated clock
  const i = Math.round(S.base.video_clip), c = (S.media.clips || [])[i]; if (i === 255 || !c) return {pos: 0, dur: 0, clip: c, i};
  const t = S.t + (performance.now() - S.tRecv) / 1000 * (S.live ? S.clock_speed : 0);
  const el = Math.max(0, t - S.base.video_t0) * (S.base.video_speed || 1), dur = +c.duration || 0;
  if (!dur) return {pos: el, dur: 0, clip: c, i};
  return {pos: S.base.video_loop >= 0.5 ? el % dur : Math.min(el, dur), dur, clip: c, i, ended: S.base.video_loop < 0.5 && el >= dur};
}
function renderVideo() {
  const v = S.video || {}, clips = S.media.clips || [], on9 = Math.round(S.base.mode) === 9, i = Math.round(S.base.video_clip);
  const name = i === 255 ? 'LIVE' : (clips[i] || {}).name || v.name || '—';
  $('video-count').textContent = clips.length ? clips.length + ' clip' + (clips.length === 1 ? '' : 's') : (S.live ? 'no clips yet' : 'demo');
  $('video-card').classList.toggle('expanded', on9);
  $('eng-video-sub').textContent = on9 ? `▶ ${name}` : clips.length ? `${clips.length} clips · ${v.cycle === 'bars' ? 'advance every ' + v.cycle_bars + ' bars' : v.cycle === 'off' ? 'manual' : 'advance at end'}` : 'clips on every Pi, frame-locked · or a LIVE HDMI feed';
  const p = videoPos();
  $('video-big-name').textContent = name;
  $('video-big-sub').textContent = i === 255 ? ((S.media.live || {}).running ? 'live stream · ' + (S.media.live.source || '') : 'live stream — not running (Media → LIVE source)') : p.clip ? `#${i} · ${fmtDur(p.pos)} / ${fmtDur(p.dur)} · ${p.clip.width}×${p.clip.height} · ${S.base.video_loop >= 0.5 ? 'loop' : 'one-shot' + (p.ended ? ' · ended' : '')}` : (clips.length ? 'pick a clip' : 'upload clips in the Media tab');
  $('video-bar-fill').style.width = p.dur ? (100 * p.pos / p.dur).toFixed(1) + '%' : '0%';
  $('video-loop').className = 'btn small' + (S.base.video_loop >= 0.5 ? ' active' : '');
  if (document.activeElement !== $('video-speed')) $('video-speed').value = S.base.video_speed || 1;
  $('video-speed-v').textContent = (+S.base.video_speed || 1).toFixed(2) + '×';
  $('video-barsync').className = 'btn small' + (v.bar_sync ? ' active' : '');
  if (document.activeElement !== $('video-cycle')) $('video-cycle').value = v.cycle || 'end';
  if (document.activeElement !== $('video-cycle-bars')) $('video-cycle-bars').value = v.cycle_bars || 8;
  $('video-cycle-bars').disabled = v.cycle !== 'bars';
  $('video-live').className = 'btn' + (i === 255 && on9 ? ' active' : '');
  const sig = clips.map(c => c.name).join('|') + '#' + i + on9;
  if ($('video-chips').dataset.sig !== sig) { $('video-chips').dataset.sig = sig; $('video-chips').innerHTML = clips.slice(0, 16).map((c, k) => `<button class="btn small ${on9 && k === i ? 'active' : ''}" data-c="${k}" title="${esc(c.name)} · ${fmtDur(c.duration)}">${esc(c.name.slice(0, 22))}</button>`).join(''); $('video-chips').querySelectorAll('[data-c]').forEach(b => b.onclick = () => send({video: {play: +b.dataset.c}})); }
  // card placement: under the preview when active (like projectM)
  const previewCard = document.querySelector('.previewwrap').closest('.card'), vc = $('video-card');
  if (on9 && vc.previousElementSibling !== previewCard) previewCard.after(vc);
  if (!on9 && vc.previousElementSibling === previewCard) document.querySelector('#fleet').closest('.card').before(vc);
  if (S.live && (on9 || !mediaLast)) fetchMedia(false);
}
$('eng-video').onclick = () => send({video: {play: S.video.index === 255 ? 255 : Math.max(0, S.video.index || 0)}});
$('eng-resolume').onclick = () => { const lv = (S.video && S.video.live) || {}; if (lv.running && String(lv.source || '').startsWith('ndi:')) { send({video: {live: 1}}); return; } $('eng-resolume-sub').textContent = 'looking for Resolume on the network…'; send({video: {live_start: {kind: 'ndi', source: 'auto', low: false}}}); setTimeout(() => { send({video: {live: 1}}); fetchMedia(true); }, 4500); };
$('video-prev').onclick = () => send({video: {prev: 1}}); $('video-next').onclick = () => send({video: {next: 1}}); $('video-restart').onclick = () => send({video: {restart: 1}});
$('video-live').onclick = () => send({video: {live: 1}});
$('video-loop').onclick = () => send({video: {loop: !(S.base.video_loop >= 0.5)}});
$('video-speed').oninput = () => { $('video-speed-v').textContent = (+$('video-speed').value).toFixed(2) + '×'; send({video: {speed: +$('video-speed').value}}); };
$('video-barsync').onclick = () => send({video: {bar_sync: !S.video.bar_sync}});
$('video-cycle').onchange = () => send({video: {cycle: $('video-cycle').value}});
$('video-cycle-bars').onchange = () => send({video: {cycle_bars: +$('video-cycle-bars').value}});
$('video-open-media').onclick = () => showView('media');

// ---- Media tab
function renderMedia() {
  if ($('media').hidden) return;
  const md = S.media || {}, clips = md.clips || [], v = S.video || {}, cur = Math.round(S.base.video_clip), on9 = Math.round(S.base.mode) === 9;
  $('media-ffmpeg').textContent = !S.live ? 'demo — no master' : md.ffmpeg ? 'ffmpeg ready' : 'ffmpeg missing on master';
  $('media-ffmpeg').style.color = S.live && !md.ffmpeg ? 'var(--bad)' : '';
  const jobs = md.jobs || [];
  $('media-jobs').innerHTML = jobs.filter(j => j.state !== 'done' || Date.now() / 1000 - j.started < 120).map(j => `<div class="up"><span>${esc(j.orig || j.name)} → <b>${esc(j.name)}.mp4</b> <span class="mute">${j.src ? j.src + ' · ' + fmtDur(j.duration) : ''}</span></span><span class="${j.state === 'failed' ? 'bad' : j.state === 'done' ? 'ok' : 'warn'}">${j.state}${j.state === 'converting' ? ' ' + Math.round(j.progress * 100) + '%' : ''}${j.msg ? ' · ' + esc(j.msg) : ''}</span><div class="bar"><i style="width:${Math.round((j.state === 'done' ? 1 : j.progress) * 100)}%"></i></div></div>`).join('');
  $('media-summary').textContent = clips.length ? `${clips.length} clips · ${fmtMB(clips.reduce((a, c) => a + c.size, 0))} · index order is name order (same on every Pi)` : (S.live ? 'nothing uploaded yet' : 'connect to a master to manage clips');
  const sig = JSON.stringify(clips.map(c => [c.name, c.sha1, c.thumb])) + cur + on9 + (v.playlist || []).join();
  if ($('media-grid').dataset.sig !== sig) {
    $('media-grid').dataset.sig = sig;
    $('media-grid').innerHTML = clips.map((c, i) => `<div class="clip ${on9 && i === cur ? 'on' : ''}" data-i="${i}">
      <div class="th" style="${c.thumb ? `background-image:url(${c.thumb}?${c.mtime})` : ''}" title="play on every projector">${c.thumb ? '' : 'no thumbnail'}</div>
      <div class="nm" title="${esc(c.name)}">#${i} ${esc(c.name)}</div>
      <div class="meta">${fmtDur(c.duration)} · ${c.width}×${c.height} · ${fmtMB(c.size)}</div>
      <div class="acts"><button class="btn primary" data-play="${i}">▶ play</button><button class="btn" data-pl="${c.name}" ${(v.playlist || []).includes(c.name) ? 'disabled' : ''}>+ playlist</button><button class="btn" data-ren="${c.name}">rename</button><button class="btn" data-del="${c.name}">delete</button></div>
    </div>`).join('') || '<div class="hint">No clips yet. Drop files above.</div>';
    $('media-grid').querySelectorAll('.th').forEach(el => el.onclick = () => send({video: {play: +el.closest('.clip').dataset.i}}));
    $('media-grid').querySelectorAll('[data-play]').forEach(b => b.onclick = () => send({video: {play: +b.dataset.play}}));
    $('media-grid').querySelectorAll('[data-pl]').forEach(b => b.onclick = () => send({video: {playlist: (S.video.playlist || []).concat([b.dataset.pl])}}));
    $('media-grid').querySelectorAll('[data-ren]').forEach(b => b.onclick = () => { const n = prompt('New name for ' + b.dataset.ren, b.dataset.ren); if (n && n !== b.dataset.ren) { send({video: {rename: {old: b.dataset.ren, new: n}}}); setTimeout(() => fetchMedia(true), 600); } });
    $('media-grid').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (confirm('Delete ' + b.dataset.del + '.mp4 from the master? Renderers remove it on their next sync.')) { send({video: {delete: b.dataset.del}}); setTimeout(() => fetchMedia(true), 600); } });
  }
  // playlist
  const pl = v.playlist || [];
  const psig = pl.join('|') + '#' + (v.name || '');
  if ($('media-playlist').dataset.sig !== psig) {
    $('media-playlist').dataset.sig = psig;
    $('media-playlist').innerHTML = pl.map((n, k) => `<div class="it ${v.name === n && on9 ? 'on' : ''}"><span class="n">${k + 1}</span><span class="t">${esc(n)}</span><button class="btn" data-up="${k}">▲</button><button class="btn" data-dn="${k}">▼</button><button class="btn" data-go="${esc(n)}">▶</button><button class="btn" data-rm="${k}">✕</button></div>`).join('') || '<div class="hint">empty — PREV / NEXT walk the whole library</div>';
    const mv = (k, d) => { const a = pl.slice(); const j = k + d; if (j < 0 || j >= a.length) return; [a[k], a[j]] = [a[j], a[k]]; send({video: {playlist: a}}); };
    $('media-playlist').querySelectorAll('[data-up]').forEach(b => b.onclick = () => mv(+b.dataset.up, -1));
    $('media-playlist').querySelectorAll('[data-dn]').forEach(b => b.onclick = () => mv(+b.dataset.dn, 1));
    $('media-playlist').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => send({video: {playlist: pl.filter((_, k) => k !== +b.dataset.rm)}}));
    $('media-playlist').querySelectorAll('[data-go]').forEach(b => b.onclick = () => send({video: {play: b.dataset.go}}));
    $('media-pl-add').innerHTML = clips.map(c => `<option>${esc(c.name)}</option>`).join('');
  }
  if (document.activeElement !== $('media-cycle')) $('media-cycle').value = v.cycle || 'end';
  if (document.activeElement !== $('media-cycle-bars')) $('media-cycle-bars').value = v.cycle_bars || 8;
  // live
  const lv = md.live || {};
  $('live-state').innerHTML = `<i class="dot ${lv.running ? 'ok' : ''}"></i>${lv.running ? 'streaming · ' + esc(lv.source || '') : 'off'}`;
  $('live-msg').textContent = lv.msg || (lv.running ? lv.url : '');
  if ($('live-kind').value === 'file' && $('live-source').dataset.kind !== 'file') { $('live-source').dataset.kind = 'file'; $('live-source').innerHTML = clips.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join(''); }
}
$('media-pl-addbtn').onclick = () => { const n = $('media-pl-add').value; if (n) send({video: {playlist: (S.video.playlist || []).concat([n])}}); };
$('media-pl-clear').onclick = () => send({video: {playlist: []}});
$('media-cycle').onchange = () => send({video: {cycle: $('media-cycle').value}});
$('media-cycle-bars').onchange = () => send({video: {cycle_bars: +$('media-cycle-bars').value}});
async function liveDevices() {
  const kind = $('live-kind').value, sel = $('live-source'); sel.dataset.kind = kind;
  if (kind === 'file') { sel.innerHTML = (S.media.clips || []).map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join(''); return; }
  if (kind === 'test') { sel.innerHTML = '<option value="testsrc2">colour bars + clock</option>'; return; }
  $('live-low-wrap').style.display = kind === 'ndi' ? 'flex' : 'none'; $('live-size').style.display = kind === 'ndi' ? 'none' : '';
  sel.innerHTML = `<option value="">${kind === 'ndi' ? 'looking for NDI sources…' : 'scanning…'}</option>`;
  let devs = {v4l2: [], ndi: [], have_ndi: false};
  try { const j = await (await fetch('/api/media/devices?ndi=' + (kind === 'ndi' ? 1 : 0))).json(); devs = Array.isArray(j) ? {v4l2: j, ndi: [], have_ndi: false} : j; } catch (e) {}
  if (kind === 'ndi') {
    sel.innerHTML = (devs.ndi || []).map(d => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('') ||
      (devs.have_ndi ? '<option value="">no NDI sources on the LAN — enable NDI output in Resolume (Output → NDI) and press ↻</option>' : '<option value="">NDI receiver not installed — sudo bash setup/install-ndi.sh &lt;SDK.tar.gz&gt; on the master</option>');
    return;
  }
  const list = kind === 'hdmi' ? (devs.v4l2 || []).filter(d => d.hdmi).concat((devs.v4l2 || []).filter(d => !d.hdmi)) : (devs.v4l2 || []);
  sel.innerHTML = list.map(d => `<option value="${d.dev}">${d.dev} — ${esc(d.name || 'video device')}${d.hdmi ? ' (capture)' : ''}</option>`).join('') || '<option value="">no capture device found — plug the HDMI dongle into the master</option>';
}
$('live-kind').onchange = liveDevices; $('live-refresh').onclick = liveDevices;
$('live-start').onclick = () => { const kind = $('live-kind').value, source = $('live-source').value; if (!source) return alert('no source selected'); send({video: {live_start: {kind, source, size: $('live-size').value, low: $('live-low').checked}}}); setTimeout(() => fetchMedia(true), kind === 'ndi' ? 4000 : 1200); };
$('live-stop').onclick = () => { send({video: {live_stop: 1}}); setTimeout(() => fetchMedia(true), 800); };
$('live-show').onclick = () => send({video: {live: 1}});
liveDevices();
// uploads (XHR for progress)
function uploadFiles(files) {
  if (!S.live) return alert('Connect to a master first — the Pages demo has no library.');
  [...files].forEach(f => {
    const row = document.createElement('div'); row.className = 'up'; row.innerHTML = `<span>${esc(f.name)} <span class="mute">${fmtMB(f.size)}</span></span><span class="warn" data-st>uploading…</span><div class="bar"><i style="width:0"></i></div>`;
    $('media-uploads').prepend(row);
    const fd = new FormData(); fd.append('file', f, f.name);
    const x = new XMLHttpRequest(); x.open('POST', '/api/media/upload');
    x.upload.onprogress = e => { if (e.lengthComputable) row.querySelector('.bar i').style.width = Math.round(100 * e.loaded / e.total) + '%'; };
    x.onload = () => { const ok = x.status === 200; row.querySelector('[data-st]').className = ok ? 'ok' : 'bad'; row.querySelector('[data-st]').textContent = ok ? 'uploaded — converting' : 'upload failed (' + x.status + ')'; fetchMedia(true); setTimeout(() => row.remove(), 6000); };
    x.onerror = () => { row.querySelector('[data-st]').className = 'bad'; row.querySelector('[data-st]').textContent = 'upload failed'; };
    x.send(fd);
  });
}
$('media-pick').onclick = () => $('media-file').click();
$('media-file').onchange = () => { uploadFiles($('media-file').files); $('media-file').value = ''; };
['dragenter', 'dragover'].forEach(ev => $('media-drop').addEventListener(ev, e => { e.preventDefault(); $('media-drop').classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => $('media-drop').addEventListener(ev, e => { e.preventDefault(); $('media-drop').classList.remove('over'); }));
$('media-drop').addEventListener('drop', e => uploadFiles(e.dataTransfer.files));
setInterval(() => { if (!$('media').hidden || Math.round(S.base.mode) === 9) fetchMedia(false); if (!$('media').hidden) renderMedia(); }, 2000);

// ---- preview: play the clip in the browser in step with the master clock (live stream can't be shown here)
const pvVideo = $('pv-video');
let pvSrc = '';
function videoFrame(now, t) {
  const on9 = Math.round(S.base.mode) === 9;
  pvVideo.hidden = !on9; $('pv-video-overlay').hidden = !on9;
  if (!on9) { if (!pvVideo.paused) pvVideo.pause(); return false; }
  const i = Math.round(S.base.video_clip), c = (S.media.clips || [])[i];
  if (i === 255 || !c || !S.live) {
    if (pvSrc) { pvVideo.removeAttribute('src'); pvVideo.load(); pvSrc = ''; }
    $('pv-video-label').textContent = i === 255 ? 'LIVE stream on the projectors — no browser preview' : S.live ? 'video · no clip selected' : 'video scene · demo has no clips';
    return true;
  }
  const url = '/media/' + encodeURIComponent(c.file);
  if (pvSrc !== url) { pvSrc = url; pvVideo.src = url; pvVideo.loop = false; pvVideo.play().catch(() => {}); }
  const p = videoPos(); const rate = +S.base.video_speed || 1;
  if (Math.abs(pvVideo.playbackRate - rate) > 0.01) pvVideo.playbackRate = Math.min(4, Math.max(0.1, rate));
  if (pvVideo.readyState >= 2 && Math.abs(pvVideo.currentTime - p.pos) > 0.35) { try { pvVideo.currentTime = p.pos; } catch (e) {} }
  if (p.ended) { if (!pvVideo.paused) pvVideo.pause(); } else if (pvVideo.paused) pvVideo.play().catch(() => {});
  $('pv-video-label').textContent = `video · ${c.name} · ${fmtDur(p.pos)} / ${fmtDur(p.dur)} · browser preview follows the master clock`;
  return true;
}

$('eng-pm').onclick = () => send({set: {mode: 8}});
$('eng-shader').onclick = () => send({set: {mode: lastShaderMode}});
$('tap').onclick = () => send({tap: 1});
$('beat1').onclick = () => send({beat1: 1});
$('bpm-set').onclick = () => send({bpm: +$('bpm-in').value});
$('bpm-clear').onclick = () => send({bpm: 0});
$('preset-save').onclick = () => { const n = $('preset-name').value.trim(); if (n) { send({preset: {save: n}}); $('preset-name').value = ''; } };
$('auto-all').onclick = () => { const a = {}; PARAMS.forEach(p => { if (p.kind !== 'i') a[p.key] = true; }); send({auto: a}); };
$('auto-none').onclick = () => { const a = {}; PARAMS.forEach(p => a[p.key] = false); send({auto: a}); };
$('reset').onclick = () => { const s = {}; PARAMS.forEach(p => s[p.key] = p.def_); send({set: s}); };
$('learn').onclick = () => send({midi_learn: $('learn-param').value});
for (const k of ['clock_speed', 'auto_depth', 'auto_rate']) $(k).oninput = () => send({[k]: +$(k).value});
document.addEventListener('keydown', e => { if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return; if (e.code === 'Space') { e.preventDefault(); send({tap: 1}); } if (e.key === '1') send({beat1: 1}); if (e.key === 'Escape' && perfOn) perfEnter(false); if (e.key.toLowerCase() === 'p' && !e.metaKey && !e.ctrlKey) perfEnter(!perfOn); if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey && (perfOn || !$('cues').hidden)) send({cue: {go: true}}); if (e.key.toLowerCase() === 'b' && !e.metaKey && !e.ctrlKey && (perfOn || !$('cues').hidden)) send({cue: {back: 1}}); });
