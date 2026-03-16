/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// Workbox injects precache manifest here
precacheAndRoute(self.__WB_MANIFEST);

// Handle push notifications from server
self.addEventListener("push", (event) => {
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Skip notification if any PPM tab is currently visible
        const hasVisibleClient = clients.some(
          (c) => c.visibilityState === "visible",
        );
        if (hasVisibleClient) return;

        const data = event.data?.json() ?? {
          title: "PPM",
          body: "Chat completed",
        };
        return self.registration.showNotification(data.title, {
          body: data.body,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: "ppm-chat-done",
          silent: false,
          data: { url: self.location.origin },
        });
      }),
  );
});

// Handle notification click — focus existing tab or open new one
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(event.notification.data?.url || "/");
      }),
  );
});
