package com.hotdrop.app

import android.net.Uri
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/** Shared in-process state: transfers in both directions and who the PC is. */
object Hub {
    const val PORT = 47820

    enum class Status { WAITING, ACTIVE, DONE, FAILED }

    class Transfer(val name: String, size: Long, val toPc: Boolean, var uri: Uri?) {
        val id: String = UUID.randomUUID().toString().replace("-", "").take(16)
        @Volatile var size = size
        @Volatile var done = 0L
        @Volatile var status = Status.WAITING
        @Volatile var error: String? = null
        @Volatile var startedAt = 0L
        @Volatile var endedAt = 0L

        fun speed(): Double {
            val end = if (status == Status.ACTIVE) System.currentTimeMillis() else endedAt
            val ms = end - startedAt
            return if (startedAt > 0 && ms > 200) done * 1000.0 / ms else 0.0
        }
    }

    /** Newest first. */
    val transfers = CopyOnWriteArrayList<Transfer>()
    private val lock = Object()

    @Volatile var pcName: String? = null
    @Volatile var lastSeen = 0L

    val pcConnected get() = System.currentTimeMillis() - lastSeen < 25_000

    fun touch(name: String) {
        pcName = name
        lastSeen = System.currentTimeMillis()
    }

    fun queueForPc(t: Transfer) {
        synchronized(lock) {
            transfers.add(0, t)
            lock.notifyAll()
        }
    }

    fun retry(t: Transfer) {
        synchronized(lock) {
            t.done = 0; t.error = null; t.startedAt = 0; t.endedAt = 0
            t.status = Status.WAITING
            lock.notifyAll()
        }
    }

    fun addIncoming(t: Transfer) = transfers.add(0, t)

    private fun pending() = transfers.filter { it.toPc && it.status == Status.WAITING }.reversed()

    /** Long-poll: returns as soon as something is waiting for the PC, or after [ms]. */
    fun waitPending(ms: Long): List<Transfer> {
        val deadline = System.currentTimeMillis() + ms
        synchronized(lock) {
            var p = pending()
            var left = deadline - System.currentTimeMillis()
            while (p.isEmpty() && left > 0) {
                lock.wait(left)
                p = pending()
                left = deadline - System.currentTimeMillis()
            }
            return p
        }
    }

    /** Atomically take a waiting item for sending; null if it's gone or already taken. */
    fun claim(id: String): Transfer? = synchronized(lock) {
        val t = transfers.firstOrNull { it.id == id && it.toPc } ?: return null
        if (t.status == Status.ACTIVE) return null
        t.status = Status.ACTIVE
        t.done = 0; t.error = null
        t.startedAt = System.currentTimeMillis()
        t
    }

    fun finish(t: Transfer, error: String?) {
        t.endedAt = System.currentTimeMillis()
        t.error = error
        t.status = if (error == null) Status.DONE else Status.FAILED
    }

    fun clearFinished() {
        transfers.removeAll { it.status == Status.DONE || (it.status == Status.FAILED && !it.toPc) }
    }

    /** Addresses the PC can reach us on (hotspot / Wi-Fi interfaces). */
    fun localAddresses(): List<String> {
        val skip = listOf("rmnet", "ccmni", "v4-", "dummy", "tun", "ppp", "lo", "radio", "ims")
        val all = runCatching { NetworkInterface.getNetworkInterfaces().toList() }.getOrDefault(emptyList())
        return all.filter { ni -> runCatching { ni.isUp && !ni.isLoopback }.getOrDefault(false) && skip.none { ni.name.startsWith(it) } }
            .sortedBy { ni -> if (ni.name.startsWith("wlan") || ni.name.contains("ap")) 0 else 1 }
            .flatMap { ni ->
                ni.interfaceAddresses.mapNotNull { ia ->
                    (ia.address as? Inet4Address)?.takeIf { it.isSiteLocalAddress }?.hostAddress
                }
            }.distinct()
    }
}
