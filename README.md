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
public/                     página del radar (HTML, CSS, JS y datos)
  temas.js                  definición de las épocas visuales
  radar.js                  dibujo y lógica de la pantalla
tools/generar_localidades.py  genera public/localidades.json
config.example.json         plantilla de la configuración local
```

## Créditos

Datos de localidades de [GeoNames](https://www.geonames.org/), bajo licencia
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
