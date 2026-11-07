"use strict";

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const NM_POR_RADIAN = 3440.065;

const MAX_ECOS = 6;
const ALFA_MIN_ULTIMO_ECO = 0.45;
const POSICION_CADUCA_S = 30;
const DATOS_PARADOS_MS = 15000;
const SONDEO_MS = 1000;
const CALENTAMIENTO_MS = 1100;
const TEMA_INICIAL = "1962";

// umbral: población mínima para mostrar una localidad con ese alcance.
const ALCANCES = [
  { nm: 25, anillo: 5, umbral: 0 },
  { nm: 50, anillo: 10, umbral: 1500 },
  { nm: 100, anillo: 25, umbral: 6000 },
  { nm: 150, anillo: 25, umbral: 15000 },
  { nm: 250, anillo: 50, umbral: 40000 },
];

const AEROPUERTOS = [
  ["LELN", 42.589, -5.6556], ["LEAS", 43.5635, -6.0346], ["LEVD", 41.7061, -4.8519],
  ["LESA", 40.9521, -5.502], ["LEBG", 42.3576, -3.6207], ["LEXJ", 43.4271, -3.82],
  ["LEBB", 43.3011, -2.9106], ["LEVT", 42.8828, -2.7245], ["LEMD", 40.4722, -3.5609],
  ["LEST", 42.8963, -8.4151], ["LECO", 43.3021, -8.3773], ["LEVX", 42.2318, -8.6268],
  ["LPPR", 41.2481, -8.6814],
];

const FUENTES = {
  adsb_icao: "ADS-B", adsb_icao_nt: "ADS-B", adsb_other: "ADS-B", adsr_icao: "ADS-R", adsr_other: "ADS-R",
  tisb_icao: "TIS-B", tisb_trackfile: "TIS-B", tisb_other: "TIS-B", mlat: "MLAT", mode_s: "MODO S",
};

const SQUAWKS = { 7500: "7500 SECUESTRO", 7600: "7600 RADIO", 7700: "7700 EMERGENCIA" };
const PUNTOS_CARDINALES = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

const lienzo = document.getElementById("radar");
const ctx = lienzo.getContext("2d");
const pantalla = document.getElementById("pantalla");
const dom = Object.fromEntries(
  ["aviso", "estacion", "utc", "enlace", "blancos", "mensajes", "maximo", "exploracion", "alcances", "etiquetas",
    "localidades", "epocas", "epoca-info", "placa-tubo", "leyenda", "leyenda-barra", "sin-ficha", "ficha", "lista",
    "sin-trafico"].map((id) => [id, document.getElementById(id)]),
);

const movimientoReducido = matchMedia("(prefers-reduced-motion: reduce)").matches;

const estado = {
  lat: null,
  lon: null,
  blancos: new Map(),
  seleccion: null,
  alcance: leerAjuste("radar.alcance", 100),
  etiquetas: leerAjuste("radar.etiquetas", true),
  verLocalidades: leerAjuste("radar.localidades", true),
  localidades: [],
  angulo: 0,
  pulso: 0,
  encendido: 0,
  ultimoFrame: null,
  ultimoNow: null,
  ultimoCambio: performance.now(),
  ultimosMensajes: null,
  maximo: 0,
};

let tema = TEMAS.find((t) => t.id === leerAjuste("radar.tema", TEMA_INICIAL)) || TEMAS.find((t) => t.id === TEMA_INICIAL);

const geo = { tam: 0, r: 0, cx: 0, cy: 0, dpr: 1, fondo: null, cristal: null, reflejoBloom: null, patronGrano: null };

function leerAjuste(clave, porDefecto) {
  try {
    return JSON.parse(localStorage.getItem(clave)) ?? porDefecto;
  } catch {
    return porDefecto;
  }
}

function guardarAjuste(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento: el ajuste dura solo esta sesión.
  }
}

function rgba(color, alfa) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alfa})`;
}

function modoActual() {
  return movimientoReducido ? "directo" : tema.modo;
}

/* Geografía */

function polarDesde(lat0, lon0, lat, lon) {
  const f1 = lat0 * RAD;
  const f2 = lat * RAD;
  const dl = (lon - lon0) * RAD;
  const a = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  const distancia = 2 * NM_POR_RADIAN * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return { distancia, demora: (Math.atan2(y, x) + TAU) % TAU };
}

function polar(lat, lon) {
  return polarDesde(estado.lat, estado.lon, lat, lon);
}

function aPantalla(distancia, demora) {
  const r = (distancia / estado.alcance) * geo.r;
  return { x: geo.cx + r * Math.sin(demora), y: geo.cy - r * Math.cos(demora), r };
}

function enPantalla(p) {
  if (tema.forma === "tubo") return p.r <= geo.r;
  return p.x >= 0 && p.x <= geo.tam && p.y >= 0 && p.y <= geo.tam;
}

function trazarContorno(c) {
  c.beginPath();
  if (tema.forma === "tubo") c.arc(geo.cx, geo.cy, geo.r, 0, TAU);
  else c.rect(0, 0, geo.tam, geo.tam);
}

// Localidad más cercana y dónde queda el avión respecto a ella: "Astorga · 4 NM SO".
function referencia(lat, lon) {
  const coseno = Math.cos(lat * RAD);
  let mejor = null;
  let minimo = Infinity;
  for (const l of estado.localidades) {
    const d = (l.lat - lat) ** 2 + ((l.lon - lon) * coseno) ** 2;
    if (d < minimo) {
      minimo = d;
      mejor = l;
    }
  }
  if (!mejor) return "---";
  const { distancia, demora } = polarDesde(mejor.lat, mejor.lon, lat, lon);
  if (distancia < 1) return `Sobre ${mejor.nombre}`;
  const punto = PUNTOS_CARDINALES[Math.round(demora / (TAU / 8)) % 8];
  return `${mejor.nombre} · ${distancia.toFixed(0)} NM ${punto}`;
}

/* Formato de datos */

function vuelo(a) {
  return (a.flight || "").trim() || a.hex.toUpperCase();
}

function nivel(a) {
  if (a.alt_baro === "ground") return "SUELO";
  if (typeof a.alt_baro !== "number") return "---";
  return "FL" + String(Math.round(a.alt_baro / 100)).padStart(3, "0");
}

function tendencia(a) {
  const v = a.baro_rate ?? a.geom_rate;
  if (typeof v !== "number" || Math.abs(v) < 300) return "";
  return v > 0 ? "↑" : "↓";
}

function numero(v, decimales = 0) {
  return typeof v === "number" ? v.toFixed(decimales) : "---";
}

function esEmergencia(a) {
  return a.squawk in SQUAWKS || (a.emergency && a.emergency !== "none");
}

function colorAltitud(a) {
  const { suelo, tramos } = tema.altitud;
  if (typeof a.alt_baro !== "number") return suelo;
  const alt = a.alt_baro;
  if (alt <= tramos[0][0]) return tramos[0][1];
  for (let i = 1; i < tramos.length; i++) {
    const [h1, c1] = tramos[i];
    if (alt <= h1) {
      const [h0, c0] = tramos[i - 1];
      const f = (alt - h0) / (h1 - h0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
    }
  }
  return tramos[tramos.length - 1][1];
}

function colorBlanco(a, emergencia) {
  if (emergencia) return tema.colores.alerta;
  if (tema.altitud && a) return colorAltitud(a);
  return tema.colores.fosforo;
}

/* Datos */

function ingerir(datos) {
  const ahora = performance.now();
  const vistos = new Set();

  for (const a of datos.aircraft || []) {
    if (!a.hex) continue;
    vistos.add(a.hex);
    let b = estado.blancos.get(a.hex);
    if (!b) {
      b = { hex: a.hex, ecos: [], mostrado: null, vivo: true };
      estado.blancos.set(a.hex, b);
    }
    b.datos = a;
    b.vivo = true;
    const tienePosicion = typeof a.lat === "number" && typeof a.lon === "number" && !(a.seen_pos > POSICION_CADUCA_S);
    b.polar = tienePosicion ? polar(a.lat, a.lon) : null;
    if (b.polar) estado.maximo = Math.max(estado.maximo, b.polar.distancia);
    if (modoActual() === "directo" && b.polar) pintarEco(b, ahora);
  }

  for (const [hex, b] of estado.blancos) {
    if (!vistos.has(hex)) {
      b.vivo = false;
      b.polar = null;
      if (b.ecos.length === 0) estado.blancos.delete(hex);
    }
  }

  if (datos.now !== estado.ultimoNow) {
    if (estado.ultimosMensajes && datos.now > estado.ultimoNow) {
      const tasa = (datos.messages - estado.ultimosMensajes) / (datos.now - estado.ultimoNow);
      dom.mensajes.textContent = tasa >= 0 ? tasa.toFixed(0) : "---";
    }
    estado.ultimoNow = datos.now;
    estado.ultimosMensajes = datos.messages;
    estado.ultimoCambio = ahora;
  }

  actualizarEnlace(ahora - estado.ultimoCambio < DATOS_PARADOS_MS ? null : "DATOS DETENIDOS");
  actualizarPanel();
}

function actualizarEnlace(problema) {
  dom.aviso.hidden = !problema;
  dom.aviso.textContent = problema || "";
  dom.enlace.textContent = problema ? "FALLO" : "OK";
  dom.enlace.classList.toggle("mal", Boolean(problema));
}

async function sondear() {
  try {
    const respuesta = await fetch("api/aircraft", { cache: "no-store" });
    if (!respuesta.ok) throw new Error(String(respuesta.status));
    ingerir(await respuesta.json());
  } catch {
    actualizarEnlace("SIN DATOS DEL RECEPTOR");
  } finally {
    setTimeout(sondear, SONDEO_MS);
  }
}

// El radar funciona igual si este fichero falla: solo se queda sin nombres en el mapa.
async function cargarLocalidades() {
  try {
    const respuesta = await fetch("localidades.json");
    if (!respuesta.ok) throw new Error(String(respuesta.status));
    const filas = await respuesta.json();
    estado.localidades = filas.map(([nombre, lat, lon, poblacion]) => ({ nombre, lat, lon, poblacion, polar: polar(lat, lon) }));
    dibujarFondo();
    actualizarFicha();
  } catch (error) {
    console.warn("No se han podido cargar las localidades", error);
  }
}

/* Panel */

const filas = new Map();

function crearFila(hex) {
  const boton = document.createElement("button");
  boton.type = "button";
  boton.className = "fila";
  boton.append(...[0, 1, 2, 3].map(() => document.createElement("span")));
  boton.addEventListener("click", () => seleccionar(estado.seleccion === hex ? null : hex));
  return boton;
}

function actualizarPanel() {
  const vivos = [...estado.blancos.values()].filter((b) => b.vivo);
  vivos.sort((p, q) => {
    if (p.polar && q.polar) return p.polar.distancia - q.polar.distancia;
    if (p.polar || q.polar) return p.polar ? -1 : 1;
    return (q.datos.rssi ?? -99) - (p.datos.rssi ?? -99);
  });

  const conPosicion = vivos.filter((b) => b.polar).length;
  dom.blancos.textContent = `${conPosicion}/${vivos.length}`;
  dom.maximo.textContent = `${estado.maximo.toFixed(0)} NM`;
  dom["sin-trafico"].hidden = vivos.length > 0;

  const orden = vivos.map((b) => {
    const a = b.datos;
    const fila = filas.get(b.hex) || crearFila(b.hex);
    filas.set(b.hex, fila);
    const [c1, c2, c3, c4] = fila.children;
    c1.textContent = vuelo(a);
    c2.textContent = nivel(a) + tendencia(a);
    c3.textContent = numero(a.gs);
    c4.textContent = b.polar
      ? `${b.polar.distancia.toFixed(0)}/${String(Math.round(b.polar.demora / RAD) % 360).padStart(3, "0")}`
      : "SIN POS";
    fila.classList.toggle("sin-posicion", !b.polar);
    fila.classList.toggle("emergencia", Boolean(esEmergencia(a)));
    fila.setAttribute("aria-pressed", String(estado.seleccion === b.hex));
    return fila;
  });

  for (const [hex, fila] of filas) {
    if (!estado.blancos.get(hex)?.vivo) {
      fila.remove();
      filas.delete(hex);
    }
  }

  // Reordenar solo si hace falta: mover una fila le quitaría el foco del teclado.
  if (orden.some((fila, i) => dom.lista.children[i] !== fila)) dom.lista.replaceChildren(...orden);

  actualizarFicha();
}

function actualizarFicha() {
  const b = estado.blancos.get(estado.seleccion);
  const visible = Boolean(b?.vivo);
  dom.ficha.hidden = !visible;
  dom["sin-ficha"].hidden = visible;
  if (!visible) return;

  const a = b.datos;
  const velocidadVertical = a.baro_rate ?? a.geom_rate;
  const campos = [
    ["Vuelo", vuelo(a)],
    ["ICAO", a.hex.toUpperCase()],
    ["Squawk", SQUAWKS[a.squawk] || a.squawk || "---"],
    ["Fuente", FUENTES[a.type] || String(a.type ?? "---").toUpperCase()],
    ["Cerca de", b.polar ? referencia(a.lat, a.lon) : "---", true],
    ["Altitud", typeof a.alt_baro === "number" ? `${a.alt_baro} ft` : nivel(a)],
    ["Vertical", numero(velocidadVertical)],
    ["Nudos", numero(a.gs)],
    ["Rumbo", typeof a.track === "number" ? `${numero(a.track)}°` : "---"],
    ["Distancia", b.polar ? `${b.polar.distancia.toFixed(1)} NM` : "---"],
    ["Demora", b.polar ? `${(b.polar.demora / RAD).toFixed(0)}°` : "---"],
    ["Mach", numero(a.mach, 2)],
    ["Viento", typeof a.wd === "number" ? `${a.wd}°/${numero(a.ws)}` : "---"],
    ["Temp. ext.", typeof a.oat === "number" ? `${a.oat} °C` : "---"],
    ["Señal", typeof a.rssi === "number" ? `${a.rssi.toFixed(1)} dB` : "---"],
    ["Visto", `${numero(a.seen, 0)} s`],
  ];

  dom.ficha.replaceChildren(...campos.map(([rotulo, valor, ancho]) => {
    const grupo = document.createElement("div");
    if (ancho) grupo.className = "ancho";
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = rotulo;
    dd.textContent = valor;
    grupo.append(dt, dd);
    return grupo;
  }));
}

function seleccionar(hex) {
  estado.seleccion = hex;
  for (const [h, fila] of filas) fila.setAttribute("aria-pressed", String(h === hex));
  actualizarFicha();
}

/* Dibujo estático */

function nuevaCapa() {
  const capa = document.createElement("canvas");
  capa.width = lienzo.width;
  capa.height = lienzo.height;
  const c = capa.getContext("2d");
  c.scale(geo.dpr, geo.dpr);
  return [capa, c];
}

function tamFuenteBase() {
  return Math.max(14, Math.min(20, geo.tam / 42));
}

function fuenteMapa(escala = 1) {
  const px = Math.max(11, tamFuenteBase() * tema.fuente.escalaMapa * escala);
  return `${px}px ${tema.fuente.mapa}`;
}

function dibujarCuerpo(c) {
  const { cx, cy, r, tam } = geo;
  const { colores } = tema;
  const fuente = tamFuenteBase();

  if (tema.forma === "panel") {
    c.fillStyle = colores.fondoCentro;
    c.fillRect(0, 0, tam, tam);
    return;
  }

  // Bisel metálico alrededor del tubo.
  const exterior = r + fuente * 2.3;
  const metal = c.createLinearGradient(cx - exterior, cy - exterior, cx + exterior, cy + exterior);
  metal.addColorStop(0, colores.biselLuz);
  metal.addColorStop(0.5, colores.bisel);
  metal.addColorStop(1, colores.biselLuz);
  c.beginPath();
  c.arc(cx, cy, exterior, 0, TAU);
  c.fillStyle = metal;
  c.fill();
  c.beginPath();
  c.arc(cx, cy, exterior - 4, 0, TAU);
  c.fillStyle = colores.bisel;
  c.fill();

  const brillo = c.createRadialGradient(cx, cy, 0, cx, cy, r);
  brillo.addColorStop(0, colores.fondoCentro);
  brillo.addColorStop(1, colores.fondoBorde);
  c.beginPath();
  c.arc(cx, cy, r, 0, TAU);
  c.fillStyle = brillo;
  c.fill();

  if (colores.aro) {
    c.strokeStyle = colores.aro;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(cx, cy, exterior - 3, 0, TAU);
    c.stroke();
  }
}

function dibujarRetícula(c) {
  const { cx, cy, r } = geo;
  const { colores } = tema;
  const fuente = tamFuenteBase();
  const { anillo } = ALCANCES.find((a) => a.nm === estado.alcance);

  c.save();
  trazarContorno(c);
  c.clip();
  c.lineWidth = 1;

  if (tema.hud) {
    // Rejilla hexagonal para la pantalla futurista.
    const lado = 26;
    const altura = lado * Math.sqrt(3);
    c.strokeStyle = colores.reticulaTenue;
    c.beginPath();
    for (let col = 0; col * lado * 1.5 < geo.tam + lado; col++) {
      for (let fila = -1; fila * altura < geo.tam + altura; fila++) {
        const x = col * lado * 1.5;
        const y = fila * altura + (col % 2 ? altura / 2 : 0);
        c.moveTo(x + lado, y);
        for (let k = 1; k <= 3; k++) c.lineTo(x + lado * Math.cos((k * TAU) / 6), y + lado * Math.sin((k * TAU) / 6));
      }
    }
    c.stroke();
  }

  if (tema.radiales) {
    c.strokeStyle = colores.reticulaTenue;
    for (let g = 0; g < 360; g += 30) {
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + r * Math.sin(g * RAD), cy - r * Math.cos(g * RAD));
      c.stroke();
    }
  }

  const limite = tema.forma === "panel" ? estado.alcance * Math.SQRT2 : estado.alcance;
  c.font = fuenteMapa();
  c.textAlign = "left";
  c.textBaseline = "bottom";
  for (let nm = anillo; nm <= limite; nm += anillo) {
    const radio = (nm / estado.alcance) * r;
    c.strokeStyle = colores.reticula;
    c.beginPath();
    c.arc(cx, cy, radio, 0, TAU);
    c.stroke();
    if (nm < estado.alcance) {
      c.fillStyle = colores.reticula;
      c.fillText(String(nm), cx + radio * Math.SQRT1_2 + 3, cy + radio * Math.SQRT1_2 - 1);
    }
  }
  c.restore();

  // Escala de rumbos.
  c.strokeStyle = colores.rumbos;
  c.fillStyle = colores.rumbos;
  c.lineWidth = 1;
  c.font = `${fuente * Math.min(1, tema.fuente.escalaMapa + 0.1)}px ${tema.fuente.mapa}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (let g = 0; g < 360; g += 5) {
    const s = Math.sin(g * RAD);
    const k = Math.cos(g * RAD);
    const largo = g % 10 === 0 ? 8 : 4;
    c.beginPath();
    c.moveTo(cx + r * s, cy - r * k);
    c.lineTo(cx + (r + largo) * s, cy - (r + largo) * k);
    c.stroke();
    if (g % 30 === 0) {
      const rt = r + 8 + fuente * 0.95;
      c.fillText(String(g).padStart(3, "0"), cx + rt * s, cy - rt * k);
    }
  }
}

function solapa(a, ocupados) {
  return ocupados.some((o) => a.x < o.x + o.ancho && o.x < a.x + a.ancho && a.y < o.y + o.alto && o.y < a.y + a.alto);
}

// Coloca el rótulo a un lado u otro del punto; si no cabe en ninguno, la localidad no se dibuja.
function colocarRotulo(c, x, y, texto, ocupados) {
  const ancho = c.measureText(texto).width;
  const alto = parseFloat(c.font) * 1.1;
  const opciones = [x + 5, x - 5 - ancho].map((xt) => ({ x: xt, y: y - alto / 2, ancho, alto }));
  const cabe = (o) => {
    if (tema.forma === "panel") return o.x >= 0 && o.x + ancho <= geo.tam;
    return Math.hypot(o.x - geo.cx, y - geo.cy) < geo.r && Math.hypot(o.x + ancho - geo.cx, y - geo.cy) < geo.r;
  };
  const sitio = opciones.find((o) => cabe(o) && !solapa(o, ocupados));
  if (!sitio) return false;
  ocupados.push(sitio);
  c.fillText(texto, sitio.x, y);
  return true;
}

function dibujarMapa(c) {
  c.save();
  trazarContorno(c);
  c.clip();
  c.fillStyle = tema.colores.mapa;
  c.strokeStyle = tema.colores.mapa;
  c.lineWidth = 1;
  c.textAlign = "left";
  c.textBaseline = "middle";

  // La antena reserva su sitio para que ningún nombre quede encima.
  const ocupados = [{ x: geo.cx - 8, y: geo.cy - 8, ancho: 16, alto: 16 }];

  // Tampoco sobre las distancias de los anillos ni, en los monitores, sobre la escala de rumbos.
  const { anillo } = ALCANCES.find((a) => a.nm === estado.alcance);
  for (let nm = anillo; nm < estado.alcance; nm += anillo) {
    const radio = (nm / estado.alcance) * geo.r;
    ocupados.push({ x: geo.cx + radio * Math.SQRT1_2, y: geo.cy + radio * Math.SQRT1_2 - 18, ancho: 26, alto: 18 });
  }
  if (tema.forma === "panel") {
    const rt = geo.r + 8 + tamFuenteBase() * 0.95;
    for (let g = 0; g < 360; g += 30) {
      ocupados.push({ x: geo.cx + rt * Math.sin(g * RAD) - 20, y: geo.cy - rt * Math.cos(g * RAD) - 11, ancho: 40, alto: 22 });
    }
  }

  // Los aeropuertos van primero: son la referencia principal.
  c.font = fuenteMapa(0.9);
  for (const [codigo, lat, lon] of AEROPUERTOS) {
    const p = polar(lat, lon);
    const { x, y, r } = aPantalla(p.distancia, p.demora);
    if (!enPantalla({ x, y, r })) continue;
    c.beginPath();
    c.moveTo(x - 4, y);
    c.lineTo(x + 4, y);
    c.moveTo(x, y - 4);
    c.lineTo(x, y + 4);
    c.stroke();
    colocarRotulo(c, x, y, codigo, ocupados);
  }

  if (estado.verLocalidades) {
    const { umbral } = ALCANCES.find((a) => a.nm === estado.alcance);
    // Vienen ordenadas por población: las grandes eligen sitio antes.
    for (const l of estado.localidades) {
      if (l.poblacion < umbral) break;
      const { x, y, r } = aPantalla(l.polar.distancia, l.polar.demora);
      if (!enPantalla({ x, y, r })) continue;
      const grande = l.poblacion >= 100000;
      const media = l.poblacion >= 20000;
      c.font = fuenteMapa(grande ? 1.15 : media ? 1 : 0.88);
      const texto = grande ? l.nombre.toUpperCase() : l.nombre;
      c.globalAlpha = grande ? 1 : media ? 0.9 : 0.72;
      if (colocarRotulo(c, x, y, texto, ocupados)) {
        c.beginPath();
        c.arc(x, y, grande ? 3 : media ? 2.2 : 1.5, 0, TAU);
        c.fill();
      }
      c.globalAlpha = 1;
    }
  }
  c.restore();
}

function dibujarFondo() {
  if (estado.lat === null || geo.tam === 0) return;
  const [capa, c] = nuevaCapa();
  dibujarCuerpo(c);
  dibujarRetícula(c);
  dibujarMapa(c);

  c.strokeStyle = tema.colores.rumbos;
  c.lineWidth = 1;
  c.beginPath();
  c.arc(geo.cx, geo.cy, 3, 0, TAU);
  c.stroke();

  geo.fondo = capa;
}

function dibujarCristal() {
  const { cx, cy, r, tam } = geo;
  const { lineas, vineta, reflejo } = tema.efectos;
  const [capa, c] = nuevaCapa();
  trazarContorno(c);
  c.clip();

  if (lineas) {
    c.fillStyle = `rgba(0, 0, 0, ${lineas})`;
    for (let y = 0; y < tam; y += 3) c.fillRect(0, y, tam, 1);
  }
  if (vineta) {
    const sombra = c.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    sombra.addColorStop(0, "rgba(0, 0, 0, 0)");
    sombra.addColorStop(1, `rgba(0, 0, 0, ${vineta})`);
    c.fillStyle = sombra;
    c.fillRect(0, 0, tam, tam);
  }
  if (reflejo) {
    // Reflejo del cristal abombado, arriba a la izquierda.
    c.save();
    c.translate(cx - r * 0.42, cy - r * 0.5);
    c.rotate(-0.6);
    c.scale(1, 0.42);
    const luz = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.62);
    luz.addColorStop(0, `rgba(255, 255, 240, ${reflejo})`);
    luz.addColorStop(1, "rgba(255, 255, 240, 0)");
    c.fillStyle = luz;
    c.fillRect(-r, -r, r * 2, r * 2);
    c.restore();
  }
  geo.cristal = capa;
}

function crearGrano() {
  const lado = 160;
  const capa = document.createElement("canvas");
  capa.width = lado;
  capa.height = lado;
  const c = capa.getContext("2d");
  const imagen = c.createImageData(lado, lado);
  for (let i = 0; i < imagen.data.length; i += 4) {
    const v = Math.random() * 255;
    imagen.data[i] = v;
    imagen.data[i + 1] = v;
    imagen.data[i + 2] = v;
    imagen.data[i + 3] = 255;
  }
  c.putImageData(imagen, 0, 0);
  geo.patronGrano = ctx.createPattern(capa, "repeat");
}

function ajustarTamano() {
  const cuadro = pantalla.getBoundingClientRect();
  const estilo = getComputedStyle(pantalla);
  const ancho = cuadro.width - parseFloat(estilo.paddingLeft) - parseFloat(estilo.paddingRight);
  const alto = cuadro.height - parseFloat(estilo.paddingTop) - parseFloat(estilo.paddingBottom);
  const tam = Math.max(240, Math.floor(Math.min(ancho, alto)));
  geo.tam = tam;
  geo.dpr = window.devicePixelRatio || 1;
  geo.cx = tam / 2;
  geo.cy = tam / 2;
  geo.r = tam / 2 - tamFuenteBase() * 2.4;
  lienzo.style.width = `${tam}px`;
  lienzo.style.height = `${tam}px`;
  lienzo.width = Math.round(tam * geo.dpr);
  lienzo.height = Math.round(tam * geo.dpr);
  const capaBloom = document.createElement("canvas");
  capaBloom.width = Math.ceil(tam / 4);
  capaBloom.height = Math.ceil(tam / 4);
  geo.reflejoBloom = capaBloom;
  dibujarFondo();
  dibujarCristal();
}

/* Barrido y ecos */

function pintarEco(b, ahora) {
  const ultimo = b.ecos[b.ecos.length - 1];
  // Sin barrido llegan datos cada segundo: la estela solo guarda un punto cada cierto tiempo.
  if (modoActual() === "directo" && ultimo && ahora - ultimo.creado < (tema.tramoMs ?? 8000)) {
    ultimo.distancia = b.polar.distancia;
    ultimo.demora = b.polar.demora;
    ultimo.t = ahora;
  } else {
    b.ecos.push({ distancia: b.polar.distancia, demora: b.polar.demora, t: ahora, creado: ahora });
    if (b.ecos.length > MAX_ECOS) b.ecos.shift();
  }
  b.mostrado = b.datos;
}

function comprobarDeteccion(ahora) {
  if (estado.ultimoFrame === null) estado.ultimoFrame = ahora;
  const transcurrido = ahora - estado.ultimoFrame;
  estado.ultimoFrame = ahora;
  const modo = modoActual();
  if (modo === "barrido") {
    const delta = Math.min(TAU, (transcurrido / tema.periodoMs) * TAU);
    const desde = estado.angulo;
    estado.angulo = (desde + delta) % TAU;
    for (const b of estado.blancos.values()) {
      if (b.polar && (b.polar.demora - desde + TAU) % TAU <= delta) pintarEco(b, ahora);
    }
  } else if (modo === "pulso") {
    const avance = Math.min(1, transcurrido / tema.periodoMs);
    const desde = estado.pulso;
    const hasta = desde + avance;
    estado.pulso = hasta % 1;
    for (const b of estado.blancos.values()) {
      if (!b.polar) continue;
      const d = Math.min(1, b.polar.distancia / estado.alcance);
      if ((d > desde && d <= hasta) || d <= hasta - 1) pintarEco(b, ahora);
    }
  }
}

function dibujarBarrido() {
  const { cx, cy, r } = geo;
  const { estela: c, estelaAlfa, linea } = tema.colores;
  const theta = estado.angulo - Math.PI / 2;
  const gradiente = ctx.createConicGradient(theta, cx, cy);
  gradiente.addColorStop(0, rgba(c, 0));
  gradiente.addColorStop(0.72, rgba(c, 0));
  gradiente.addColorStop(1, rgba(c, estelaAlfa));
  ctx.fillStyle = gradiente;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  ctx.strokeStyle = linea;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + r * Math.cos(theta), cy + r * Math.sin(theta));
  ctx.stroke();
}

function dibujarPulso() {
  const { cx, cy, r } = geo;
  const { estela: c, estelaAlfa } = tema.colores;
  const radio = Math.max(1, estado.pulso * r);
  const interior = Math.max(0, radio - r * 0.16);
  const onda = ctx.createRadialGradient(cx, cy, interior, cx, cy, radio);
  onda.addColorStop(0, rgba(c, 0));
  onda.addColorStop(1, rgba(c, estelaAlfa * (1 - estado.pulso * 0.5)));
  ctx.fillStyle = onda;
  ctx.beginPath();
  ctx.arc(cx, cy, radio, 0, TAU);
  ctx.fill();
}

function dibujarHud(ahora) {
  const { cx, cy, r } = geo;
  const t = movimientoReducido ? 0 : ahora / 1000;
  ctx.strokeStyle = tema.colores.aro;
  ctx.lineWidth = 1;
  ctx.setLineDash([14, 10]);
  ctx.lineDashOffset = -t * 18;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([2, 8]);
  ctx.lineDashOffset = t * 12;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.12, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

function colorEco(edad, alfa, base) {
  const { destello } = tema.colores;
  if (!destello) return rgba(base, alfa.toFixed(3));
  const f = Math.max(0, 1 - edad / 900);
  return rgba(base.map((v, i) => Math.round(v + (destello[i] - v) * f)), alfa.toFixed(3));
}

function trazarEco(e, p, ultimo, a) {
  if (!ultimo && tema.eco !== "arco") {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.6, 0, TAU);
    ctx.fill();
    return;
  }
  if (tema.eco === "arco") {
    ctx.lineWidth = ultimo ? tema.anchoEco : tema.anchoEco - 1;
    ctx.beginPath();
    if (p.r < 8) {
      ctx.arc(p.x, p.y, 2, 0, TAU);
      ctx.fill();
      return;
    }
    // El haz de la antena ensancha el eco en acimut, no en distancia.
    const semi = tema.semiEco / p.r;
    const angulo = e.demora - Math.PI / 2;
    ctx.arc(geo.cx, geo.cy, p.r, angulo - semi, angulo + semi);
    ctx.stroke();
  } else if (tema.eco === "cuadro") {
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - 4, p.y - 4, 8, 8);
  } else if (tema.eco === "flecha") {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(((a?.track ?? 0) * RAD));
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-5.5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 7);
    ctx.lineTo(p.x + 7, p.y);
    ctx.lineTo(p.x, p.y + 7);
    ctx.lineTo(p.x - 7, p.y);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, TAU);
    ctx.fill();
  }
}

function dibujarEcos(ahora) {
  const visibles = [];
  ctx.lineCap = "round";

  for (const [hex, b] of estado.blancos) {
    const emergencia = Boolean(b.mostrado && esEmergencia(b.mostrado));
    const base = colorBlanco(b.mostrado, emergencia);
    b.pantalla = null;
    // Un blanco sin posición vigente se apaga: no debe parecer que sigue ahí.
    const vigente = b.vivo && Boolean(b.polar);
    b.ecos = b.ecos.filter((e, i) => {
      const esUltimo = i === b.ecos.length - 1 && vigente;
      return esUltimo || Math.exp(-(ahora - e.t) / tema.tauEcoMs) > 0.03;
    });
    if (b.ecos.length === 0) {
      if (!b.vivo) estado.blancos.delete(hex);
      continue;
    }

    b.ecos.forEach((e, i) => {
      const ultimo = i === b.ecos.length - 1;
      const edad = ahora - e.t;
      let alfa = Math.exp(-edad / tema.tauEcoMs);
      if (ultimo && vigente) alfa = Math.max(alfa, ALFA_MIN_ULTIMO_ECO);
      if (!ultimo) alfa *= 0.6;
      const p = aPantalla(e.distancia, e.demora);
      if (!enPantalla(p)) return;
      const color = colorEco(edad, alfa, base);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = ultimo ? tema.resplandorEco : 0;
      trazarEco(e, p, ultimo, b.mostrado);
      ctx.shadowBlur = 0;
      if (ultimo) {
        b.pantalla = p;
        if (b.mostrado) visibles.push({ b, p, alfa, emergencia });
      }
    });
  }
  return visibles;
}

function dibujarEtiquetas(visibles) {
  const fuente = Math.max(15, Math.min(20, geo.tam / 40)) * tema.fuente.escala;
  const alto = fuente * 1.9;
  ctx.font = `${tema.fuente.peso} ${fuente}px ${tema.fuente.etiqueta}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const ocupados = [];

  // Primero la selección y las emergencias, para que conserven el mejor sitio.
  visibles.sort((p, q) => prioridad(q) - prioridad(p));

  for (const { b, p, alfa, emergencia } of visibles) {
    const a = b.mostrado;
    const seleccionado = estado.seleccion === b.hex;
    if (!estado.etiquetas && !seleccionado && !emergencia) continue;

    const linea1 = vuelo(a);
    const linea2 = `${nivel(a)}${tendencia(a)} ${numero(a.gs)}`;
    const ancho = Math.max(ctx.measureText(linea1).width, ctx.measureText(linea2).width);

    const base = emergencia ? tema.colores.alerta : tema.altitud ? colorAltitud(a) : tema.colores.etiqueta;
    const opacidad = seleccionado || emergencia ? 1 : Math.max(0.8, alfa);
    const color = rgba(base, opacidad);

    // Línea de rumbo: dónde estará dentro de un minuto.
    if (typeof a.track === "number" && typeof a.gs === "number") {
      const largo = (a.gs / 60 / estado.alcance) * geo.r;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + largo * Math.sin(a.track * RAD), p.y - largo * Math.cos(a.track * RAD));
      ctx.stroke();
    }

    const sitio = elegirSitio(p, ancho, alto, ocupados);
    ocupados.push(sitio);

    // Enlace punteado, para no confundirlo con la línea de rumbo.
    ctx.strokeStyle = rgba(base, 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(sitio.x < p.x ? sitio.x + ancho : sitio.x, sitio.y + alto / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Fondo oscuro para que se lea sobre anillos y nombres del mapa.
    ctx.fillStyle = tema.colores.fondoEtiqueta;
    ctx.fillRect(sitio.x - 2, sitio.y - 1, ancho + 4, alto + 1);

    ctx.fillStyle = color;
    ctx.save();
    ctx.translate(sitio.x, sitio.y);
    if (tema.fuente.inclinada) ctx.rotate((parseInt(b.hex.slice(-2), 16) % 7 - 3) * 0.012);
    ctx.fillText(linea1, 0, 0);
    ctx.fillText(linea2, 0, fuente * 0.95);
    ctx.restore();

    if (seleccionado) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - 11, p.y - 11, 22, 22);
    }
  }
}

function prioridad({ b, emergencia }) {
  return (estado.seleccion === b.hex ? 2 : 0) + (emergencia ? 1 : 0);
}

function elegirSitio(p, ancho, alto, ocupados) {
  const opciones = [
    { x: p.x + 14, y: p.y - alto - 6 },
    { x: p.x + 14, y: p.y + 6 },
    { x: p.x - 14 - ancho, y: p.y - alto - 6 },
    { x: p.x - 14 - ancho, y: p.y + 6 },
  ].map((o) => ({ ...o, ancho, alto }));
  const dentro = (o) => [[o.x, o.y], [o.x + ancho, o.y], [o.x, o.y + alto], [o.x + ancho, o.y + alto]]
    .every(([x, y]) => (tema.forma === "tubo"
      ? Math.hypot(x - geo.cx, y - geo.cy) < geo.r
      : x >= 0 && x <= geo.tam && y >= 0 && y <= geo.tam));
  return opciones.find((o) => dentro(o) && !solapa(o, ocupados)) || opciones.find(dentro) || opciones[0];
}

/* Efectos del tubo, por encima de todo lo demás */

function aplicarResplandor() {
  const { bloom } = tema.efectos;
  if (!bloom || !geo.reflejoBloom) return;
  const capa = geo.reflejoBloom;
  const c = capa.getContext("2d");
  c.clearRect(0, 0, capa.width, capa.height);
  c.drawImage(lienzo, 0, 0, capa.width, capa.height);
  ctx.save();
  trazarContorno(ctx);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = bloom;
  ctx.drawImage(capa, 0, 0, geo.tam, geo.tam);
  ctx.restore();
}

function aplicarGrano() {
  const { grano } = tema.efectos;
  if (!grano || !geo.patronGrano) return;
  ctx.save();
  trazarContorno(ctx);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = grano;
  if (!movimientoReducido) ctx.translate(Math.random() * -160, Math.random() * -160);
  ctx.fillStyle = geo.patronGrano;
  ctx.fillRect(0, 0, geo.tam + 160, geo.tam + 160);
  ctx.restore();
}

function aplicarEncendido(ahora) {
  const { parpadeo, calentamiento } = tema.efectos;
  const progreso = (ahora - estado.encendido) / CALENTAMIENTO_MS;
  const calentando = calentamiento && !movimientoReducido && progreso < 1;
  if (!calentando && (!parpadeo || movimientoReducido)) return;

  ctx.save();
  trazarContorno(ctx);
  ctx.clip();
  if (calentando) {
    // El tubo se calienta: un punto brillante en el centro y la imagen aparece poco a poco.
    ctx.fillStyle = `rgba(0, 0, 0, ${(1 - progreso ** 2).toFixed(3)})`;
    ctx.fillRect(0, 0, geo.tam, geo.tam);
    if (progreso < 0.45) {
      const punto = ctx.createRadialGradient(geo.cx, geo.cy, 0, geo.cx, geo.cy, geo.r * (0.05 + progreso));
      punto.addColorStop(0, rgba(tema.colores.destello, 1 - progreso * 2));
      punto.addColorStop(1, rgba(tema.colores.destello, 0));
      ctx.fillStyle = punto;
      ctx.fillRect(0, 0, geo.tam, geo.tam);
    }
  } else {
    ctx.fillStyle = `rgba(0, 0, 0, ${(Math.random() * parpadeo).toFixed(3)})`;
    ctx.fillRect(0, 0, geo.tam, geo.tam);
  }
  ctx.restore();
}

function frame(ahora) {
  comprobarDeteccion(ahora);
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.tam, geo.tam);
  if (geo.fondo) ctx.drawImage(geo.fondo, 0, 0, geo.tam, geo.tam);

  ctx.save();
  trazarContorno(ctx);
  ctx.clip();
  const modo = modoActual();
  if (modo === "barrido") dibujarBarrido();
  if (modo === "pulso") dibujarPulso();
  if (tema.hud) dibujarHud(ahora);
  const visibles = dibujarEcos(ahora);
  dibujarEtiquetas(visibles);
  ctx.restore();

  aplicarResplandor();
  if (geo.cristal) ctx.drawImage(geo.cristal, 0, 0, geo.tam, geo.tam);
  aplicarGrano();
  aplicarEncendido(ahora);
  requestAnimationFrame(frame);
}

/* Mandos */

function aplicarTema(id, guardar = true) {
  tema = TEMAS.find((t) => t.id === id) || tema;
  document.documentElement.dataset.tema = tema.id;
  if (guardar) guardarAjuste("radar.tema", tema.id);

  for (const entrada of dom.epocas.querySelectorAll("input")) entrada.checked = entrada.value === tema.id;
  dom["epoca-info"].textContent = `${tema.nombre}. ${tema.descripcion}`;
  dom.exploracion.textContent = tema.exploracion;
  dom["placa-tubo"].textContent = tema.placa;
  dom["placa-tubo"].hidden = !tema.placa;

  dom.leyenda.hidden = !tema.altitud;
  if (tema.altitud) {
    const { tramos } = tema.altitud;
    const paradas = tramos.map(([h, c]) => `rgb(${c.join(", ")}) ${(h / tramos[tramos.length - 1][0]) * 100}%`);
    dom["leyenda-barra"].style.background = `linear-gradient(to right, ${paradas.join(", ")})`;
  }

  estado.encendido = performance.now();
  ajustarTamano();

  // Las fuentes del lienzo pueden llegar después: se redibuja cuando estén.
  const fuentes = [`${tema.fuente.peso} 16px ${tema.fuente.etiqueta}`, `16px ${tema.fuente.mapa}`];
  const elegido = tema.id;
  Promise.all(fuentes.map((f) => document.fonts?.load(f))).catch(() => {}).then(() => {
    if (tema.id === elegido) dibujarFondo();
  });
}

function cambiarAlcance(nm) {
  estado.alcance = nm;
  guardarAjuste("radar.alcance", nm);
  for (const tecla of dom.alcances.children) {
    tecla.setAttribute("aria-pressed", String(Number(tecla.dataset.nm) === nm));
  }
  dibujarFondo();
}

function prepararInterruptor(boton, clave, campo, alCambiar) {
  const pintar = () => {
    boton.setAttribute("aria-pressed", String(estado[campo]));
    boton.textContent = estado[campo] ? "Sí" : "No";
  };
  pintar();
  boton.addEventListener("click", () => {
    estado[campo] = !estado[campo];
    guardarAjuste(clave, estado[campo]);
    pintar();
    alCambiar?.();
  });
}

function prepararMandos() {
  if (!ALCANCES.some((a) => a.nm === estado.alcance)) estado.alcance = 100;

  dom.epocas.append(...TEMAS.map((t) => {
    const etiqueta = document.createElement("label");
    etiqueta.className = "epoca";
    const entrada = document.createElement("input");
    entrada.type = "radio";
    entrada.name = "epoca";
    entrada.id = `epoca-${t.id}`;
    entrada.value = t.id;
    entrada.addEventListener("change", () => aplicarTema(t.id));
    const ano = document.createElement("span");
    ano.textContent = t.id;
    etiqueta.append(entrada, ano);
    return etiqueta;
  }));

  dom.alcances.append(...ALCANCES.map(({ nm }) => {
    const tecla = document.createElement("button");
    tecla.type = "button";
    tecla.className = "tecla";
    tecla.dataset.nm = nm;
    tecla.textContent = nm;
    tecla.setAttribute("aria-pressed", String(nm === estado.alcance));
    tecla.addEventListener("click", () => cambiarAlcance(nm));
    return tecla;
  }));

  prepararInterruptor(dom.etiquetas, "radar.etiquetas", "etiquetas");
  prepararInterruptor(dom.localidades, "radar.localidades", "verLocalidades", dibujarFondo);

  lienzo.addEventListener("click", (evento) => {
    const caja = lienzo.getBoundingClientRect();
    const x = evento.clientX - caja.left;
    const y = evento.clientY - caja.top;
    let mejor = null;
    let distanciaMejor = 18;
    for (const b of estado.blancos.values()) {
      if (!b.pantalla) continue;
      const d = Math.hypot(b.pantalla.x - x, b.pantalla.y - y);
      if (d < distanciaMejor) {
        mejor = b.hex;
        distanciaMejor = d;
      }
    }
    seleccionar(mejor);
  });
}

function relojUtc() {
  dom.utc.textContent = new Date().toISOString().slice(11, 19);
}

async function arrancar() {
  prepararMandos();
  crearGrano();
  aplicarTema(tema.id, false);
  new ResizeObserver(() => {
    ajustarTamano();
  }).observe(pantalla);
  relojUtc();
  setInterval(relojUtc, 1000);
  requestAnimationFrame(frame);

  // Sin la posición de la antena no se puede dibujar nada: se reintenta hasta tenerla.
  while (estado.lat === null) {
    try {
      const respuesta = await fetch("api/config");
      if (!respuesta.ok) throw new Error(String(respuesta.status));
      const config = await respuesta.json();
      estado.lat = config.lat;
      estado.lon = config.lon;
      const hemisferios = `${Math.abs(config.lat).toFixed(2)}${config.lat >= 0 ? "N" : "S"} ${Math.abs(config.lon).toFixed(2)}${config.lon >= 0 ? "E" : "W"}`;
      dom.estacion.textContent = `${config.station} ${hemisferios}`;
    } catch {
      actualizarEnlace("SIN CONEXIÓN CON EL SERVIDOR");
      await new Promise((resolver) => setTimeout(resolver, SONDEO_MS * 3));
    }
  }
  dibujarFondo();
  cargarLocalidades();
  sondear();
}

arrancar();
