# Architecture

```mermaid
flowchart LR
  subgraph CP["Charge points"]
    A[Real chargers<br/>OCPP 1.6J]
    B[Web emulator<br/>1–4 connectors]
    C[Android emulator<br/>Kotlin, Compose]
    D[Fleet simulator<br/>N × M connectors]
  end
  subgraph G["ocpp-gateway (Go) :9100"]
    E[OCPP-J transport<br/>WebSocket /ocpp/{id}]
    G1[Command API<br/>+ event stream]
  end
  subgraph M["motor (Go) :9200"]
    F[CSMS + power manager<br/>allocation, plans]
    K[Analytics<br/>energy, maintenance]
    L[Domain API /api/v1<br/>events /api/v1/events]
  end
  P[(PostgreSQL 19<br/>vehicles, chargers)]
  Q[(MongoDB 9<br/>sessions, plans, samples,<br/>OCPP log, events)]
  subgraph B2["bff (Java, Spring Boot) :9000"]
    N[REST /api/v1<br/>validation, CSV]
    O[Live relay /ws/live]
    R[AI assistant<br/>Claude + read-only tools]
  end
  S[front (Angular)<br/>English / Spanish]
  A & B & C & D <-->|Boot, Status, Start/Stop,<br/>MeterValues, DataTransfer| E
  E <--> G1
  G1 <-->|stream: connections, frames,<br/>CALLs to answer| F
  F -->|REST commands:<br/>SetChargingProfile…| G1
  F --> P & Q
  K --> P & Q
  L --> F & K
  N --> L
  O --> L
  R --> L
  S <--> N & O & R
```

## Projects

| Folder | Stack | Responsibility |
|---|---|---|
| `ocpp-gateway/` | Go 1.27, gorilla/websocket | Holds the charger connections; OCPP command API and event stream ([ocpp-gateway.md](ocpp-gateway.md)). No business logic, no data. |
| `motor/` | Go 1.27, gorilla/websocket, pgx 5, MongoDB driver 2 | Domain service (CSMS logic through the gateway). The only one that owns data. |
| `bff/` | Java 25, Spring Boot 4.2, Anthropic Java SDK | Backend for Frontend: the API the UI needs, input validation, CSV, live relay, assistant. |
| `front/` | Angular 22 (standalone components, signals, zoneless) | Dashboard served by the BFF. |
| `emulators/` | JavaScript | Web charger emulator (served by the gateway at `/emulator/`) and fleet simulator. |
| `android/` | Kotlin, Jetpack Compose, OkHttp | Android charger emulator. |
| `tools/` | Node.js | SQLite migration, screenshots. |

Why four services: the gateway isolates OCPP (sockets, framing, correlation, timeouts), so the motor can restart
or be updated without the chargers losing their connection; the motor is a real-time process (allocation every few
seconds) that must not be slowed down by dashboard queries or AI calls; the BFF adapts and protects the domain API
for one specific client; the front is a pure client. Each can be deployed and scaled on its own.

## Motor packages

| Package | Content |
|---|---|
| `cmd/motor` | Entry point: configuration, database connections, HTTP server, graceful shutdown. |
| `internal/gateway` | Client of the OCPP gateway: commands over REST, charger events and CALLs over the stream (reconnects with backoff). |
| `internal/csms` | Charger and connector state, OCPP handlers, vehicle identification, power manager, charging plans, live snapshot. |
| `internal/engine` | Allocation algorithm (pure function) and its tests. |
| `internal/store` | PostgreSQL (master data) and MongoDB (operational data); batched writes for frequent data. |
| `internal/analytics` | Predictive-maintenance indicators. |
| `internal/energy` | Energy-management indicators. |
| `internal/api` | Domain REST API, events hub, OCPP command relay. |

Concurrency: in the gateway each charger connection runs in its own goroutine; in the motor each CALL received from
the stream is answered in its own goroutine. All
in-memory state is guarded by one mutex; OCPP calls and database writes happen outside it. One reallocation runs at
a time (requests arriving meanwhile are coalesced).

## Data

**PostgreSQL** (relational master data, unique identifiers):

| Table | Content |
|---|---|
| `vehicles` | Name, make, model, VIN, EVCCID, RFID idTag (all unique), battery, on-board AC power, phases, target SoC, priority. |
| `chargers` | ChargePoint ID, vendor, model, serial, firmware, location, maximum power, priority, connectors, first/last contact. |

**MongoDB** (high-volume operational data):

| Collection | Content |
|---|---|
| `sessions` | One document per transaction (`_id` = transaction id) with the vehicle data denormalised at link time. |
| `charging_plans` | Scheduled, running and finished plans. |
| `meter_samples` | Time series (meta: transaction id): measured and allocated power, energy, SoC, current. |
| `site_samples` | Time series of the yard: limit, auxiliary loads, EV power, allocated power. |
| `ocpp_log` | Every OCPP frame, with the correlated action and errors flagged. 14-day TTL. |
| `charger_events` | Availability: connect, disconnect, boot, fault, fault cleared, unavailable. |
| `engine_events` | Engine decisions and warnings. 14-day TTL. |
| `settings`, `counters` | Engine configuration and id sequences. |

## Vehicle identification

OCPP 1.6 has no standard field for the VIN; the system accepts the usual channels, by preference:

| Method | How it reaches the CSMS |
|---|---|
| `vin` | `DataTransfer` (`messageId: "VehicleInfo"`, `data: {connectorId, vin, evccid}`) when plugged in — ISO 15118 chargers. |
| `evccid` | The same `DataTransfer` with only the EVCCID (MAC of the EV communication controller, DIN 70121 / ISO 15118). |
| `autocharge` | `idTag = "VID:" + EVCCID` in `Authorize` / `StartTransaction`. |
| `rfid` | `idTag` equal to the vehicle's RFID card. |

With the vehicle identified, the engine uses its on-board charger as cap, its minimum by phases, its priority and its
pending energy.

## Supported OCPP messages

| Direction | Messages |
|---|---|
| Charger → CSMS | BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction, StopTransaction, MeterValues, DataTransfer, Firmware/DiagnosticsStatusNotification |
| CSMS → charger | Used by the engine: SetChargingProfile, RemoteStartTransaction, RemoteStopTransaction, Reset. Any of the 19 OCPP 1.6 CSMS commands can be sent through the command API. |

## Robustness

- Sessions left open by a restart are closed (`ServerRestart`, with the energy of their last samples); if a charger
  keeps reporting an unknown transaction, the motor asks it once to stop it.
- A charger that loses communication keeps its last setpoint as a reservation.
- Charger connections survive a motor restart (they live in the gateway); on reattach the gateway sends the list of
  connected chargers. Without a motor the gateway answers `Heartbeat` and rejects other CALLs with a CALLERROR.
- The BFF reconnects to the motor events with exponential backoff and tells the dashboard when the motor is down.
- Assistant queries are read-only: SQL in a read-only transaction with a 5 s statement timeout; Mongo aggregations
  limited to an allow-list of stages and collections.
