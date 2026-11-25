# Power allocation engine

The engine splits the available power of a charging yard among the connected vehicles in real time and imposes it
on every charger through OCPP 1.6 charging profiles (`SetChargingProfile`). Code:
[`motor/internal/engine/allocate.go`](../motor/internal/engine/allocate.go) (pure algorithm, with tests) and
[`motor/internal/csms/power.go`](../motor/internal/csms/power.go) (budget, transitions, OCPP).

## Available power

```
available = yard limit − auxiliary loads − reservations − safety margin
```

- **Yard limit**: contracted power of the grid connection.
- **Auxiliary loads**: lighting, offices… (not managed; fixed or a simulated profile). Measured every second; a
  change above 250 W triggers an immediate reallocation.
- **Reservations**: a charger that loses communication during a session keeps its last setpoint (it may still be charging).
- **Safety margin** (1 kW by default): absorbs changes between control cycles and the measurement delay.

## Algorithm

On every change (session start/end, status, configuration, auxiliary loads) and every 5 s:

1. **Admission.** Sessions are admitted while each one can be guaranteed its technical minimum: 6 A on the phases
   the vehicle uses (IEC 61851; 1.4 kW single-phase, 4.2 kW three-phase). Those that do not fit are paused
   (0 W → `SuspendedEVSE`), lowest priority first.
2. **Distribution** by the configured strategy:

| Strategy | Rule |
|---|---|
| `equal` | Same **total** power for everyone: find the level *L* such that Σ clamp(L, minᵢ, capᵢ) = available (bisection). What one vehicle cannot use goes to the others. |
| `need` | Proportional to the **required power** of each vehicle: weightᵢ = pending energy to its target SoC / hours to its departure (4 h without a plan). The earliest departure gets more. |
| `priority` | Everyone gets the minimum; the surplus goes by priority (1–10). |
| `fifo` | Everyone gets the minimum; the surplus goes by arrival order. |

3. **Cap of each session** = min(charger power, on-board charger of the identified vehicle, plan limit, real demand).
4. **Adaptation to the real demand (with hysteresis).** When a vehicle draws more than 1.5 kW below its allocation
   (nearly full battery, small on-board charger) it is trimmed and the surplus goes to the others; when it draws all
   it was given again, it may rise (×1.5 or +2 kW per cycle). Only measurements taken at least 10 s after the last
   setpoint count, so a vehicle still ramping up is not trimmed.

## Sending setpoints without exceeding the limit

Transitions are the critical point: raising one vehicle before another has gone down exceeds the limit for a moment.
The engine:

1. Sends **all decreases first** (always, even small ones), in parallel.
2. Waits 2.5 s (`rampDelayMs`) for those vehicles to reduce.
3. **Re-checks** with the current state that the increases still fit, and only then sends them (increases under
   200 W are skipped so chargers are not flooded).
4. Runs one reallocation at a time; requests arriving meanwhile are coalesced into one more run.

Every charger also receives a `TxDefaultProfile` of **0 W** after booting: a new session waits for the engine to
allocate power (~0.3 s) instead of starting at the minimum without checking the headroom.

**Measured results**: 0 of 89 samples over the limit with 8 connectors, variable auxiliary loads and the FIFO strategy
(22 % before these measures), 88 % average use of the limit. With the Go motor: 0 of 77 samples over the limit with
10 simultaneous sessions (peak 49.2 kW of 50 kW).

## OCPP setpoints

`SetChargingProfile` with `TxProfile`, `stackLevel` 1, `chargingProfileKind: Relative`, in W or A (configurable; in A
the power is divided by voltage × phases). The emulators apply the hierarchy `TxProfile` > `TxDefaultProfile` and the
`ChargePointMaxProfile` cap.

## Charging plans

From the dashboard ("Start or schedule") a charge can start **now** or be **scheduled**, with vehicle, departure time,
target SoC and kW limit. The scheduler sends `RemoteStartTransaction` at the start time (retrying for 15 minutes if
the charger is offline or busy), the engine applies the limit and the departure time (`need` strategy) and sends
`RemoteStopTransaction` when the target SoC is reached. Overlapping plans on one connector are rejected.

## Tests

```bash
cd motor && go test ./internal/engine/
```

10 cases: equal share, redistribution, pauses for lack of power, priority, FIFO, need, departure time, single-phase
minimum, same total for single- and three-phase vehicles, and that the available power is never exceeded.
