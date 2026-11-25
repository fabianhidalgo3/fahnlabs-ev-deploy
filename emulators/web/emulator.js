// UI del emulador web. La lógica OCPP y la simulación están en emu-core.mjs.
import { ChargePoint, STATUS_ES, vehicleFromApi, manualVehicle } from './emu-core.mjs';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MODE_LABEL = { rfid: 'RFID (idTag)', autocharge: 'Autocharge (VID:EVCCID)', iso15118: 'ISO 15118 (VIN)' };

// ---------- persistencia de formulario (comodidad por navegador) ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const form = $('#cpForm');
// Local development: dashboard on the BFF (port 9000), emulator on the OCPP gateway (9100), vehicles from the motor (9200).
// Behind the production reverse proxy (default port) everything shares one origin and vehicles come from the BFF.
const behindProxy = location.protocol.startsWith('http') && location.port === '';
$('#dashLink').href = behindProxy ? '/' : `${location.protocol}//${location.hostname || 'localhost'}:9000/`;
(function initForm() {
  const host = location.host || 'localhost:9100';
  const saved = store.get('emu.form') || {};
  form.elements.url.value = saved.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ocpp`;
  form.elements.cpId.value = saved.cpId || `CP-WEB-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  for (const k of ['vendor', 'model', 'maxKw', 'connectors', 'phases', 'meterInterval', 'speed']) {
    if (saved[k] != null) form.elements[k].value = saved[k];
  }
})();

function logLine(cls, text) {
  const el = $('#log');
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>${esc(text)}`;
  el.append(d);
  while (el.children.length > 200) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

// ---------- vehículos registrados ----------
let vehicles = [];
async function loadVehicles() {
  try {
    const r = await fetch(behindProxy ? '/api/v1/vehicles'
      : `${location.protocol}//${location.hostname || 'localhost'}:9200/api/v1/vehicles`);
    if (r.ok) vehicles = (await r.json()).map(vehicleFromApi);
  } catch {
    vehicles = []; // p. ej. abierto como archivo: sólo vehículo manual
  }
}

// ---------- conexión ----------
let cp = null;
let rafPending = false;
const scheduleRender = () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (cp) renderConnectors();
  });
};

function setConnUi(on) {
  $('#wsDot').className = 'dot ' + (on ? 'on' : 'off');
  $('#wsText').textContent = on ? 'Conectado' : 'Desconectado';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (cp) {
    cp.disconnect();
    cp = null;
    setConnUi(false);
    $('#btnConnect').textContent = 'Conectar';
    [...form.elements].forEach((el) => (el.disabled = false));
    $('#connectors').innerHTML = '';
    return;
  }
  const f = form.elements;
  const opts = {
    url: f.url.value.trim(),
    cpId: f.cpId.value.trim(),
    vendor: f.vendor.value.trim() || 'EmuCharge',
    model: f.model.value.trim() || 'AC-Web',
    maxKw: Number(f.maxKw.value) || 22,
    connectors: Math.min(4, Math.max(1, Number(f.connectors.value) || 1)),
    phases: Number(f.phases.value),
    meterInterval: Math.max(1, Number(f.meterInterval.value) || 5),
    speed: Number(f.speed.value),
  };
  store.set('emu.form', { ...opts });
  await loadVehicles();
  cp = new ChargePoint({ ...opts, log: logLine, onUpdate: scheduleRender });
  // Por defecto, un vehículo registrado distinto en cada conector
  cp.connectors.forEach((c, i) => {
    if (vehicles[i]) cp.setVehicle(c, vehicles[i], 'autocharge');
  });
  buildConnectorCards();
  cp.connect();
  $('#btnConnect').textContent = 'Desconectar';
  [...form.elements].forEach((el) => {
    if (el.id !== 'btnConnect' && el.name !== 'speed') el.disabled = true;
  });
});

form.elements.speed.addEventListener('change', () => {
  if (cp) cp.o.speed = Number(form.elements.speed.value);
});

// ---------- tarjetas de conector ----------
const FIELDS = [
  ['vin', 'VIN', 'text'],
  ['evccid', 'EVCCID (MAC)', 'text'],
  ['idTag', 'idTag RFID', 'text'],
  ['capKWh', 'Batería (kWh)', 'number'],
  ['maxKw', 'Cargador VE (kW)', 'number'],
  ['phases', 'Fases VE', 'number'],
  ['targetSoc', 'SoC objetivo (%)', 'number'],
];

function buildConnectorCards() {
  $('#connectors').innerHTML = cp.connectors
    .map(
      (c) => `
    <article class="card" data-c="${c.id}">
      <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong>Conector ${c.id}</strong><span class="status" data-f="status"></span>
      </header>
      <div class="ev">
        <div class="gauge"><span data-f="power">0.0</span> <small>kW</small></div>
        <div class="meta">Límite OCPP: <b data-f="limit">–</b> · Sesión: <b data-f="tx">–</b> · Contador: <b data-f="meter"></b></div>
        <div class="battery"><div data-f="socbar"></div><span data-f="soc"></span></div>
        <div class="vehsel">
          <label>Vehículo<select data-v="select"></select></label>
          <label>Identificación<select data-v="mode">
            ${Object.entries(MODE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
          </select></label>
        </div>
        <div class="vehfields">
          ${FIELDS.map(([k, l, t]) => `<label>${l}<input data-ev="${k}" type="${t}" ${t === 'number' ? 'step="any" min="0"' : ''} /></label>`).join('')}
          <label>SoC actual (%)<input data-ev="soc" type="number" min="0" max="100" /></label>
        </div>
        <div class="ident" data-f="ident"></div>
        <div class="btns">
          <button data-a="plug">Enchufar</button>
          <button class="primary" data-a="start">Iniciar carga</button>
          <button class="danger" data-a="stop">Detener</button>
          <button data-a="fault">Simular avería</button>
        </div>
      </div>
    </article>`,
    )
    .join('');
  for (const c of cp.connectors) fillVehicleForm(c);
  renderConnectors();
}

function cardOf(c) {
  return $(`[data-c="${c.id}"]`);
}

function fillVehicleForm(c) {
  const card = cardOf(c);
  if (!card) return;
  const inUse = new Set(cp.connectors.filter((x) => x !== c && x.vehicle.id != null).map((x) => x.vehicle.id));
  $('[data-v="select"]', card).innerHTML =
    `<option value="">Vehículo manual</option>` +
    vehicles
      .map((v) => `<option value="${v.id}" ${inUse.has(v.id) ? 'disabled' : ''}>${esc(v.name)}${inUse.has(v.id) ? ' (en uso)' : ''}</option>`)
      .join('');
  $('[data-v="select"]', card).value = c.vehicle.id ?? '';
  $('[data-v="mode"]', card).value = c.idMode;
  for (const [k] of FIELDS) $(`[data-ev="${k}"]`, card).value = c.vehicle[k] ?? '';
  $('[data-ev="soc"]', card).value = c.soc.toFixed(0);
}

function renderConnectors() {
  const online = cp.online;
  setConnUi(online);
  for (const c of cp.connectors) {
    const card = cardOf(c);
    if (!card) continue;
    const st = c.status || cp.computeStatus(c);
    const s = $('[data-f="status"]', card);
    s.className = `status ${st}`;
    s.textContent = STATUS_ES[st] || st;
    $('[data-f="power"]', card).textContent = (c.powerW / 1000).toFixed(1);
    $('[data-f="limit"]', card).textContent = Number.isFinite(c.limitW) ? `${(c.limitW / 1000).toFixed(1)} kW` : 'sin perfil';
    $('[data-f="tx"]', card).textContent = c.txId ? `#${c.txId}` : '–';
    $('[data-f="meter"]', card).textContent = `${(c.meterWh / 1000).toFixed(2)} kWh`;
    $('[data-f="socbar"]', card).style.width = `${c.soc}%`;
    $('[data-f="soc"]', card).textContent = `SoC ${c.soc.toFixed(1)} %  ·  objetivo ${c.vehicle.targetSoc} %`;
    const socInput = $('[data-ev="soc"]', card);
    if (document.activeElement !== socInput) socInput.value = c.soc.toFixed(0);

    const tag = cp.identTag(c);
    const sends =
      c.idMode === 'autocharge' ? `EVCCID ${c.vehicle.evccid || '—'}` : c.idMode === 'iso15118' ? `VIN ${c.vehicle.vin || '—'} + EVCCID` : 'nada (sólo RFID)';
    $('[data-f="ident"]', card).innerHTML = `idTag: <b>${esc(c.txId ? c.activeTag : tag)}</b> · al enchufar envía: ${esc(sends)}`;

    // Durante la sesión no se cambia de vehículo
    const locked = !!c.txId || c.plugged;
    card.querySelectorAll('[data-v], [data-ev]:not([data-ev="soc"])').forEach((el) => (el.disabled = locked));
    $('[data-ev="soc"]', card).disabled = !!c.txId;

    $('[data-a="plug"]', card).textContent = c.plugged ? 'Desenchufar' : 'Enchufar';
    $('[data-a="plug"]', card).disabled = !online || c.faulted;
    $('[data-a="start"]', card).disabled = !online || !!c.txId || c.faulted;
    $('[data-a="stop"]', card).disabled = !online || !c.txId;
    $('[data-a="fault"]', card).textContent = c.faulted ? 'Reparar avería' : 'Simular avería';
    $('[data-a="fault"]', card).disabled = !online;
  }
}

const connOf = (el) => cp?.connectors.find((x) => x.id === Number(el.closest('[data-c]')?.dataset.c));

$('#connectors').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn || !cp) return;
  const c = connOf(btn);
  switch (btn.dataset.a) {
    case 'plug':
      c.plugged ? cp.unplug(c) : cp.plug(c);
      break;
    case 'start':
      cp.startTx(c);
      break;
    case 'stop':
      cp.stopTx(c, 'Local');
      break;
    case 'fault':
      cp.toggleFault(c);
      break;
  }
  renderConnectors();
});

$('#connectors').addEventListener('change', (e) => {
  if (!cp) return;
  const el = e.target;
  const c = connOf(el);
  if (!c) return;
  try {
    if (el.dataset.v === 'select') {
      const v = vehicles.find((x) => String(x.id) === el.value);
      cp.setVehicle(c, v || { ...manualVehicle(c.id - 1), ...c.vehicle, id: null, name: 'Vehículo manual' });
      cp.connectors.forEach(fillVehicleForm); // actualiza "(en uso)" en los demás
    } else if (el.dataset.v === 'mode') {
      cp.setVehicle(c, c.vehicle, el.value);
    } else if (el.dataset.ev === 'soc') {
      c.soc = Math.min(100, Math.max(0, Number(el.value) || 0));
    } else if (el.dataset.ev) {
      const k = el.dataset.ev;
      const num = ['capKWh', 'maxKw', 'phases', 'targetSoc'].includes(k);
      // Editar un campo convierte el vehículo en manual (ya no coincide con el registro)
      const v = { ...c.vehicle, [k]: num ? Math.max(0, Number(el.value) || 0) : el.value.trim(), id: null, name: 'Vehículo manual' };
      if (k === 'phases') v.phases = Math.min(3, Math.max(1, Math.round(v.phases) || 3));
      cp.setVehicle(c, v);
      fillVehicleForm(c);
    }
  } catch (err) {
    logLine('error', err.message);
  }
  renderConnectors();
});
