// Fractal Rig web UI — info.js: the manual's side menu, collapsible sections and search. The menu is BUILT from the
// cards (#info .card[id] > h3), so a new section only needs a card with an id — never a hand-edited link list.
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
(() => {
  const cards = [...document.querySelectorAll('#info .card[id]')];
  let closed = new Set(); try { closed = new Set(JSON.parse(localStorage.getItem('frx.info.closed') || '[]')); } catch (e) {}
  const remember = () => { try { localStorage.setItem('frx.info.closed', JSON.stringify([...closed])); } catch (e) {} };
  cards.forEach(c => {
    const h = c.querySelector('h3'); if (!h) return;
    const body = document.createElement('div'); body.className = 'ibody'; while (h.nextSibling) body.appendChild(h.nextSibling); c.appendChild(body);
    c.classList.toggle('closed', closed.has(c.id));
    h.onclick = () => { c.classList.toggle('closed'); if (c.classList.contains('closed')) closed.add(c.id); else closed.delete(c.id); remember(); };
  });
  let lastG = null; $('info-nav').innerHTML = cards.map(c => { const g = c.dataset.group || ''; const head = g && g !== lastG ? `<div class="im-group">${esc(g)}</div>` : ''; lastG = g; return head + `<a href="#${c.id}" data-t="${c.id}">${esc(c.querySelector('h3').textContent.replace(/\s+/g, ' ').trim())}</a>`; }).join('');
  $('info-nav').querySelectorAll('a').forEach(a => a.onclick = e => { e.preventDefault(); const c = $(a.dataset.t); c.classList.remove('closed'); closed.delete(c.id); remember(); c.scrollIntoView({behavior: 'smooth', block: 'start'}); history.replaceState(null, '', '#' + c.id); });
  const setAll = open => { cards.forEach(c => { c.classList.toggle('closed', !open); if (open) closed.delete(c.id); else closed.add(c.id); }); remember(); };
  $('info-expand').onclick = () => setAll(true); $('info-collapse').onclick = () => setAll(false);
  let t = null; $('info-search').oninput = () => { clearTimeout(t); t = setTimeout(() => {
    const q = $('info-search').value.trim().toLowerCase();
    cards.forEach(c => { const hit = !q || c.textContent.toLowerCase().includes(q); c.classList.toggle('nomatch', !hit); if (q && hit) c.classList.remove('closed'); $('info-nav').querySelector(`[data-t="${c.id}"]`).classList.toggle('hidden', !hit); });
  }, 120); };
  // highlight the section in view
  if ('IntersectionObserver' in window) { const io = new IntersectionObserver(es => { es.forEach(en => { if (en.isIntersecting) { $('info-nav').querySelectorAll('a').forEach(a => a.classList.toggle('cur', a.dataset.t === en.target.id)); } }); }, {rootMargin: '-70px 0px -70% 0px'}); cards.forEach(c => io.observe(c)); }
  // deep link (#i-topology) opens that section
  const openHash = () => { const id = location.hash.slice(1); const c = id && $(id); if (c && c.closest('#info')) { showView('info'); c.classList.remove('closed'); setTimeout(() => c.scrollIntoView({block: 'start'}), 50); } };
  window.addEventListener('hashchange', openHash); if (location.hash.startsWith('#i-')) setTimeout(openHash, 200);
})();
