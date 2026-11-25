# Operations assistant and predictive maintenance

A chat in the dashboard's **top bar** (`Ctrl K`) answers questions about the chargers: errors, disconnections,
setpoints, sessions, energy savings, health, history and failure probability. It uses **Claude** (Anthropic) with
**read-only** tools that call the motor API; it cannot act on the chargers. It answers in the dashboard language.

Code: [`bff/src/main/java/com/emob/bff/assistant/`](../bff/src/main/java/com/emob/bff/assistant) (assistant and tools),
[`motor/internal/analytics/`](../motor/internal/analytics) (calculations), [`front/src/app/shell/chat.ts`](../front/src/app/shell/chat.ts) (chat).

## Navigation from the chat

- **Without an API key** (in the browser): short commands in English or Spanish — "go to engine log", "open the live
  yard", "show MeterValues of PRUEBA-03", "ir al motor" — switch section and apply filters (charger and OCPP action in
  the engine log; the charger is highlighted elsewhere).
- **With the assistant**: the `navigate_dashboard` tool lets Claude take the user to the useful view after a diagnosis.

## Source data

| Collection | Content |
|---|---|
| `ocpp_log` | Every OCPP frame. Answers inherit the action of their request (correlated by id); CALLERRORs, non-accepted answers (`Rejected`…) and StatusNotifications with an `errorCode` are flagged as errors. 14-day retention. |
| `charger_events` | Connect, disconnect, boot, fault (with its cause), fault cleared, per charger. |
| `sessions`, `meter_samples` | Sessions and measured vs allocated power series. |
| `engine_events` | Engine decisions and warnings. 14-day retention. |

## Assistant tools

| Tool | Purpose |
|---|---|
| `ocpp_summary`, `search_ocpp_messages`, `search_engine_events`, `current_state`, `sessions` | Query the OCPP log, engine events, live state and sessions. |
| `charger_health` | Health indicators and **0–100 risk** per charger. |
| `charger_history` | Daily or hourly series. |
| `predict_failures` | Probability of an incident and of a fault within a horizon. |
| `energy_indicators` | Savings of the power control (see [energy-management.md](energy-management.md)). |
| `query_database` | Custom calculations: one read-only SELECT on PostgreSQL (read-only transaction, 5 s) or a Mongo aggregation limited to safe stages and collections. Max 200 rows. |
| `navigate_dashboard` | Takes the user to a section (with optional charger and OCPP action). |

## Health indicators

- **Availability** = 1 − disconnected time / observed time.
- **MTBF** = observed hours / incidents; **MTTR** = down hours / incidents (incident = fault or disconnection).
- **OCPP errors** per thousand frames, rejected profiles, **communication gaps** longer than 15 minutes.
- **Short sessions** and **abnormal stops** (`Other`, `PowerLoss`, `EmergencyStop`…).
- **Setpoint tracking** = delivered / allocated power (with SoC < 75 %, to exclude the end-of-charge taper). A value
  below 0.9 sustained suggests degradation of the power hardware.

**Risk 0–100** = weighted sum of: fault rate (30), disconnection rate (20), availability deficit (15), growing incident
trend (15), OCPP errors (10) and setpoint-tracking deficit (10). Rates use the last 7 days (current condition) and the
trend uses the whole window. Levels: low < 25 ≤ medium < 50 ≤ high < 75 ≤ critical.

## Forecast model

For each charger, over the daily incident series of the window (30 days by default):

- Daily rate **λ = 0.5 · EWMA(α = 0.3) + 0.5 · linear regression projected** to mid-horizon.
- **P(≥ 1 incident in h days) = 1 − e^(−λ·h)** (Poisson process). The same for faults.
- **Trend**: weekly slope relative to the mean (> +20 % worsening, < −20 % improving; needs ≥ 3 incidents).
- **Anomaly**: z-score of the last day against the previous ones.
- **Days until 1 incident/day** if the trend continues, and **setpoint-tracking degradation** (days until < 85 %).
- **Confidence** from the available days and events, and a **recommendation** (`corrective-maintenance-asap`,
  `preventive-inspection-soon`, `monitor`, `no-action`).

## Validation with synthetic history

The `HIST-*` history (30 days, 6 chargers) makes **HIST-03 and HIST-05 degrade** from 40 % of the period with
d(t) = ((t − start)/(end − start))^1.5:

| Quantity | Healthy | Degraded |
|---|---|---|
| Faults / day | 0.02 | 0.02 + 2.5·d (causes biased to `HighTemperature`, `OverCurrentFailure`) |
| Communication drops / day | 0.08 | 0.08 + 3·d (longer) |
| Communication gaps / day | 0 | 4·d |
| Setpoint tracking | 0.98 | 0.98 − 0.25·d |
| Abnormal stops | 2 % | 2 % + 25 %·d |

Result (30-day window, 7-day horizon), unchanged after the migration to the Go motor: HIST-03 and HIST-05 critical
(risk ~80, fault probability ≈ 1, worsening, tracking 0.71); the rest low risk and stable.

Faults can also be injected into the live fleet: `--fallas 0.03 --caidas 0.05 --degradar 3` (rates per simulated hour;
charger 3 ages up to ×10).

## Configuration

Put `ANTHROPIC_API_KEY` in `bff/.env` and restart the BFF. Default model `claude-opus-5-5` (`AGENT_MODEL`), effort
medium. Every question uses API tokens.
