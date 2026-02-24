plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.kotlin.parcelize)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "bar.bto.meshsix"
    compileSdk = 35

    defaultConfig {
        applicationId = "bar.bto.meshsix"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_MQTT_LAN", "\"tcp://10.43.0.100:1883\"")
            buildConfigField("String", "DEFAULT_MQTT_WSS", "\"wss://mqtt.bto.bar/ws\"")
            buildConfigField("String", "DEFAULT_API_BASE", "\"https://mesh-six.bto.bar\"")
            buildConfigField("String", "DEFAULT_NTFY_URL", "\"https://ntfy.bto.bar\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            buildConfigField("String", "DEFAULT_MQTT_LAN", "\"tcp://10.43.0.100:1883\"")
            buildConfigField("String", "DEFAULT_MQTT_WSS", "\"wss://mqtt.bto.bar/ws\"")
            buildConfigField("String", "DEFAULT_API_BASE", "\"https://mesh-six.bto.bar\"")
            buildConfigField("String", "DEFAULT_NTFY_URL", "\"https://ntfy.bto.bar\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Compose BOM — pins all Compose artifact versions
    val composeBom = platform(libs.compose.bom)
    implementation(composeBom)
    debugImplementation(composeBom)

    // Compose core
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    // Material 3 Adaptive — the backbone of responsive layout
    implementation(libs.adaptive)
    implementation(libs.adaptive.layout)
    implementation(libs.adaptive.navigation)
    implementation(libs.adaptive.navigation.suite)

    // Activity
    implementation(libs.activity.compose)

    // Lifecycle
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)

    // Navigation
    implementation(libs.navigation.compose)
    implementation(libs.hilt.navigation.compose)

    // Hilt DI
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)

    // Serialization
    implementation(libs.kotlinx.serialization.json)

    // OkHttp
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)

    // MQTT
    implementation(libs.paho.mqtt.android)

    // WorkManager
    implementation(libs.work.runtime.ktx)

    // DataStore
    implementation(libs.datastore.preferences)

    // Testing
    testImplementation(libs.junit)
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
