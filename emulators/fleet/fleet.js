#!/usr/bin/env node
// Simulador de flota: N cargadores × M conectores con llegadas aleatorias de los vehículos registrados.
// Pensado para experimentos reproducibles (misma --seed ⇒ misma secuencia de decisiones aleatorias).
//
// Perfiles:
//   car (por defecto) autos AC con llegadas aleatorias (proceso de Bernoulli por conector).
//   bus               depósito nocturno de buses eléctricos: cargadores DC de --maxkw (150 kW), un conjunto declarado de
//                     buses (creados en el motor si faltan), llegadas 21:00–00:00, salidas 05:00–07:00 en tiempo
//                     simulado; cada llegada crea un plan de carga en el motor (salida, SoC objetivo y mínimo).
//
// Uso:
//   node emulators/fleet/fleet.js --chargers 4 --connectors 2 --speed 60 --duration 30 --arrival 0.05 --mode mixed --seed 42
//   node emulators/fleet/fleet.js --profile bus --chargers 10 --connectors 1 --speed 60 --prefix DEPOT --csv depot.csv
//
// Opciones comunes (valor por defecto):
//   --profile    car                        car | bus
//   --url        ws://localhost:9100/ocpp   OCPP gateway base URL (/<chargePointId> is appended)
//   --api        http://localhost:9200      motor domain API (vehicles, chargers, charging plans, state)
//   --chargers   4                          número de cargadores
//   --connectors 2                          conectores por cargador (1–4)
//   --maxkw      22 (bus: 150)              potencia máxima por conector (kW)
//   --phases     3                          fases de los cargadores (AC)
//   --speed      60                         aceleración del tiempo: 1 s real = speed s simulados
//   --duration   30                         duración del experimento en MINUTOS REALES (bus: si se omite, hasta la
//                                           última salida)
//   --seed       42                         semilla del generador pseudoaleatorio (mulberry32)
//   --prefix     FLEET                      prefijo de los chargePointId (FLEET-01, FLEET-02…)
//   --meter      5 (bus: 2)                 s reales entre MeterValues
//   --report     10                         s reales entre resúmenes por consola
//   --quiet                                 sin eventos individuales (sólo resúmenes)
//   --fallas     0                          prob. de avería (Faulted) por conector y HORA SIMULADA (repara en 0,5–3 h sim.)
//   --caidas     0                          prob. de caída de comunicación por cargador y HORA SIMULADA (reconecta a los 5 s)
//   --degradar   ""                         números de cargador (p. ej. "2,4") cuya tasa de fallas y caídas crece
//                                           durante el experimento hasta ×10 al final (envejecimiento simulado)
//
// Perfil car:
//   --arrival    0.05                       probabilidad de que llegue un VE a un conector libre
//                                           en cada MINUTO SIMULADO (proceso de Bernoulli ≈ Poisson;
//                                           tasa media ≈ arrival × 60 llegadas/hora simulada por conector)
//   --dwell      2-8                        estancia máxima en HORAS SIMULADAS (uniforme min-max); el VE se
//                                           va antes si alcanza su SoC objetivo
//   --soc        10-60                      SoC inicial (%) uniforme
//   --mode       mixed                      rfid | autocharge | iso15118 | mixed (aleatorio por llegada)
//
// Perfil bus:
//   --buses      10                         cuántos buses del conjunto declarado (máx. 10)
//   --start      20:30                      hora simulada de inicio
//   --arrive     21:00-00:00                ventana de llegadas (hora simulada, uniforme)
//   --depart     05:00-07:00                ventana de salidas (hora simulada, uniforme)
//   --soc        15-50                      SoC de llegada (%) uniforme
//   --target     90                         SoC objetivo (%); el bus deja de pedir energía al alcanzarlo
//   --minsoc     80                         SoC mínimo exigido a la salida (%)
//   --dcv        650                        tensión DC (V) para convertir límites en A y Current.Import
//   --csv        ""                         ruta del CSV con los resultados por bus
//   --sitekw     0                          si > 0, fija el límite del patio en el motor (PUT /api/v1/config)
//   --strategy   ""                         si se indica, fija la estrategia del motor (p. ej. weighted)
//
// Ctrl+C: detiene todas las sesiones abiertas (StopTransaction) y cierra las conexiones.
import { writeFileSync } from 'node:fs';
import { ChargePoint, vehicleFromApi } from '../web/emu-core.mjs';

// ---------- argumentos ----------
const DEFAULTS = {
  profile: 'car',
  url: 'ws://localhost:9100/ocpp', api: 'http://localhost:9200', chargers: 4, connectors: 2, maxkw: 22, phases: 3,
  speed: 60, duration: 30, arrival: 0.05, dwell: '2-8', soc: '10-60', mode: 'mixed', seed: 42, prefix: 'FLEET',
  meter: 5, report: 10, quiet: false, fallas: 0, caidas: 0, degradar: '',
  // perfil bus
  buses: 10, start: '20:30', arrive: '21:00-00:00', depart: '05:00-07:00', target: 90, minsoc: 80, dcv: 650, csv: '',
  sitekw: 0, strategy: '',
};
const BUS_DEFAULTS = { maxkw: 150, soc: '15-50', meter: 2 };

function parseArgs(argv) {
  const a = { ...DEFAULTS };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (!(k in DEFAULTS)) throw new Error(`Opción desconocida: ${argv[i]}`);
    given.add(k);
    if (typeof DEFAULTS[k] === 'boolean') a[k] = true;
    else a[k] = typeof DEFAULTS[k] === 'number' ? Number(argv[++i]) : argv[++i];
  }
  if (!['car', 'bus'].includes(a.profile)) throw new Error('--profile inválido (car | bus)');
  if (a.profile === 'bus') for (const [k, v] of Object.entries(BUS_DEFAULTS)) if (!given.has(k)) a[k] = v;
  a.given = given;
  const range = (s) => {
    const [lo, hi] = String(s).split('-').map(Number);
    return [lo, hi ?? lo];
  };
  a.degradeSet = new Set(String(a.degradar).split(',').map((x) => Number(x.trim())).filter(Boolean));
  a.dwellH = range(a.dwell);
  a.socRange = range(a.soc);
  a.connectors = Math.min(4, Math.max(1, a.connectors));
  if (!['rfid', 'autocharge', 'iso15118', 'mixed'].includes(a.mode)) throw new Error('--mode inválido');
  return a;
}
const args = parseArgs(process.argv.slice(2));

// ---------- PRNG reproducible ----------
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(args.seed);
const uniform = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const ts = () => new Date().toLocaleTimeString();
const say = (msg) => console.log(`${ts()}  ${msg}`);
const event = (msg) => !args.quiet && say(msg);

// ---------- estado del experimento ----------
const stats = {
  arrivals: 0, started: 0, rejected: 0, noVehicle: 0, completed: 0, energyWh: 0,
  byMode: { rfid: 0, autocharge: 0, iso15118: 0 }, byReason: {},
};
const inUse = new Set(); // id de vehículos actualmente enchufados
let simSeconds = 0;
let stopping = false;

// ---------- utilidades compartidas ----------
// Optional shared secret of the motor API (MOTOR_TOKEN env var), needed when the motor runs with one (server stack).
const authHeaders = process.env.MOTOR_TOKEN ? { 'X-Motor-Token': process.env.MOTOR_TOKEN } : {};
const fetchMotor = (path) => fetch(`${args.api}${path}`, { headers: authHeaders });
async function api(method, path, body) {
  const res = await fetch(`${args.api}${path}`, {
    method,
    headers: { ...authHeaders, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = new Error(`${method} ${path} → ${res.status} ${data?.detail || data?.title || text || ''}`.trim());
    e.status = res.status;
    throw e;
  }
  return data;
}

function makeChargers({ vendor, model, maxKw, currentType, dcVoltage }) {
  const cps = [];
  for (let i = 0; i < args.chargers; i++) {
    const cpId = `${args.prefix}-${String(i + 1).padStart(2, '0')}`;
    const cp = new ChargePoint({
      url: args.url, cpId, vendor, model, connectors: args.connectors, maxKw,
      phases: args.phases, meterInterval: args.meter, speed: args.speed, currentType, dcVoltage,
      log: (cls, text) => {
        if ((cls === 'error' || cls === 'warn') && !stopping) event(`[${cpId}] ${text}`);
      },
    });
    cp.connectors.forEach((c) => (c.fleet = null));
    cp.connect();
    cps.push(cp);
  }
  return cps;
}

async function waitReady(cps) {
  await Promise.race([
    Promise.all(cps.map((cp) => cp.ready)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Los cargadores no arrancaron en 15 s')), 15000)),
  ]);
  say(`${cps.length} cargadores conectados y aceptados (BootNotification).`);
}

/** Inyección de fallas (averías y caídas de comunicación). Devuelve true si el cargador se cayó en este paso. */
function injectFaults(cp, ci, dtSim, progress) {
  // Envejecimiento simulado: los cargadores degradados multiplican su tasa de fallas hasta ×10 al final
  const mult = args.degradeSet.has(ci + 1) ? 1 + 9 * progress : 1;
  if (args.caidas > 0 && rnd() < 1 - Math.pow(1 - Math.min(1, args.caidas * mult), dtSim / 3600)) {
    stats.drops = (stats.drops || 0) + 1;
    event(`[${cp.o.cpId}] ⚠ caída de comunicación simulada`);
    cp.ws?.close(4000, 'Caída simulada'); // emu-core reconecta solo a los 5 s
    return true;
  }
  if (args.fallas > 0)
    for (const c of cp.connectors) {
      if (c.faulted || rnd() >= 1 - Math.pow(1 - Math.min(1, args.fallas * mult), dtSim / 3600)) continue;
      c.faultCode = pick(args.degradeSet.has(ci + 1) ? ['HighTemperature', 'HighTemperature', 'OverCurrentFailure'] : ['GroundFailure', 'OverCurrentFailure', 'HighTemperature', 'ConnectorLockFailure', 'PowerMeterFailure']);
      stats.faults = (stats.faults || 0) + 1;
      event(`[${cp.o.cpId}/${c.id}] ⚠ avería simulada ${c.faultCode}`);
      cp.toggleFault(c);
      const repairS = (uniform(0.5, 3) * 3600) / args.speed;
      setTimeout(() => {
        if (c.faulted) {
          cp.toggleFault(c);
          event(`[${cp.o.cpId}/${c.id}] avería reparada`);
        }
      }, repairS * 1000);
    }
  return false;
}

// =====================================================================================================
// Perfil car (autos AC, llegadas aleatorias)
// =====================================================================================================
async function mainCar() {
  const res = await fetchMotor(`/api/v1/vehicles`);
  if (!res.ok) throw new Error(`GET /api/v1/vehicles → ${res.status}`);
  // Los buses del depósito (perfil bus) no participan en el perfil de autos
  const vehicles = (await res.json()).map(vehicleFromApi).filter((v) => !isDepotBus(v));
  if (!vehicles.length) throw new Error('No hay vehículos registrados en el CSMS');

  say(
    `Flota: ${args.chargers} cargadores × ${args.connectors} conectores, ${vehicles.length} vehículos, ` +
      `x${args.speed}, ${args.duration} min reales (${((args.duration * args.speed) / 60).toFixed(1)} h simuladas), ` +
      `llegada p=${args.arrival}/min sim, modo ${args.mode}, semilla ${args.seed}`,
  );

  const cps = makeChargers({ vendor: 'EmuCharge', model: 'AC-Fleet', maxKw: args.maxkw, currentType: 'AC' });
  await waitReady(cps);

  const startedAt = Date.now();
  const endAt = startedAt + args.duration * 60000;
  let last = Date.now();
  let lastReport = Date.now();

  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    clearInterval(loop);
    say(`Fin del experimento (${why}). Cerrando sesiones abiertas…`);
    for (const cp of cps) for (const c of cp.connectors) if (c.txId) await finish(cp, c, why === 'Ctrl+C' ? 'Local' : 'Other', 'fin del experimento');
    await new Promise((r) => setTimeout(r, 800));
    cps.forEach((cp) => cp.disconnect());
    summary(true);
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));

  const loop = setInterval(async () => {
    const now = Date.now();
    const dtSim = ((now - last) / 1000) * args.speed;
    last = now;
    simSeconds += dtSim;
    const pArrive = 1 - Math.pow(1 - args.arrival, dtSim / 60);

    const progress = Math.min(1, (now - startedAt) / (args.duration * 60000));
    for (const [ci, cp] of cps.entries()) {
      if (!cp.online) continue;
      if (injectFaults(cp, ci, dtSim, progress)) continue;
      for (const c of cp.connectors) {
        if (c.fleet) {
          // VE presente: ¿se va?
          const f = c.fleet;
          f.simStay += dtSim;
          if (f.leaving) continue;
          // La sesión terminó desde fuera (RemoteStop del CSMS, Reset, reinicio del servidor): el VE se va.
          if (f.started && !c.txId) {
            f.leaving = true;
            finish(cp, c, 'Remote', 'detenida por el CSMS');
            continue;
          }
          const full = c.soc >= c.vehicle.targetSoc || c.status === 'SuspendedEV';
          if (full || f.simStay >= f.dwellS) {
            f.leaving = true;
            finish(cp, c, full ? 'EVDisconnected' : 'Local', full ? 'SoC objetivo' : 'fin de estancia');
          }
        } else if (!c.plugged && !c.faulted && rnd() < pArrive) {
          arrive(cp, c, vehicles);
        }
      }
    }
    if (now - lastReport >= args.report * 1000) {
      lastReport = now;
      await report(cps);
    }
    if (now >= endAt) shutdown('duración alcanzada');
  }, 1000);
}

async function arrive(cp, c, vehicles) {
  stats.arrivals++;
  const free = vehicles.filter((v) => !inUse.has(v.id));
  if (!free.length) {
    stats.noVehicle++;
    return;
  }
  const v = pick(free);
  let mode = args.mode === 'mixed' ? pick(['rfid', 'autocharge', 'iso15118']) : args.mode;
  if (mode === 'autocharge' && !v.evccid) mode = 'rfid';
  if (mode === 'iso15118' && !v.vin) mode = v.evccid ? 'autocharge' : 'rfid';
  const soc = uniform(args.socRange[0], args.socRange[1]);
  const dwellS = uniform(args.dwellH[0], args.dwellH[1]) * 3600;

  inUse.add(v.id);
  cp.setVehicle(c, v, mode, soc);
  c.fleet = { vehicleId: v.id, simStay: 0, dwellS, leaving: false, meterStart: c.meterWh, mode };
  cp.plug(c);
  await new Promise((r) => setTimeout(r, 300)); // que llegue VehicleInfo antes de StartTransaction
  const ok = await cp.startTx(c);
  if (ok) {
    c.fleet.started = true;
    stats.started++;
    stats.byMode[mode]++;
    c.fleet.meterStart = c.meterWh;
    event(`[${cp.o.cpId}/${c.id}] llega ${v.name} (SoC ${soc.toFixed(0)} % → ${v.targetSoc} %, ${mode}, tag ${c.activeTag}) · sesión #${c.txId}`);
  } else {
    stats.rejected++;
    event(`[${cp.o.cpId}/${c.id}] ${v.name}: inicio rechazado`);
    cp.unplug(c);
    inUse.delete(v.id);
    c.fleet = null;
  }
}

async function finish(cp, c, reason, why = reason) {
  const f = c.fleet;
  const tx = c.txId;
  if (tx) {
    const wh = c.meterWh - (f?.meterStart ?? c.meterWh);
    stats.energyWh += wh;
    stats.completed++;
    stats.byReason[why] = (stats.byReason[why] || 0) + 1;
    event(`[${cp.o.cpId}/${c.id}] se va ${c.vehicle.name}: ${(wh / 1000).toFixed(2)} kWh, SoC ${c.soc.toFixed(0)} % (${why}) · sesión #${tx}`);
    await cp.stopTx(c, reason);
  }
  setTimeout(() => {
    cp.unplug(c);
    if (f) inUse.delete(f.vehicleId);
    c.fleet = null;
  }, stopping ? 0 : 2000);
}

async function report(cps) {
  let active = 0;
  let kw = 0;
  for (const cp of cps)
    for (const c of cp.connectors)
      if (c.txId) {
        active++;
        kw += c.powerW / 1000;
      }
  let extra = '';
  try {
    const s = await (await fetchMotor(`/api/v1/state`)).json();
    extra = ` · CSMS: disponible ${(s.availableW / 1000).toFixed(1)} kW, asignado ${(s.totalAllocatedW / 1000).toFixed(1)} kW, estrategia ${s.config.strategy}`;
  } catch {
    /* API no disponible */
  }
  say(`t_sim ${(simSeconds / 3600).toFixed(2)} h · sesiones activas ${active} · potencia VE ${kw.toFixed(1)} kW${extra}`);
}

function summary(final) {
  console.log(`\n===== Resumen ${final ? 'final' : ''} =====`);
  console.log(`Tiempo simulado:        ${(simSeconds / 3600).toFixed(2)} h`);
  console.log(`Llegadas:               ${stats.arrivals} (sin vehículo libre: ${stats.noVehicle})`);
  console.log(`Sesiones iniciadas:     ${stats.started} (rechazadas: ${stats.rejected})`);
  console.log(`Sesiones cerradas:      ${stats.completed}  ${JSON.stringify(stats.byReason)}`);
  console.log(`Por identificación:     ${JSON.stringify(stats.byMode)}`);
  if (args.fallas || args.caidas) console.log(`Fallas inyectadas:      ${stats.faults || 0} averías, ${stats.drops || 0} caídas de comunicación`);
  console.log(`Energía entregada:      ${(stats.energyWh / 1000).toFixed(2)} kWh`);
  console.log(`Datos detallados (BFF):  http://localhost:9000/api/v1/exports/sessions.csv`);
}

// =====================================================================================================
// Perfil bus (depósito nocturno, cargadores DC)
// =====================================================================================================

// Conjunto declarado de buses del depósito. importance → prioridad del vehículo en el motor (1–10).
const BUS_FLEET = [
  { make: 'BYD', model: 'K9', batteryKWh: 324, importance: 7 },
  { make: 'Yutong', model: 'E12', batteryKWh: 350, importance: 5 },
  { make: 'Foton', model: 'U12', batteryKWh: 280, importance: 4 },
  { make: 'King Long', model: 'XMQ6127', batteryKWh: 400, importance: 6 },
  { make: 'Zhongtong', model: 'LCK6122', batteryKWh: 380, importance: 5 },
  { make: 'BYD', model: 'K9', batteryKWh: 324, importance: 8 },
  { make: 'Yutong', model: 'E12', batteryKWh: 350, importance: 3 },
  { make: 'Volvo', model: 'BZL', batteryKWh: 420, importance: 6 },
  { make: 'Higer', model: 'KLQ6125', batteryKWh: 300, importance: 4 },
  { make: 'Mercedes-Benz', model: 'eCitaro', batteryKWh: 396, importance: 9 },
].map((b, i) => {
  const nn = String(i + 1).padStart(2, '0');
  return {
    ...b,
    n: i + 1,
    name: `Bus ${nn} ${b.make} ${b.model}`,
    vin: `XS0EBUSDEPT0000${nn}`, // 17 caracteres, sin I/O/Q
    evccid: `EB05DE0000${nn}`, // 12 dígitos hexadecimales
    idTag: `BUS-${nn}`,
    maxDcKw: 150,
    maxAcKw: 22, // cargador a bordo (respaldo AC)
  };
});
const BUS_TAG = /^BUS-\d{2}$/;
function isDepotBus(v) {
  return BUS_TAG.test(v.idTag || v.id_tag || '');
}

function busBody(b, legacy = false) {
  const body = {
    name: b.name, make: b.make, model: b.model, vin: b.vin, evccid: b.evccid, id_tag: b.idTag,
    battery_kwh: legacy ? Math.min(300, b.batteryKWh) : b.batteryKWh, max_ac_kw: b.maxAcKw, phases: 3,
    target_soc: args.target, priority: b.importance,
  };
  if (!legacy) Object.assign(body, { max_dc_kw: b.maxDcKw, min_soc: args.minsoc });
  return body;
}

/** Crea (o actualiza) los buses declarados en el motor, buscándolos por nombre. Idempotente. */
async function ensureBuses(buses) {
  const existing = await api('GET', '/api/v1/vehicles');
  const byName = new Map(existing.map((v) => [v.name, v]));
  let created = 0;
  let updated = 0;
  let legacyUsed = false;
  for (const b of buses) {
    const v = byName.get(b.name);
    const differs = (row) => {
      const want = busBody(b);
      return Object.entries(want).some(([k, w]) => {
        if (!(k in row)) return false; // campo que este motor no conoce (p. ej. max_dc_kw en versiones antiguas)
        if (typeof w === 'number') return Math.abs(Number(row[k]) - w) > 1e-6;
        return String(row[k] ?? '').toUpperCase() !== String(w).toUpperCase();
      });
    };
    const send = async (method, path) => {
      try {
        return await api(method, path, busBody(b));
      } catch (e) {
        if (e.status !== 400) throw e;
        // Motor sin los campos nuevos o con rangos de auto (p. ej. battery_kwh ≤ 300): cuerpo compatible
        legacyUsed = true;
        return await api(method, path, busBody(b, true));
      }
    };
    if (!v) {
      try {
        const row = await send('POST', '/api/v1/vehicles');
        b.vehicleId = row.id;
        created++;
      } catch (e) {
        say(`⚠ No se pudo crear ${b.name} (se identificará sólo por idTag ${b.idTag}): ${e.message}`);
      }
    } else {
      b.vehicleId = v.id;
      if (differs(v)) {
        try {
          await send('PUT', `/api/v1/vehicles/${v.id}`);
          updated++;
        } catch (e) {
          say(`⚠ No se pudo actualizar ${b.name}: ${e.message}`);
        }
      }
    }
  }
  say(
    `Buses en el motor: ${buses.length} (creados ${created}, actualizados ${updated})` +
      (legacyUsed ? ' · ⚠ el motor rechazó campos/rangos de bus; se usó un cuerpo compatible (batería ≤ 300 kWh, sin max_dc_kw/min_soc)' : ''),
  );
}

/** Presenta cada cargador como DC de maxkw en el motor (Capabilities ya anuncia la potencia; aquí el tipo). */
async function configureDcChargers(cps) {
  let rows = [];
  try {
    rows = await api('GET', '/api/v1/chargers');
  } catch (e) {
    say(`⚠ No se pudo leer /api/v1/chargers: ${e.message}`);
    return;
  }
  let typed = 0;
  for (const cp of cps) {
    const row = rows.find((r) => r.id === cp.o.cpId);
    const body = {};
    if (!row || row.current_type !== 'DC') body.currentType = 'DC';
    if (!row || Math.abs(Number(row.max_power_kw) - args.maxkw) > 0.01) body.maxPowerKw = args.maxkw;
    if (!Object.keys(body).length) continue;
    try {
      const after = await api('PUT', `/api/v1/chargers/${encodeURIComponent(cp.o.cpId)}`, body);
      if (after?.current_type === 'DC') typed++;
    } catch (e) {
      say(`⚠ PUT /chargers/${cp.o.cpId}: ${e.message}`);
    }
  }
  const after = await api('GET', '/api/v1/chargers').catch(() => []);
  const mine = after.filter((r) => cps.some((cp) => cp.o.cpId === r.id));
  const dc = mine.filter((r) => r.current_type === 'DC').length;
  const kw = [...new Set(mine.map((r) => r.max_power_kw))].join('/');
  say(
    `Cargadores en el motor: ${mine.length} a ${kw} kW` +
      (mine.some((r) => 'current_type' in r) ? `, ${dc} marcados DC` : ' (este motor no expone current_type; tipo DC no registrado)'),
  );
}

/** Cancela planes abiertos que hayan quedado en los cargadores de este prefijo (ejecuciones anteriores). */
async function cancelStalePlans() {
  try {
    const plans = await api('GET', '/api/v1/charging-plans');
    const stale = plans.filter((p) => String(p.charger_id).startsWith(`${args.prefix}-`) && ['scheduled', 'starting', 'active'].includes(p.status));
    for (const p of stale) await api('DELETE', `/api/v1/charging-plans/${p.id}`).catch(() => {});
    if (stale.length) say(`Planes abiertos de ejecuciones anteriores cancelados: ${stale.length}`);
  } catch (e) {
    say(`⚠ No se pudieron revisar los planes: ${e.message}`);
  }
}

const parseTod = (s) => {
  const [h, m] = String(s).trim().split(':').map(Number);
  if (!(h >= 0 && h <= 24 && m >= 0 && m < 60)) throw new Error(`Hora inválida: ${s}`);
  return h * 60 + m;
};
const todRange = (s) => {
  const [a, b] = String(s).split('-');
  return [parseTod(a), parseTod(b ?? a)];
};

async function mainBus() {
  const startMin = parseTod(args.start);
  const offS = (min) => (((min - startMin) % 1440) + 1440) % 1440 * 60; // s simulados desde el inicio
  const clock = (s) => {
    const m = Math.floor(startMin + s / 60) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const [arrA, arrB] = todRange(args.arrive).map(offS);
  const [depA, depB] = todRange(args.depart).map(offS);
  if (!(depA > arrB)) throw new Error('--depart debe ser posterior a --arrive (respecto de --start)');

  const buses = BUS_FLEET.slice(0, Math.max(1, Math.min(BUS_FLEET.length, args.buses))).map((b) => ({
    ...b,
    arriveS: uniform(arrA, arrB === arrA ? arrA + 1 : arrB),
    departS: uniform(depA, depB === depA ? depA + 1 : depB),
    socArrival: uniform(args.socRange[0], args.socRange[1]),
    state: 'pending', // pending → queued → plugged → (parked) → departed
    sessions: [],
    energyWh: 0,
    peakW: 0,
  }));

  let siteLimitKw = null;
  let buildingW = 0;
  try {
    if (args.sitekw > 0 || args.strategy) {
      const patch = {};
      if (args.sitekw > 0) patch.siteLimitKw = args.sitekw;
      if (args.strategy) patch.strategy = args.strategy;
      await api('PUT', '/api/v1/config', patch).catch((e) => say(`⚠ PUT /config: ${e.message}`));
    }
    const cfg = await api('GET', '/api/v1/config');
    siteLimitKw = cfg.siteLimitKw ?? null;
    say(`Motor: límite del patio ${siteLimitKw} kW, estrategia ${cfg.strategy}, unidad ${cfg.chargingRateUnit}`);
  } catch (e) {
    say(`⚠ No se pudo leer la configuración del motor: ${e.message}`);
  }

  await ensureBuses(buses);
  await cancelStalePlans();

  const lastDepart = Math.max(...buses.map((b) => b.departS));
  const autoEnd = !args.given.has('duration');
  const realMin = ((lastDepart + 120) / args.speed) / 60;
  say(
    `Depósito: ${args.chargers} cargadores DC × ${args.connectors} conectores de ${args.maxkw} kW, ${buses.length} buses, ` +
      `x${args.speed}, inicio ${args.start}, llegadas ${args.arrive}, salidas ${args.depart}, SoC llegada ${args.soc} %, ` +
      `objetivo ${args.target} %, mínimo ${args.minsoc} %, semilla ${args.seed} · ` +
      (autoEnd ? `hasta la última salida (~${realMin.toFixed(1)} min reales)` : `${args.duration} min reales (${((args.duration * args.speed) / 60).toFixed(1)} h simuladas)`),
  );

  const cps = makeChargers({ vendor: 'EmuCharge', model: `DC-Depot-${args.maxkw}`, maxKw: args.maxkw, currentType: 'DC', dcVoltage: args.dcv });
  await waitReady(cps);
  await new Promise((r) => setTimeout(r, 1000)); // que el motor procese Capabilities
  await configureDcChargers(cps);

  const conns = cps.flatMap((cp) => cp.connectors.map((c) => ({ cp, c })));
  const busOn = new Map(); // connector → bus
  const startedAt = Date.now();
  const endAt = autoEnd ? Infinity : startedAt + args.duration * 60000;
  let last = Date.now();
  let lastReport = Date.now();
  const peak = { evW: 0, evAt: 0 };
  const dstats = { plans: 0, planFail: 0, localStarts: 0, sessions: 0 };

  const realAt = (simS) => Date.now() + ((simS - simSeconds) / args.speed) * 1000; // instante real de un tiempo simulado

  const busVehicle = (b) => ({
    id: b.vehicleId ?? null, name: b.name, vin: b.vin, evccid: b.evccid, idTag: b.idTag, capKWh: b.batteryKWh,
    maxKw: b.maxDcKw, maxDcKw: b.maxDcKw, phases: 3, targetSoc: args.target, stopSoc: args.target, taperSoc: 80, taperFloor: 0.2,
  });

  const requestCharge = async (b) => {
    const { cp, c } = b.slot;
    b.requestedAt = Date.now();
    b.localTried = false;
    const body = {
      chargerId: cp.o.cpId, connectorId: c.id, departureAt: Math.round(realAt(b.departS)),
      targetSoc: args.target, minSoc: args.minsoc,
    };
    if (b.vehicleId) body.vehicleId = b.vehicleId;
    else body.idTag = b.idTag;
    try {
      const plan = await api('POST', '/api/v1/charging-plans', body);
      b.planId = plan?.id ?? null;
      dstats.plans++;
      event(`[${cp.o.cpId}/${c.id}] ${b.name}: plan #${b.planId} (salida ${clock(b.departS)}, objetivo ${args.target} %, mínimo ${args.minsoc} %)`);
    } catch (e) {
      dstats.planFail++;
      event(`[${cp.o.cpId}/${c.id}] ${b.name}: plan rechazado (${e.message}); inicio local`);
      startLocal(b);
    }
  };

  const startLocal = async (b) => {
    if (b.localTried || !b.slot) return;
    b.localTried = true;
    const { cp, c } = b.slot;
    if (c.txId) return;
    const ok = await cp.startTx(c);
    if (ok) dstats.localStarts++;
    else event(`[${cp.o.cpId}/${c.id}] ${b.name}: inicio local rechazado`);
  };

  const arriveBus = (b) => {
    stats.arrivals++;
    b.state = 'queued';
    b.arrivedReal = Date.now();
    event(`Llega ${b.name} a las ${clock(b.arriveS)} (SoC ${b.socArrival.toFixed(0)} %, sale ${clock(b.departS)})`);
  };

  const plugBus = async (b, slot) => {
    const { cp, c } = slot;
    b.slot = slot;
    b.state = 'plugged';
    b.charger = cp.o.cpId;
    b.connector = c.id;
    busOn.set(c, b);
    cp.setVehicle(c, busVehicle(b), 'iso15118', b.soc ?? b.socArrival);
    cp.plug(c); // ISO 15118: DataTransfer VehicleInfo (VIN + EVCCID) al enchufar
    await new Promise((r) => setTimeout(r, 300));
    await requestCharge(b);
  };

  const closeSession = (b, reason) => {
    const s = b.current;
    if (!s) return;
    const { c } = b.slot;
    s.energyWh = c.meterWh - s.meterStart;
    s.socEnd = c.soc;
    s.reason = reason;
    b.energyWh += s.energyWh;
    stats.energyWh += s.energyWh;
    stats.completed++;
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
    b.current = null;
    event(`[${b.charger}/${b.connector}] ${b.name}: sesión #${s.txId} cerrada (${reason}), ${(s.energyWh / 1000).toFixed(1)} kWh, SoC ${c.soc.toFixed(1)} %`);
  };

  const departBus = async (b) => {
    b.state = 'departed';
    b.departedAtSim = simSeconds;
    if (b.slot) {
      const { cp, c } = b.slot;
      b.soc = c.soc;
      if (c.txId) {
        cp.sendMeterValues(c);
        closeSession(b, 'salida (EVDisconnected)');
        await cp.stopTx(c, 'EVDisconnected');
      }
      busOn.delete(c);
      b.slot = null;
      setTimeout(() => cp.unplug(c), stopping ? 0 : 1000);
    }
    b.socDeparture = b.soc ?? b.socArrival;
    const ok = b.socDeparture >= args.minsoc - 1e-9;
    event(`Sale ${b.name} a las ${clock(b.departS)} con SoC ${b.socDeparture.toFixed(1)} % ${ok ? '✓' : `✗ (< ${args.minsoc} %)`}`);
  };

  const parkBus = (b) => {
    // Cargó y libera el cargador para un bus en espera (se estaciona sin cargador hasta la salida)
    const { cp, c } = b.slot;
    b.soc = c.soc;
    busOn.delete(c);
    b.slot = null;
    b.state = 'parked';
    cp.unplug(c);
    event(`${b.name} libera ${b.charger}/${b.connector} (SoC ${b.soc.toFixed(1)} %)`);
  };

  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    clearInterval(loop);
    say(`Fin del experimento (${why}). Cerrando sesiones abiertas…`);
    for (const b of buses) {
      if (b.slot) {
        const { cp, c } = b.slot;
        b.soc = c.soc;
        if (c.txId) {
          closeSession(b, 'fin del experimento');
          await cp.stopTx(c, why === 'Ctrl+C' ? 'Local' : 'Other');
        }
      }
    }
    await new Promise((r) => setTimeout(r, 800));
    cps.forEach((cp) => cp.disconnect());
    busSummary(buses, peak, dstats, siteLimitKw, clock);
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));

  const loop = setInterval(async () => {
    const now = Date.now();
    const dtSim = ((now - last) / 1000) * args.speed;
    last = now;
    simSeconds += dtSim;
    const progress = autoEnd ? Math.min(1, simSeconds / lastDepart) : Math.min(1, (now - startedAt) / (args.duration * 60000));

    // Potencia de carga del patio (medida por los cargadores emulados)
    const evW = conns.reduce((a, { c }) => a + (c.txId ? c.powerW : 0), 0);
    if (evW > peak.evW) Object.assign(peak, { evW, evAt: simSeconds });

    for (const [ci, cp] of cps.entries()) if (cp.online) injectFaults(cp, ci, dtSim, progress);

    for (const b of buses) {
      if (b.state === 'pending' && simSeconds >= b.arriveS) arriveBus(b);
      if (b.state !== 'pending' && b.state !== 'departed' && simSeconds >= b.departS) {
        departBus(b);
        continue;
      }
      if (b.state !== 'plugged') continue;
      const { cp, c } = b.slot;
      if (c.faulted && b.current) b.faultHit = true;
      // Inicio de sesión (por el plan → RemoteStartTransaction, o local)
      if (c.txId && (!b.current || b.current.txId !== c.txId)) {
        if (b.current) closeSession(b, 'reemplazada');
        b.current = { txId: c.txId, meterStart: c.meterWh, socStart: c.soc, startSim: simSeconds, method: b.localTried ? 'local' : 'plan' };
        b.sessions.push(b.current);
        b.txIds = [...(b.txIds || []), c.txId];
        b.targetSeenAt = null;
        stats.started++;
        dstats.sessions++;
        event(`[${cp.o.cpId}/${c.id}] ${b.name}: sesión #${c.txId} iniciada (${b.current.method}, tag ${c.activeTag})`);
      }
      if (c.txId) {
        b.peakW = Math.max(b.peakW, c.powerW);
        // Objetivo alcanzado: el bus deja de pedir energía; se informa el SoC para que el motor cierre el plan,
        // y si no lo detiene en 5 s reales el cargador termina la sesión localmente.
        if (c.soc >= args.target) {
          if (!b.targetSeenAt) {
            b.targetSeenAt = now;
            cp.sendMeterValues(c);
          } else if (now - b.targetSeenAt > 5000) {
            closeSession(b, 'SoC objetivo (local)');
            cp.stopTx(c, 'Local');
          }
        }
      } else if (b.current) {
        // La sesión terminó desde fuera (RemoteStop del motor al llegar al objetivo, avería, reset…)
        closeSession(b, c.soc >= args.target - 0.5 ? 'SoC objetivo (motor)' : b.faultHit ? 'avería' : 'detenida por el CSMS');
      } else if (!b.localTried && b.requestedAt && now - b.requestedAt > 20000) {
        // El plan no arrancó la sesión en 20 s reales: el bus la inicia por su cuenta
        event(`[${cp.o.cpId}/${c.id}] ${b.name}: el plan no inició la sesión; inicio local`);
        startLocal(b);
      }
      // Tras una avería reparada, si aún le falta carga, pide un plan nuevo (máx. 3)
      if (!c.txId && !b.current && b.faultHit && !c.faulted && c.soc < args.target - 1 && (b.retries || 0) < 3) {
        b.faultHit = false;
        b.retries = (b.retries || 0) + 1;
        requestCharge(b);
      }
    }

    // Buses en espera: conectores libres o liberados por buses que ya cargaron
    const queue = buses.filter((b) => b.state === 'queued').sort((x, y) => x.arriveS - y.arriveS);
    for (const b of queue) {
      let slot = conns.find(({ cp, c }) => cp.online && !c.plugged && !c.faulted && !busOn.has(c));
      if (!slot) {
        const done = buses.find((o) => o.state === 'plugged' && !o.slot.c.txId && !o.current && o.slot.c.soc >= args.target - 0.5);
        if (done) {
          slot = done.slot;
          parkBus(done);
        }
      }
      if (!slot) break;
      plugBus(b, slot);
    }

    if (now - lastReport >= args.report * 1000) {
      lastReport = now;
      let extra = '';
      try {
        const s = await (await fetchMotor(`/api/v1/state`)).json();
        buildingW = Number(s.buildingLoadW) || 0;
        extra = ` · CSMS: edificio ${(buildingW / 1000).toFixed(1)} kW, disponible ${(s.availableW / 1000).toFixed(1)} kW, asignado ${(s.totalAllocatedW / 1000).toFixed(1)} kW, estrategia ${s.config.strategy}`;
      } catch {
        /* API no disponible */
      }
      const count = (st) => buses.filter((b) => b.state === st).length;
      const charging = conns.filter(({ c }) => c.txId).length;
      say(
        `${clock(simSeconds)} (t_sim ${(simSeconds / 3600).toFixed(2)} h) · cargando ${charging} · en espera ${count('queued')} · ` +
          `salidos ${count('departed')}/${buses.length} · potencia VE ${(evW / 1000).toFixed(1)} kW${extra}`,
      );
    }
    if (now >= endAt) shutdown('duración alcanzada');
    else if (autoEnd && buses.every((b) => b.state === 'departed')) shutdown('todos los buses salieron');
  }, 1000);
}

function busSummary(buses, peak, dstats, siteLimitKw, clock) {
  const departed = buses.filter((b) => b.state === 'departed');
  const okMin = departed.filter((b) => b.socDeparture >= args.minsoc - 1e-9);
  const okTarget = departed.filter((b) => b.socDeparture >= args.target - 0.5);
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)} %` : '–');
  console.log('\n===== Resumen final (depósito de buses) =====');
  console.log(`Tiempo simulado:        ${(simSeconds / 3600).toFixed(2)} h (${args.start} → ${clock(simSeconds)})`);
  console.log(`Llegadas:               ${stats.arrivals} de ${buses.length} buses`);
  console.log(`Sesiones:               ${dstats.sessions} (planes creados ${dstats.plans}, planes rechazados ${dstats.planFail}, inicios locales ${dstats.localStarts})`);
  console.log(`Sesiones cerradas:      ${stats.completed}  ${JSON.stringify(stats.byReason)}`);
  if (args.fallas || args.caidas) console.log(`Fallas inyectadas:      ${stats.faults || 0} averías, ${stats.drops || 0} caídas de comunicación`);
  console.log(`Energía entregada:      ${(stats.energyWh / 1000).toFixed(1)} kWh`);
  console.log(
    `Potencia VE máxima:     ${(peak.evW / 1000).toFixed(1)} kW a las ${clock(peak.evAt)}` +
      (siteLimitKw != null ? ` (límite del patio ${siteLimitKw} kW, incluida la carga del edificio)` : ''),
  );
  console.log(`Salidas:                ${departed.length} de ${buses.length}`);
  console.log(`Salen con SoC ≥ ${args.minsoc} %:   ${okMin.length}/${departed.length} (${pct(okMin.length, departed.length)})`);
  console.log(`Salen con SoC ≥ ${args.target} %:   ${okTarget.length}/${departed.length} (${pct(okTarget.length, departed.length)})`);
  const pending = buses.filter((b) => b.state !== 'departed');
  if (pending.length) console.log(`Sin salir al terminar:  ${pending.map((b) => `${b.idTag} (${b.state})`).join(', ')}`);

  console.log('\nBus     Cargador     Llega  Sale   SoC ini → sal   kWh    kW máx  Sesión');
  for (const b of buses) {
    const soc = b.socDeparture ?? b.soc ?? b.slot?.c.soc;
    console.log(
      `${b.idTag.padEnd(7)} ${String(b.charger ? `${b.charger}/${b.connector}` : '–').padEnd(12)} ${clock(b.arriveS)}  ${clock(b.departS)}  ` +
        `${b.socArrival.toFixed(0).padStart(3)} → ${soc != null ? soc.toFixed(1).padStart(5) : '    –'} %  ${(b.energyWh / 1000).toFixed(1).padStart(6)}  ` +
        `${(b.peakW / 1000).toFixed(1).padStart(6)}  ${(b.txIds || []).map((t) => `#${t}`).join(',') || '–'}`,
    );
  }

  if (args.csv) {
    const head = [
      'bus', 'name', 'vehicle_id', 'battery_kwh', 'importance', 'charger_id', 'connector_id', 'arrival', 'departure',
      'soc_arrival', 'soc_departure', 'target_soc', 'min_soc', 'met_min', 'met_target', 'energy_kwh', 'peak_kw', 'plan_id',
      'transaction_ids', 'start_method', 'stop_reason', 'state',
    ];
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = buses.map((b) => {
      const soc = b.socDeparture ?? b.soc ?? b.slot?.c.soc ?? null;
      const last = b.sessions[b.sessions.length - 1];
      return [
        b.idTag, b.name, b.vehicleId ?? '', b.batteryKWh, b.importance, b.charger ?? '', b.connector ?? '', clock(b.arriveS),
        clock(b.departS), b.socArrival.toFixed(1), soc != null ? soc.toFixed(1) : '', args.target, args.minsoc,
        b.state === 'departed' ? (soc >= args.minsoc - 1e-9 ? 'yes' : 'no') : '',
        b.state === 'departed' ? (soc >= args.target - 0.5 ? 'yes' : 'no') : '',
        (b.energyWh / 1000).toFixed(2), (b.peakW / 1000).toFixed(1), b.planId ?? '', (b.txIds || []).join(' '),
        b.sessions.map((s) => s.method).join(' '), last?.reason ?? '', b.state,
      ].map(q).join(',');
    });
    try {
      writeFileSync(args.csv, [head.join(','), ...rows].join('\n') + '\n', 'utf8');
      console.log(`\nCSV por bus:            ${args.csv}`);
    } catch (e) {
      console.log(`\n⚠ No se pudo escribir ${args.csv}: ${e.message}`);
    }
  }
  console.log(`Datos detallados (BFF):  http://localhost:9000/api/v1/exports/sessions.csv`);
}

(args.profile === 'bus' ? mainBus : mainCar)().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
