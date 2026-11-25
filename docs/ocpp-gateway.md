# OCPP gateway

A separate service that isolates OCPP from the rest of the system. It holds the WebSocket of every charge point and
exposes them to the central system (the motor) through an **OCPP command API** and an **event stream**. It has no
business logic and no database. Code: [`ocpp-gateway/`](../ocpp-gateway).

```
charge points ──OCPP-J──▶ ocpp-gateway :9100 ──REST commands / stream──▶ motor :9200
```

Why: the motor can restart or be updated without dropping the chargers' connections (verified: 4 chargers stayed
connected through a motor restart), OCPP concerns (sockets, framing, correlation, timeouts) live in one place, and
any other component can send OCPP commands through one audited API.

## Charge point endpoint

`ws://<host>:9100/ocpp/{chargePointId}` with subprotocol `ocpp1.6`. A second connection with the same ID replaces the
first one. The web charger emulator is served at `http://<host>:9100/emulator/`.

## Command API (CSMS → charger)

OpenAPI 3.1: `/api/v1/openapi.yaml`; Swagger UI: `/api/v1/docs`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/chargers/{id}/commands/{action}` | Sends one OCPP 1.6 command. Body: the OCPP payload. Answer: the charger's CALLRESULT payload. |
| GET | `/api/v1/actions` | Supported commands: CancelReservation, ChangeAvailability, ChangeConfiguration, ClearCache, ClearChargingProfile, DataTransfer, GetCompositeSchedule, GetConfiguration, GetDiagnostics, GetLocalListVersion, RemoteStartTransaction, RemoteStopTransaction, ReserveNow, Reset, SendLocalList, SetChargingProfile, TriggerMessage, UnlockConnector, UpdateFirmware. |
| GET | `/api/v1/connections` | Connected chargers (`chargerId`, `remoteAddr`, `connectedAt`, `lastMessageAt`). |
| DELETE | `/api/v1/connections/{id}?reason=&policy=true` | Closes a connection (policy violation when `policy=true`). |
| GET | `/api/v1/health` | Status, connected chargers, whether a CSMS is attached. |

Errors (RFC 9457): `400` unknown command or invalid JSON, `404` charger not connected, `502` the charger answered
with a CALLERROR (`ocppErrorCode` property), `504` no answer within 15 s.

Example:

```bash
curl -X POST http://localhost:9100/api/v1/chargers/PRUEBA-02/commands/GetConfiguration \
     -H 'Content-Type: application/json' -d '{"key":["HeartbeatInterval"]}'
# {"configurationKey":[{"key":"HeartbeatInterval","readonly":false,"value":"30"}],"unknownKey":[]}
```

## Event stream (gateway ↔ CSMS)

`ws://<host>:9100/api/v1/stream`. One CSMS at a time (a new one replaces the previous). JSON messages:

| From | `type` | Content |
|---|---|---|
| gateway | `hello` | `connections`: chargers connected at attach time (the CSMS reconciles its state). |
| gateway | `connected` / `disconnected` | `chargerId`, `remoteAddr`, `t`. |
| gateway | `frame` | Every OCPP frame: `chargerId`, `dir` (`in` / `out`), `frame`, `t`. The motor stores them in the OCPP log. |
| gateway | `call` | A CALL from a charger (`id`, `chargerId`, `action`, `payload`) that the CSMS must answer. |
| CSMS | `result` / `error` | Answer to a `call`: `payload`, or `code` + `description` (sent to the charger as CALLERROR). |

If no CSMS is attached, the gateway answers `Heartbeat` itself and every other CALL with a CALLERROR
(`InternalError: Central system unavailable`); a CSMS that does not answer within 10 s also produces a CALLERROR.
Under backpressure only `frame` messages may be dropped, never calls or connection changes.

## Security

Optional shared secret `GATEWAY_TOKEN` (header `X-Gateway-Token`) for the CSMS-facing API and stream. The charge point
endpoint has no authentication in this prototype (OCPP security profiles 1–3 are future work).

## Through the motor and the BFF

The motor relays any of these commands at `POST /api/v1/chargers/{id}/ocpp/{action}` and the BFF exposes the same path
to the dashboard. Session control should use `remote-start`, `remote-stop` and `reset` (they keep the CSMS state).
