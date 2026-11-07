#!/usr/bin/env python3
"""Sirve la pantalla de radar y los datos en vivo de readsb. Solo usa la biblioteca estándar."""
import argparse
import json
import socket
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

RAIZ = Path(__file__).resolve().parent
PUBLIC = RAIZ / "public"
CONFIG_LOCAL = RAIZ / "config.local.json"  # no se sube a git: copia config.example.json
POSICION_GENERICA = {"lat": 42.5987, "lon": -5.5671}  # centro de León


def posicion_antena():
    try:
        return {**POSICION_GENERICA, **json.loads(CONFIG_LOCAL.read_text(encoding="utf-8"))}
    except FileNotFoundError:
        return POSICION_GENERICA


class RadarHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, data_file, config, **kwargs):
        self.data_file = data_file
        self.config = config
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/config":
            self.send_json(200, json.dumps(self.config).encode())
        elif path == "/api/aircraft":
            try:
                self.send_json(200, self.data_file.read_bytes())
            except OSError as error:
                self.send_json(503, json.dumps({"error": str(error)}).encode())
        else:
            super().do_GET()

    def send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def main():
    posicion = posicion_antena()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lat", type=float, default=posicion["lat"], help="latitud de la antena (por defecto, config.local.json)")
    parser.add_argument("--lon", type=float, default=posicion["lon"], help="longitud de la antena (por defecto, config.local.json)")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--bind", default="0.0.0.0", help="usa 127.0.0.1 para limitarlo a esta máquina")
    parser.add_argument("--data", type=Path, default=Path("/run/readsb/aircraft.json"))
    args = parser.parse_args()

    config = {"lat": args.lat, "lon": args.lon, "station": socket.gethostname().upper()}
    handler = partial(RadarHandler, data_file=args.data, config=config)
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Radar en http://{args.bind}:{args.port}  (datos: {args.data})", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
