# EV yard power control (OCPP 1.6J)

Real-time power allocation for an electric-vehicle charging yard: an OCPP 1.6J central system that keeps the
yard under its contracted limit and shares the available power among the vehicles, with a live dashboard,
energy-savings indicators, predictive maintenance and an AI operations assistant.

Thesis project by **Fabián Hidalgo**.

## Architecture

```
 charge points ──OCPP 1.6J/WebSocket──▶  ocpp-gateway  (Go 1.27)
 (real, web emulator,                    :9100  /ocpp/{id}  command API + event stream
  Android, fleet simulator)                        │ REST commands + stream
                                                   ▼
                                         motor  (Go 1.27)         ◀── PostgreSQL 19  vehicles, chargers
                                         domain service           ◀── MongoDB 9      sessions, plans, meter
                                         :9200  /api/v1  /api/v1/events              values, yard samples,
                                                   │ REST + WebSocket                OCPP log, events
                                                   ▼
                                         bff  (Java 25, Spring Boot 4)
                                         :9000  /api/v1  /ws/live  + AI assistant (Claude)
                                                   │
                                                   ▼
                                         front  (Angular 22, English / Spanish)
```

## Repositories

| Repository | Stack | Responsibility |
|---|---|---|
| [fahnlabs-ev-gateway](https://github.com/fabianhidalgo3/fahnlabs-ev-gateway) | Go 1.27, gorilla/websocket | Holds the charger connections and isolates OCPP: command API, event stream, web emulator |
| [fahnlabs-ev-engine](https://github.com/fabianhidalgo3/fahnlabs-ev-engine) | Go 1.27, pgx 5, MongoDB driver 2 | Motor: CSMS logic, power allocation engine, charging plans, domain REST API, energy and maintenance analytics |
| [fahnlabs-ev-bff](https://github.com/fabianhidalgo3/fahnlabs-ev-bff) | Java 25, Spring Boot 4.2, Anthropic Java SDK | Backend for Frontend: validated REST API for the UI, live state relay, CSV exports, AI assistant with read-only tools |
| [fahnlabs-ev-web](https://github.com/fabianhidalgo3/fahnlabs-ev-web) | Angular 22 (standalone, signals, zoneless) | Dashboard with runtime English/Spanish switch, light/dark theme, mobile layout |
| **fahnlabs-ev-deploy** (this one) | Docker Compose, Caddy, JavaScript, Kotlin | Databases, production deployment, charger emulators, tools and documentation |

This repository contains:

| Path | Content |
|---|---|
| [`docker-compose.yml`](docker-compose.yml) | PostgreSQL 19 and MongoDB 9 for development |
| [`deploy/`](deploy) | Production compose file and Caddy configuration ([docs/deployment.md](docs/deployment.md)) |
| [`emulators/`](emulators) | Web charger emulator and fleet simulator |
| [`android/`](android) | Android charger emulator (Kotlin, Jetpack Compose) |
| [`tools/`](tools) | SQLite migration and screenshot tools |
| [`docs/`](docs) | Architecture, API, power engine, energy, maintenance, simulation results |

Only the motor owns data: the BFF never touches a database and the front only talks to the BFF.

## Features

- **Power allocation engine**: keeps the yard under its limit with four strategies (equal share, by priority,
  first come first served, by energy need with departure time), IEC 61851 minimums, adaptation to the real demand
  and safe transitions (decreases first, then re-checked increases). Measured: 0 % of samples over the limit.
- **OCPP 1.6J CSMS**: BootNotification, StatusNotification, transactions, MeterValues, charging profiles
  (`SetChargingProfile`), remote start/stop, reset; every frame is logged. A separate OCPP gateway exposes all 19
  OCPP 1.6 CSMS commands through a REST API, and chargers stay connected while the motor restarts.
- **Vehicle identification** by VIN (ISO 15118), EVCCID, Autocharge (`VID:`) or RFID.
- **Charging plans**: start now or scheduled, with departure time, target SoC and power limit.
- **Energy indicators**: controlled demand versus immediate full-power charging, avoided peak, demand-charge
  savings, load factor, CO₂ avoided, and what the control gives up.
- **Predictive maintenance**: availability, MTBF/MTTR, 0–100 risk score and failure probability per charger.
- **AI assistant** in the top bar (Claude): answers from the yard data and navigates the dashboard; navigation
  also works without an API key.

## Getting started

Requirements: Docker (PostgreSQL + MongoDB), Go 1.27+, JDK 25, Node.js 24+ (front build and emulators).

Clone the five repositories side by side:

```bash
mkdir Development && cd Development
for r in ev-gateway ev-engine ev-bff ev-web ev-deploy; do
  git clone git@github.com:fabianhidalgo3/fahnlabs-$r.git
done
```

```
Development/
├── fahnlabs-ev-gateway   OCPP gateway (Go)
├── fahnlabs-ev-engine    motor: CSMS logic, power allocation, data (Go)
├── fahnlabs-ev-bff       REST API for the UI + assistant (Spring Boot)
├── fahnlabs-ev-web       front (Angular)
└── fahnlabs-ev-deploy    this repository
```

```bash
cd fahnlabs-ev-deploy && docker compose up -d && cd ..          # databases (host ports 5442 / 27027)

cd fahnlabs-ev-gateway && go build -o bin/gateway ./cmd/gateway && ./bin/gateway   # :9100 (chargers connect here)
cd fahnlabs-ev-engine && go build -o bin/motor ./cmd/motor && ./bin/motor          # :9200
cd fahnlabs-ev-web && npm install && npm run build                                 # built front
cd fahnlabs-ev-bff && FRONT_DIR=../fahnlabs-ev-web/dist/front/browser ./mvnw spring-boot:run   # :9000, serves the front
```

During front development: `cd fahnlabs-ev-web && npm start` (http://localhost:4200, proxies `/api` and `/ws` to the BFF).
The production build (`deploy/docker-compose.prod.yml`) uses that parent folder as its Docker context.

Test chargers:

```bash
# web emulator: http://localhost:9100/emulator/
node emulators/fleet/fleet.js --chargers 6 --connectors 2 --speed 20 --duration 30 --arrival 0.4 --prefix PRUEBA
```

Configuration (all optional; defaults match `docker-compose.yml`): copy `.env.example` to `.env` (databases, gateway,
motor) and set the BFF variables (`ANTHROPIC_API_KEY`, `MOTOR_URL`, `MOTOR_TOKEN`) in a git-ignored `fahnlabs-ev-bff/.env`.

Migrating data from the previous SQLite version: [`tools/migrate-sqlite`](tools/migrate-sqlite).

## Tests

```bash
cd fahnlabs-ev-engine && go test ./...      # allocation engine
```

Limit check: no yard sample may have `ev_w + building_w > limit_w` (Mongo `site_samples`).

## API

- OCPP gateway: `http://localhost:9100/api/v1` (OCPP commands, connections, event stream), see
  [docs/ocpp-gateway.md](docs/ocpp-gateway.md).
- Motor domain API: `http://localhost:9200/api/v1` (vehicles, chargers and OCPP commands, charging plans, sessions,
  logs, energy, maintenance, read-only queries, exports) and live events at `ws://…/api/v1/events`.
- BFF API for the front: `http://localhost:9000/api/v1` with the same resources, validation and RFC 9457 problem
  details, plus `/api/v1/assistant`, CSV exports and `ws://…/ws/live`.
- Swagger UI (OpenAPI 3.1): BFF `http://localhost:9000/swagger-ui.html`, motor `http://localhost:9200/api/v1/docs`,
  gateway `http://localhost:9100/api/v1/docs`.

## Limitations (prototype)

- The VIN travels through a custom `DataTransfer` extension (OCPP 1.6 does not define it).
- Balanced three-phase allocation, no per-phase balancing.
- The Android app has not been compiled in this development environment.

## Authorship and license

© 2026 Fabián Hidalgo · FAHNLABS. All rights reserved. Developed as a thesis project.
