package io.github.munzzyy.magpie

import android.content.ContentValues
import android.content.Intent
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

// The page's window into the platform. Only bundled app code can call this:
// the WebView never navigates off the asset origin.
class MagpieBridge(private val activity: MainActivity) {

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

    @JavascriptInterface
    fun shareFile(b64: String, mime: String, name: String) {
        val bytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() ?: return
        val uri = runCatching {
            val dir = File(activity.cacheDir, "shared_out").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val file = File(dir, sanitize(name))
            file.writeBytes(bytes)
            FileProvider.getUriForFile(activity, MainActivity.AUTHORITY, file)
        }.getOrNull()
        activity.runOnUiThread {
            if (uri == null) {
                Toast.makeText(activity, activity.getString(R.string.save_failed), Toast.LENGTH_SHORT).show()
                return@runOnUiThread
            }
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            runCatching { activity.startActivity(Intent.createChooser(send, null)) }
        }
    }

    // Exports land in Downloads, where a zip belongs.
    @JavascriptInterface
    fun saveFile(b64: String, mime: String, name: String) {
        val bytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() ?: return
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, sanitize(name))
            put(MediaStore.Downloads.MIME_TYPE, mime)
        }
        val resolver = activity.contentResolver
        val ok = runCatching {
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return@runCatching false
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return@runCatching false
            true
        }.getOrDefault(false)
        activity.runOnUiThread {
            Toast.makeText(
                activity,
                if (ok) activity.getString(R.string.saved_to_downloads)
                else activity.getString(R.string.save_failed),
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private fun sanitize(name: String): String {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
        return if (safe.trim('.', '_').isEmpty()) "export.zip" else safe
    }
}
