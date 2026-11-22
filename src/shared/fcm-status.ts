/**
 * Firebase Cloud Messaging for PPM's Android app: what `GET /api/notifications/fcm` answers.
 *
 * Each install brings its own Firebase project, so the app learns the project's public client
 * config from the server it is connected to. Nothing from the service account is ever in here.
 */

/** The Android app's package name: the `google-services.json` client PPM reads. */
export const FCM_ANDROID_PACKAGE = "com.hienlh.ppm";

/** What the app needs for `FirebaseOptions.Builder`. Public values: they ship inside any Firebase APK. */
export interface FcmAndroidConfig {
  apiKey: string;
  appId: string;
  senderId: string;
  projectId: string;
  storageBucket?: string;
}

export interface FcmStatus {
  configured: boolean;
  projectId?: string;
  android?: FcmAndroidConfig | null;
}
