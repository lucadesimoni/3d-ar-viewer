// The Spatial AR Android shell: ARCore world tracking under the web app.
// `protocol` is plain Kotlin (the bridge's messages and maths, unit-tested on
// any JVM); `app` is the Android application that uses it.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    // Versions here, resolved only where a module applies the plugin: the
    // protocol builds without the Android plugin, where Google's Maven is unreachable.
    plugins {
        id("com.android.application") version "8.7.3"
        id("org.jetbrains.kotlin.android") version "2.0.21"
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "spatial-ar-android"
include(":protocol")
// The app needs the Android SDK; without one (`-PprotocolOnly`) only the protocol builds.
if (!providers.gradleProperty("protocolOnly").isPresent) include(":app")
