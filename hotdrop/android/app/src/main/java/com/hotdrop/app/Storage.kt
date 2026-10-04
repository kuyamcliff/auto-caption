package com.hotdrop.app

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

/** Writes received files into Download/HotDrop. */
object Storage {
    const val FOLDER = "HotDrop"

    class Target(val out: OutputStream, val commit: () -> Uri?, val abort: () -> Unit)

    fun mimeOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    fun cleanName(raw: String): String {
        var n = raw.replace('\\', '/').substringAfterLast('/')
            .map { if (it < ' ' || it in "<>:\"|?*") '_' else it }.joinToString("").trim()
        if (n.isEmpty() || n == "." || n == "..") n = "file"
        if (n.length > 180) {
            val ext = n.substringAfterLast('.', "").take(15)
            n = n.take(180 - ext.length - 1) + if (ext.isNotEmpty()) ".$ext" else ""
        }
        return n
    }

    fun create(ctx: Context, rawName: String): Target {
        val name = cleanName(rawName)
        val cr = ctx.contentResolver
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Cannot create file")
            val out = cr.openOutputStream(uri, "w") ?: throw IllegalStateException("Cannot open file")
            return Target(out,
                commit = {
                    cr.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                    uri
                },
                abort = { runCatching { cr.delete(uri, null, null) } })
        }

        @Suppress("DEPRECATION")
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER)
        dir.mkdirs()
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        var f = File(dir, name)
        var i = 1
        while (f.exists()) f = File(dir, "${name.substring(0, dot)} ($i)${name.substring(dot)}").also { i++ }
        val file = f
        return Target(FileOutputStream(file),
            commit = {
                var result: Uri? = null
                val latch = java.util.concurrent.CountDownLatch(1)
                MediaScannerConnection.scanFile(ctx, arrayOf(file.path), arrayOf(mimeOf(name))) { _, uri ->
                    result = uri; latch.countDown()
                }
                latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
                result
            },
            abort = { file.delete() })
    }
}
