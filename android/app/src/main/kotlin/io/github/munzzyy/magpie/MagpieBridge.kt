package io.github.munzzyy.magpie

import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

// The page's window into the platform. Only bundled app code can call this:
// the WebView never navigates off the asset origin.
class MagpieBridge(private val activity: MainActivity) {

    companion object {
        // platform.js sends 768 KiB of bytes per call, which is exactly this much base64.
        const val MAX_CHUNK_CHARS = 1024 * 1024
    }

    // An export on its way out: base64 chunks append to a cache file, so no
    // ByteArray or String the size of the export exists on this side.
    private class Out(val file: File, val mime: String, val name: String, val share: Boolean)

    private val outs = ConcurrentHashMap<String, Out>()

    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun version(): String = runCatching {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName
    }.getOrNull() ?: "unknown"

    @JavascriptInterface
    fun sharedTokens(): String = activity.sharedTokensJson()

    @JavascriptInterface
    fun canCapture(): Boolean =
        Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(activity.packageManager) != null

    // The system camera app does the capturing; no camera permission exists
    // in this APK to misuse.
    @JavascriptInterface
    fun capturePhoto() {
        activity.runOnUiThread { activity.startCapture() }
    }

    // mode is "share" (system share sheet) or "save" (Downloads, or the picker on Android 9).
    @JavascriptInterface
    fun beginOut(name: String, mime: String, mode: String): String {
        if (mode != "share" && mode != "save") return ""
        return runCatching {
            dropOuts()
            val dir = File(activity.cacheDir, "shared_out").apply { mkdirs() }
            dir.listFiles()?.forEach { it.deleteRecursively() }
            val safe = sanitize(name)
            val file = File(dir, safe)
            FileOutputStream(file).close()
            val raw = ByteArray(16)
            SecureRandom().nextBytes(raw)
            val id = raw.joinToString("") { "%02x".format(it) }
            outs[id] = Out(file, mime, safe, mode == "share")
            id
        }.getOrDefault("")
    }

    @JavascriptInterface
    fun appendOut(id: String, b64: String): Boolean {
        val out = outs[id] ?: return false
        if (b64.length > MAX_CHUNK_CHARS || b64.length % 4 != 0) {
            abortOut(id)
            return false
        }
        val ok = runCatching {
            FileOutputStream(out.file, true).use { it.write(Base64.decode(b64, Base64.NO_WRAP)) }
        }.isSuccess
        if (!ok) abortOut(id)
        return ok
    }

    @JavascriptInterface
    fun abortOut(id: String) {
        outs.remove(id)?.file?.delete()
    }

    // The outcome comes back on __magpieOutDone(id, "ok" | "cancelled" | "failed").
    @JavascriptInterface
    fun finishOut(id: String) {
        val out = outs.remove(id) ?: return activity.reportOut(id, "failed")
        when {
            out.share -> activity.runOnUiThread { share(id, out) }
            Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ->
                activity.runOnUiThread { activity.saveWithPicker(out.file, out.mime, out.name) { activity.reportOut(id, it) } }
            else -> thread {
                val ok = saveToDownloads(out)
                out.file.delete()
                if (ok) {
                    activity.runOnUiThread {
                        Toast.makeText(activity, activity.getString(R.string.saved_to_downloads), Toast.LENGTH_SHORT).show()
                    }
                }
                activity.reportOut(id, if (ok) "ok" else "failed")
            }
        }
    }

    fun dropOuts() {
        for (id in outs.keys.toList()) abortOut(id)
    }

    // The file stays in cache for the receiving app to read; the next export or the next launch clears it.
    private fun share(id: String, out: Out) {
        val ok = runCatching {
            val uri = FileProvider.getUriForFile(activity, MainActivity.AUTHORITY, out.file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = out.mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(send, null))
        }.isSuccess
        if (!ok) out.file.delete()
        activity.reportOut(id, if (ok) "ok" else "failed")
    }

    private fun saveToDownloads(out: Out): Boolean = runCatching {
        // MediaStore.Downloads is Android 10+; on 9 the caller falls back to the share sheet.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@runCatching false
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, out.name)
            put(MediaStore.Downloads.MIME_TYPE, out.mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = activity.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return@runCatching false
        val copied = runCatching {
            resolver.openOutputStream(uri)?.use { sink -> out.file.inputStream().use { it.copyTo(sink, 1 shl 20) } } != null
        }.getOrDefault(false)
        if (!copied) {
            resolver.delete(uri, null, null)
            return@runCatching false
        }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        true
    }.getOrDefault(false)

    private fun sanitize(name: String): String {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
        return if (safe.trim('.', '_').isEmpty()) "export.zip" else safe
    }
}
