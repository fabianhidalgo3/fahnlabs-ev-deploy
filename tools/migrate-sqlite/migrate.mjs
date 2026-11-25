// One-off migration of the legacy SQLite database (Node motor) to PostgreSQL + MongoDB (Go motor).
//
//   node migrate.mjs <path/to/emob.sqlite> [path/to/config.json]
//
// Start the Go motor once before running it (it creates the schema and collections), then stop it.
// Postgres: vehicles (same ids) and chargers. Mongo: sessions, charging plans, meter samples, yard samples,
// charger events, OCPP log and engine events (only the last 14 days, as the TTL would drop older ones).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import pg from 'pg';
import { MongoClient, Long } from 'mongodb';

const [sqlitePath, configPath] = process.argv.slice(2);
if (!sqlitePath) {
  console.error('Usage: node migrate.mjs <emob.sqlite> [config.json]');
  process.exit(1);
}
const env = (k, d) => process.env[k] || d;
const PG = env('POSTGRES_URL', `postgres://${env('POSTGRES_USER', 'emob')}:${env('POSTGRES_PASSWORD', 'emob-dev')}@127.0.0.1:${env('POSTGRES_PORT', '5442')}/${env('POSTGRES_DB', 'emob')}`);
const MONGO = env('MONGO_URI', `mongodb://${env('MONGO_USER', 'emob')}:${env('MONGO_PASSWORD', 'emob-dev')}@127.0.0.1:${env('MONGO_PORT', '27027')}/?authSource=admin`);
const RETENTION = Date.now() - 14 * 86400000;

const lite = new DatabaseSync(sqlitePath, { readOnly: true });
const pgc = new pg.Client({ connectionString: PG });
await pgc.connect();
const mongo = new MongoClient(MONGO);
await mongo.connect();
const db = mongo.db(env('MONGO_DB', 'emob'));

const ts = (ms) => (ms == null ? null : new Date(Math.round(Number(ms))));
// Integer times stored as 64-bit integers (BSON Long), as the Go motor writes them
const ms = (v) => (v == null ? null : Long.fromNumber(Math.round(Number(v))));
const int = (v) => (v == null ? null : Math.round(Number(v)));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- PostgreSQL ----------
const vehicles = lite.prepare('SELECT * FROM vehicles ORDER BY id').all();
await pgc.query('BEGIN');
await pgc.query('TRUNCATE vehicles, chargers RESTART IDENTITY');
for (const v of vehicles) {
  await pgc.query(
    `INSERT INTO vehicles (id, name, make, model, vin, evccid, id_tag, battery_kwh, max_ac_kw, phases, target_soc, priority, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [v.id, v.name, v.make, v.model, v.vin, v.evccid, v.id_tag, v.battery_kwh, v.max_ac_kw, v.phases, v.target_soc, v.priority, ts(v.created_at) ?? new Date()],
  );
}
await pgc.query(`SELECT setval(pg_get_serial_sequence('vehicles','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM vehicles), 1))`);
const chargers = lite.prepare('SELECT * FROM chargers ORDER BY id').all();
for (const c of chargers) {
  await pgc.query(
    `INSERT INTO chargers (id, vendor, model, serial, firmware, location, max_power_kw, priority, manual_max, connectors, first_seen, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [c.id, c.vendor, c.model, c.serial, c.firmware, c.location, c.max_power_kw, c.priority, !!c.manual_max, c.connectors, ts(c.first_seen), ts(c.last_seen)],
  );
}
await pgc.query('COMMIT');
log(`postgres: ${vehicles.length} vehicles, ${chargers.length} chargers`);

// ---------- MongoDB ----------
const byId = new Map(vehicles.map((v) => [v.id, v]));
const cols = ['sessions', 'charging_plans', 'meter_samples', 'site_samples', 'charger_events', 'ocpp_log', 'engine_events', 'counters', 'settings'];
for (const c of cols) await db.collection(c).deleteMany({});

async function copy(name, rows, map, batch = 5000) {
  let n = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const docs = rows.slice(i, i + batch).map(map);
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
    n += docs.length;
  }
  log(`mongo ${name}: ${n}`);
}

const sessions = lite.prepare('SELECT * FROM sessions ORDER BY transaction_id').all();
await copy('sessions', sessions, (s) => {
  const v = s.vehicle_id != null ? byId.get(s.vehicle_id) : null;
  return {
    _id: ms(s.transaction_id), charger_id: s.charger_id, connector_id: int(s.connector_id), vehicle_id: ms(s.vehicle_id),
    vehicle_name: v?.name ?? null, vehicle_vin: v?.vin ?? null, vehicle_evccid: v?.evccid ?? null, id_tag: s.id_tag, ident_method: s.ident_method,
    started_at: ms(s.started_at), stopped_at: ms(s.stopped_at), meter_start_wh: s.meter_start_wh, meter_stop_wh: s.meter_stop_wh, energy_wh: s.energy_wh,
    soc_start: s.soc_start, soc_end: s.soc_end, max_power_w: s.max_power_w, stop_reason: s.stop_reason,
  };
});

const plans = lite.prepare('SELECT * FROM charge_plans ORDER BY id').all();
await copy('charging_plans', plans, (p) => ({
  _id: ms(p.id), charger_id: p.charger_id, connector_id: int(p.connector_id), vehicle_id: ms(p.vehicle_id),
  vehicle_name: p.vehicle_id != null ? (byId.get(p.vehicle_id)?.name ?? null) : null, id_tag: p.id_tag, start_at: ms(p.start_at),
  departure_at: ms(p.departure_at), target_soc: p.target_soc, max_kw: p.max_kw, status: p.status, transaction_id: ms(p.transaction_id),
  note: p.note, created_at: ms(p.created_at), updated_at: ms(p.updated_at),
}));
await db.collection('counters').insertOne({ _id: 'charging_plans', seq: Long.fromNumber(plans.reduce((m, p) => Math.max(m, p.id), 0)) });

const samples = lite.prepare('SELECT * FROM meter_samples ORDER BY t').all();
await copy('meter_samples', samples, (m) => ({
  ts: ts(m.t), transaction_id: ms(m.transaction_id), t: ms(m.t), power_w: m.power_w, allocated_w: m.allocated_w, energy_wh: m.energy_wh, soc: m.soc, current_a: m.current_a,
}));
const site = lite.prepare('SELECT * FROM site_samples ORDER BY t').all();
await copy('site_samples', site, (s) => ({ ts: ts(s.t), t: ms(s.t), limit_w: s.limit_w, building_w: s.building_w, ev_w: s.ev_w, alloc_w: s.alloc_w, sessions: s.sessions }));
const chev = lite.prepare('SELECT * FROM charger_events ORDER BY t').all();
await copy('charger_events', chev, (e) => ({ t: ms(e.t), charger_id: e.charger_id, type: e.type, connector_id: int(e.connector_id), detail: e.detail }));
const ocpp = lite.prepare('SELECT * FROM ocpp_log WHERE t >= ? ORDER BY t').all(RETENTION);
await copy('ocpp_log', ocpp, (o) => ({
  ts: ts(o.t), t: ms(o.t), charger_id: o.charger_id, dir: o.dir, kind: o.kind, action: o.action, msg_id: o.msg_id, error_code: o.error_code, payload: o.payload ?? '{}',
}));
const events = lite.prepare('SELECT * FROM event_log WHERE t >= ? ORDER BY t').all(RETENTION);
await copy('engine_events', events, (e) => ({ ts: ts(e.t), t: ms(e.t), level: e.level, charger_id: e.charger_id, msg: e.msg }));

if (configPath && fs.existsSync(configPath)) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete cfg.chargerSettings;
  await db.collection('settings').replaceOne({ _id: 'engine' }, { _id: 'engine', ...cfg }, { upsert: true });
  log('mongo settings: engine configuration');
}

await pgc.end();
await mongo.close();
log('migration finished');
