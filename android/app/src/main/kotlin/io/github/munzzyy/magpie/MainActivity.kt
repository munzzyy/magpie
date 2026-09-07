package io.github.munzzyy.magpie

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.security.SecureRandom

// One screen: the bundled web app in a WebView on the fixed asset origin.
// The APK requests no permissions at all; photos come back from the system
// camera app, and shares stream in over one-shot asset-origin tokens.
class MainActivity : ComponentActivity() {

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$ASSET_HOST/index.html"
        const val AUTHORITY = "io.github.munzzyy.magpie.files"
    }

    lateinit var webView: WebView
        private set

    private lateinit var assetLoader: WebViewAssetLoader

    // (token, uri) pairs for shared-in and captured files, RAM only, each
    // served exactly once.
    private val shared = mutableListOf<Pair<String, Uri>>()

    private var captureUri: Uri? = null

    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = captureUri
        captureUri = null
        if (ok && uri != null) {
            val token = addShared(uri) ?: return@registerForActivityResult
            webView.evaluateJavascript(
                "globalThis.__magpieCaptured && __magpieCaptured(\"$token\")",
                null,
            )
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // The screen holds an evidence journal; the app switcher must not
        // thumbnail it.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        webView = WebView(this)
        setContentView(webView)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/shared/") { path -> serveShared(path) }
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            textZoom = (resources.configuration.fontScale * 100).toInt()
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
        }

        webView.addJavascriptInterface(MagpieBridge(this), "MagpieNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (request.url.host == ASSET_HOST) return false
                if (request.isForMainFrame && request.hasGesture() && request.url.scheme == "https") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                }
                return true
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        // Stale capture files from previous sessions have no business
        // surviving; the journal keeps its own encrypted copies.
        runCatching { File(cacheDir, "capture").deleteRecursively() }
        runCatching { File(cacheDir, "shared_out").deleteRecursively() }

        takeShared(intent)
        webView.loadUrl(START_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (takeShared(intent)) {
            webView.evaluateJavascript(
                "globalThis.__magpieShared && __magpieShared(${sharedTokensJson()})",
                null,
            )
        }
    }

    fun sharedTokensJson(): String =
        shared.joinToString(prefix = "[", postfix = "]", separator = ",") { "\"${it.first}\"" }

    fun startCapture() {
        val dir = File(cacheDir, "capture").apply { mkdirs() }
        val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(this, AUTHORITY, file)
        captureUri = uri
        runCatching { takePicture.launch(uri) }
    }

    private fun addShared(uri: Uri): String? {
        val raw = ByteArray(16)
        SecureRandom().nextBytes(raw)
        val token = raw.joinToString("") { "%02x".format(it) }
        shared.add(token to uri)
        return token
    }

    private fun takeShared(intent: Intent?): Boolean {
        val uris: List<Uri> = when (intent?.action) {
            Intent.ACTION_SEND ->
                listOfNotNull(
                    androidx.core.content.IntentCompat.getParcelableExtra(
                        intent, Intent.EXTRA_STREAM, Uri::class.java,
                    ),
                )
            Intent.ACTION_SEND_MULTIPLE ->
                androidx.core.content.IntentCompat.getParcelableArrayListExtra(
                    intent, Intent.EXTRA_STREAM, Uri::class.java,
                )?.filterNotNull() ?: emptyList()
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            else -> emptyList()
        }
        // content:// only, and never Magpie's own share-out provider paths.
        val safe = uris.filter { it.scheme == "content" }
        if (safe.isEmpty()) return false
        for (uri in safe.take(50)) addShared(uri)
        return true
    }

    // One-shot: a successful serve removes the entry. The capture provider
    // is our own authority, which is exactly the case where serving must
    // still work, so only foreign shared_out-style paths are refused above.
    private fun serveShared(path: String): WebResourceResponse? {
        val idx = shared.indexOfFirst { it.first == path }
        if (idx == -1) return null
        val (_, uri) = shared[idx]
        return runCatching {
            val mime = contentResolver.getType(uri) ?: "application/octet-stream"
            val stream = contentResolver.openInputStream(uri)
            shared.removeAt(idx)
            WebResourceResponse(mime, null, stream)
        }.getOrNull()
    }

    override fun onDestroy() {
        shared.clear()
        super.onDestroy()
    }
}
