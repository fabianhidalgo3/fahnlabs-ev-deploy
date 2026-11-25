# Deployment

One Linux server runs the whole stack with Docker Compose ([`deploy/`](../deploy)):

```
internet ──443──▶ caddy (HTTPS, Let's Encrypt) ──┬── /ocpp/*            ──▶ gateway :9100 ──▶ motor :9200 ──▶ postgres, mongo
                                                 ├── /emulator/* (login) ──▶ gateway :9100
                                                 └── everything else (login) ──▶ bff :9000 (front, /api/v1, /ws/live, Swagger)
```

Only Caddy publishes ports (80/443). The motor, the gateway API and the databases stay on the internal network,
protected also by `MOTOR_TOKEN` and `GATEWAY_TOKEN`. The dashboard and the emulator ask for a login (HTTP basic auth
in Caddy); the OCPP endpoint does not, because charge points cannot answer it (OCPP security profiles are future work).

## Server

| Item | Value |
|---|---|
| Size | 4 vCPU, 8 GB RAM is enough for the whole stack |
| OS | Linux with Docker Compose (tested on Ubuntu 26.04 LTS; see the MongoDB kernel note below) |
| Open ports | 80 and 443 (plus your SSH port); SSH with keys only |
| Public URL | `https://${DOMAIN}` (DNS A record → server IP) |
| Charge points | `wss://${DOMAIN}/ocpp/{chargePointId}` |
| App folder | `/opt/emob` (the five repositories side by side), `/opt/emob/ev-deploy/deploy/.env` (secrets, mode 600) |
| Dashboard login | HTTP basic auth in Caddy (`UI_USER`, `UI_PASSWORD_HASH`) |

## Images

The Docker context is the folder that holds the five repositories.

| Service | Dockerfile | Context | Notes |
|---|---|---|---|
| gateway | `ev-gateway/Dockerfile` | parent folder | Go → distroless; includes the web emulator from `ev-deploy/emulators/web` (`EMULATOR_DIR=/app/emulators/web`) |
| motor | `ev-engine/Dockerfile` | `ev-engine/` | Go → distroless; `POSTGRES_URL`, `MONGO_URI`, `GATEWAY_URL` set by compose |
| bff | `ev-bff/Dockerfile` | parent folder | Node builds the front from `ev-web`, JDK 25 builds the jar, JRE 25 runs it (`FRONT_DIR=/app/front`) |

The BFF reports the public OCPP and emulator URLs from `OCPP_PUBLIC_URL` (`https://${DOMAIN}`).

## Deploy or update

On the server, clone or pull the five repositories into `/opt/emob` and rebuild:

```bash
cd /opt/emob
for r in ev-gateway ev-engine ev-bff ev-web ev-deploy; do
  [ -d $r ] && git -C $r pull || git clone https://github.com/fabianhidalgo3/fahnlabs-$r.git $r
done
cd ev-deploy/deploy && docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

First deployment only: create `deploy/.env` on the server from [`deploy/.env.example`](../deploy/.env.example) with
random secrets, and the login hash with `docker run --rm caddy:2.10-alpine caddy hash-password`.

## Demo chargers

The `fleet` service (compose profile `demo`) runs the fleet simulator inside the stack: 6 emulated chargers
`PATIO-01…06` with 2 connectors each, connected to the gateway, charging the registered vehicles around the clock
(60-minute runs at ×20, restarted automatically).

```bash
cd /opt/emob/ev-deploy/deploy
docker compose -f docker-compose.prod.yml --env-file .env --profile demo up -d fleet   # start
docker compose -f docker-compose.prod.yml stop fleet                                    # stop
```

## Known issues

- MongoDB 8+ refuses to start on Linux kernels 6.19 to 7.0.13 (TCMalloc/rseq incompatibility, MongoDB ticket
  SERVER-121912). Ubuntu's 7.0.0-44 kernel works.
- Backups are not configured yet.
