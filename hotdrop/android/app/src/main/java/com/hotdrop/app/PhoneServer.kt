package com.hotdrop.app

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors

/**
 * Minimal HTTP/1.1 server the PC talks to. The PC always initiates:
 *   GET  /ping              -> who we are
 *   GET  /outbox?wait=N     -> files queued for the PC (long-poll)
 *   GET  /file/{id}         -> stream one queued file to the PC
 *   PUT  /upload?name=&size -> receive a file from the PC
 */
class PhoneServer(private val ctx: Context) {
    private val pool = Executors.newCachedThreadPool()
    @Volatile private var server: ServerSocket? = null
    private val wakeLock = (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HotDrop:transfer").apply { setReferenceCounted(true) }

    private val deviceName: String by lazy {
        Settings.Global.getString(ctx.contentResolver, "device_name")?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
    }

    fun start() {
        Thread({
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.receiveBufferSize = 1 shl 20
                ss.bind(InetSocketAddress(Hub.PORT), 64)
                server = ss
                while (!ss.isClosed) {
                    val s = try { ss.accept() } catch (e: Exception) { break }
                    pool.execute { handle(s) }
                }
            } catch (_: Exception) {
            }
        }, "hotdrop-accept").start()
    }

    fun stop() {
        runCatching { server?.close() }
        pool.shutdownNow()
    }

    private class Request(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>)

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream(128)
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString("UTF-8")
            if (b == '\n'.code) return buf.toString("UTF-8").trimEnd('\r')
            buf.write(b)
            if (buf.size() > 16 * 1024) throw IllegalStateException("line too long")
        }
    }

    private fun parse(input: InputStream): Request? {
        val line = readLine(input) ?: return null
        val parts = line.split(' ')
        if (parts.size < 2) return null
        val headers = HashMap<String, String>()
        while (true) {
            val h = readLine(input) ?: break
            if (h.isEmpty()) break
            val i = h.indexOf(':')
            if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
        }
        val target = parts[1]
        val path = target.substringBefore('?')
        val query = HashMap<String, String>()
        if ('?' in target) {
            for (kv in target.substringAfter('?').split('&')) {
                if (kv.isEmpty()) continue
                val k = URLDecoder.decode(kv.substringBefore('='), "UTF-8")
                val v = URLDecoder.decode(kv.substringAfter('=', ""), "UTF-8")
                query[k] = v
            }
        }
        return Request(parts[0], URLDecoder.decode(path, "UTF-8"), query, headers)
    }

    private fun respond(out: OutputStream, code: Int, body: String, type: String = "application/json") {
        val bytes = body.toByteArray()
        val reason = when (code) { 200 -> "OK"; 400 -> "Bad Request"; 404 -> "Not Found"; else -> "Error" }
        out.write(("HTTP/1.1 $code $reason\r\nContent-Type: $type; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray())
        out.write(bytes)
        out.flush()
    }

    private fun json(s: String) = buildString {
        append('"')
        for (c in s) when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c < ' ' -> append(String.format("\\u%04x", c.code))
            else -> append(c)
        }
        append('"')
    }

    private fun handle(sock: Socket) {
        sock.use { s ->
            try {
                s.tcpNoDelay = true
                s.sendBufferSize = 1 shl 20
                s.soTimeout = 60_000
                val input = BufferedInputStream(s.getInputStream(), 256 * 1024)
                val out = BufferedOutputStream(s.getOutputStream(), 256 * 1024)
                val req = parse(input) ?: return
                req.headers["x-hotdrop-name"]?.let { Hub.touch(it) }
                when {
                    req.method == "GET" && req.path == "/ping" ->
                        respond(out, 200, """{"app":"hotdrop","name":${json(deviceName)},"v":1}""")
                    req.method == "GET" && req.path == "/outbox" -> outbox(req, out)
                    req.method == "GET" && req.path.startsWith("/file/") -> sendFile(req.path.removePrefix("/file/"), out)
                    req.method == "PUT" && req.path == "/upload" -> receive(req, input, out)
                    else -> respond(out, 404, """{"error":"not found"}""")
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun outbox(req: Request, out: OutputStream) {
        val wait = (req.query["wait"]?.toLongOrNull() ?: 0L).coerceIn(0, 30) * 1000
        val items = Hub.waitPending(wait)
        Hub.pcName?.let { Hub.touch(it) }
        val body = items.joinToString(",", "[", "]") {
            """{"id":${json(it.id)},"name":${json(it.name)},"size":${it.size}}"""
        }
        respond(out, 200, body)
    }

    private fun sendFile(id: String, out: OutputStream) {
        val t = Hub.claim(id) ?: return respond(out, 404, """{"error":"no such file"}""")
        wakeLock.acquire(6 * 60 * 60 * 1000L)
        try {
            val input = ctx.contentResolver.openInputStream(t.uri!!) ?: throw IllegalStateException("Cannot open file")
            input.use { src ->
                val head = StringBuilder("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n")
                if (t.size >= 0) head.append("Content-Length: ${t.size}\r\n")
                out.write(head.append("\r\n").toString().toByteArray())
                val buf = ByteArray(512 * 1024)
                while (true) {
                    val n = src.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    t.done += n
                }
                out.flush()
            }
            if (t.size < 0) t.size = t.done
            Hub.finish(t, null)
        } catch (e: Exception) {
            Hub.finish(t, "Connection lost")
        } finally {
            if (wakeLock.isHeld) wakeLock.release()
        }
    }

    private fun receive(req: Request, input: InputStream, out: OutputStream) {
        val name = req.query["name"]?.takeIf { it.isNotBlank() } ?: return respond(out, 400, """{"error":"missing name"}""")
        val len = req.headers["content-length"]?.toLongOrNull() ?: 0L
        val t = Hub.Transfer(Storage.cleanName(name), len, toPc = false, uri = null)
        t.status = Hub.Status.ACTIVE
        t.startedAt = System.currentTimeMillis()
        Hub.addIncoming(t)
        wakeLock.acquire(6 * 60 * 60 * 1000L)
        var target: Storage.Target? = null
        try {
            target = Storage.create(ctx, name)
            target.out.use { dst ->
                val buf = ByteArray(512 * 1024)
                var left = len
                while (left > 0) {
                    val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n < 0) throw IllegalStateException("Connection lost")
                    dst.write(buf, 0, n)
                    left -= n
                    t.done += n
                }
            }
            t.uri = target.commit()
            Hub.finish(t, null)
            respond(out, 200, """{"ok":true}""")
        } catch (e: Exception) {
            target?.abort?.invoke()
            val msg = if (e is java.net.SocketException || e is java.net.SocketTimeoutException) "Connection lost"
                      else (e.message ?: "Could not save file")
            Hub.finish(t, msg)
            runCatching { respond(out, 500, msg, "text/plain") }
        } finally {
            if (wakeLock.isHeld) wakeLock.release()
        }
    }
}
