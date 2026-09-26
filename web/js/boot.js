// Fractal Rig web UI — boot.js: start-up: build controls, connect to the master or start the demo
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ boot
buildControls();
try { const sv = localStorage.getItem('frx.view'); if (sv && sv !== 'control') showView(sv); } catch (e) {}
initGL().catch(e => { console.error(e); logLocal('preview error: ' + e.message); });
const saved = (() => { try { return localStorage.getItem('frx.master'); } catch (e) { return null; } })();
$('master-url').value = saved || '';
$('master-connect').onclick = () => { const u = $('master-url').value.trim(); if (u) { try { localStorage.setItem('frx.master', u); } catch (e) {} connect(u); } };
const here = location.protocol.startsWith('http') && !/github\.io$/.test(location.hostname) ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' : null;
if (saved) connect(saved); else if (here) connect(here); else startDemo();
try { if (new URLSearchParams(location.search).get('perf') === '1' || localStorage.getItem('frx.perf') === '1') perfEnter(true); } catch (e) {}
