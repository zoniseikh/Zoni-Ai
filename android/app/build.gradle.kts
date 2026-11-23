import org.gradle.api.tasks.testing.logging.TestExceptionFormat
import org.gradle.api.tasks.testing.logging.TestLogEvent

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

val releaseKeystoreFile = providers.environmentVariable("ANDROID_KEYSTORE_PATH")
    .orNull
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?.let { file(it) }
    ?.takeIf { it.isFile }

android {
    namespace = "com.zoni.jarvis.assistant"
    compileSdk = 34
    buildToolsVersion = "34.0.0"

    defaultConfig {
        applicationId = "com.zoni.jarvis.assistant"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    signingConfigs {
        create("release") {
            if (releaseKeystoreFile != null) {
                storeFile = releaseKeystoreFile
                storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orElse("").get()
                keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").orElse("").get()
                keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").orElse("").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            if (releaseKeystoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = false
            isReturnDefaultValues = true
            all {
                it.testLogging {
                    events(
                        TestLogEvent.PASSED,
                        TestLogEvent.SKIPPED,
                        TestLogEvent.FAILED,
                        TestLogEvent.STANDARD_ERROR
                    )
                    showExceptions = true
                    showCauses = true
                    showStackTraces = true
                    exceptionFormat = TestExceptionFormat.FULL
                }
            }
        }
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.security.crypto)
    implementation(libs.google.tink.android)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.org.json)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.ui.test.junit4)
    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)
}
