"""Diagrama de cobertura: alcance máximo recibido en cada dirección, por bandas de altitud.

El recolector del servidor le pasa el aircraft.json de readsb cada segundo y aquí se guarda, para
cada sector de PASO grados, la mayor distancia a la que se ha recibido un avión. Se acumula aunque
no haya ningún navegador abierto y se conserva en disco entre reinicios.
"""
import json
import math
import threading
import time

PASO = 2  # grados por sector
SECTORES = 360 // PASO
NM_POR_RADIAN = 3440.065
DISTANCIA_MAX_NM = 400  # más allá es una posición errónea, no recepción real
VELOCIDAD_MAX_KT = 1200  # entre dos posiciones seguidas del mismo avión
SEGUIMIENTO_S = 60  # cuánto se recuerda la última posición de cada avión

# (id, nombre, techo en pies). Los aviones en tierra cuentan como banda baja.
BANDAS = [
    ("baja", "< FL100", 10000),
    ("media", "FL100–250", 25000),
    ("alta", "> FL250", math.inf),
]


def polar(lat0, lon0, lat, lon):
    f1, f2 = math.radians(lat0), math.radians(lat)
    dl = math.radians(lon - lon0)
    a = math.sin((f2 - f1) / 2) ** 2 + math.cos(f1) * math.cos(f2) * math.sin(dl / 2) ** 2
    distancia = 2 * NM_POR_RADIAN * math.asin(min(1, math.sqrt(a)))
    y = math.sin(dl) * math.cos(f2)
    x = math.cos(f1) * math.sin(f2) - math.sin(f1) * math.cos(f2) * math.cos(dl)
    return distancia, math.degrees(math.atan2(y, x)) % 360


def banda(avion):
    altitud = avion.get("alt_baro")
    if altitud == "ground":
        return 0
    if not isinstance(altitud, (int, float)):
        altitud = avion.get("alt_geom")
        if not isinstance(altitud, (int, float)):
            return None
    return next(i for i, (_, _, techo) in enumerate(BANDAS) if altitud < techo)


def recibido_directamente(avion):
    # TIS-B y ADS-R los retransmite una estación de tierra y MLAT es una posición calculada
    # por la red: ninguno dice nada del alcance de esta antena.
    tipo = avion.get("type", "adsb_icao")
    return tipo.startswith("adsb")


class Cobertura:
    def __init__(self, fichero_cobertura, lat, lon):
        self.fichero = fichero_cobertura
        self.lat = lat
        self.lon = lon
        self.cerrojo = threading.Lock()
        self.ultimas = {}  # hex -> (tiempo, lat, lon)
        self.ultimo_now = None
        self.cambios = False
        self.cargar()

    def vacio(self):
        self.desde = time.time()
        self.alcance = [[0.0] * SECTORES for _ in BANDAS]

    def cargar(self):
        self.vacio()
        try:
            guardado = json.loads(self.fichero.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            print(f"Cobertura: no se puede leer {self.fichero} ({error}); se empieza de cero", flush=True)
            return
        # Si cambia la posición de la antena o el tamaño de sector, lo guardado ya no sirve.
        misma_antena = abs(guardado.get("lat", 0) - self.lat) < 1e-4 and abs(guardado.get("lon", 0) - self.lon) < 1e-4
        if not misma_antena or guardado.get("paso") != PASO:
            print("Cobertura: la antena o el sector han cambiado; se empieza de cero", flush=True)
            return
        self.desde = guardado.get("desde", self.desde)
        for i, (id_banda, _, _) in enumerate(BANDAS):
            valores = guardado.get("bandas", {}).get(id_banda)
            if isinstance(valores, list) and len(valores) == SECTORES:
                self.alcance[i] = [float(v) for v in valores]

    def guardar(self):
        with self.cerrojo:
            if not self.cambios:
                return
            datos = {
                "lat": self.lat,
                "lon": self.lon,
                "paso": PASO,
                "desde": self.desde,
                "bandas": {id_banda: list(valores) for (id_banda, _, _), valores in zip(BANDAS, self.alcance)},
            }
            self.cambios = False
        self.fichero.parent.mkdir(parents=True, exist_ok=True)
        temporal = self.fichero.with_suffix(".tmp")
        temporal.write_text(json.dumps(datos, separators=(",", ":")), encoding="utf-8")
        temporal.replace(self.fichero)

    def ingerir(self, datos):
        ahora = datos.get("now")
        if not isinstance(ahora, (int, float)) or ahora == self.ultimo_now:
            return
        self.ultimo_now = ahora

        with self.cerrojo:
            for avion in datos.get("aircraft", []):
                hex_ = avion.get("hex")
                lat, lon = avion.get("lat"), avion.get("lon")
                if not hex_ or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                    continue
                if avion.get("seen_pos", 0) > 2 or not recibido_directamente(avion):
                    continue
                momento = ahora - avion.get("seen_pos", 0)
                anterior = self.ultimas.get(hex_)
                self.ultimas[hex_] = (momento, lat, lon)
                # Una sola posición falsa estropearía un sector para siempre: solo cuenta si
                # cuadra con la anterior del mismo avión.
                if anterior is None or not self.coherente(anterior, momento, lat, lon):
                    continue
                i = banda(avion)
                if i is None:
                    continue
                distancia, demora = polar(self.lat, self.lon, lat, lon)
                if distancia > DISTANCIA_MAX_NM:
                    continue
                sector = int(demora // PASO) % SECTORES
                if distancia > self.alcance[i][sector]:
                    self.alcance[i][sector] = round(distancia, 1)
                    self.cambios = True

            self.ultimas = {h: u for h, u in self.ultimas.items() if ahora - u[0] < SEGUIMIENTO_S}

    @staticmethod
    def coherente(anterior, momento, lat, lon):
        t0, lat0, lon0 = anterior
        intervalo = momento - t0
        if intervalo <= 0 or intervalo > SEGUIMIENTO_S:
            return False
        recorrido, _ = polar(lat0, lon0, lat, lon)
        return recorrido / (intervalo / 3600) <= VELOCIDAD_MAX_KT

    def resumen(self):
        with self.cerrojo:
            return {
                "paso": PASO,
                "desde": self.desde,
                "bandas": [
                    {"id": id_banda, "nombre": nombre, "nm": list(valores)}
                    for (id_banda, nombre, _), valores in zip(BANDAS, self.alcance)
                ],
            }
