// Núcleo del emulador de punto de carga OCPP 1.6J (sin DOM).
// Se usa desde el navegador (web/emulator.js) y desde Node 22+ (server/sim/fleet.js).
//
//   const cp = new ChargePoint({ url, cpId, connectors: 2, log, onUpdate });
//   cp.connect(); await cp.ready;
//   cp.setVehicle(cp.connectors[0], vehiculo, 'autocharge');
//   cp.plug(c); await cp.startTx(c); ...; await cp.stopTx(c); cp.unplug(c);
//
// Identificación del vehículo (modo por conector):
//   'rfid'       idTag = vehicle.idTag; no se envían datos del VE.
//   'autocharge' al enchufar → DataTransfer VehicleInfo {connectorId, evccid}; idTag = 'VID:' + EVCCID.
//   'iso15118'   al enchufar → DataTransfer VehicleInfo {connectorId, vin, evccid}; idTag = vehicle.idTag || 'EV-' + últimos 8 del VIN.

export const VOLTAGE = 230;
export const ID_MODES = ['rfid', 'autocharge', 'iso15118'];

export const STATUS_ES = {
  Available: 'Disponible', Preparing: 'Preparando', Charging: 'Cargando', SuspendedEV: 'Pausa VE',
  SuspendedEVSE: 'Pausa red', Finishing: 'Finalizando', Unavailable: 'No disponible', Faulted: 'Avería',
};

/** Convierte una fila de GET /api/v1/vehicles (motor) al formato del emulador. */
export function vehicleFromApi(v) {
  return {
    id: v.id,
    name: v.name,
    vin: v.vin || '',
    evccid: v.evccid || '',
    idTag: v.id_tag || '',
    capKWh: Number(v.battery_kwh) || 60,
    maxKw: Number(v.max_ac_kw) || 11,
    phases: Number(v.phases) || 3,
    targetSoc: Number(v.target_soc) || 80,
    maxDcKw: Number(v.max_dc_kw) || null, // optional (newer motor builds)
    minSoc: Number(v.min_soc) || null, // optional (newer motor builds)
  };
}

export function manualVehicle(i = 0) {
  return {
    id: null,
    name: 'Vehículo manual',
    vin: '',
    evccid: '',
    idTag: `TAG-${String(i + 1).padStart(3, '0')}`,
    capKWh: 60,
    maxKw: i % 2 ? 22 : 11,
    phases: 3,
    targetSoc: 100,
  };
}

const uuid = () =>
  globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const nowMs = () => (globalThis.performance ? performance.now() : Date.now());

export class ChargePoint {
  /**
   * @param {object} o
   * @param {string} o.url        URL base del CSMS (p. ej. ws://localhost:9100/ocpp)
   * @param {string} o.cpId       chargePointId
   * @param {number} [o.connectors=1]
   * @param {number} [o.maxKw=22] potencia máxima por conector
   * @param {number} [o.phases=3] fases del cargador
   * @param {number} [o.meterInterval=5] s reales entre MeterValues
   * @param {number} [o.speed=1]  aceleración del tiempo (sólo energía/SoC)
   * @param {Function} [o.WebSocketImpl] constructor WebSocket (por defecto globalThis.WebSocket)
   * @param {(cls:string, text:string)=>void} [o.log]
   * @param {()=>void} [o.onUpdate]
   * @param {boolean} [o.autoReconnect=true]
   * @param {'AC'|'DC'} [o.currentType='AC'] DC: limits in A are DC amps × dcVoltage, meter reports DC values and
   *                                          the vehicle's maxDcKw (if any) replaces its on-board AC limit
   * @param {number} [o.dcVoltage=650] DC link / battery voltage (V) used for DC current ↔ power conversions
   */
  constructor(o) {
    this.o = {
      vendor: 'EmuCharge', model: 'AC-Emu', connectors: 1, maxKw: 22, phases: 3, meterInterval: 5, speed: 1,
      autoReconnect: true, currentType: 'AC', dcVoltage: 650, ...o,
    };
    this.WS = o.WebSocketImpl || globalThis.WebSocket;
    this.log = o.log || (() => {});
    this.onUpdate = o.onUpdate || (() => {});
    this.ws = null;
    this.pending = new Map();
    this.profiles = []; // { connectorId, profile, receivedAt }
    this.heartbeatInterval = 30;
    this.meterInterval = this.o.meterInterval;
    this.timers = [];
    this.manualClose = false;
    this.booted = false;
    this.#newReady();
    this.connectors = Array.from({ length: this.o.connectors }, (_, i) => ({
      id: i + 1,
      status: null,
      plugged: false,
      faulted: false,
      finishing: false,
      txId: null,
      activeTag: null,
      txStartMs: null,
      meterWh: Math.round(100000 + Math.random() * 50000),
      powerW: 0,
      limitW: Infinity,
      soc: 20 + i * 10,
      vehicle: manualVehicle(i),
      idMode: 'rfid',
    }));
  }

  #newReady() {
    this.ready = new Promise((res) => (this._resolveReady = res));
  }

  get online() {
    return this.ws?.readyState === 1 && this.booted;
  }

  get isDC() {
    return this.o.currentType === 'DC';
  }

  minEvW(c) {
    if (this.isDC) return 1000; // DC: no IEC 61851 6 A minimum; the EV accepts low setpoints
    return 6 * VOLTAGE * Math.min(this.o.phases, c.vehicle.phases || this.o.phases); // IEC 61851: 6 A mínimo
  }

  // ---------- transporte ----------
  connect() {
    this.manualClose = false;
    const url = `${this.o.url.replace(/\/+$/, '')}/${encodeURIComponent(this.o.cpId)}`;
    this.log('', `Conectando a ${url}`);
    this.ws = new this.WS(url, ['ocpp1.6']);
    this.ws.onopen = () => this.#onOpen();
    this.ws.onmessage = (ev) => this.#onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    this.ws.onclose = (ev) => this.#onClose(ev);
    this.ws.onerror = () => this.log('error', 'Error de WebSocket');
  }

  disconnect() {
    this.manualClose = true;
    this.#stopTimers();
    this.ws?.close();
  }

  #send(frame) {
    if (this.ws?.readyState !== 1) return false;
    const text = JSON.stringify(frame);
    this.ws.send(text);
    this.log('ocpp out', text);
    return true;
  }

  call(action, payload = {}) {
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout ${action}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.#send([2, id, action, payload])) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Sin conexión'));
      }
    });
  }

  async #onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.log('ocpp in', text);
    const [type, id] = msg;
    if (type === 2) {
      try {
        const res = await this.handle(msg[2], msg[3] || {});
        this.#send([3, id, res]);
      } catch (e) {
        this.#send([4, id, e.code || 'InternalError', e.message, {}]);
      }
    } else {
      const p = this.pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      type === 3 ? p.resolve(msg[2]) : p.reject(new Error(`${msg[2]}: ${msg[3]}`));
    }
  }

  async #onOpen() {
    this.onUpdate();
    try {
      const boot = await this.call('BootNotification', {
        chargePointVendor: this.o.vendor,
        chargePointModel: this.o.model,
        chargePointSerialNumber: this.o.cpId,
        firmwareVersion: 'emu-2.0.0',
      });
      if (boot.status !== 'Accepted') {
        this.log('warn', `BootNotification ${boot.status}; reintento en ${boot.interval || 10}s`);
        this.timers.push(setTimeout(() => this.#onOpen(), (boot.interval || 10) * 1000));
        return;
      }
      this.heartbeatInterval = boot.interval || 30;
      this.call('DataTransfer', {
        vendorId: 'EMOB',
        messageId: 'Capabilities',
        data: JSON.stringify({
          maxPowerW: this.o.maxKw * 1000, connectors: this.o.connectors, phases: this.o.phases, currentType: this.o.currentType,
        }),
      }).catch(() => {});
      await this.call('StatusNotification', { connectorId: 0, status: 'Available', errorCode: 'NoError' });
      for (const c of this.connectors) {
        c.status = null; // fuerza reenvío
        this.updateStatus(c);
        if (c.plugged) this.#sendVehicleInfo(c);
      }
      this.booted = true;
      this.#startTimers();
      this._resolveReady();
      this.onUpdate();
    } catch (e) {
      this.log('error', e.message);
    }
  }

  #onClose(ev) {
    this.booted = false;
    this.#stopTimers();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Conexión cerrada'));
    }
    this.pending.clear();
    this.log('warn', `Conexión cerrada (${ev?.code ?? ''}${ev?.reason ? ' ' + ev.reason : ''})`);
    this.#newReady();
    this.onUpdate();
    if (!this.manualClose && this.o.autoReconnect) {
      this.log('', 'Reconectando en 5 s…');
      this.timers.push(setTimeout(() => this.connect(), 5000));
    }
  }

  #startTimers() {
    this.#stopTimers();
    let last = nowMs();
    this.timers.push(
      setInterval(() => {
        const t = nowMs();
        this.tick((t - last) / 1000);
        last = t;
      }, 500),
    );
    this.timers.push(setInterval(() => this.call('Heartbeat', {}).catch(() => {}), this.heartbeatInterval * 1000));
    this.timers.push(setInterval(() => this.sendMeterValues(), this.meterInterval * 1000));
  }

  #stopTimers() {
    this.timers.forEach((t) => {
      clearInterval(t);
      clearTimeout(t);
    });
    this.timers = [];
  }

  // ---------- perfiles de carga ----------
  scheduleLimitW(entry, c) {
    const p = entry.profile;
    const sch = p.chargingSchedule;
    let start = entry.receivedAt;
    if (p.chargingProfileKind === 'Absolute' && sch.startSchedule) start = Date.parse(sch.startSchedule);
    else if (p.chargingProfileKind === 'Relative' && c?.txStartMs) start = c.txStartMs;
    const elapsed = (Date.now() - start) / 1000;
    if (sch.duration && elapsed > sch.duration) return Infinity;
    let limit = null;
    let phases = this.o.phases;
    for (const per of [...sch.chargingSchedulePeriod].sort((a, b) => a.startPeriod - b.startPeriod)) {
      if (per.startPeriod <= Math.max(elapsed, 0)) {
        limit = per.limit;
        phases = per.numberPhases || this.o.phases;
      }
    }
    if (limit === null) return Infinity;
    if (sch.chargingRateUnit !== 'A') return limit;
    if (this.isDC) return limit * this.o.dcVoltage; // DC current × DC voltage
    const evPhases = c?.vehicle?.phases || this.o.phases;
    return limit * VOLTAGE * Math.min(phases, this.o.phases, evPhases);
  }

  #pickProfile(purpose, matcher) {
    return this.profiles
      .filter((e) => e.profile.chargingProfilePurpose === purpose && matcher(e))
      .sort((a, b) => b.profile.stackLevel - a.profile.stackLevel)[0];
  }

  connectorLimitW(c) {
    const tx = this.#pickProfile(
      'TxProfile',
      (e) => e.connectorId === c.id && (!e.profile.transactionId || e.profile.transactionId === c.txId),
    );
    if (tx) return this.scheduleLimitW(tx, c);
    const def = this.#pickProfile('TxDefaultProfile', (e) => e.connectorId === c.id || e.connectorId === 0);
    if (def) return this.scheduleLimitW(def, c);
    return Infinity;
  }

  // ---------- simulación ----------
  evAcceptW(c) {
    const soc = c.soc;
    const v = c.vehicle;
    if (soc >= 100) return 0;
    // EV-side target (e.g. communicated over ISO 15118): the EV stops requesting energy once reached
    if (v.stopSoc != null && soc >= v.stopSoc) return 0;
    let taper;
    if (v.taperFloor != null) {
      // Acceptance curve: constant up to taperSoc, then linear down to taperFloor × max at 100 % SoC
      const ts = v.taperSoc ?? 80;
      taper = soc < ts ? 1 : Math.max(v.taperFloor, 1 - ((1 - v.taperFloor) * (soc - ts)) / (100 - ts));
    } else taper = soc < 80 ? 1 : Math.max(0.08, (100 - soc) / 20);
    const maxKw = this.isDC && v.maxDcKw ? v.maxDcKw : v.maxKw;
    return maxKw * 1000 * taper;
  }

  tick(dt) {
    const speed = this.o.speed;
    const targets = this.connectors.map((c) => {
      c.limitW = this.connectorLimitW(c);
      if (!c.txId || c.faulted) return 0;
      let t = Math.min(this.o.maxKw * 1000, this.evAcceptW(c), c.limitW);
      if (t < this.minEvW(c)) t = 0;
      return t;
    });
    // ChargePointMaxProfile: límite total del equipo
    const cpMax = this.#pickProfile('ChargePointMaxProfile', (e) => e.connectorId === 0);
    if (cpMax) {
      const lim = this.scheduleLimitW(cpMax);
      const sum = targets.reduce((a, b) => a + b, 0);
      if (sum > lim) targets.forEach((t, i) => (targets[i] = t * (lim / sum)));
    }
    this.connectors.forEach((c, i) => {
      c.powerW += (targets[i] - c.powerW) * Math.min(1, dt * 1.5);
      if (c.powerW < 50 && targets[i] === 0) c.powerW = 0;
      const wh = (c.powerW * dt * speed) / 3600;
      c.meterWh += wh;
      c.soc = Math.min(100, c.soc + (wh / (c.vehicle.capKWh * 1000)) * 100);
      this.updateStatus(c);
    });
    this.onUpdate();
  }

  computeStatus(c) {
    if (c.faulted) return 'Faulted';
    if (!c.plugged) return 'Available';
    if (!c.txId) return c.finishing ? 'Finishing' : 'Preparing';
    if (this.evAcceptW(c) === 0) return 'SuspendedEV';
    if (Math.min(c.limitW, this.o.maxKw * 1000) < this.minEvW(c)) return 'SuspendedEVSE';
    return 'Charging';
  }

  updateStatus(c) {
    const s = this.computeStatus(c);
    if (s === c.status) return;
    c.status = s;
    this.call('StatusNotification', {
      connectorId: c.id,
      status: s,
      errorCode: c.faulted ? c.faultCode || 'OtherError' : 'NoError', // faultCode: causa OCPP (p. ej. HighTemperature)
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }

  sendMeterValues(only) {
    for (const c of this.connectors) {
      if (only && c !== only) continue;
      if (!c.txId) continue;
      const ph = Math.min(this.o.phases, c.vehicle.phases || this.o.phases);
      const volts = this.isDC ? this.o.dcVoltage : VOLTAGE;
      const amps = this.isDC ? c.powerW / volts : c.powerW / (VOLTAGE * ph);
      this.call('MeterValues', {
        connectorId: c.id,
        transactionId: c.txId,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              { value: c.powerW.toFixed(0), measurand: 'Power.Active.Import', unit: 'W', context: 'Sample.Periodic' },
              { value: c.meterWh.toFixed(0), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context: 'Sample.Periodic' },
              { value: amps.toFixed(1), measurand: 'Current.Import', unit: 'A', context: 'Sample.Periodic' },
              { value: c.soc.toFixed(1), measurand: 'SoC', unit: 'Percent', location: 'EV', context: 'Sample.Periodic' },
              { value: String(volts), measurand: 'Voltage', unit: 'V', context: 'Sample.Periodic' },
            ],
          },
        ],
      }).catch(() => {});
    }
  }

  // ---------- vehículo e identificación ----------
  setVehicle(c, vehicle, idMode = c.idMode, soc) {
    if (c.txId) throw new Error('No se puede cambiar el vehículo durante una sesión');
    c.vehicle = { ...vehicle };
    c.idMode = ID_MODES.includes(idMode) ? idMode : 'rfid';
    if (soc != null) c.soc = Math.max(0, Math.min(100, soc));
    this.onUpdate();
  }

  /** idTag que presentará el conector según el modo de identificación (máx. 20 caracteres, OCPP 1.6). */
  identTag(c) {
    const v = c.vehicle;
    const evccid = String(v.evccid || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    const vin = String(v.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let tag;
    if (c.idMode === 'autocharge' && evccid) tag = `VID:${evccid}`;
    else if (c.idMode === 'iso15118') tag = v.idTag || (vin ? `EV-${vin.slice(-8)}` : 'EV-UNKNOWN');
    else tag = v.idTag || `TAG-${c.id}`;
    return tag.slice(0, 20);
  }

  #sendVehicleInfo(c) {
    if (c.idMode === 'rfid') return;
    const v = c.vehicle;
    const data = { connectorId: c.id, evccid: v.evccid || null };
    if (c.idMode === 'iso15118') data.vin = v.vin || null;
    if (!data.evccid && !data.vin) return;
    this.call('DataTransfer', { vendorId: 'EMOB', messageId: 'VehicleInfo', data: JSON.stringify(data) }).catch(() => {});
  }

  // ---------- acciones locales ----------
  plug(c) {
    if (c.plugged || c.faulted) return;
    c.plugged = true;
    c.finishing = false;
    this.updateStatus(c);
    this.#sendVehicleInfo(c); // HLC: el VE se identifica al enchufar
    this.onUpdate();
  }

  unplug(c) {
    if (c.txId) this.stopTx(c, 'EVDisconnected');
    c.plugged = false;
    c.finishing = false;
    this.updateStatus(c);
    this.onUpdate();
  }

  /** Inicia una sesión. Devuelve true si el CSMS la aceptó. */
  async startTx(c, idTag = this.identTag(c), remote = false) {
    if (c.txId || c.faulted) return false;
    if (!c.plugged) this.plug(c);
    c.finishing = false;
    this.updateStatus(c);
    try {
      if (!remote) {
        const auth = await this.call('Authorize', { idTag });
        if (auth.idTagInfo?.status !== 'Accepted') {
          this.log('warn', `idTag ${idTag} rechazado (${auth.idTagInfo?.status})`);
          return false;
        }
      }
      const res = await this.call('StartTransaction', {
        connectorId: c.id,
        idTag,
        meterStart: Math.round(c.meterWh),
        timestamp: new Date().toISOString(),
      });
      c.txId = res.transactionId;
      c.txStartMs = Date.now();
      c.activeTag = idTag;
      if (res.idTagInfo?.status !== 'Accepted') {
        await this.stopTx(c, 'DeAuthorized');
        return false;
      }
      this.updateStatus(c);
      this.sendMeterValues(c);
      this.onUpdate();
      return true;
    } catch (e) {
      this.log('error', `No se pudo iniciar: ${e.message}`);
      return false;
    }
  }

  async stopTx(c, reason = 'Local') {
    if (!c.txId) return;
    const txId = c.txId;
    c.txId = null;
    c.powerW = 0;
    c.finishing = c.plugged;
    this.profiles = this.profiles.filter(
      (e) => !(e.profile.chargingProfilePurpose === 'TxProfile' && e.connectorId === c.id),
    );
    this.updateStatus(c);
    this.onUpdate();
    try {
      await this.call('StopTransaction', {
        transactionId: txId,
        idTag: c.activeTag,
        meterStop: Math.round(c.meterWh),
        timestamp: new Date().toISOString(),
        reason,
      });
    } catch (e) {
      this.log('error', `StopTransaction: ${e.message}`);
    }
  }

  async toggleFault(c) {
    c.faulted = !c.faulted;
    if (c.faulted && c.txId) await this.stopTx(c, 'Other');
    this.updateStatus(c);
    this.onUpdate();
  }

  // ---------- mensajes del CSMS ----------
  async handle(action, p) {
    switch (action) {
      case 'SetChargingProfile': {
        const prof = p.csChargingProfiles;
        if (!prof?.chargingSchedule?.chargingSchedulePeriod?.length) return { status: 'Rejected' };
        if (prof.chargingProfilePurpose === 'TxProfile') {
          const c = this.connectors.find((x) => x.id === p.connectorId);
          if (!c || !c.txId) return { status: 'Rejected' };
        }
        this.profiles = this.profiles.filter(
          (e) =>
            !(
              e.profile.chargingProfileId === prof.chargingProfileId ||
              (e.connectorId === p.connectorId &&
                e.profile.stackLevel === prof.stackLevel &&
                e.profile.chargingProfilePurpose === prof.chargingProfilePurpose)
            ),
        );
        this.profiles.push({ connectorId: p.connectorId, profile: prof, receivedAt: Date.now() });
        const lim = this.scheduleLimitW(
          { profile: prof, receivedAt: Date.now() },
          this.connectors.find((x) => x.id === p.connectorId),
        );
        this.log('power', `Perfil ${prof.chargingProfilePurpose} conector ${p.connectorId}: ${(lim / 1000).toFixed(1)} kW`);
        return { status: 'Accepted' };
      }
      case 'ClearChargingProfile': {
        const before = this.profiles.length;
        this.profiles = this.profiles.filter((e) => {
          const pr = e.profile;
          if (p.id != null) return pr.chargingProfileId !== p.id;
          if (p.connectorId != null && e.connectorId !== p.connectorId) return true;
          if (p.chargingProfilePurpose && pr.chargingProfilePurpose !== p.chargingProfilePurpose) return true;
          if (p.stackLevel != null && pr.stackLevel !== p.stackLevel) return true;
          return false;
        });
        return { status: this.profiles.length < before ? 'Accepted' : 'Unknown' };
      }
      case 'GetCompositeSchedule': {
        const c = this.connectors.find((x) => x.id === p.connectorId);
        const lim = c ? Math.min(c.limitW, this.o.maxKw * 1000) : this.o.maxKw * 1000 * this.o.connectors;
        return {
          status: 'Accepted',
          connectorId: p.connectorId,
          scheduleStart: new Date().toISOString(),
          chargingSchedule: {
            duration: p.duration,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: Math.round(lim) }],
          },
        };
      }
      case 'RemoteStartTransaction': {
        const c = p.connectorId
          ? this.connectors.find((x) => x.id === p.connectorId)
          : this.connectors.find((x) => !x.txId && !x.faulted);
        if (!c || c.txId || c.faulted) return { status: 'Rejected' };
        if (p.chargingProfile) {
          setTimeout(() => {
            if (c.txId)
              this.profiles.push({
                connectorId: c.id,
                profile: { ...p.chargingProfile, transactionId: c.txId },
                receivedAt: Date.now(),
              });
          }, 1500);
        }
        setTimeout(() => this.startTx(c, p.idTag, true), 200);
        return { status: 'Accepted' };
      }
      case 'RemoteStopTransaction': {
        const c = this.connectors.find((x) => x.txId === p.transactionId);
        if (!c) return { status: 'Rejected' };
        setTimeout(() => this.stopTx(c, 'Remote'), 200);
        return { status: 'Accepted' };
      }
      case 'Reset': {
        setTimeout(async () => {
          for (const c of this.connectors) await this.stopTx(c, p.type === 'Hard' ? 'HardReset' : 'SoftReset');
          this.profiles = [];
          this.log('warn', `Reset ${p.type}: reiniciando…`);
          this.ws.close(1000, 'Reset'); // #onClose reconecta (autoReconnect)
        }, 300);
        return { status: 'Accepted' };
      }
      case 'UnlockConnector': {
        const c = this.connectors.find((x) => x.id === p.connectorId);
        if (!c) return { status: 'NotSupported' };
        setTimeout(() => this.unplug(c), 100);
        return { status: 'Unlocked' };
      }
      case 'ChangeAvailability':
        return { status: 'Accepted' };
      case 'GetConfiguration': {
        const all = [
          { key: 'HeartbeatInterval', readonly: false, value: String(this.heartbeatInterval) },
          { key: 'MeterValueSampleInterval', readonly: false, value: String(this.meterInterval) },
          { key: 'NumberOfConnectors', readonly: true, value: String(this.o.connectors) },
          { key: 'ChargingScheduleAllowedChargingRateUnit', readonly: true, value: 'Current,Power' },
          { key: 'ChargeProfileMaxStackLevel', readonly: true, value: '10' },
          { key: 'MaxChargingProfilesInstalled', readonly: true, value: '10' },
        ];
        const keys = p.key || [];
        return {
          configurationKey: keys.length ? all.filter((k) => keys.includes(k.key)) : all,
          unknownKey: keys.filter((k) => !all.some((a) => a.key === k)),
        };
      }
      case 'ChangeConfiguration': {
        const v = Number(p.value);
        if (p.key === 'MeterValueSampleInterval' && v > 0) {
          this.meterInterval = v;
          this.#startTimers();
          return { status: 'Accepted' };
        }
        if (p.key === 'HeartbeatInterval' && v > 0) {
          this.heartbeatInterval = v;
          this.#startTimers();
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      }
      case 'TriggerMessage': {
        const m = p.requestedMessage;
        const ok = ['StatusNotification', 'MeterValues', 'Heartbeat', 'BootNotification'].includes(m);
        if (ok) {
          setTimeout(() => {
            if (m === 'Heartbeat') this.call('Heartbeat', {}).catch(() => {});
            if (m === 'MeterValues') this.sendMeterValues();
            if (m === 'BootNotification') this.#onOpen();
            if (m === 'StatusNotification')
              this.connectors.forEach((c) => {
                c.status = null;
                this.updateStatus(c);
              });
          }, 100);
        }
        return { status: ok ? 'Accepted' : 'NotImplemented' };
      }
      case 'DataTransfer':
        return { status: 'UnknownVendorId' };
      default: {
        const e = new Error(`No soportado: ${action}`);
        e.code = 'NotImplemented';
        throw e;
      }
    }
  }
}
