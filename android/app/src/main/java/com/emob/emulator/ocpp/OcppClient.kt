package com.emob.emulator.ocpp

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class OcppException(val code: String, message: String) : Exception(message)

/**
 * Cliente OCPP-J 1.6 (RPC sobre WebSocket) del lado del punto de carga.
 * Los callbacks se ejecutan en [scope] (viewModelScope → hilo principal).
 */
class OcppClient(
    private val scope: CoroutineScope,
    private val onCall: suspend (action: String, payload: JSONObject) -> JSONObject,
    private val onOpen: () -> Unit,
    private val onClosed: (reason: String) -> Unit,
    private val onTraffic: (outgoing: Boolean, text: String) -> Unit,
) {
    private val http = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()

    @Volatile
    var isOpen = false
        private set

    fun connect(url: String) {
        val req = Request.Builder()
            .url(url)
            .header("Sec-WebSocket-Protocol", "ocpp1.6")
            .build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (response.header("Sec-WebSocket-Protocol") != "ocpp1.6") {
                    webSocket.close(1002, "Subprotocolo no aceptado")
                    return
                }
                isOpen = true
                scope.launch { onOpen() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handleText(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                closed("Cerrado ($code) $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                closed("Error: ${t.message ?: t.javaClass.simpleName}")
            }
        })
    }

    private fun closed(reason: String) {
        isOpen = false
        pending.values.forEach { it.completeExceptionally(OcppException("ConnectionClosed", reason)) }
        pending.clear()
        scope.launch { onClosed(reason) }
    }

    fun disconnect() {
        ws?.close(1000, "Desconexión manual")
        ws = null
    }

    private fun send(frame: JSONArray): Boolean {
        val text = frame.toString()
        val ok = ws?.send(text) ?: false
        if (ok) onTraffic(true, text)
        return ok
    }

    suspend fun call(action: String, payload: JSONObject = JSONObject(), timeoutMs: Long = 15_000): JSONObject {
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<JSONObject>()
        pending[id] = deferred
        try {
            if (!send(JSONArray().put(2).put(id).put(action).put(payload))) {
                throw OcppException("ConnectionClosed", "Sin conexión")
            }
            return withTimeout(timeoutMs) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    private suspend fun handleText(text: String) {
        val msg = try {
            JSONArray(text)
        } catch (e: Exception) {
            return
        }
        onTraffic(false, text)
        val id = msg.optString(1)
        when (msg.optInt(0)) {
            2 -> {
                val action = msg.optString(2)
                val payload = msg.optJSONObject(3) ?: JSONObject()
                try {
                    send(JSONArray().put(3).put(id).put(onCall(action, payload)))
                } catch (e: OcppException) {
                    send(JSONArray().put(4).put(id).put(e.code).put(e.message ?: "").put(JSONObject()))
                } catch (e: Exception) {
                    send(JSONArray().put(4).put(id).put("InternalError").put(e.message ?: "").put(JSONObject()))
                }
            }
            3 -> pending[id]?.complete(msg.optJSONObject(2) ?: JSONObject())
            4 -> pending[id]?.completeExceptionally(OcppException(msg.optString(2), msg.optString(3)))
        }
    }
}
