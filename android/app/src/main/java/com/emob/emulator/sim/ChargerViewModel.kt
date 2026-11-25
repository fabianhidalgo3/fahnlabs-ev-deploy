package com.emob.emulator.sim

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.emob.emulator.ocpp.OcppClient
import com.emob.emulator.ocpp.OcppException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

private const val VOLTAGE = 230.0

data class UiState(
    // configuración
    val url: String = "ws://10.0.2.2:9100/ocpp",
    val cpId: String = "CP-ANDROID-01",
    val maxKw: String = "22",
    val phases: Int = 3,
    val speed: Int = 10,
    // conexión
    val connected: Boolean = false,
    val connecting: Boolean = false,
    // conector 1
    val status: String = "Available",
    val plugged: Boolean = false,
    val faulted: Boolean = false,
    val txId: Int? = null,
    val powerW: Double = 0.0,
    val limitW: Double = Double.POSITIVE_INFINITY,
    val meterWh: Double = 120_000.0,
    // vehículo
    val soc: Double = 25.0,
    val evName: String = "VE manual",
    val vin: String = "",
    val evccid: String = "",
    val evCapKWh: String = "60",
    val evMaxKw: String = "11",
    val evPhases: Int = 3,
    val targetSoc: String = "80",
    val idTag: String = "TAG-ANDROID",
    val identMode: IdentMode = IdentMode.RFID,
    // vehículos de la BD del CSMS
    val vehicles: List<VehicleItem> = emptyList(),
    val loadingVehicles: Boolean = false,
    // registro
    val log: List<String> = emptyList(),
)

/** Cómo se identifica el VE ante el CSMS. */
enum class IdentMode(val label: String) {
    RFID("RFID"),
    AUTOCHARGE("Autocharge"),
    ISO15118("ISO 15118"),
}

/** Vehículo registrado en la BD del CSMS (GET /api/v1/vehicles). */
data class VehicleItem(
    val id: Int,
    val name: String,
    val vin: String?,
    val evccid: String?,
    val idTag: String?,
    val batteryKwh: Double,
    val maxAcKw: Double,
    val phases: Int,
    val targetSoc: Double,
)

private data class Profile(
    val id: Int,
    val connectorId: Int,
    val purpose: String,
    val stackLevel: Int,
    val transactionId: Int?,
    val kind: String,
    val unit: String,
    val startSchedule: Long?,
    val duration: Int?,
    val periods: List<Triple<Int, Double, Int?>>, // startPeriod, limit, numberPhases
    val receivedAt: Long,
)

/** Emulador de un punto de carga AC de 1 conector con VE simulado, controlado por perfiles OCPP. */
class ChargerViewModel : ViewModel() {
    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var client: OcppClient? = null
    private var loops = mutableListOf<Job>()
    private val profiles = mutableListOf<Profile>()
    private var lastSentStatus: String? = null
    private var manualDisconnect = false
    private var heartbeatSec = 30
    private var meterSec = 5
    private var txStartMs = 0L
    private var activeTag = ""

    private inline fun update(block: UiState.() -> UiState) {
        _ui.value = _ui.value.block()
    }

    private fun log(line: String) {
        val t = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        update { copy(log = (log + "$t  $line").takeLast(150)) }
    }

    private fun now() = Instant.now().toString()
    private val s get() = _ui.value
    private val chargerMaxW get() = (s.maxKw.toDoubleOrNull() ?: 22.0) * 1000
    // IEC 61851: 6 A en las fases que realmente usa el VE
    private val minEvW get() = 6 * VOLTAGE * min(s.phases, s.evPhases)
    private val http = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build()

    // ---------- edición de configuración ----------
    fun setUrl(v: String) = update { copy(url = v) }
    fun setCpId(v: String) = update { copy(cpId = v) }
    fun setMaxKw(v: String) = update { copy(maxKw = v) }
    fun setPhases(v: Int) = update { copy(phases = v) }
    fun setSpeed(v: Int) = update { copy(speed = v) }
    fun setEvCap(v: String) = update { copy(evCapKWh = v) }
    fun setEvMax(v: String) = update { copy(evMaxKw = v) }
    fun setIdTag(v: String) = update { copy(idTag = v) }
    fun setSoc(v: Float) = update { copy(soc = v.toDouble()) }
    fun setEvName(v: String) = update { copy(evName = v) }
    fun setVin(v: String) = update { copy(vin = v.uppercase(Locale.ROOT).filter { it.isLetterOrDigit() }.take(17)) }
    fun setEvccid(v: String) = update { copy(evccid = v.uppercase(Locale.ROOT).filter { it in "0123456789ABCDEF" }.take(12)) }
    fun setEvPhases(v: Int) = update { copy(evPhases = v) }
    fun setTargetSoc(v: String) = update { copy(targetSoc = v) }
    fun setIdentMode(v: IdentMode) = update { copy(identMode = v) }

    // ---------- vehículos de la BD ----------
    /** ws://host:9100/ocpp (OCPP gateway) → http://host:9200 (motor domain API, where the vehicle registry lives) */
    private fun httpBase(): String? = runCatching {
        val u = URI(s.url.trim())
        val scheme = if (u.scheme.equals("wss", ignoreCase = true)) "https" else "http"
        val host = u.host ?: return null
        "$scheme://$host:9200"
    }.getOrNull()

    fun loadVehicles() {
        val base = httpBase()
        if (base == null) {
            log("URL inválida: no se puede derivar la API")
            return
        }
        update { copy(loadingVehicles = true) }
        viewModelScope.launch {
            try {
                val list = withContext(Dispatchers.IO) {
                    val req = Request.Builder().url("$base/api/v1/vehicles").get().build()
                    http.newCall(req).execute().use { resp ->
                        if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
                        parseVehicles(resp.body?.string() ?: "[]")
                    }
                }
                update { copy(vehicles = list) }
                log("${list.size} vehículos cargados de la BD")
            } catch (e: Exception) {
                log("No se pudieron cargar vehículos: ${e.message}")
            } finally {
                update { copy(loadingVehicles = false) }
            }
        }
    }

    private fun parseVehicles(json: String): List<VehicleItem> {
        val arr = JSONArray(json)
        fun JSONObject.str(k: String) = if (isNull(k)) null else optString(k).takeIf { it.isNotEmpty() }
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            VehicleItem(
                id = o.optInt("id"),
                name = o.optString("name", "VE"),
                vin = o.str("vin"),
                evccid = o.str("evccid"),
                idTag = o.str("id_tag"),
                batteryKwh = o.optDouble("battery_kwh", 60.0),
                maxAcKw = o.optDouble("max_ac_kw", 11.0),
                phases = o.optInt("phases", 3),
                targetSoc = o.optDouble("target_soc", 80.0),
            )
        }
    }

    fun selectVehicle(v: VehicleItem) {
        fun num(d: Double) = if (d % 1.0 == 0.0) d.toLong().toString() else d.toString()
        update {
            copy(
                evName = v.name,
                vin = v.vin ?: "",
                evccid = v.evccid ?: "",
                idTag = v.idTag ?: idTag,
                evCapKWh = num(v.batteryKwh),
                evMaxKw = num(v.maxAcKw),
                evPhases = if (v.phases <= 1) 1 else 3,
                targetSoc = num(v.targetSoc),
            )
        }
        log("Vehículo seleccionado: ${v.name}")
    }

    /** idTag que se presenta según el modo de identificación (CiString20 en OCPP 1.6). */
    private fun effectiveIdTag(): String = when (s.identMode) {
        IdentMode.RFID -> s.idTag
        IdentMode.AUTOCHARGE -> if (s.evccid.isNotEmpty()) "VID:${s.evccid}" else s.idTag
        IdentMode.ISO15118 -> s.idTag.ifBlank { if (s.vin.length >= 8) "EV-${s.vin.takeLast(8)}" else "EV-UNKNOWN" }
    }.take(20)

    /** Simula la info que el cargador obtiene del VE por comunicación de alto nivel. */
    private suspend fun sendVehicleInfo() {
        val c = client ?: return
        val data = JSONObject().put("connectorId", 1)
        when (s.identMode) {
            IdentMode.RFID -> return
            IdentMode.AUTOCHARGE -> {
                if (s.evccid.isEmpty()) return
                data.put("evccid", s.evccid)
            }
            IdentMode.ISO15118 -> {
                if (s.vin.isEmpty() && s.evccid.isEmpty()) return
                if (s.vin.isNotEmpty()) data.put("vin", s.vin)
                if (s.evccid.isNotEmpty()) data.put("evccid", s.evccid)
            }
        }
        runCatching {
            c.call("DataTransfer", JSONObject()
                .put("vendorId", "EMOB").put("messageId", "VehicleInfo").put("data", data.toString()))
        }.onFailure { log("VehicleInfo: ${it.message}") }
    }

    // ---------- conexión ----------
    fun toggleConnection() {
        if (client != null) {
            manualDisconnect = true
            stopLoops()
            client?.disconnect()
            client = null
            update { copy(connected = false, connecting = false) }
            return
        }
        manualDisconnect = false
        openConnection()
    }

    private fun openConnection() {
        val url = "${s.url.trimEnd('/')}/${s.cpId.trim()}"
        log("Conectando a $url")
        update { copy(connecting = true) }
        client = OcppClient(
            scope = viewModelScope,
            onCall = ::handleCall,
            onOpen = { viewModelScope.launch { onOpen() } },
            onClosed = { reason -> onClosed(reason) },
            onTraffic = { out, text -> log((if (out) "⇢ " else "⇠ ") + text) },
        ).also { it.connect(url) }
    }

    private suspend fun onOpen() {
        update { copy(connected = true, connecting = false) }
        val c = client ?: return
        try {
            val boot = c.call("BootNotification", JSONObject()
                .put("chargePointVendor", "EmuCharge")
                .put("chargePointModel", "AC-Android")
                .put("chargePointSerialNumber", s.cpId)
                .put("firmwareVersion", "emu-android-1.0"))
            if (boot.optString("status") != "Accepted") {
                log("Boot ${boot.optString("status")}, reintento en 10 s")
                delay(10_000)
                if (client === c) onOpen()
                return
            }
            heartbeatSec = boot.optInt("interval", 30).coerceAtLeast(5)
            c.call("DataTransfer", JSONObject()
                .put("vendorId", "EMOB").put("messageId", "Capabilities")
                .put("data", JSONObject().put("maxPowerW", chargerMaxW).put("connectors", 1).put("phases", s.phases).toString()))
            c.call("StatusNotification", JSONObject().put("connectorId", 0).put("status", "Available").put("errorCode", "NoError"))
            lastSentStatus = null
            refreshStatus()
            startLoops()
        } catch (e: Exception) {
            log("Error en arranque: ${e.message}")
        }
    }

    private fun onClosed(reason: String) {
        stopLoops()
        update { copy(connected = false, connecting = false) }
        log("Conexión cerrada: $reason")
        if (!manualDisconnect && client != null) {
            viewModelScope.launch {
                delay(5_000)
                if (!manualDisconnect && client != null) openConnection()
            }
        }
    }

    private fun startLoops() {
        stopLoops()
        loops += viewModelScope.launch {
            var last = System.nanoTime()
            while (isActive) {
                delay(500)
                val t = System.nanoTime()
                tick((t - last) / 1e9)
                last = t
            }
        }
        loops += viewModelScope.launch {
            while (isActive) {
                delay(heartbeatSec * 1000L)
                runCatching { client?.call("Heartbeat") }
            }
        }
        loops += viewModelScope.launch {
            while (isActive) {
                delay(meterSec * 1000L)
                sendMeterValues()
            }
        }
    }

    private fun stopLoops() {
        loops.forEach { it.cancel() }
        loops.clear()
    }

    // ---------- perfiles de carga ----------
    private fun scheduleLimitW(p: Profile): Double {
        val start = when {
            p.kind == "Absolute" && p.startSchedule != null -> p.startSchedule
            p.kind == "Relative" && txStartMs > 0 -> txStartMs
            else -> p.receivedAt
        }
        val elapsed = max(0.0, (System.currentTimeMillis() - start) / 1000.0)
        if (p.duration != null && elapsed > p.duration) return Double.POSITIVE_INFINITY
        var limit: Double? = null
        var phases = s.phases
        for ((startPeriod, lim, np) in p.periods.sortedBy { it.first }) {
            if (startPeriod <= elapsed) {
                limit = lim
                phases = np ?: s.phases
            }
        }
        val l = limit ?: return Double.POSITIVE_INFINITY
        return if (p.unit == "A") l * VOLTAGE * min(phases, s.phases) else l
    }

    private fun currentLimitW(): Double {
        val tx = profiles.filter { it.purpose == "TxProfile" && it.connectorId == 1 && (it.transactionId == null || it.transactionId == s.txId) }
            .maxByOrNull { it.stackLevel }
        val def = profiles.filter { it.purpose == "TxDefaultProfile" && (it.connectorId == 1 || it.connectorId == 0) }
            .maxByOrNull { it.stackLevel }
        val cpMax = profiles.filter { it.purpose == "ChargePointMaxProfile" }.maxByOrNull { it.stackLevel }
        val base = (tx ?: def)?.let { scheduleLimitW(it) } ?: Double.POSITIVE_INFINITY
        return min(base, cpMax?.let { scheduleLimitW(it) } ?: Double.POSITIVE_INFINITY)
    }

    private fun parseProfile(connectorId: Int, o: JSONObject): Profile {
        val sch = o.getJSONObject("chargingSchedule")
        val arr = sch.getJSONArray("chargingSchedulePeriod")
        val periods = (0 until arr.length()).map {
            val p = arr.getJSONObject(it)
            Triple(p.getInt("startPeriod"), p.getDouble("limit"), if (p.has("numberPhases")) p.getInt("numberPhases") else null)
        }
        return Profile(
            id = o.getInt("chargingProfileId"),
            connectorId = connectorId,
            purpose = o.getString("chargingProfilePurpose"),
            stackLevel = o.optInt("stackLevel", 0),
            transactionId = if (o.has("transactionId")) o.getInt("transactionId") else null,
            kind = o.optString("chargingProfileKind", "Relative"),
            unit = sch.optString("chargingRateUnit", "W"),
            startSchedule = sch.optString("startSchedule", "").takeIf { it.isNotEmpty() }
                ?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() },
            duration = if (sch.has("duration")) sch.getInt("duration") else null,
            periods = periods,
            receivedAt = System.currentTimeMillis(),
        )
    }

    // ---------- simulación ----------
    private fun evAcceptW(): Double {
        val soc = s.soc
        if (soc >= 100) return 0.0
        val taper = if (soc < 80) 1.0 else max(0.08, (100 - soc) / 20)
        return (s.evMaxKw.toDoubleOrNull() ?: 11.0) * 1000 * taper
    }

    private fun tick(dt: Double) {
        val limit = currentLimitW()
        var target = if (s.txId != null && !s.faulted) minOf(chargerMaxW, evAcceptW(), limit) else 0.0
        if (target < minEvW) target = 0.0
        var power = s.powerW + (target - s.powerW) * min(1.0, dt * 1.5)
        if (power < 50 && target == 0.0) power = 0.0
        val wh = power * dt * s.speed / 3600.0
        val cap = (s.evCapKWh.toDoubleOrNull() ?: 60.0) * 1000
        update {
            copy(
                limitW = limit,
                powerW = power,
                meterWh = meterWh + wh,
                soc = min(100.0, soc + wh / cap * 100),
            )
        }
        refreshStatus()
    }

    private fun computeStatus(): String = when {
        s.faulted -> "Faulted"
        !s.plugged -> "Available"
        s.txId == null -> if (lastSentStatus == "Finishing" || lastSentStatus == "Charging" || lastSentStatus?.startsWith("Suspended") == true) "Finishing" else "Preparing"
        evAcceptW() == 0.0 -> "SuspendedEV"
        min(currentLimitW(), chargerMaxW) < minEvW -> "SuspendedEVSE"
        else -> "Charging"
    }

    private fun refreshStatus() {
        val st = computeStatus()
        update { copy(status = st) }
        if (st == lastSentStatus) return
        lastSentStatus = st
        viewModelScope.launch {
            runCatching {
                client?.call("StatusNotification", JSONObject()
                    .put("connectorId", 1).put("status", st)
                    .put("errorCode", if (s.faulted) "OtherError" else "NoError")
                    .put("timestamp", now()))
            }
        }
    }

    private suspend fun sendMeterValues() {
        val tx = s.txId ?: return
        val amps = s.powerW / (VOLTAGE * min(s.phases, s.evPhases))
        fun sv(v: String, m: String, u: String) = JSONObject().put("value", v).put("measurand", m).put("unit", u).put("context", "Sample.Periodic")
        val values = JSONArray()
            .put(sv("%.0f".format(Locale.US, s.powerW), "Power.Active.Import", "W"))
            .put(sv("%.0f".format(Locale.US, s.meterWh), "Energy.Active.Import.Register", "Wh"))
            .put(sv("%.1f".format(Locale.US, amps), "Current.Import", "A"))
            .put(sv("%.1f".format(Locale.US, s.soc), "SoC", "Percent").put("location", "EV"))
        runCatching {
            client?.call("MeterValues", JSONObject()
                .put("connectorId", 1).put("transactionId", tx)
                .put("meterValue", JSONArray().put(JSONObject().put("timestamp", now()).put("sampledValue", values))))
        }
    }

    // ---------- acciones locales ----------
    fun togglePlug() {
        if (s.plugged) {
            if (s.txId != null) viewModelScope.launch { stopTx("EVDisconnected") }
            update { copy(plugged = false) }
        } else {
            lastSentStatus = lastSentStatus.takeIf { it != "Finishing" }
            update { copy(plugged = true) }
            // Al enchufar, el cargador conoce VIN/EVCCID por HLC y lo informa al CSMS
            viewModelScope.launch { sendVehicleInfo() }
        }
        refreshStatus()
    }

    fun startLocal() = viewModelScope.launch { startTx(effectiveIdTag(), remote = false) }
    fun stopLocal() = viewModelScope.launch { stopTx("Local") }

    fun toggleFault() = viewModelScope.launch {
        val f = !s.faulted
        update { copy(faulted = f) }
        if (f && s.txId != null) stopTx("Other")
        refreshStatus()
    }

    private suspend fun startTx(idTag: String, remote: Boolean) {
        val c = client ?: return
        if (s.txId != null || s.faulted) return
        if (!s.plugged) {
            update { copy(plugged = true) }
            sendVehicleInfo()
        }
        refreshStatus()
        try {
            if (!remote) {
                val auth = c.call("Authorize", JSONObject().put("idTag", idTag))
                val st = auth.optJSONObject("idTagInfo")?.optString("status")
                if (st != "Accepted") {
                    log("idTag rechazado: $st")
                    return
                }
            }
            val res = c.call("StartTransaction", JSONObject()
                .put("connectorId", 1).put("idTag", idTag)
                .put("meterStart", s.meterWh.toLong()).put("timestamp", now()))
            txStartMs = System.currentTimeMillis()
            activeTag = idTag
            update { copy(txId = res.getInt("transactionId")) }
            if (res.optJSONObject("idTagInfo")?.optString("status") != "Accepted") stopTx("DeAuthorized")
            refreshStatus()
            sendMeterValues()
        } catch (e: Exception) {
            log("No se pudo iniciar: ${e.message}")
        }
    }

    private suspend fun stopTx(reason: String) {
        val tx = s.txId ?: return
        update { copy(txId = null, powerW = 0.0) }
        profiles.removeAll { it.purpose == "TxProfile" }
        txStartMs = 0
        refreshStatus()
        runCatching {
            client?.call("StopTransaction", JSONObject()
                .put("transactionId", tx).put("idTag", activeTag)
                .put("meterStop", s.meterWh.toLong()).put("timestamp", now()).put("reason", reason))
        }.onFailure { log("StopTransaction: ${it.message}") }
    }

    // ---------- mensajes del CSMS ----------
    private suspend fun handleCall(action: String, p: JSONObject): JSONObject {
        fun status(v: String) = JSONObject().put("status", v)
        return when (action) {
            "SetChargingProfile" -> {
                val connectorId = p.optInt("connectorId", 0)
                val prof = runCatching { parseProfile(connectorId, p.getJSONObject("csChargingProfiles")) }.getOrNull()
                    ?: return status("Rejected")
                if (prof.purpose == "TxProfile" && (connectorId != 1 || s.txId == null)) return status("Rejected")
                profiles.removeAll {
                    it.id == prof.id || (it.connectorId == prof.connectorId && it.stackLevel == prof.stackLevel && it.purpose == prof.purpose)
                }
                profiles += prof
                log("Perfil ${prof.purpose}: %.1f kW".format(Locale.US, scheduleLimitW(prof) / 1000))
                status("Accepted")
            }
            "ClearChargingProfile" -> {
                val before = profiles.size
                profiles.removeAll { pr ->
                    when {
                        p.has("id") -> pr.id == p.getInt("id")
                        else -> (!p.has("connectorId") || pr.connectorId == p.getInt("connectorId")) &&
                            (!p.has("chargingProfilePurpose") || pr.purpose == p.getString("chargingProfilePurpose")) &&
                            (!p.has("stackLevel") || pr.stackLevel == p.getInt("stackLevel"))
                    }
                }
                status(if (profiles.size < before) "Accepted" else "Unknown")
            }
            "GetCompositeSchedule" -> {
                val lim = min(currentLimitW(), chargerMaxW)
                JSONObject().put("status", "Accepted").put("connectorId", p.optInt("connectorId"))
                    .put("scheduleStart", now())
                    .put("chargingSchedule", JSONObject().put("chargingRateUnit", "W")
                        .put("chargingSchedulePeriod", JSONArray().put(JSONObject().put("startPeriod", 0).put("limit", lim.toLong()))))
            }
            "RemoteStartTransaction" -> {
                if (s.txId != null || s.faulted || (p.has("connectorId") && p.getInt("connectorId") != 1)) {
                    status("Rejected")
                } else {
                    val tag = p.optString("idTag", "REMOTE")
                    viewModelScope.launch { delay(200); startTx(tag, remote = true) }
                    status("Accepted")
                }
            }
            "RemoteStopTransaction" -> {
                if (p.optInt("transactionId") != s.txId) status("Rejected")
                else {
                    viewModelScope.launch { delay(200); stopTx("Remote") }
                    status("Accepted")
                }
            }
            "Reset" -> {
                val type = p.optString("type", "Soft")
                viewModelScope.launch {
                    delay(300)
                    stopTx(if (type == "Hard") "HardReset" else "SoftReset")
                    profiles.clear()
                    log("Reset $type: reiniciando…")
                    client?.disconnect() // onClosed reconecta automáticamente
                }
                status("Accepted")
            }
            "UnlockConnector" -> {
                viewModelScope.launch { if (s.plugged) togglePlug() }
                status("Unlocked")
            }
            "ChangeAvailability" -> status("Accepted")
            "GetConfiguration" -> {
                fun kv(k: String, v: String, ro: Boolean) = JSONObject().put("key", k).put("value", v).put("readonly", ro)
                JSONObject().put("configurationKey", JSONArray()
                    .put(kv("HeartbeatInterval", "$heartbeatSec", false))
                    .put(kv("MeterValueSampleInterval", "$meterSec", false))
                    .put(kv("NumberOfConnectors", "1", true))
                    .put(kv("ChargingScheduleAllowedChargingRateUnit", "Current,Power", true))
                    .put(kv("ChargeProfileMaxStackLevel", "10", true)))
            }
            "ChangeConfiguration" -> {
                val v = p.optString("value").toIntOrNull()
                when {
                    v == null || v <= 0 -> status("Rejected")
                    p.optString("key") == "MeterValueSampleInterval" -> { meterSec = v; startLoops(); status("Accepted") }
                    p.optString("key") == "HeartbeatInterval" -> { heartbeatSec = v; startLoops(); status("Accepted") }
                    else -> status("NotSupported")
                }
            }
            "TriggerMessage" -> {
                when (p.optString("requestedMessage")) {
                    "StatusNotification" -> { lastSentStatus = null; viewModelScope.launch { delay(100); refreshStatus() }; status("Accepted") }
                    "MeterValues" -> { viewModelScope.launch { delay(100); sendMeterValues() }; status("Accepted") }
                    "Heartbeat" -> { viewModelScope.launch { delay(100); runCatching { client?.call("Heartbeat") } }; status("Accepted") }
                    else -> status("NotImplemented")
                }
            }
            "DataTransfer" -> status("UnknownVendorId")
            else -> throw OcppException("NotImplemented", "No soportado: $action")
        }
    }

    override fun onCleared() {
        manualDisconnect = true
        client?.disconnect()
    }
}
