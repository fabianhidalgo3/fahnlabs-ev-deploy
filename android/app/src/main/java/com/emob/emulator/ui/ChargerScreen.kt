package com.emob.emulator.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.emob.emulator.sim.ChargerViewModel
import com.emob.emulator.sim.IdentMode
import com.emob.emulator.sim.VehicleItem
import java.util.Locale

private val STATUS_ES = mapOf(
    "Available" to "Disponible", "Preparing" to "Preparando", "Charging" to "Cargando",
    "SuspendedEV" to "Pausa VE", "SuspendedEVSE" to "Pausa red", "Finishing" to "Finalizando",
    "Faulted" to "Avería", "Unavailable" to "No disponible",
)

private fun kw(w: Double) = String.format(Locale.US, "%.1f kW", w / 1000)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VehiclePicker(
    vehicles: List<VehicleItem>,
    enabled: Boolean,
    onSelect: (VehicleItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<String?>(null) }
    ExposedDropdownMenuBox(
        expanded = expanded && enabled,
        onExpandedChange = { if (enabled) expanded = it },
        modifier = modifier,
    ) {
        OutlinedTextField(
            value = selected ?: if (vehicles.isEmpty()) "Sin vehículos" else "Elegir vehículo",
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            singleLine = true,
            label = { Text("Vehículo de la BD") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
            vehicles.forEach { v ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(v.name)
                            Text(
                                "${v.maxAcKw} kW · ${v.phases}F · ${v.batteryKwh} kWh",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    },
                    onClick = {
                        selected = v.name
                        expanded = false
                        onSelect(v)
                    },
                )
            }
        }
    }
}

@Composable
fun ChargerScreen(vm: ChargerViewModel = viewModel()) {
    val s by vm.ui.collectAsStateWithLifecycle()
    val logState = rememberLazyListState()
    LaunchedEffect(s.log.size) { if (s.log.isNotEmpty()) logState.scrollToItem(s.log.size - 1) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        LazyColumn(
            Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Spacer(Modifier.height(8.dp))
                Text("Emulador de cargador OCPP 1.6J", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    if (s.connected) "● Conectado" else if (s.connecting) "○ Conectando…" else "○ Desconectado",
                    color = if (s.connected) Color(0xFF22C55E) else MaterialTheme.colorScheme.error,
                )
            }

            // ----- conexión -----
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val editable = !s.connected && !s.connecting
                        OutlinedTextField(s.url, vm::setUrl, label = { Text("URL del CSMS") }, singleLine = true, enabled = editable, modifier = Modifier.fillMaxWidth())
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(s.cpId, vm::setCpId, label = { Text("ChargePoint ID") }, singleLine = true, enabled = editable, modifier = Modifier.weight(1.4f))
                            OutlinedTextField(
                                s.maxKw, vm::setMaxKw, label = { Text("Máx. kW") }, singleLine = true, enabled = editable,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Fases:")
                            listOf(1, 3).forEach { n -> FilterChip(s.phases == n, { vm.setPhases(n) }, { Text("$n") }, enabled = editable) }
                            Spacer(Modifier.weight(1f))
                            Text("Tiempo:")
                            listOf(1, 10, 60).forEach { n -> FilterChip(s.speed == n, { vm.setSpeed(n) }, { Text("x$n") }) }
                        }
                        Button(onClick = vm::toggleConnection, modifier = Modifier.fillMaxWidth()) {
                            Text(if (s.connected || s.connecting) "Desconectar" else "Conectar")
                        }
                    }
                }
            }

            // ----- conector -----
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Conector 1", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            AssistChip(onClick = {}, label = { Text(STATUS_ES[s.status] ?: s.status) })
                        }
                        Text(
                            if (s.plugged) "🚗 ${s.evName} · ${s.identMode.label}" +
                                (if (s.vin.isNotEmpty()) " · VIN ${s.vin}" else "") else "Sin vehículo enchufado",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(kw(s.powerW), fontSize = 40.sp, fontWeight = FontWeight.Bold)
                        Text(
                            "Límite OCPP: ${if (s.limitW.isInfinite()) "sin perfil" else kw(s.limitW)}   ·   " +
                                "Sesión: ${s.txId?.let { "#$it" } ?: "–"}   ·   " +
                                String.format(Locale.US, "Contador: %.2f kWh", s.meterWh / 1000),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text(String.format(Locale.US, "SoC %.1f %%", s.soc), style = MaterialTheme.typography.labelLarge)
                        LinearProgressIndicator(progress = { (s.soc / 100).toFloat() }, modifier = Modifier.fillMaxWidth().height(10.dp))

                        val online = s.connected
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = vm::togglePlug, enabled = online && !s.faulted, modifier = Modifier.weight(1f)) {
                                Text(if (s.plugged) "Desenchufar" else "Enchufar")
                            }
                            OutlinedButton(onClick = { vm.toggleFault() }, enabled = online, modifier = Modifier.weight(1f)) {
                                Text(if (s.faulted) "Reparar" else "Avería")
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { vm.startLocal() }, enabled = online && s.txId == null && !s.faulted, modifier = Modifier.weight(1f)) {
                                Text("Iniciar carga")
                            }
                            Button(
                                onClick = { vm.stopLocal() }, enabled = online && s.txId != null, modifier = Modifier.weight(1f),
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                            ) { Text("Detener") }
                        }
                    }
                }
            }

            // ----- vehículo -----
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Vehículo simulado", fontWeight = FontWeight.Bold)
                        val locked = s.plugged || s.txId != null
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            VehiclePicker(
                                vehicles = s.vehicles,
                                enabled = !locked && s.vehicles.isNotEmpty(),
                                onSelect = vm::selectVehicle,
                                modifier = Modifier.weight(1f),
                            )
                            OutlinedButton(onClick = vm::loadVehicles, enabled = !s.loadingVehicles) {
                                Text(if (s.loadingVehicles) "Cargando…" else "Cargar de la BD")
                            }
                        }
                        Text("Identificación", style = MaterialTheme.typography.labelMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            IdentMode.entries.forEach { m ->
                                FilterChip(s.identMode == m, { vm.setIdentMode(m) }, { Text(m.label) }, enabled = !locked)
                            }
                        }
                        OutlinedTextField(s.evName, vm::setEvName, label = { Text("Nombre") }, singleLine = true, enabled = !locked, modifier = Modifier.fillMaxWidth())
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                s.vin, vm::setVin, label = { Text("VIN (${s.vin.length}/17)") }, singleLine = true, enabled = !locked,
                                isError = s.vin.isNotEmpty() && s.vin.length != 17, modifier = Modifier.weight(1.4f),
                            )
                            OutlinedTextField(
                                s.evccid, vm::setEvccid, label = { Text("EVCCID") }, singleLine = true, enabled = !locked,
                                isError = s.evccid.isNotEmpty() && s.evccid.length != 12, modifier = Modifier.weight(1f),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Fases VE:")
                            listOf(1, 3).forEach { n -> FilterChip(s.evPhases == n, { vm.setEvPhases(n) }, { Text("$n") }, enabled = !locked) }
                            Spacer(Modifier.weight(1f))
                            OutlinedTextField(
                                s.targetSoc, vm::setTargetSoc, label = { Text("SoC obj. %") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                s.evCapKWh, vm::setEvCap, label = { Text("Batería kWh") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f),
                            )
                            OutlinedTextField(
                                s.evMaxKw, vm::setEvMax, label = { Text("Cargador VE kW") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f),
                            )
                        }
                        OutlinedTextField(s.idTag, vm::setIdTag, label = { Text("idTag (RFID)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Text("Ajustar SoC", style = MaterialTheme.typography.labelMedium)
                        Slider(value = s.soc.toFloat(), onValueChange = vm::setSoc, valueRange = 0f..100f)
                    }
                }
            }

            // ----- registro -----
            item { Text("Tráfico OCPP", fontWeight = FontWeight.Bold) }
            item {
                Card(Modifier.fillMaxWidth().height(260.dp)) {
                    LazyColumn(Modifier.padding(8.dp), state = logState) {
                        items(s.log) { line ->
                            Text(line, fontFamily = FontFamily.Monospace, fontSize = 10.sp, lineHeight = 13.sp)
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}
