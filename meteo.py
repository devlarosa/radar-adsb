"""Radiosonda virtual: perfil de temperatura y viento a partir de los propios aviones.

En Europa los aviones responden a los radares con datos de vuelo (rumbo, velocidad verdadera,
Mach…). Con ellos readsb calcula el viento (wd/ws) y la temperatura exterior (oat) a la altitud de
cada avión. Aquí se acumulan esas observaciones y se resumen por capas de altitud, como un sondeo.
"""
import json
import math
import time
from collections import deque
from statistics import median
from threading import Lock

CAPA_FT = 1000
TECHO_FT = 45000
VENTANA_S = 3600  # el perfil usa la última hora
CONSERVAR_S = 3 * 3600
INTERVALO_AVION_S = 30  # una observación por avión cada medio minuto, para no sobrerrepresentar a ninguno
ALABEO_MAX = 4  # en viraje el cálculo del viento es poco fiable
DESVIO_ISA_MAX = 30
JET_KT = 60  # umbral habitual de corriente en chorro (≈ 30 m/s)


def numero(valor):
    return valor if isinstance(valor, (int, float)) and math.isfinite(valor) else None


def temperatura_isa(altitud_ft):
    return max(15 - 1.98 * altitud_ft / 1000, -56.5)


class Meteo:
    def __init__(self, fichero):
        self.fichero = fichero
        self.cerrojo = Lock()
        self.observaciones = deque()  # (t, hex, altitud_ft, temperatura | None, direccion | None, velocidad | None)
        self.ultima_por_avion = {}
        self.cambios = False
        self.cargar()

    def cargar(self):
        try:
            guardado = json.loads(self.fichero.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            print(f"Meteo: no se puede leer {self.fichero} ({error}); se empieza de cero", flush=True)
            return
        limite = time.time() - CONSERVAR_S
        self.observaciones.extend(tuple(o) for o in guardado.get("observaciones", []) if o[0] >= limite)

    def guardar(self):
        with self.cerrojo:
            if not self.cambios:
                return
            datos = {"observaciones": list(self.observaciones)}
            self.cambios = False
        self.fichero.parent.mkdir(parents=True, exist_ok=True)
        temporal = self.fichero.with_suffix(".tmp")
        temporal.write_text(json.dumps(datos, separators=(",", ":")), encoding="utf-8")
        temporal.replace(self.fichero)

    def ingerir(self, datos):
        ahora = numero(datos.get("now"))
        if ahora is None:
            return
        with self.cerrojo:
            for avion in datos.get("aircraft", []):
                observacion = self.observar(avion, ahora)
                if observacion:
                    self.observaciones.append(observacion)
                    self.ultima_por_avion[observacion[1]] = ahora
                    self.cambios = True
            while self.observaciones and self.observaciones[0][0] < ahora - CONSERVAR_S:
                self.observaciones.popleft()
            self.ultima_por_avion = {h: t for h, t in self.ultima_por_avion.items() if ahora - t < INTERVALO_AVION_S}

    def observar(self, avion, ahora):
        hex_ = avion.get("hex")
        altitud = numero(avion.get("alt_baro"))  # altitud de presión: es la que corresponde a un nivel meteorológico
        if not hex_ or altitud is None or altitud < 0 or altitud > TECHO_FT:
            return None
        if (numero(avion.get("seen")) or 0) > 2 or hex_ in self.ultima_por_avion:
            return None

        temperatura = numero(avion.get("oat"))
        # Las desviaciones reales respecto a la atmósfera estándar rara vez pasan de 25 °C.
        if temperatura is not None and abs(temperatura - temperatura_isa(altitud)) > DESVIO_ISA_MAX:
            temperatura = None

        direccion, velocidad = numero(avion.get("wd")), numero(avion.get("ws"))
        alabeo = numero(avion.get("roll"))
        if direccion is None or velocidad is None or velocidad > 250 or (alabeo is not None and abs(alabeo) > ALABEO_MAX):
            direccion = velocidad = None

        if temperatura is None and velocidad is None:
            return None
        return (round(ahora, 1), hex_, int(altitud), temperatura, direccion, velocidad)

    def resumen(self):
        with self.cerrojo:
            ahora = time.time()
            recientes = [o for o in self.observaciones if o[0] >= ahora - VENTANA_S]

        capas = {}
        for _, hex_, altitud, temperatura, direccion, velocidad in recientes:
            capa = capas.setdefault(int(altitud // CAPA_FT), {"t": [], "u": [], "v": [], "aviones": set()})
            capa["aviones"].add(hex_)
            if temperatura is not None:
                capa["t"].append(temperatura)
            if velocidad is not None:
                # Componentes hacia donde sopla; la dirección meteorológica es de dónde viene.
                capa["u"].append(-velocidad * math.sin(math.radians(direccion)))
                capa["v"].append(-velocidad * math.cos(math.radians(direccion)))

        perfil = []
        for indice in sorted(capas):
            capa = capas[indice]
            altitud = indice * CAPA_FT + CAPA_FT // 2
            fila = {"alt": altitud, "aviones": len(capa["aviones"]), "isa": round(temperatura_isa(altitud), 1)}
            if capa["t"]:
                fila["t"] = round(median(capa["t"]), 1)
                fila["nt"] = len(capa["t"])
            if capa["u"]:
                u, v = median(capa["u"]), median(capa["v"])
                fila["ws"] = round(math.hypot(u, v))
                fila["wd"] = round(math.degrees(math.atan2(-u, -v)) % 360)
                fila["nw"] = len(capa["u"])
            perfil.append(fila)

        return {
            "capa": CAPA_FT,
            "ventana": VENTANA_S,
            "observaciones": [
                {"alt": o[2], "t": o[3]} for o in recientes if o[3] is not None
            ],
            "aviones": len({o[1] for o in recientes}),
            "perfil": perfil,
            "isoterma0": isoterma_cero(perfil),
            "tropopausa": tropopausa(perfil),
            "inversiones": inversiones(perfil),
            "vientoMax": viento_maximo(perfil),
        }


def con_temperatura(perfil):
    return [(c["alt"], c["t"]) for c in perfil if "t" in c]


def isoterma_cero(perfil):
    puntos = con_temperatura(perfil)
    for (h0, t0), (h1, t1) in zip(puntos, puntos[1:]):
        if t0 >= 0 > t1:
            return round(h0 + (h1 - h0) * t0 / (t0 - t1), -2)
    if puntos and puntos[0][1] < 0:
        return {"debajo": puntos[0][0]}  # ya bajo cero en la capa más baja observada
    return None


def tropopausa(perfil):
    """Definición de la OMM: el nivel más bajo, por encima de 500 hPa, donde el gradiente baja de
    2 °C/km y se mantiene así de media en los 2 km siguientes."""
    puntos = [(h, t) for h, t in con_temperatura(perfil) if h >= 18000]
    km = 0.0003048
    for i, (h0, t0) in enumerate(puntos):
        encima = [(h, t) for h, t in puntos[i + 1:] if h - h0 <= 2 / km]
        if len(encima) < 2 or encima[-1][0] - h0 < 1.5 / km:
            continue  # sin datos suficientes por encima para decidir
        h1, t1 = encima[0]
        if (t0 - t1) / ((h1 - h0) * km) > 2:
            continue
        if all((t0 - t) / ((h - h0) * km) <= 2 for h, t in encima):
            return h0
    return None


def inversiones(perfil):
    """Capas donde la temperatura sube con la altura (al menos 1 °C), por debajo de FL250."""
    puntos = [(h, t) for h, t in con_temperatura(perfil) if h <= 25000]
    resultado = []
    for (h0, t0), (h1, t1) in zip(puntos, puntos[1:]):
        if h1 - h0 > 3000 or t1 <= t0:
            continue
        if resultado and resultado[-1]["techo"] == h0:
            tramo = resultado[-1]
            tramo["techo"], tramo["salto"] = h1, round(tramo["salto"] + t1 - t0, 1)
        else:
            resultado.append({"base": h0, "techo": h1, "salto": round(t1 - t0, 1)})
    return [r for r in resultado if r["salto"] >= 1]


def viento_maximo(perfil):
    # Una capa con un solo avión puede ser un mal dato: se prefieren las que tienen al menos dos.
    candidatas = [c for c in perfil if c.get("nw", 0) >= 2] or [c for c in perfil if "ws" in c]
    if not candidatas:
        return None
    capa = max(candidatas, key=lambda c: c["ws"])
    return {"alt": capa["alt"], "wd": capa["wd"], "ws": capa["ws"], "chorro": capa["ws"] >= JET_KT}
