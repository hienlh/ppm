import { useState, useEffect, useCallback } from "react";
import { getAuthToken } from "@/lib/api-client";

/** Convert VAPID public key from base64url to Uint8Array for PushManager */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

export function usePushNotification() {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);

  // Check current permission and subscription state on mount
  useEffect(() => {
    if ("Notification" in window) {
      setPermission(Notification.permission);
    }
    setIsSubscribed(localStorage.getItem("ppm-push-subscribed") === "true");
  }, []);

  const subscribe = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Request notification permission
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;

      // 2. Get VAPID public key from server
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch("/api/push/vapid-key", { headers });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed to get VAPID key");

      // 3. Subscribe via PushManager
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(json.data.publicKey).buffer as ArrayBuffer,
      });

      // 4. Send subscription to server
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });

      setIsSubscribed(true);
      localStorage.setItem("ppm-push-subscribed", "true");
    } catch (err) {
      console.error("[push] Subscribe failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Remove from server
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const token = getAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers,
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });

        // Unsubscribe locally
        await sub.unsubscribe();
      }

      setIsSubscribed(false);
      localStorage.removeItem("ppm-push-subscribed");
    } catch (err) {
      console.error("[push] Unsubscribe failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  return { permission, isSubscribed, loading, subscribe, unsubscribe };
}
