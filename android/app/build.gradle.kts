plugins {
    // AGP 9 ships built-in Kotlin support; no separate Kotlin plugin wanted.
    id("com.android.application") version "9.3.0"
}

android {
    namespace = "io.github.munzzyy.magpie"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.munzzyy.magpie"
        minSdk = 29
        targetSdk = 36
        versionCode = 402
        versionName = "0.4.2"
    }

    buildTypes {
        release {
            // Unsigned on purpose: tools/release-android.sh signs with apksigner
            // so F-Droid's reproducible-build flow can byte-compare the APK and
            // copy the developer signature onto its own rebuild.
            isMinifyEnabled = false
            isShrinkResources = false
            vcsInfo.include = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencyLocking {
    lockAllConfigurations()
}

// The web app IS the app. Every build syncs ../../app into assets so the
// wrapper can never drift from what the website serves. sw.js stays out:
// WebView never wires up service worker interception and the assets are
// already local. _headers is server config, not content.
val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    val webDir = rootProject.layout.projectDirectory.dir("../app")
    from(webDir) {
        exclude("sw.js", "_headers")
    }
    into(layout.buildDirectory.dir("webassets"))
}

android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("webassets").get().asFile)

tasks.named("preBuild") {
    dependsOn(syncWebAssets)
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
}
