import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// One version for the whole product: the web app's package.json.
@Suppress("UNCHECKED_CAST")
val webVersion = (JsonSlurper().parse(rootDir.resolve("../../package.json")) as Map<String, Any>)["version"] as String
val (major, minor, patch) = webVersion.split(".").map { it.toInt() }

// The site the app opens, and the only origins given the bridge. Override with
// -PspatialHome=https://your.host/ -PspatialOrigins=https://your.host,https://other.host
val home = (findProperty("spatialHome") as String?) ?: "https://3d-ar-viewer-ten.vercel.app/"
val origins = (findProperty("spatialOrigins") as String?) ?: "https://3d-ar-viewer-ten.vercel.app"
/** WebViewAssetLoader's origin: where debug builds serve the instrumented tests' pages. */
val TEST_ORIGIN = "https://appassets.androidplatform.net"

android {
    namespace = "com.outthinkx.spatialar"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.outthinkx.spatialar"
        minSdk = 24
        targetSdk = 35
        versionCode = major * 10_000 + minor * 100 + patch
        versionName = webVersion
        buildConfigField("String", "HOME_URL", "\"$home\"")
        buildConfigField("String", "ALLOWED_ORIGINS", "\"$origins\"")
        buildConfigField("boolean", "TEST_ASSETS", "false")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Chrome reads this to tell the web app the app is installed (getInstalledRelatedApps).
        val site = origins.split(",").first()
        resValue(
            "string", "asset_statements",
            """[{\"relation\": [\"delegate_permission/common.handle_all_urls\"], \"target\": {\"namespace\": \"web\", \"site\": \"$site\"}}]""",
        )
    }

    // A stable signature, so a newer APK installs over an older one. The test key
    // is in the repository on purpose and is not a secret: it signs builds for
    // sideloading only. A store release signs with a private key from the
    // environment (SPATIAL_KEYSTORE, SPATIAL_KEYSTORE_PASSWORD, SPATIAL_KEY_ALIAS,
    // SPATIAL_KEY_PASSWORD).
    signingConfigs {
        create("shell") {
            val ks = System.getenv("SPATIAL_KEYSTORE")
            storeFile = if (ks != null) file(ks) else file("test-signing.jks")
            storePassword = System.getenv("SPATIAL_KEYSTORE_PASSWORD") ?: "spatialar-test"
            keyAlias = System.getenv("SPATIAL_KEY_ALIAS") ?: "spatialar-test"
            keyPassword = System.getenv("SPATIAL_KEY_PASSWORD") ?: "spatialar-test"
        }
    }

    buildTypes {
        // Debug builds also serve the instrumented tests' pages from the app's
        // assets, at a real https origin that is allowed the bridge. Release
        // builds have neither.
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shell")
            buildConfigField("boolean", "TEST_ASSETS", "true")
            buildConfigField("String", "ALLOWED_ORIGINS", "\"$origins,$TEST_ORIGIN\"")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shell")
        }
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        abortOnError = true
        warningsAsErrors = false
    }
}

dependencies {
    implementation(project(":protocol"))
    implementation("com.google.ar:core:1.46.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.6.1")
}
