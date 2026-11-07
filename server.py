#!/usr/bin/env python3
"""Sirve la pantalla de radar y los datos en vivo de readsb. Solo usa la biblioteca estándar."""
import argparse
import json
import signal
import socket
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from cobertura import Cobertura
from meteo import Meteo

RAIZ = Path(__file__).resolve().parent
PUBLIC = RAIZ / "public"
CONFIG_LOCAL = RAIZ / "config.local.json"  # no se sube a git: copia config.example.json
POSICION_GENERICA = {"lat": 42.5987, "lon": -5.5671}  # centro de León
GUARDAR_CADA_S = 60


def posicion_antena():
    try:
        return {**POSICION_GENERICA, **json.loads(CONFIG_LOCAL.read_text(encoding="utf-8"))}
    except FileNotFoundError:
        return POSICION_GENERICA


class Recolector:
    """Lee el aircraft.json de readsb cada segundo, se lo pasa a cada consumidor (cobertura,
    meteo…) y los guarda en disco de vez en cuando. Funciona aunque no haya navegadores abiertos."""

    def __init__(self, fichero_datos, consumidores):
        self.fichero_datos = fichero_datos
        self.consumidores = consumidores
        self.parar = threading.Event()

    def bucle(self):
        siguiente_guardado = time.monotonic() + GUARDAR_CADA_S
        while not self.parar.wait(1):
            try:
                datos = json.loads(self.fichero_datos.read_bytes())
            except (OSError, ValueError):
                continue  # readsb parado o escribiendo: se reintenta en el siguiente segundo
            for consumidor in self.consumidores:
                try:
                    consumidor.ingerir(datos)
                except Exception as error:  # un dato raro no debe parar la recogida
                    print(f"{type(consumidor).__name__}: error procesando datos ({error!r})", flush=True)
            if time.monotonic() >= siguiente_guardado:
                self.guardar()
                siguiente_guardado = time.monotonic() + GUARDAR_CADA_S

    def guardar(self):
        for consumidor in self.consumidores:
            try:
                consumidor.guardar()
            except OSError as error:
                print(f"{type(consumidor).__name__}: no se puede guardar ({error})", flush=True)

    def arrancar(self):
        threading.Thread(target=self.bucle, name="recolector", daemon=True).start()

    def detener(self):
        self.parar.set()
        self.guardar()


class RadarHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, data_file, config, cobertura, meteo, **kwargs):
        self.data_file = data_file
        self.config = config
        self.cobertura = cobertura
        self.meteo = meteo
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
        elif path == "/api/cobertura":
            self.send_json(200, json.dumps(self.cobertura.resumen(), separators=(",", ":")).encode())
        elif path == "/api/meteo":
            self.send_json(200, json.dumps(self.meteo.resumen(), separators=(",", ":")).encode())
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


def interrumpir(*_):
    raise KeyboardInterrupt  # systemd para con SIGTERM: así también se guarda la cobertura


def main():
    posicion = posicion_antena()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lat", type=float, default=posicion["lat"], help="latitud de la antena (por defecto, config.local.json)")
    parser.add_argument("--lon", type=float, default=posicion["lon"], help="longitud de la antena (por defecto, config.local.json)")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--bind", default="0.0.0.0", help="usa 127.0.0.1 para limitarlo a esta máquina")
    parser.add_argument("--data", type=Path, default=Path("/run/readsb/aircraft.json"))
    parser.add_argument("--cobertura", type=Path, default=RAIZ / "datos" / "cobertura.json",
                        help="dónde se guarda el diagrama de cobertura (bórralo para empezar de cero)")
    parser.add_argument("--meteo", type=Path, default=RAIZ / "datos" / "meteo.json",
                        help="dónde se guardan las observaciones meteorológicas de las últimas horas")
    args = parser.parse_args()

    config = {"lat": args.lat, "lon": args.lon, "station": socket.gethostname().upper()}
    cobertura = Cobertura(args.cobertura, args.lat, args.lon)
    meteo = Meteo(args.meteo)
    recolector = Recolector(args.data, [cobertura, meteo])
    recolector.arrancar()
    signal.signal(signal.SIGTERM, interrumpir)
    handler = partial(RadarHandler, data_file=args.data, config=config, cobertura=cobertura, meteo=meteo)
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Radar en http://{args.bind}:{args.port}  (datos: {args.data})", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            recolector.detener()


if __name__ == "__main__":
    main()
