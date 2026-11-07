"use strict";

const RAD = Math.PI / 180;
const TECHO_MIN_FT = 45000;
const T_MIN = -70;
const T_MAX = 30;
const SONDEO_MS = 30000;
const SEPARACION_BARBAS = 26;

const lienzo = document.getElementById("sondeo");
const ctx = lienzo.getContext("2d");
const pantalla = document.getElementById("pantalla");
const dom = Object.fromEntries(
  ["aviso", "resumen", "isoterma", "tropopausa", "viento-max", "aviones", "observaciones", "actualizado",
    "avisos-meteo", "tabla", "sin-capas"].map((id) => [id, document.getElementById(id)]),
);

const geo = { ancho: 0, alto: 0, dpr: 1, techo: TECHO_MIN_FT };
let datos = null;

/* Formato */

function nivel(alt) {
  return "FL" + String(Math.round(alt / 100)).padStart(3, "0");
}

function grados(t) {
  return `${t > 0 ? "+" : ""}${t.toFixed(0)}°`;
}

function viento(c) {
  return `${String(c.wd).padStart(3, "0")}/${c.ws}`;
}

function textoIsoterma(iso) {
  if (iso === null || iso === undefined) return "---";
  if (typeof iso === "object") return `< ${nivel(iso.debajo)}`;
  return nivel(iso);
}

/* Colores de la época, leídos de radar.css */

function tokens() {
  const estilo = getComputedStyle(document.documentElement);
  const leer = (nombre) => estilo.getPropertyValue(nombre).trim();
  return {
    fondo: leer("--bisel"),
    traza: leer("--fosforo"),
    trazaTenue: leer("--fosforo-tenue"),
    rotulo: leer("--rotulo"),
    rotuloTenue: leer("--rotulo-tenue"),
    alerta: leer("--alerta"),
    fuente: leer("--lectura"),
    escala: parseFloat(leer("--escala-lectura")) || 0.8,
  };
}

/* Diagrama */

function ajustarTamano() {
  const cuadro = pantalla.getBoundingClientRect();
  const estilo = getComputedStyle(pantalla);
  geo.ancho = Math.max(280, Math.floor(cuadro.width - parseFloat(estilo.paddingLeft) - parseFloat(estilo.paddingRight)));
  geo.alto = Math.max(320, Math.floor(cuadro.height - parseFloat(estilo.paddingTop) - parseFloat(estilo.paddingBottom)));
  geo.dpr = window.devicePixelRatio || 1;
  lienzo.style.width = `${geo.ancho}px`;
  lienzo.style.height = `${geo.alto}px`;
  lienzo.width = Math.round(geo.ancho * geo.dpr);
  lienzo.height = Math.round(geo.alto * geo.dpr);
  dibujar();
}

function marco(t) {
  const fuente = Math.max(12, Math.min(16, geo.ancho / 50)) * (t.escala / 0.8);
  const izquierda = fuente * 4.2;
  const columnaViento = Math.max(70, fuente * 5.5);
  const derecha = columnaViento + 12;
  const arriba = fuente * 1.6;
  const abajo = fuente * 2.6;
  return {
    fuente,
    x0: izquierda,
    x1: geo.ancho - derecha,
    y0: arriba,
    y1: geo.alto - abajo,
    xViento: geo.ancho - derecha / 2 - 6,
  };
}

function dibujar() {
  if (!geo.ancho) return;
  const t = tokens();
  const m = marco(t);
  // El techo crece de 5000 en 5000 ft si algún avión vuela por encima de FL450.
  const masAlta = Math.max(0, ...(datos?.perfil ?? []).map((c) => c.alt + 500));
  geo.techo = Math.max(TECHO_MIN_FT, Math.ceil(masAlta / 5000) * 5000);
  const x = (temp) => m.x0 + ((temp - T_MIN) / (T_MAX - T_MIN)) * (m.x1 - m.x0);
  const y = (alt) => m.y1 - (alt / geo.techo) * (m.y1 - m.y0);

  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.ancho, geo.alto);
  ctx.fillStyle = t.fondo;
  ctx.fillRect(0, 0, geo.ancho, geo.alto);
  ctx.font = `${m.fuente}px ${t.fuente}`;
  ctx.lineCap = "round";

  dibujarRejilla(t, m, x, y);

  if (!datos || datos.perfil.length === 0) {
    ctx.fillStyle = t.rotulo;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("ESPERANDO DATOS DE LOS AVIONES", (m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2);
    return;
  }

  dibujarReferencias(t, m, x, y);
  dibujarTemperatura(t, x, y);
  dibujarBarbas(t, m, y);
}

function dibujarRejilla(t, m, x, y) {
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";

  for (let alt = 0; alt <= geo.techo; alt += 5000) {
    ctx.strokeStyle = t.rotuloTenue;
    ctx.globalAlpha = alt % 10000 === 0 ? 0.35 : 0.18;
    ctx.beginPath();
    ctx.moveTo(m.x0, y(alt));
    ctx.lineTo(m.x1, y(alt));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = t.rotuloTenue;
    ctx.textAlign = "right";
    ctx.fillText(nivel(alt), m.x0 - 6, y(alt));
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // En pantallas estrechas las etiquetas de cada 10° no caben: se dejan cada 20°.
  const pasoTemp = (x(10) - x(0)) < m.fuente * 3.6 ? 20 : 10;
  for (let temp = T_MIN; temp <= T_MAX; temp += 10) {
    ctx.strokeStyle = t.rotuloTenue;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.moveTo(x(temp), m.y0);
    ctx.lineTo(x(temp), m.y1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = t.rotuloTenue;
    if ((temp - T_MIN) % pasoTemp === 0) ctx.fillText(grados(temp), x(temp), m.y1 + 6);
  }
  ctx.fillText("TEMPERATURA °C", (m.x0 + m.x1) / 2, m.y1 + 6 + m.fuente * 1.1);
  ctx.fillText("VIENTO KT", m.xViento, m.y1 + 6 + m.fuente * 1.1);

  // Isoterma de 0 °C: la vertical que marca dónde empieza el hielo.
  ctx.strokeStyle = t.alerta;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x(0), m.y0);
  ctx.lineTo(x(0), m.y1);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = t.rotuloTenue;
  ctx.strokeRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
}

function dibujarReferencias(t, m, x, y) {
  // Inversiones: franjas donde la temperatura sube con la altura.
  ctx.fillStyle = t.traza;
  ctx.globalAlpha = 0.12;
  for (const inv of datos.inversiones) {
    ctx.fillRect(m.x0, y(inv.techo), m.x1 - m.x0, y(inv.base) - y(inv.techo));
  }
  ctx.globalAlpha = 1;

  // Atmósfera estándar.
  ctx.strokeStyle = t.rotulo;
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  for (let alt = 0; alt <= geo.techo; alt += 500) {
    const isa = Math.max(15 - 1.98 * alt / 1000, -56.5);
    if (alt === 0) ctx.moveTo(x(isa), y(alt));
    else ctx.lineTo(x(isa), y(alt));
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  const marca = (alt, texto, color) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(m.x0, y(alt));
    ctx.lineTo(m.x1, y(alt));
    ctx.stroke();
    ctx.fillText(texto, m.x0 + 6, y(alt) - 3);
  };
  ctx.lineWidth = 1.5;
  if (datos.tropopausa) marca(datos.tropopausa, `TROPOPAUSA ${nivel(datos.tropopausa)}`, t.rotulo);
  if (typeof datos.isoterma0 === "number") marca(datos.isoterma0, `0 °C ${nivel(datos.isoterma0)}`, t.alerta);
  ctx.lineWidth = 1;
}

function dibujarTemperatura(t, x, y) {
  // Cada observación individual, tenue; encima, la mediana por capa.
  ctx.fillStyle = t.trazaTenue;
  ctx.globalAlpha = 0.45;
  for (const o of datos.observaciones) {
    ctx.beginPath();
    ctx.arc(x(o.t), y(o.alt), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const puntos = datos.perfil.filter((c) => "t" in c);
  ctx.strokeStyle = t.traza;
  ctx.fillStyle = t.traza;
  ctx.shadowColor = t.traza;
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  puntos.forEach((c, i) => {
    // Un salto de más de 3000 ft sin datos no se une: sería inventar el perfil.
    const salto = i > 0 && c.alt - puntos[i - 1].alt > 3000;
    if (i === 0 || salto) ctx.moveTo(x(c.t), y(c.alt));
    else ctx.lineTo(x(c.t), y(c.alt));
  });
  ctx.stroke();
  for (const c of puntos) {
    ctx.beginPath();
    ctx.arc(x(c.t), y(c.alt), c.nt >= 3 ? 3 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

// Barba meteorológica: el mástil apunta hacia donde viene el viento;
// banderín = 50 kt, pluma = 10 kt, media pluma = 5 kt.
function barba(cx, cy, direccion, velocidad, largo) {
  if (velocidad < 3) {
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const dx = Math.sin(direccion * RAD);
  const dy = -Math.cos(direccion * RAD);
  const px = -dy;
  const py = dx;
  const punta = { x: cx + dx * largo, y: cy + dy * largo };
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(punta.x, punta.y);
  ctx.stroke();

  let resto = Math.round(velocidad / 5) * 5;
  let d = 0;
  const paso = largo / 6;
  const pluma = largo * 0.45;
  while (resto >= 50) {
    ctx.beginPath();
    ctx.moveTo(punta.x - dx * d, punta.y - dy * d);
    ctx.lineTo(punta.x - dx * d + px * pluma, punta.y - dy * d + py * pluma);
    ctx.lineTo(punta.x - dx * (d + paso * 1.4), punta.y - dy * (d + paso * 1.4));
    ctx.closePath();
    ctx.fill();
    d += paso * 1.8;
    resto -= 50;
  }
  while (resto >= 10) {
    ctx.beginPath();
    ctx.moveTo(punta.x - dx * d, punta.y - dy * d);
    ctx.lineTo(punta.x - dx * d + px * pluma + dx * paso, punta.y - dy * d + py * pluma + dy * paso);
    ctx.stroke();
    d += paso;
    resto -= 10;
  }
  if (resto >= 5) {
    if (d === 0) d = paso;  // una media pluma sola se separa de la punta para no confundirla
    ctx.beginPath();
    ctx.moveTo(punta.x - dx * d, punta.y - dy * d);
    ctx.lineTo(punta.x - dx * d + (px * pluma + dx * paso) / 2, punta.y - dy * d + (py * pluma + dy * paso) / 2);
    ctx.stroke();
  }
}

function dibujarBarbas(t, m, y) {
  const capas = datos.perfil.filter((c) => "ws" in c).reverse();
  const maximo = datos.vientoMax;
  ctx.lineWidth = 1.5;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  let ultimaY = -Infinity;
  for (const c of capas) {
    const cy = y(c.alt);
    if (cy - ultimaY < SEPARACION_BARBAS) continue;
    ultimaY = cy;
    const destacada = maximo && maximo.chorro && c.alt === maximo.alt;
    const color = destacada ? t.alerta : t.traza;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    barba(m.xViento + 10, cy, c.wd, c.ws, Math.min(26, SEPARACION_BARBAS));
    ctx.fillText(String(c.ws), m.xViento - 18, cy);
  }
}

/* Panel */

function actualizarPanel() {
  const d = datos;
  dom.isoterma.textContent = textoIsoterma(d.isoterma0);
  dom.tropopausa.textContent = d.tropopausa ? nivel(d.tropopausa) : "---";
  dom["viento-max"].textContent = d.vientoMax ? `${d.vientoMax.ws} KT` : "---";
  dom.aviones.textContent = d.aviones;
  dom.observaciones.textContent = d.observaciones.length;
  dom.actualizado.textContent = new Date().toISOString().slice(11, 16);

  const conDatos = d.perfil.length;
  const minimo = conDatos ? nivel(d.perfil[0].alt) : null;
  const maximo = conDatos ? nivel(d.perfil[conDatos - 1].alt) : null;
  dom.resumen.textContent = conDatos
    ? `Última hora: ${conDatos} capas con datos, de ${minimo} a ${maximo}.`
    : "Todavía no ha llegado ningún avión con datos meteorológicos.";

  const avisos = [];
  if (d.vientoMax?.chorro) {
    avisos.push(`Corriente en chorro: ${d.vientoMax.ws} kt del ${String(d.vientoMax.wd).padStart(3, "0")}° a ${nivel(d.vientoMax.alt)}.`);
  }
  for (const inv of d.inversiones) {
    avisos.push(`Inversión de ${nivel(inv.base)} a ${nivel(inv.techo)} (+${inv.salto} °C).`);
  }
  dom["avisos-meteo"].textContent = avisos.join(" ");
  dom["avisos-meteo"].hidden = avisos.length === 0;

  dom["sin-capas"].hidden = conDatos > 0;
  dom.tabla.replaceChildren(...[...d.perfil].reverse().map((c) => {
    const fila = document.createElement("tr");
    const tropopausa = d.tropopausa && c.alt === d.tropopausa;
    const chorro = d.vientoMax?.chorro && c.alt === d.vientoMax.alt;
    if (tropopausa) fila.classList.add("tropopausa");
    if (chorro) fila.classList.add("chorro");
    const celdas = [
      nivel(c.alt),
      "t" in c ? grados(c.t) : "---",
      "t" in c ? grados(c.t - c.isa) : "---",
      "ws" in c ? viento(c) : "---",
      String(c.aviones),
    ];
    fila.append(...celdas.map((texto) => {
      const celda = document.createElement("td");
      celda.textContent = texto;
      if (texto === "---" || c.aviones < 2) celda.classList.add("tenue");
      return celda;
    }));
    return fila;
  }));
}

async function consultar() {
  try {
    const respuesta = await fetch("api/meteo", { cache: "no-store" });
    if (!respuesta.ok) throw new Error(String(respuesta.status));
    datos = await respuesta.json();
    dom.aviso.hidden = true;
    actualizarPanel();
    dibujar();
  } catch {
    dom.aviso.textContent = "SIN CONEXIÓN CON EL SERVIDOR";
    dom.aviso.hidden = false;
  } finally {
    setTimeout(consultar, SONDEO_MS);
  }
}

// Si se cambia la época en el radar (otra pestaña), esta pantalla la sigue.
window.addEventListener("storage", (evento) => {
  if (evento.key !== "radar.tema") return;
  try {
    document.documentElement.dataset.tema = JSON.parse(evento.newValue) || "1962";
  } catch {
    return;
  }
  dibujar();
});

new ResizeObserver(ajustarTamano).observe(pantalla);
document.fonts?.ready.then(dibujar);
consultar();
