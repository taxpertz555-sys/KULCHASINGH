from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import socket
import threading
import time
import uuid


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", APP_DIR))
DATA_FILE = DATA_DIR / "queue-data.json"
DEFAULT_AVG_MINUTES = 8
DEFAULT_OWNER_PIN = "1234"
lock = threading.Lock()


def now_ms():
    return int(time.time() * 1000)


def default_state():
    return {
        "hotelName": "Hotel Table Queue",
        "averageMinutesPerTable": DEFAULT_AVG_MINUTES,
        "ownerPin": DEFAULT_OWNER_PIN,
        "nextToken": 1,
        "entries": [],
    }


def load_state():
    defaults = default_state()
    if not DATA_FILE.exists():
        return defaults
    try:
        state = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        return {**defaults, **state}
    except json.JSONDecodeError:
        return defaults


def save_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def active_entries(state):
    return [e for e in state["entries"] if e["status"] in {"waiting", "ready"}]


def reset_tokens_if_queue_empty(state):
    if active_entries(state):
        return state
    state["entries"] = []
    state["nextToken"] = 1
    return state


def public_entry(entry, waiting_entries, average=None):
    if entry["status"] == "waiting":
        position = next(
            (idx + 1 for idx, item in enumerate(waiting_entries) if item["id"] == entry["id"]),
            None,
        )
    else:
        position = None
    average = average or load_state().get("averageMinutesPerTable", DEFAULT_AVG_MINUTES)
    return {
        **entry,
        "position": position,
        "estimatedWaitMinutes": (position or 0) * average if position else 0,
        "waitedSeconds": max(0, int((now_ms() - entry["createdAt"]) / 1000)),
    }


def customer_entry(entry, waiting_entries, average):
    public = public_entry(entry, waiting_entries, average)
    return {
        "id": public["id"],
        "token": public["token"],
        "name": public["name"],
        "seats": public["seats"],
        "status": public["status"],
        "position": public["position"],
        "estimatedWaitMinutes": public["estimatedWaitMinutes"],
        "waitedSeconds": public["waitedSeconds"],
    }


def client_urls(port):
    public_url = os.environ.get("PUBLIC_URL", "").rstrip("/")
    if public_url:
        return [public_url]
    hosts = ["localhost", "127.0.0.1"]
    try:
        name = socket.gethostname()
        for addr in socket.gethostbyname_ex(name)[2]:
            if addr and not addr.startswith("127.") and addr not in hosts:
                hosts.append(addr)
    except OSError:
        pass
    return [f"http://{host}:{port}" for host in hosts]


class QueueHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def is_owner(self, state):
        return self.headers.get("X-Owner-Pin", "") == str(state.get("ownerPin", DEFAULT_OWNER_PIN))

    def require_owner(self, state):
        if self.is_owner(state):
            return True
        self.send_json({"error": "Owner PIN required"}, 401)
        return False

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/public":
            with lock:
                state = load_state()
                self.send_json(
                    {
                        "hotelName": state["hotelName"],
                        "averageMinutesPerTable": state["averageMinutesPerTable"],
                        "serverTime": now_ms(),
                    }
                )
            return
        if parsed.path == "/api/owner/state":
            with lock:
                state = load_state()
                if not self.require_owner(state):
                    return
                before = json.dumps(state, sort_keys=True)
                reset_tokens_if_queue_empty(state)
                if json.dumps(state, sort_keys=True) != before:
                    save_state(state)
                waiting = [e for e in state["entries"] if e["status"] == "waiting"]
                entries = [public_entry(e, waiting, state["averageMinutesPerTable"]) for e in state["entries"]]
                owner_state = {k: v for k, v in state.items() if k != "ownerPin"}
                self.send_json({**owner_state, "entries": entries, "serverTime": now_ms()})
            return
        if parsed.path.startswith("/api/customer/"):
            customer_id = parsed.path.rsplit("/", 1)[-1]
            with lock:
                state = load_state()
                waiting = [e for e in state["entries"] if e["status"] == "waiting"]
                entry = next((e for e in state["entries"] if e["id"] == customer_id), None)
                if not entry:
                    self.send_json({"error": "Customer not found"}, 404)
                    return
                self.send_json(customer_entry(entry, waiting, state["averageMinutesPerTable"]))
            return
        if parsed.path == "/api/config":
            port = self.server.server_address[1]
            self.send_json({"urls": client_urls(port)})
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/join":
            try:
                payload = self.read_json()
            except json.JSONDecodeError:
                self.send_json({"error": "Invalid JSON"}, 400)
                return
            name = str(payload.get("name", "")).strip()
            phone = "".join(ch for ch in str(payload.get("phone", "")) if ch.isdigit() or ch == "+")
            seats = int(payload.get("seats") or 0)
            if len(name) < 2 or len(phone) < 8 or seats < 1:
                self.send_json({"error": "Please enter a valid name, phone number, and seats."}, 400)
                return
            with lock:
                state = load_state()
                state = reset_tokens_if_queue_empty(state)
                entry = {
                    "id": uuid.uuid4().hex,
                    "token": state["nextToken"],
                    "name": name,
                    "phone": phone,
                    "seats": seats,
                    "status": "waiting",
                    "createdAt": now_ms(),
                    "readyAt": None,
                }
                state["nextToken"] += 1
                state["entries"].append(entry)
                save_state(state)
                waiting = [e for e in state["entries"] if e["status"] == "waiting"]
                self.send_json(customer_entry(entry, waiting, state["averageMinutesPerTable"]), 201)
            return
        if parsed.path.startswith("/api/status/"):
            customer_id = parsed.path.rsplit("/", 1)[-1]
            try:
                payload = self.read_json()
            except json.JSONDecodeError:
                self.send_json({"error": "Invalid JSON"}, 400)
                return
            next_status = payload.get("status")
            if next_status not in {"ready", "seated", "cancelled"}:
                self.send_json({"error": "Unsupported status"}, 400)
                return
            with lock:
                state = load_state()
                if not self.require_owner(state):
                    return
                entry = next((e for e in state["entries"] if e["id"] == customer_id), None)
                if not entry:
                    self.send_json({"error": "Customer not found"}, 404)
                    return
                entry["status"] = next_status
                if next_status == "ready":
                    entry["readyAt"] = now_ms()
                reset_tokens_if_queue_empty(state)
                save_state(state)
                waiting = [e for e in state["entries"] if e["status"] == "waiting"]
                self.send_json(public_entry(entry, waiting, state["averageMinutesPerTable"]))
            return
        if parsed.path == "/api/clear":
            with lock:
                state = load_state()
                if not self.require_owner(state):
                    return
                state["entries"] = []
                state["nextToken"] = 1
                save_state(state)
                self.send_json({"ok": True, "nextToken": 1, "entries": []})
            return
        if parsed.path == "/api/settings":
            payload = self.read_json()
            with lock:
                state = load_state()
                if not self.require_owner(state):
                    return
                hotel_name = str(payload.get("hotelName", state["hotelName"])).strip()
                average = int(payload.get("averageMinutesPerTable") or DEFAULT_AVG_MINUTES)
                state["hotelName"] = hotel_name[:80] or "Hotel Table Queue"
                state["averageMinutesPerTable"] = max(1, min(60, average))
                new_pin = str(payload.get("ownerPin", "")).strip()
                if new_pin:
                    state["ownerPin"] = new_pin[:24]
                save_state(state)
                owner_state = {k: v for k, v in state.items() if k != "ownerPin"}
                self.send_json(owner_state)
            return
        if parsed.path == "/api/reset":
            with lock:
                state = load_state()
                if not self.require_owner(state):
                    return
                save_state(default_state())
                self.send_json({"ok": True})
            return
        self.send_json({"error": "Not found"}, 404)


def main():
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("0.0.0.0", port), QueueHandler)
    print(f"Hotel queue app running:")
    for url in client_urls(port):
        print(f"  Owner:    {url}/#owner")
        print(f"  Customer: {url}/#customer")
    server.serve_forever()


if __name__ == "__main__":
    main()
