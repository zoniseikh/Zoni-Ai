# ProGuard / R8 Rules for Zoni AI Assistant (com.zoni.jarvis.assistant)

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# Keep all @JavascriptInterface methods so R8 never strips ZoniWebAppInterface in Release APKs
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.zoni.jarvis.assistant.bridge.ZoniWebAppInterface { *; }

# Keep JSON annotated fields/methods
-keepclassmembers class * {
    @org.json.* <fields>;
    @org.json.* <methods>;
}

# Keep Room database, entities, and DAOs
-keep class * extends androidx.room.RoomDatabase
-keep class com.zoni.jarvis.assistant.db.** { *; }

# Keep domain models, action protocol, device controllers & Android SIM calling states
-keep class com.zoni.jarvis.assistant.domain.** { *; }
-keep class com.zoni.jarvis.assistant.action.** { *; }
-keep class com.zoni.jarvis.assistant.device.** { *; }
-keep class com.zoni.jarvis.assistant.calling.** { *; }

# Keep Android Services & Screen Capture Manager declared in AndroidManifest.xml
-keep class com.zoni.jarvis.assistant.service.** { *; }
-keep class com.zoni.jarvis.assistant.screen.** { *; }

# Keep Google Tink / AndroidX Security Crypto key managers safely under R8
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.shaded.protobuf.**
-dontwarn javax.annotation.**
-dontwarn com.google.errorprone.annotations.**

# OkHttp / Kotlin coroutines safety
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
-dontwarn org.bouncycastle.**
