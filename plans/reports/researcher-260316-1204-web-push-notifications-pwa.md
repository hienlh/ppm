# Web Push Notifications with vite-plugin-pwa & React — Research Report

**Date:** 2026-03-16 | **Focus:** Custom service worker, VAPID, iOS support, best practices

---

## 1. Custom Service Worker Code (injectManifest Strategy)

### Setup
- Use **`injectManifest` strategy** (NOT `generateSW`) for custom push handling
- Configure in `vite.config.ts`:
  ```typescript
  VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts'
  })
  ```

### Push Event Listener Pattern
In your custom `sw.ts` service worker file:
```typescript
declare let self: ServiceWorkerGlobalScope

// Precache setup (plugin handles manifest injection)
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Push event handler
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {}
  const options = {
    body: data.body,
    icon: '/icon-192x192.png',
    badge: '/badge-72x72.png',
    // ... other options
  }
  event.waitUntil(self.registration.showNotification(data.title, options))
})

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      // Focus existing window or open new one
      return clientList.length > 0 ? clientList[0].focus() : clients.openWindow('/')
    })
  )
})

// Update messaging
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
```

**Key insight:** `injectManifest` compiles your TS/JS service worker automatically and injects the precache manifest — you own all event handling logic.

---

## 2. injectManifest vs generateSW

| Feature | generateSW | injectManifest |
|---------|-----------|----------------|
| **Control** | Automatic, zero-config | Full custom control |
| **Push events** | ❌ Not supported | ✅ Full support |
| **Custom handlers** | ❌ Cannot use | ✅ Can add any listeners |
| **When to use** | Standard precaching only | Web Push, custom logic, advanced features |
| **Effort** | Write service worker file | Write service worker file |
| **Manifest injection** | Automatic | Automatic |

**Decision:** For push notifications, **always use `injectManifest`**. `generateSW` is a dead end for this use case.

---

## 3. PushManager.subscribe() — VAPID & ApplicationServerKey

### VAPID Key Format
- **VAPID (Voluntary Application Server Identification)** is an ECDSA P-256 public/private key pair
- **applicationServerKey** = Base64-encoded public key that browsers use to authenticate your server
- **Format conversion required:** Base64 → Uint8Array (Chrome/Edge requirement)

### Implementation Pattern
```typescript
// React hook for subscription
async function subscribeToPushNotifications() {
  // 1. Fetch public key from backend
  const response = await fetch('/api/push/public-key')
  const publicKeyBase64 = await response.text()

  // 2. Convert Base64 to Uint8Array
  const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
    const padding = '='.repeat((4 - base64String.length % 4) % 4)
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/')
    const rawData = window.atob(base64)
    return new Uint8Array(rawData.split('').map(x => x.charCodeAt(0)))
  }

  const applicationServerKey = urlBase64ToUint8Array(publicKeyBase64)

  // 3. Subscribe
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey
  })

  // 4. Send subscription to backend for storage
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription)
  })
}
```

### Key Points
- **VAPID is mandatory in Chrome/Edge**, optional elsewhere
- **Generate keys** using Node.js `web-push` library: `npx web-push generate-vapid-keys`
- **Store private key securely** — only backend has it
- **Public key exposed** — safe to share with clients
- **User interaction required** — permission prompt must follow user gesture

---

## 4. iOS PWA Push Notifications (iOS 16.4+)

### Support Status
- ✅ **iOS 16.4+** added Web Push API support for PWAs added to home screen
- ⚠️ **Significant gotchas:**

| Gotcha | Impact |
|--------|--------|
| **Home screen install required** | Only installed PWAs receive push; limits audience |
| **Safari tab blocking** | Push NOT supported inside Safari tabs — only home screen |
| **Permission timing** | Can only request on home screen; NOT in Safari |
| **No background processing** | Limited to showing notifications, not running code |
| **Storage restrictions** | Less offline storage than Android PWAs |

### Implementation Considerations
1. **Detect iOS PWA mode:**
   ```typescript
   const isIosPWA = () => {
     return /iPad|iPhone|iPod/.test(navigator.userAgent) &&
            (navigator.standalone === true || window.navigator.standalone === true)
   }
   ```

2. **Conditionally request permission** only on home screen:
   ```typescript
   if (isIosPWA() && Notification.permission === 'default') {
     // Safe to request
     Notification.requestPermission()
   }
   ```

3. **User education:** Explain PWA must be installed to receive notifications

### 2025 Status
iOS PWA support is now mature enough to implement, but requires setting user expectations around installation requirement.

---

## 5. Requesting Notification Permission in React

### Best Practices

**1. Timing:** Request permission during logical flow (e.g., after successful login, onboarding)
```typescript
// React hook
useEffect(() => {
  if (shouldShowNotificationPrompt()) {
    requestNotificationPermission()
  }
}, [])

async function requestNotificationPermission() {
  try {
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      // Subscribe to push
      await subscribeToPushNotifications()
    }
  } catch (error) {
    console.error('Permission request failed:', error)
  }
}
```

**2. Check permission state first:**
```typescript
// Don't ask twice
if (Notification.permission === 'granted') {
  // Already subscribed
  return
}
if (Notification.permission === 'denied') {
  // User rejected — don't ask again
  return
}
// permission === 'default' → safe to ask
```

**3. Re-check on foreground:**
Users may change permissions in device settings; check at app startup:
```typescript
useEffect(() => {
  // App gained focus (user came back from settings)
  const handleFocus = () => {
    if (Notification.permission === 'granted') {
      ensurePushSubscription()
    }
  }
  window.addEventListener('focus', handleFocus)
  return () => window.removeEventListener('focus', handleFocus)
}, [])
```

**4. Explain why:**
Show permission rationale before prompt (especially iOS PWA):
```typescript
<NotificationPrompt
  title="Get Important Updates"
  description="We'll notify you about project changes and team messages"
  onAccept={requestNotificationPermission}
/>
```

---

## 6. Foreground vs Background Detection

### Distinction
- **Foreground:** App visible, active user interaction (full power)
- **Background:** App in memory but not visible (OS can suspend)

### Detection Pattern
```typescript
// Track visibility state
let isAppForeground = !document.hidden

useEffect(() => {
  const handleVisibilityChange = () => {
    isAppForeground = !document.hidden
    console.log(isAppForeground ? 'App in foreground' : 'App in background')
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
}, [])
```

### Toast vs Push Decision Logic
```typescript
// In your notification handler (frontend or service worker)
function handleNotification(data: NotificationData) {
  if (isAppForeground) {
    // Show toast in-app
    showToast({ title: data.title, description: data.body })
  } else {
    // Push event will trigger service worker notification
    // (This happens automatically if app is closed/backgrounded)
  }
}

// Service worker always receives push messages
// But you can filter them based on app state if needed
self.addEventListener('push', (event) => {
  // Service worker handles background; app handles foreground
  const data = event.data?.json()

  // Could send message to active clients to check if they want toast
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      if (clientList.length > 0) {
        // Notify active window to show toast instead
        clientList[0].postMessage({ type: 'SHOW_TOAST', data })
      } else {
        // No active window — show notification
        self.registration.showNotification(data.title, data)
      }
    })
  )
})
```

**Key insight:** Service worker always runs for push events. App must communicate via `postMessage` to coordinate foreground/background behavior.

---

## Summary

| Area | Recommendation |
|------|-----------------|
| **Strategy** | Use `injectManifest` for custom push |
| **Service Worker** | Write custom SW with push/notificationclick listeners |
| **VAPID** | Generate P-256 keys, store private key backend-only, send public key to clients |
| **iOS** | Support iOS 16.4+, require home screen install, educate users |
| **Permission** | Request at logical moment, check state before asking, re-check on focus |
| **Foreground/Background** | Use `document.visibilitychange` to detect; coordinate toast vs push via postMessage |

---

## Unresolved Questions

1. Does vite-plugin-pwa automatically reload the service worker when `injectManifest` code changes, or do you need manual refresh?
2. How to handle subscription refresh/revalidation if VAPID keys are rotated?
3. Does iOS support `notificationclick` events or only `push` events in home screen PWAs?
4. Best practice for storing subscriptions in IndexedDB vs only backend for sync resilience?
5. How to test Web Push locally without a real push server?

---

**Sources:**
- [Advanced (injectManifest) | Vite PWA Guide](https://vite-pwa-org.netlify.app/guide/inject-manifest)
- [Service Worker Strategies | Vite PWA Guide](https://vite-pwa-org.netlify.app/guide/service-worker-strategies-and-behaviors)
- [PushManager.subscribe() | MDN Web APIs](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe)
- [Web Push Protocol | web.dev](https://web.dev/articles/push-notifications-web-push-protocol)
- [VAPID Explanation | Pushpad](https://pushpad.xyz/blog/web-push-what-is-vapid)
- [iOS PWA Push Limitations | Solving iOS PWA Limitations (2025)](https://iphtechnologies9.wordpress.com/2025/07/01/solving-ios-pwa-limitations-push-notifications-offline-access/)
- [PWA iOS Limitations Guide | MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- [Notification Permission Best Practices | MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static)
- [generateSW vs injectManifest Discussion | GitHub](https://github.com/vite-pwa/vite-plugin-pwa/discussions/756)
