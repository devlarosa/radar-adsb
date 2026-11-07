# Radar ADS-B

Pantalla de radar en el navegador para los datos en vivo de [readsb](https://github.com/wiedehopf/readsb)
recibidos con un SDR. Incluye varias «épocas» visuales (tubo de válvulas de 1945, consola de 1962…),
alcances de 25 a 250 NM, etiquetas de blancos, localidades y aeropuertos de referencia.

Solo usa la biblioteca estándar de Python: no hay dependencias que instalar.

## Puesta en marcha

1. Indica la posición de tu antena (este archivo no se sube a git):

   ```sh
   cp config.example.json config.local.json
   # edita lat y lon
   ```

2. Arranca el servidor:

   ```sh
   python3 server.py
   ```

   y abre `http://<máquina>:8090`.

Opciones de `server.py`:

| Opción   | Por defecto                  | Descripción                                   |
|----------|------------------------------|-----------------------------------------------|
| `--lat`  | `config.local.json`          | Latitud de la antena                          |
| `--lon`  | `config.local.json`          | Longitud de la antena                         |
| `--port` | `8090`                       | Puerto HTTP                                   |
| `--bind` | `0.0.0.0`                    | Usa `127.0.0.1` para limitarlo a esta máquina |
| `--data` | `/run/readsb/aircraft.json`  | JSON de aviones que escribe readsb            |

### API

- `GET /api/config`: posición de la estación y nombre de la máquina.
- `GET /api/aircraft`: copia del `aircraft.json` de readsb.
- `GET /api/cobertura`: alcance máximo por sector de 2° y banda de altitud.
- `GET /api/meteo`: perfil de temperatura y viento de la última hora.

## Sondeo aéreo (`/sondeo.html`)

Una radiosonda virtual hecha con los propios aviones. En Europa los aviones responden a los radares
secundarios con datos de vuelo (rumbo, velocidad verdadera, Mach…) y readsb calcula con ellos el
viento y la temperatura exterior a la altitud de cada uno. El servidor acumula esas observaciones
(una por avión cada 30 s, descartando virajes y temperaturas imposibles) y la página muestra:

- el perfil de temperatura frente a la atmósfera estándar (ISA), con barbas de viento por capa;
- la isoterma de 0 °C, la tropopausa (definición de la OMM), las inversiones y la corriente en chorro;
- una tabla por capas de 1000 ft con la mediana de la última hora.

Las observaciones de las últimas 3 horas se guardan en `datos/meteo.json` (opción `--meteo`).
Por la noche, con poco tráfico, el perfil tendrá huecos.

## Diagrama de cobertura

El servidor registra continuamente, aunque no haya ningún navegador abierto, la distancia máxima
a la que se ha recibido un avión en cada dirección, separada en tres bandas de altitud
(`< FL100`, `FL100–250`, `> FL250`). La pantalla lo dibuja como un polígono por banda: la banda baja
muestra bien dónde tapa el relieve.

- Solo cuentan posiciones ADS-B recibidas directamente (no TIS-B, ADS-R ni MLAT) y coherentes
  con la anterior del mismo avión, para que una posición errónea no estropee un sector.
- Se guarda en `datos/cobertura.json` cada minuto y al parar el servidor (opción `--cobertura`).
- Para empezar de cero (por ejemplo, tras mover la antena) borra ese archivo. Si cambia la
  posición de la antena en `config.local.json`, se reinicia sola.

## Localidades

`public/localidades.json` contiene las poblaciones de más de 1000 habitantes en un radio de 360 NM.
Para regenerarlo alrededor de tu propia antena:

```sh
wget https://download.geonames.org/export/dump/cities1000.zip
python3 tools/generar_localidades.py cities1000.zip
```

## Estructura

```
server.py                   servidor HTTP y API
cobertura.py                acumula el diagrama de cobertura
meteo.py                    radiosonda virtual con los datos de los aviones
public/                     página del radar (HTML, CSS, JS y datos)
  temas.js                  definición de las épocas visuales
  radar.js                  dibujo y lógica de la pantalla
  sondeo.html, sondeo.js    pantalla del sondeo aéreo
tools/generar_localidades.py  genera public/localidades.json
config.example.json         plantilla de la configuración local
```

## Créditos

Datos de localidades de [GeoNames](https://www.geonames.org/), bajo licencia
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Licencia

El código se distribuye bajo la [licencia MIT](LICENSE). Los datos de `public/localidades.json`
mantienen su licencia original (CC BY 4.0, GeoNames).
