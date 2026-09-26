"""Cloud mirror (Supabase) for everything the rig saves — offline-first.

The Pi's local files stay the working copy (a venue often has no internet). Every save goes to disk first,
then into an outbox; whenever the master can reach Supabase the outbox is flushed and newer rows are
pulled back, last-write-wins on `updated_at`. Deletes are soft (`deleted=true`) so they propagate too.

Table: public.studio_fractal_docs (rig, kind, name, data jsonb, deleted, updated_at) — see the migration in
CLAUDE.md. Kinds: show · preset_bank · cue_stack · led_config · mapping · config.
Shows and LED configs are shared across rigs (rig='*'); preset bank / cues / mappings / config are per rig
(rig = this master's hostname, or config "rig_id").

No SDK: plain PostgREST over aiohttp. Config keys (config.json / config.local.json):
    supabase_url, supabase_key (publishable/anon), rig_id, cloud_enabled (default true when url+key present)
"""
import asyncio
import json
import os
import socket
import time
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
OUTBOX = os.path.join(HERE, "cloud_outbox.json")
SYNC_STATE = os.path.join(HERE, "cloud_sync.json")
SHARED_KINDS = ("show", "led_config", "mapping_preset")
TABLE = "studio_fractal_docs"


def _iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts or time.time())) + "Z"


class Cloud:
    def __init__(self, engine, cfg):
        self.e, self.cfg = engine, cfg
        self.url = (cfg.get("supabase_url") or "").rstrip("/")
        self.key = cfg.get("supabase_key") or ""
        self.rig = cfg.get("rig_id") or socket.gethostname()
        self.enabled = bool(cfg.get("cloud_enabled", True)) and bool(self.url and self.key)
        self.online = False
        self.error = ""
        self.last_sync = 0.0
        self.last_try = 0.0
        self.pulled = 0
        self.outbox = self._load(OUTBOX, [])
        self.state = self._load(SYNC_STATE, {"since": "1970-01-01T00:00:00Z"})
        self.handlers = {}          # kind → callable(name, data|None(deleted), updated_at) applying a pulled row locally
        self._lock = asyncio.Lock()
        self._task = None

    # ------------------------------------------------------------ persistence helpers
    @staticmethod
    def _load(path, default):
        try:
            return json.load(open(path))
        except Exception:
            return default

    def _save_outbox(self):
        try:
            json.dump(self.outbox, open(OUTBOX, "w"))
        except Exception:
            pass

    def _save_state(self):
        try:
            json.dump(self.state, open(SYNC_STATE, "w"))
        except Exception:
            pass

    def rig_for(self, kind):
        return "*" if kind in SHARED_KINDS else self.rig

    # ------------------------------------------------------------ public API used by the rest of the master
    def configure(self, url=None, key=None, rig_id=None, enabled=None):
        if url is not None: self.url = url.rstrip("/"); self.cfg["supabase_url"] = self.url
        if key is not None: self.key = key; self.cfg["supabase_key"] = key
        if rig_id: self.rig = rig_id; self.cfg["rig_id"] = rig_id
        if enabled is not None: self.cfg["cloud_enabled"] = bool(enabled)
        self.enabled = bool(self.cfg.get("cloud_enabled", True)) and bool(self.url and self.key)
        self.error = ""
        self.kick()

    def put(self, kind, name, data):
        """Queue an upsert (called right after the local file was written)."""
        if not name:
            return
        self.outbox = [o for o in self.outbox if not (o["kind"] == kind and o["name"] == name)]
        self.outbox.append(dict(kind=kind, name=str(name), data=data, deleted=False, updated_at=_iso()))
        self._save_outbox()
        self.kick()

    def delete(self, kind, name):
        self.outbox = [o for o in self.outbox if not (o["kind"] == kind and o["name"] == name)]
        self.outbox.append(dict(kind=kind, name=str(name), data={}, deleted=True, updated_at=_iso()))
        self._save_outbox()
        self.kick()

    def on(self, kind, handler):
        self.handlers[kind] = handler

    def status(self):
        return dict(enabled=self.enabled, configured=bool(self.url and self.key), online=self.online, pending=len(self.outbox),
                    last_sync=self.last_sync, error=self.error, rig=self.rig, url=self.url, pulled=self.pulled,
                    key_hint=(self.key[:14] + "…") if self.key else "")

    def kick(self):
        """Ask the sync loop to run soon."""
        self._wake = True

    # ------------------------------------------------------------ HTTP
    def _headers(self):
        return {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", "Prefer": "return=minimal"}

    async def _req(self, method, path, **kw):
        import aiohttp
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12)) as s:
            async with s.request(method, self.url + "/rest/v1/" + path, headers=self._headers(), **kw) as r:
                txt = await r.text()
                if r.status >= 300:
                    raise RuntimeError(f"HTTP {r.status}: {txt[:160]}")
                return json.loads(txt) if txt.strip() else None

    async def push_all(self):
        """Flush the outbox (oldest first). Stops at the first network failure."""
        while self.outbox:
            o = self.outbox[0]
            row = dict(rig=self.rig_for(o["kind"]), kind=o["kind"], name=o["name"], data=o["data"], deleted=o["deleted"], updated_at=o["updated_at"])
            await self._upsert(row)
            self.outbox.pop(0)
            self._save_outbox()

    async def _upsert(self, row):
        import aiohttp
        h = self._headers(); h["Prefer"] = "resolution=merge-duplicates,return=minimal"
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12)) as s:
            async with s.post(self.url + f"/rest/v1/{TABLE}?on_conflict=rig,kind,name", headers=h, data=json.dumps([row])) as r:
                if r.status >= 300:
                    raise RuntimeError(f"HTTP {r.status}: {(await r.text())[:160]}")

    async def pull(self, full=False):
        """Fetch rows newer than the last sync (or everything) and hand them to the kind handlers."""
        since = "1970-01-01T00:00:00Z" if full else self.state.get("since", "1970-01-01T00:00:00Z")
        rows = await self._req("GET", f"{TABLE}?select=rig,kind,name,data,deleted,updated_at&updated_at=gt.{quote(since, safe='')}&or=(rig.eq.{quote(self.rig, safe='')},rig.eq.*)&order=updated_at.asc&limit=1000")
        newest = since
        n = 0
        for r in rows or []:
            h = self.handlers.get(r["kind"])
            if h:
                try:
                    if h(r["name"], None if r.get("deleted") else r.get("data"), r["updated_at"]):
                        n += 1
                except Exception as ex:
                    self.e.event(f"cloud: apply {r['kind']}/{r['name']} failed: {ex}")
            if r["updated_at"] > newest:
                newest = r["updated_at"]
        self.state["since"] = newest
        self._save_state()
        self.pulled += n
        return n

    async def list_kind(self, kind):
        """Names available in the cloud for a kind (for menus) — live query, [] when offline."""
        try:
            rows = await self._req("GET", f"{TABLE}?select=name,updated_at,rig&kind=eq.{quote(kind, safe='')}&deleted=eq.false&or=(rig.eq.{quote(self.rig, safe='')},rig.eq.*)&order=name.asc")
            return rows or []
        except Exception:
            return []

    async def fetch(self, kind, name):
        rows = await self._req("GET", f"{TABLE}?select=data,updated_at&kind=eq.{quote(kind, safe='')}&name=eq.{quote(name, safe='')}&deleted=eq.false&or=(rig.eq.{quote(self.rig, safe='')},rig.eq.*)&limit=1")
        return rows[0] if rows else None

    # ------------------------------------------------------------ loop
    async def sync_once(self, full=False):
        if not self.enabled:
            return False
        async with self._lock:
            self.last_try = time.time()
            try:
                await self.push_all()
                n = await self.pull(full)
                if not self.online:
                    self.e.event(f"cloud: online ({self.url.split('//')[-1]}) · rig '{self.rig}'" + (f" · pulled {n}" if n else ""))
                self.online = True
                self.error = ""
                self.last_sync = time.time()
                return True
            except Exception as ex:
                if self.online or not self.error:
                    self.e.event(f"cloud: offline — {str(ex)[:90]} (keeping {len(self.outbox)} change{'s' if len(self.outbox) != 1 else ''} queued)")
                self.online = False
                self.error = str(ex)[:160]
                return False

    async def loop(self):
        self._wake = True
        n = 0
        while True:
            try:
                if self.enabled and (self._wake or n % (6 if self.online else 30) == 0):
                    self._wake = False
                    await self.sync_once()
            except Exception as ex:
                self.error = str(ex)[:160]
            n += 1
            await asyncio.sleep(5)
