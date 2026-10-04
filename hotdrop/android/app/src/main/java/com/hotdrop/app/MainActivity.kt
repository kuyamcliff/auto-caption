package com.hotdrop.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var list: LinearLayout
    private val rows = LinkedHashMap<String, View>()
    private var resumed = false

    private val tick = object : Runnable {
        override fun run() {
            refresh()
            if (resumed) ui.postDelayed(this, 300)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        list = findViewById(R.id.list)
        findViewById<View>(R.id.btnPhotos).setOnClickListener { pickMedia() }
        findViewById<View>(R.id.btnFiles).setOnClickListener { pickFiles() }
        findViewById<View>(R.id.btnClear).setOnClickListener { Hub.clearFinished(); refresh() }

        val perms = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        if (Build.VERSION.SDK_INT < 29) perms += Manifest.permission.WRITE_EXTERNAL_STORAGE
        perms.removeAll { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        if (perms.isNotEmpty()) requestPermissions(perms.toTypedArray(), 1)

        handleShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    override fun onResume() {
        super.onResume()
        if (!TransferService.running) TransferService.start(this)
        resumed = true
        ui.removeCallbacks(tick)
        ui.post(tick)
    }

    override fun onPause() {
        resumed = false
        super.onPause()
    }

    // ---- choosing files ----------------------------------------------------

    private fun pickMedia() {
        val i = if (Build.VERSION.SDK_INT >= 33) {
            Intent(MediaStore.ACTION_PICK_IMAGES).putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
        } else {
            Intent(Intent.ACTION_GET_CONTENT).setType("*/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                .addCategory(Intent.CATEGORY_OPENABLE)
        }
        launch(i)
    }

    private fun pickFiles() {
        launch(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
            .addCategory(Intent.CATEGORY_OPENABLE)
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true))
    }

    private fun launch(i: Intent) {
        try {
            @Suppress("DEPRECATION") startActivityForResult(i, 7)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No file picker available", Toast.LENGTH_SHORT).show()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 7 || resultCode != RESULT_OK || data == null) return
        val uris = mutableListOf<Uri>()
        data.clipData?.let { c -> for (i in 0 until c.itemCount) uris += c.getItemAt(i).uri }
        if (uris.isEmpty()) data.data?.let { uris += it }
        enqueue(uris)
    }

    private fun handleShare(intent: Intent?) {
        intent ?: return
        val uris = mutableListOf<Uri>()
        @Suppress("DEPRECATION")
        when (intent.action) {
            Intent.ACTION_SEND -> (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris += it }
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris += it }
            else -> return
        }
        intent.action = Intent.ACTION_MAIN // don't re-queue on rotation
        if (uris.isEmpty()) {
            Toast.makeText(this, "Only files can be sent", Toast.LENGTH_SHORT).show()
            return
        }
        enqueue(uris)
    }

    private fun enqueue(uris: List<Uri>) {
        for (uri in uris) {
            var name: String? = null
            var size = -1L
            runCatching {
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        name = c.getString(0)
                        if (!c.isNull(1)) size = c.getLong(1)
                    }
                }
            }
            val n = Storage.cleanName(name ?: uri.lastPathSegment ?: "file")
            Hub.queueForPc(Hub.Transfer(n, size, toPc = true, uri = uri))
        }
        if (!Hub.pcConnected && uris.isNotEmpty()) {
            Toast.makeText(this, "Queued — will send when your PC connects", Toast.LENGTH_SHORT).show()
        }
        refresh()
    }

    // ---- UI ----------------------------------------------------------------

    private fun refresh() {
        val connected = Hub.pcConnected
        findViewById<View>(R.id.dot).setBackgroundResource(if (connected) R.drawable.dot_on else R.drawable.dot_off)
        findViewById<TextView>(R.id.status).text =
            if (connected) getString(R.string.connected_to, Hub.pcName ?: "PC") else getString(R.string.waiting)
        findViewById<View>(R.id.steps).visibility = if (connected) View.GONE else View.VISIBLE
        findViewById<TextView>(R.id.hint).text =
            if (connected) getString(R.string.connected_hint) else {
                val addrs = Hub.localAddresses()
                if (addrs.isEmpty()) getString(R.string.no_network)
                else getString(R.string.manual_hint, addrs.joinToString("  or  "))
            }

        val items = Hub.transfers.toList()
        val ids = items.map { it.id }
        if (ids != rows.keys.toList()) {
            list.removeAllViews()
            val old = HashMap(rows)
            rows.clear()
            for (t in items) {
                val v = old[t.id] ?: layoutInflater.inflate(R.layout.item_transfer, list, false)
                rows[t.id] = v
                list.addView(v)
            }
        }
        findViewById<View>(R.id.empty).visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        findViewById<View>(R.id.btnClear).visibility = if (items.any { it.status == Hub.Status.DONE || it.status == Hub.Status.FAILED }) View.VISIBLE else View.GONE
        for (t in items) bind(rows[t.id]!!, t, connected)
    }

    private fun bind(v: View, t: Hub.Transfer, connected: Boolean) {
        v.findViewById<TextView>(R.id.arrow).text = if (t.toPc) "↑" else "↓"
        v.findViewById<TextView>(R.id.name).text = t.name
        val bar = v.findViewById<ProgressBar>(R.id.bar)
        val pct = when {
            t.size > 0 -> (t.done * 1000 / t.size).toInt().coerceIn(0, 1000)
            t.status == Hub.Status.DONE -> 1000
            else -> 0
        }
        bar.progress = pct
        val state = v.findViewById<TextView>(R.id.state)
        val meta = v.findViewById<TextView>(R.id.meta)
        val sizeText = fmt(if (t.size >= 0) t.size else t.done)
        when (t.status) {
            Hub.Status.WAITING -> {
                state.text = if (connected) "Starting…" else "Waiting for PC"
                meta.text = sizeText
            }
            Hub.Status.ACTIVE -> {
                val sp = t.speed()
                state.text = "${pct / 10}%"
                meta.text = "${fmt(t.done)} of $sizeText · ${fmt(sp.toLong())}/s" +
                        (if (sp > 0 && t.size > 0) " · " + eta(((t.size - t.done) / sp).toLong()) else "")
            }
            Hub.Status.DONE -> {
                state.text = if (t.toPc) "Sent ✓" else "Received ✓"
                val sp = t.speed()
                meta.text = sizeText + (if (sp > 0) " · avg ${fmt(sp.toLong())}/s" else "") +
                        if (!t.toPc && t.uri != null) " · tap to open" else ""
            }
            Hub.Status.FAILED -> {
                state.text = "Failed"
                meta.text = (t.error ?: "") + if (t.toPc) " · tap to retry" else ""
            }
        }
        state.setTextColor(getColor(when (t.status) {
            Hub.Status.DONE -> R.color.ok
            Hub.Status.FAILED -> R.color.bad
            else -> R.color.muted
        }))
        v.setOnClickListener {
            when {
                t.status == Hub.Status.FAILED && t.toPc -> { Hub.retry(t); refresh() }
                t.status == Hub.Status.DONE && !t.toPc && t.uri != null -> open(t)
            }
        }
    }

    private fun open(t: Hub.Transfer) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(t.uri, Storage.mimeOf(t.name))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (e: Exception) {
            Toast.makeText(this, "No app can open this file. It's in Download/HotDrop.", Toast.LENGTH_LONG).show()
        }
    }

    private fun fmt(bytes: Long): String {
        if (bytes < 0) return "?"
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        var v = bytes.toDouble()
        var i = 0
        while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
        return if (i == 0) "$bytes B" else String.format(if (v < 10) "%.2f %s" else if (v < 100) "%.1f %s" else "%.0f %s", v, units[i])
    }

    private fun eta(s: Long) = if (s < 60) "${s}s left" else "${s / 60}m ${s % 60}s left"
}
