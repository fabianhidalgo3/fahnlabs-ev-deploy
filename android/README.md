# Emulador de cargador OCPP 1.6J — Android

App Kotlin + Jetpack Compose que emula un punto de carga AC de 1 conector con un vehículo simulado.
Se conecta al motor (`server/`) y obedece las consignas de potencia (`SetChargingProfile`).

## Abrir y ejecutar

1. Android Studio (Ladybug o posterior) → *Open* → esta carpeta `android/`. Deja que sincronice Gradle
   (si pide el wrapper, acepta la sugerencia del IDE o ejecuta `gradle wrapper`).
2. Arranca el servidor (`cd server && npm start`).
3. Ejecuta la app:
   - Emulador de Android: URL `ws://10.0.2.2:9000/ocpp` (10.0.2.2 = el PC anfitrión).
   - Móvil físico: `ws://<IP-LAN-del-PC>:9000/ocpp` y abre el puerto 9000 en el firewall.

## Vehículo e identificación

- **Cargar de la BD** descarga `GET http://<host>:9000/api/vehicles` (derivado de la URL ws) y permite
  elegir un vehículo; rellena nombre, VIN, EVCCID, idTag, batería, potencia AC, fases y SoC objetivo.
- Modos de identificación:

| Modo | Al enchufar | idTag de la sesión |
|---|---|---|
| RFID | – | idTag del vehículo |
| Autocharge | `DataTransfer` EMOB/VehicleInfo `{connectorId, evccid}` | `VID:<EVCCID>` |
| ISO 15118 | `DataTransfer` EMOB/VehicleInfo `{connectorId, vin, evccid}` | idTag del vehículo (o `EV-<8 últimos del VIN>`) |

El motor vincula la sesión al vehículo y usa su potencia AC y fases para el reparto.
El mínimo de carga es 6 A × 230 V × min(fases del cargador, fases del VE).
