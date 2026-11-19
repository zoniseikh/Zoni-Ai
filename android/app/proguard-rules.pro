# ProGuard Rules for Zoni AI Assistant
-keepattributes *Annotation*
-keepclassmembers class * {
    @org.json.* <fields>;
    @org.json.* <methods>;
}

# Keep Gemini AI models and client
-keep class com.google.ai.client.generativeai.** { *; }

# Keep data models
-keep class com.zoni.jarvis.assistant.domain.** { *; }
