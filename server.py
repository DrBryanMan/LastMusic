#!/usr/bin/env python3
"""Локальний сервер Scrobble Deck: роздає статику й підписує запити до Last.fm.

Shared secret ніколи не потрапляє в браузер: він лежить у config.json.
Запуск: python server.py  (порт змінюється через PORT=9000)
"""
import hashlib
import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
CONFIG_PATH = ROOT / "config.json"
LFM_URL = "https://ws.audioscrobbler.com/2.0/"
PUBLIC_FIELDS = ("user", "lfmKey", "ytKey")

lock = threading.Lock()


# ── Конфіг ──────────────────────────────────────────────────────────
def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    try:
        CONFIG_PATH.chmod(0o600)
    except OSError:
        pass


def public_config() -> dict:
    cfg = load_config()
    return {
        **{name: cfg.get(name, "") for name in PUBLIC_FIELDS},
        "hasSecret": bool(cfg.get("lfmSecret")),
        "authorized": bool(cfg.get("sk")),
    }


# ── Last.fm ─────────────────────────────────────────────────────────
def lfm_call(cfg: dict, method: str, params: dict | None = None, *, post: bool = False) -> dict:
    data = {"method": method, "api_key": cfg["lfmKey"], **(params or {})}
    raw = "".join(f"{k}{v}" for k, v in sorted(data.items())) + cfg["lfmSecret"]
    data["api_sig"] = hashlib.md5(raw.encode("utf-8")).hexdigest()
    data["format"] = "json"  # не входить у підпис

    query = urllib.parse.urlencode(data)
    req = urllib.request.Request(LFM_URL, query.encode()) if post \
        else urllib.request.Request(f"{LFM_URL}?{query}")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res)
    except urllib.error.HTTPError as err:
        try:
            return json.load(err)
        except json.JSONDecodeError:
            return {"error": err.code, "message": str(err.reason)}
    except OSError as err:
        return {"error": 0, "message": str(err)}


def has_credentials(cfg: dict) -> bool:
    return bool(cfg.get("lfmKey") and cfg.get("lfmSecret"))


# ── Маршрути (кожен повертає dict; поле "error" = помилка) ──────────
def save_settings(body: dict) -> dict:
    cfg = load_config()
    old_user = cfg.get("user")
    for name in PUBLIC_FIELDS:
        cfg[name] = str(body.get(name, "")).strip()
    if secret := str(body.get("lfmSecret", "")).strip():
        cfg["lfmSecret"] = secret
    if cfg["user"] != old_user:
        cfg.pop("sk", None)  # інший акаунт — потрібна нова авторизація
    save_config(cfg)
    return public_config()


def auth_start(_: dict) -> dict:
    cfg = load_config()
    if not has_credentials(cfg):
        return {"error": "Вкажи API key і Shared secret"}
    res = lfm_call(cfg, "auth.getToken")
    if "token" not in res:
        return {"error": res.get("message", "Last.fm не видав токен")}
    # Зберігаємо токен у config.json — виживає перезапуск сервера
    cfg["pendingToken"] = res["token"]
    save_config(cfg)
    return {"url": f"https://www.last.fm/api/auth/?api_key={cfg['lfmKey']}&token={cfg['pendingToken']}"}


def auth_finish(_: dict) -> dict:
    cfg = load_config()
    token = cfg.get("pendingToken")
    if not token:
        return {"error": "Спершу натисни «Авторизувати»"}
    res = lfm_call(cfg, "auth.getSession", {"token": token})
    if "session" not in res:
        return {"error": res.get("message", "Не вдалося отримати сесію")}
    cfg.pop("pendingToken", None)
    cfg["sk"] = res["session"]["key"]
    cfg["user"] = res["session"]["name"]
    save_config(cfg)
    return public_config()


def signed_write(method: str, fields: tuple[str, ...]):
    def route(body: dict) -> dict:
        cfg = load_config()
        if not (has_credentials(cfg) and cfg.get("sk")):
            return {"error": "Last.fm не авторизовано"}
        params = {name: body[name] for name in fields if body.get(name) not in (None, "")}
        if not {"artist", "track"} <= params.keys():
            return {"error": "Потрібні artist і track"}
        res = lfm_call(cfg, method, {**params, "sk": cfg["sk"]}, post=True)
        return {"error": res.get("message", "Помилка Last.fm")} if "error" in res else {"ok": True}
    return route


ROUTES = {
    "/api/config": save_settings,
    "/api/auth/start": auth_start,
    "/api/auth/finish": auth_finish,
    "/api/nowplaying": signed_write("track.updateNowPlaying", ("artist", "track", "duration")),
    "/api/scrobble": signed_write("track.scrobble", ("artist", "track", "timestamp", "duration")),
    "/api/love": signed_write("track.love", ("artist", "track")),
    "/api/unlove": signed_write("track.unlove", ("artist", "track")),
}


# ── HTTP ────────────────────────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):
    # На Windows реєстр інколи віддає .js як text/plain — ES-модулі тоді не вантажаться
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".css": "text/css", ".html": "text/html"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        clean = self.path.split("?")[0]
        if clean == "/api/config":
            return self.send_json(public_config())
        # SPA fallback: якщо це не файл і не API, віддаємо index.html
        rel_path = clean.lstrip("/")
        if rel_path and not (STATIC / rel_path).exists() and not clean.startswith("/api/"):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        route = ROUTES.get(self.path.split("?")[0])
        if route is None:
            return self.send_json({"error": "Не знайдено"}, 404)
        # Захист від запитів з чужих сайтів до localhost
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlparse(origin).netloc != self.headers.get("Host"):
            return self.send_json({"error": "Заборонений origin"}, 403)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send_json({"error": "Некоректний JSON"}, 400)
        with lock:
            self.send_json(route(body))


def main() -> None:
    port = int(os.environ.get("PORT", 9000))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Scrobble Deck: http://localhost:{port}  (Ctrl+C — зупинити)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nЗупинено")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
