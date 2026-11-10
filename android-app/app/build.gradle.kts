import java.io.File

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

/** 开发签名默认指向仓库根目录 signing/dev-release.jks，可用环境变量覆盖。 */
val releaseStoreFile: File = System.getenv("SIGNING_STORE_FILE")?.let { file(it) }
    ?: rootProject.file("../signing/dev-release.jks")

android {
    namespace = "dev.wristkey.app"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "dev.wristkey.app"
        minSdk = 28
        targetSdk = 36
        versionCode = 4
        versionName = "2.0.0"
    }

    signingConfigs {
        create("release") {
            storeFile = releaseStoreFile
            storePassword = System.getenv("SIGNING_STORE_PASSWORD") ?: "wristkey-dev"
            keyAlias = System.getenv("SIGNING_KEY_ALIAS") ?: "wristkey"
            keyPassword = System.getenv("SIGNING_KEY_PASSWORD") ?: "wristkey-dev"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
    }
    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.bouncycastle.bcprov)
    implementation(files("libs/xms-wearable-lib_1.4_release.aar"))
    testImplementation(libs.junit)
    testImplementation(libs.json)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
