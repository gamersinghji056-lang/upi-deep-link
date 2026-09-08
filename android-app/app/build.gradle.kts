plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.wtron.wpayagent"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.wtron.wpayagent"
        minSdk = 26
        targetSdk = 35
        versionCode = 8
        versionName = "0.8.0"
        buildConfigField("String", "API_BASE_URL", "\"https://pay.wtron.org\"")
    }

    buildFeatures {
        buildConfig = true
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
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    testImplementation("junit:junit:4.13.2")
}
