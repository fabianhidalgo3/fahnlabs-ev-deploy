# Emulators and simulation

## Web emulator

`http://localhost:9100/emulator/` (served by the OCPP gateway; it reads the vehicle registry from the motor at
`http://<host>:9200/api/v1/vehicles`). A charge point with 1 to 4 connectors. Per connector you
pick a vehicle from the registry (or a manual one) and the identification mode (RFID, Autocharge, ISO 15118). It applies
the received charging profiles with a power ramp and the vehicle's charging curve (it tapers above 80 % SoC) and sends
MeterValues (power, energy, current, SoC, voltage). Open several tabs for several chargers.

## Android emulator

Folder `android/` (Kotlin, Jetpack Compose, OkHttp); open it in Android Studio. In the Android emulator the URL
`ws://10.0.2.2:9100/ocpp` points to the gateway on the PC (vehicles come from the motor on port 9200); on a real
phone use the PC's LAN address. See
[`android/README.md`](../android/README.md).

## Fleet simulator

`emulators/fleet/fleet.js` has two profiles: `car` (default, AC cars arriving at random) and `bus` (overnight
electric-bus depot with DC chargers).

```bash
node emulators/fleet/fleet.js --chargers 6 --connectors 2 --speed 20 --duration 60 --arrival 0.3 --mode mixed --seed 42 --prefix PRUEBA
node emulators/fleet/fleet.js --profile bus --chargers 10 --connectors 1 --speed 60 --prefix DEPOT --csv depot.csv
```

Common options:

| Option | Default | Description |
|---|---|---|
| `--profile` | car | `car` \| `bus`. |
| `--url`, `--api` | `ws://localhost:9100/ocpp`, `http://localhost:9200` | OCPP endpoint (gateway) and motor API (vehicles, chargers, plans, state). |
| `--chargers`, `--connectors` | 4, 2 | Yard size. |
| `--maxkw` | 22 (bus: 150) | Maximum power per connector (kW); announced to the motor with the `Capabilities` DataTransfer. |
| `--speed` | 60 | Time acceleration (1 real second = *speed* simulated seconds). |
| `--duration` | 30 | Real minutes. In the bus profile, if omitted, the run ends when the last bus has left. |
| `--seed` | 42 | Seed: same arrivals on every run. |
| `--meter`, `--report` | 5 (bus: 2), 10 | Real seconds between MeterValues / console reports. |
| `--fallas`, `--caidas` | 0 | Fault probability per connector / drop probability per charger and simulated hour (use < 1). |
| `--degradar` | — | Charger numbers whose fault rate grows up to ×10 by the end. |

### Car profile

| Option | Default | Description |
|---|---|---|
| `--arrival` | 0.05 | Arrival probability per free connector and simulated minute. |
| `--dwell`, `--soc` | 2-8, 10-60 | Stay (simulated hours) and initial SoC (%). |
| `--mode` | mixed | `rfid` \| `autocharge` \| `iso15118` \| `mixed`. |

It picks vehicles from the motor registry (the depot buses, idTag `BUS-nn`, are excluded). At the end it prints a
summary (sessions, energy, identification, faults); the data stays in the databases.

### Bus profile (overnight depot)

| Option | Default | Description |
|---|---|---|
| `--buses` | 10 | How many buses of the declared set take part (max 10). |
| `--start` | 20:30 | Simulated clock at the start of the run. |
| `--arrive`, `--depart` | 21:00-00:00, 05:00-07:00 | Arrival and departure windows (simulated time, uniform per bus). |
| `--soc` | 15-50 | Arrival SoC (%), uniform. |
| `--target`, `--minsoc` | 90, 80 | Target SoC and minimum SoC required at departure (%). |
| `--dcv` | 650 | DC voltage (V): converts setpoints in A (A × V) and reports `Current.Import`. |
| `--csv` | — | Path of the per-bus results CSV. |
| `--sitekw`, `--strategy` | — | Optional: sets the motor's yard limit / allocation strategy (`PUT /api/v1/config`) before the run. Changes persist. |

How it works:

- **Buses.** A declared set of 10 buses (BYD K9, Yutong E12, Volvo BZL…, 280–420 kWh, 150 kW DC, importance 3–9
  stored as the vehicle priority), with VIN, EVCCID and idTag `BUS-01`…`BUS-10`. At start-up they are created in the
  motor with `POST /api/v1/vehicles` if no vehicle has the same name, or updated with `PUT` if their data differ
  (idempotent). The body includes `max_dc_kw` and `min_soc`; if the motor rejects it (older build: unknown ranges,
  battery ≤ 300 kWh) a compatible body is sent instead. The emulator always uses the declared battery size.
- **Chargers.** Each emulated charger boots as `DC-Depot-<maxkw>`, announces `maxPowerW` and `currentType: "DC"` in
  the `Capabilities` DataTransfer, and is then set with `PUT /api/v1/chargers/{id}` (`currentType: "DC"`, and
  `maxPowerKw` only if the motor holds a different value).
- **Timeline.** Each bus gets an arrival time, a departure time and an arrival SoC from the seed. On arrival it takes a
  free connector (or one released by a bus that already reached its target), plugs in as ISO 15118 (DataTransfer
  `VehicleInfo` with VIN and EVCCID) and the simulator creates a **charging plan** with
  `POST /api/v1/charging-plans` (`chargerId`, `connectorId`, `vehicleId`, `departureAt`, `targetSoc`, `minSoc`).
  The motor starts the session with `RemoteStartTransaction` (idTag `BUS-nn`) and links the plan and the vehicle, so
  it knows the departure time and targets. If the plan is rejected or does not start within 20 real seconds, the
  charger starts the session locally (Authorize + StartTransaction). Open plans left on the same charger prefix by an
  earlier run are cancelled at start-up.
- **Time compression.** `departureAt` is the wall-clock instant at which the simulated departure will happen
  (`now + (t_departure − t_sim) / speed`). The motor therefore sees hours to departure divided by `--speed`, so the
  absolute power "needed" it computes is `speed` times higher than the physical one; the ranking between buses is
  preserved.
- **DC physics.** Power = min(setpoint of the active charging profile — W, or A × `--dcv` —, connector maximum,
  bus maximum × taper(SoC)). Taper: constant up to 80 % SoC, then linear down to 20 % of the maximum at 100 %. MeterValues
  carry `Power.Active.Import`, `Energy.Active.Import.Register`, `SoC`, DC `Current.Import` and `Voltage`.
- **End of charge.** At the target SoC the bus stops requesting power and a MeterValues is sent at once, so the motor
  closes the plan (`RemoteStopTransaction`); if it does not within 5 real seconds the charger stops the transaction
  (`Local`). At its departure time the bus unplugs (`StopTransaction` reason `EVDisconnected` if still charging).
- **Summary.** Peak EV power of the yard (sum measured by the emulated chargers) next to the site limit (which also
  covers the building load; the authoritative check is the motor's `site_samples`), energy delivered, sessions and plans, departures and the share leaving with
  SoC ≥ minimum and ≥ target, and a per-bus table. `--csv` writes one row per bus (arrival/departure, SoC at arrival
  and departure, `met_min`, `met_target`, energy, peak kW, plan and transaction ids, start method, stop reason).

## Synthetic history

The 30-day `HIST-*` history used to validate predictive maintenance was migrated from the previous version (see
[predictive-maintenance.md](predictive-maintenance.md)). Its generator still has to be ported to the new stores.

## Data migration

```bash
cd tools/migrate-sqlite && npm install
node migrate.mjs <path/to/emob.sqlite> [path/to/config.json]
```

Copies the legacy SQLite database to PostgreSQL (vehicles, chargers, same ids) and MongoDB (everything else; OCPP log
and events only for the last 14 days). Start the motor once before, so the schema and collections exist.
