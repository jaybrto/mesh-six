# kotlinx-serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class bar.bto.meshsix.**$$serializer { *; }
-keepclassmembers class bar.bto.meshsix.** {
    *** Companion;
}
-keepclasseswithmembers class bar.bto.meshsix.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Paho MQTT
-keep class org.eclipse.paho.** { *; }
-keep class com.github.hannesa2.** { *; }
