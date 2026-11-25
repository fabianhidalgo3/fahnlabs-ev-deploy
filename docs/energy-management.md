# Energy-management indicators

**Energy** section of the dashboard (`/energy`), API `GET /api/v1/energy/report` and the assistant tool
`energy_indicators`. Code: [`motor/internal/energy/energy.go`](../motor/internal/energy/energy.go).

## What is compared

| Scenario | How it is obtained |
|---|---|
| **With control** | Measured power of every session (MeterValues), held between samples. |
| **Without control** (reference) | *Immediate full-power charging*: each vehicle charges from arrival at `P_max = min(charger, on-board charger)` until it receives the **same energy** it got with control. |

Demand is measured in **15-minute averages**, as power is billed. Measured auxiliary loads (`site_samples`) are added
to both scenarios.

## Indicators

| Group | Indicator | Formula |
|---|---|---|
| Demand | Avoided peak (kW and %) | peak without control − peak with control |
| | Required grid connection | peak without control vs contracted (yard limit) |
| | Time over the limit | % of active windows with demand above the limit |
| Efficiency | Load factor | average demand / peak (higher = better use of the contracted power) |
| | Use of the contracted power | peak with control / limit |
| Economics | Demand-charge savings | avoided peak × charge per kW·month |
| | Energy cost and CLP/km | kWh × price; ÷ electric km |
| | Savings versus fuel | cost of the same km in a combustion car − electric cost |
| Environment | CO₂ avoided | km × combustion kg CO₂/km − kWh × grid factor |
| Cost of control | Extra minutes per session | actual duration − full-power duration |
| | Shifted energy | maximum cumulative energy delivered later than without control |
| | Sessions reaching target | final SoC ≥ target, or unplugged by the driver |

## Assumptions (editable in the dashboard)

| Parameter | Default |
|---|---|
| Energy | 150 CLP/kWh |
| Demand charge | 9,000 CLP/kW·month |
| Grid emission factor | 0.29 kg CO₂/kWh |
| EV efficiency | 6 km/kWh |
| Combustion car emissions | 0.18 kg CO₂/km |
| Combustion car efficiency | 12 km/L |
| Fuel | 1,300 CLP/L |

Reference values for the prototype; for the thesis replace them with the yard's real tariff (e.g. AT4.3 / BT4.3) and
the official grid emission factor in force.

## Limitations

- Energy is integrated from the power samples, so the speeded-up simulator (`--speed` above 1) does not inflate the
  kWh; still, with acceleration sessions last less in real time and the demand comparison is indicative. To measure
  properly: `--speed 1`.
- The synthetic `HIST` history did not go through the allocation engine: it shows no savings and is excluded by default.
- Demand-charge savings assume the peak of the period is the peak of the billed month.
