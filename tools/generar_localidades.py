#!/usr/bin/env python3
"""Genera public/localidades.json a partir de un fichero de GeoNames.

Fuente: https://download.geonames.org/export/dump/cities1000.zip (CC BY 4.0, geonames.org)
Uso: python3 tools/generar_localidades.py cities1000.zip [--lat LAT --lon LON]
(sin --lat/--lon usa la posición de config.local.json)
"""
import argparse
import csv
import io
import json
import math
import zipfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "public" / "localidades.json"
CONFIG_LOCAL = RAIZ / "config.local.json"
POSICION_GENERICA = {"lat": 42.5987, "lon": -5.5671}  # centro de León
RADIO_NM = 360  # cubre las esquinas de la pantalla con el alcance máximo (250 NM)
CODIGOS_EXCLUIDOS = {"PPLX", "PPLH", "PPLQ", "PPLW"}  # barrios y lugares históricos o abandonados


def distancia_nm(lat1, lon1, lat2, lon2):
    f1, f2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((f2 - f1) / 2) ** 2 + math.cos(f1) * math.cos(f2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1, math.sqrt(a)))


def posicion_antena():
    try:
        return {**POSICION_GENERICA, **json.loads(CONFIG_LOCAL.read_text(encoding="utf-8"))}
    except FileNotFoundError:
        return POSICION_GENERICA


def main():
    posicion = posicion_antena()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("zip", type=Path)
    parser.add_argument("--lat", type=float, default=posicion["lat"])
    parser.add_argument("--lon", type=float, default=posicion["lon"])
    args = parser.parse_args()

    localidades = []
    with zipfile.ZipFile(args.zip) as archivo, archivo.open("cities1000.txt") as bruto:
        texto = io.TextIOWrapper(bruto, encoding="utf-8", newline="")
        for fila in csv.reader(texto, delimiter="\t", quoting=csv.QUOTE_NONE):
            nombre, lat, lon, clase, codigo, poblacion = fila[1], float(fila[4]), float(fila[5]), fila[6], fila[7], int(fila[14] or 0)
            if clase != "P" or codigo in CODIGOS_EXCLUIDOS or poblacion < 1000:
                continue
            if distancia_nm(args.lat, args.lon, lat, lon) <= RADIO_NM:
                localidades.append([nombre, round(lat, 4), round(lon, 4), poblacion])

    localidades.sort(key=lambda l: -l[3])
    SALIDA.write_text(json.dumps(localidades, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(localidades)} localidades en {SALIDA}")


if __name__ == "__main__":
    main()
