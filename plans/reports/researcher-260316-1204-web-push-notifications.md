# Web Push Notifications Research — Bun + Hono Backend

**Date:** 2026-03-16
**Focus:** Compatibility, security, storage patterns, and implementation patterns for Web Push API with Bun + Hono

---

## Executive Summary

**web-push** package works with Bun via Node.js compatibility layer. Hono has no built-in push support but handles standard HTTP routes seamlessly. VAPID key management and PushSubscription storage follow standard Web Push Protocol patterns. No blockers for implementation; straightforward Bun + Hono integration.

---

## 1. web-push Package & Bun Compatibility

### Status: ✅ Compatible

**Finding:**
Bun claims 100% Node.js API compatibility and treats compatibility bugs as breaking issues. The `web-push` npm package (from `web-push-libs/web-push`) works on Node.js and will run on Bun without code changes since Bun's runtime handles npm packages via standard Node.js module resolution.

**Evidence:**
- Bun package manager installs npm packages directly
- Popular frameworks (Next.js, Express) run on Bun without modifications
- If a package works in Node.js, it's considered a bug if it doesn't work in Bun

**Risk Level:** Low — only file-system or runtime-specific APIs could break, which web-push avoids (pure crypto/HTTP).

### Alternative: PushForge (Zero Dependencies)

**Finding:**
PushForge library offers Web Push implementation designed specifically for multi-runtime support: Node.js, Deno, Bun, Cloudflare Workers, browsers.

**Trade-off:**
- **web-push:** Mature, widely used, tested at scale
- **PushForge:** Zero dependencies, lighter, multi-runtime optimized, newer ecosystem

**Recommendation:** Start with **web-push** (standard choice); PushForge is fallback if compatibility issues surface.

---

## 2. VAPID Key Generation & Storage

### Generation

**Flow:**
```bash
# Option 1: CLI (if web-push installed globally)
npm install -g web-push
web-push generate-vapid-keys

# Option 2: Programmatic (in Node.js/Bun backend)
import webpush from 'web-push';
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
```

**Key Format:**
- Base64 URL-encoded strings (not PEM)
- Keys are Elliptic Curve (P-256) ECDSA pair
- Generate once, store permanently (not per-request)

### Storage Best Practices

| Storage Method | Security | Effort | Pros | Cons |
|---|---|---|---|---|
| **Environment Variables** | ✅ High | Low | Simple, no DB, secrets rotation ready | Not searchable |
| **Config File** | ⚠️ Medium | Low | Persistent across restarts | Must not commit to git |
| **Secret Manager** (AWS Secrets, HashiCorp Vault) | ✅ Very High | Medium | Enterprise-grade, audit logging | Operational complexity |
| **Database (encrypted)** | ✅ High | Medium | Centralized, queryable, auditable | Requires encryption at rest |

**Recommended:** Environment variables for dev/staging; secret manager for production.

**Implementation:**
```bash
# .env (never commit)
VAPID_PUBLIC_KEY=BCrP5gs...
VAPID_PRIVATE_KEY=BO7iWx...
VAPID_SUBJECT=mailto:admin@example.com
```

```typescript
// In Hono route
import webpush from 'web-push';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);
```

---

## 3. PushSubscription Storage

### Data Structure

PushSubscription contains 3 required fields:

```typescript
interface PushSubscription {
  endpoint: string;          // Unique URL per browser/domain
  expirationTime: null;      // Usually null
  keys: {
    p256dh: string;          // Base64 public key for encryption
    auth: string;            // Base64 authentication secret
  };
}
```

**Critical:** `endpoint` is **unique per browser instance** — if user uninstalls/clears data, a new endpoint is generated.

### Database Schema

**PostgreSQL Example:**
```sql
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  failed_attempts INT DEFAULT 0,
  last_failed_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_subscriptions_user_id ON push_subscriptions(user_id);
CREATE INDEX idx_subscriptions_endpoint ON push_subscriptions(endpoint);
```

### Best Practices

1. **Validate before storing:**
   - Check request has valid `endpoint` and `keys`
   - Validate endpoint URL format (HTTPS only)
   - Reject invalid base64 keys

2. **Handle unsubscription:**
   - Push service returns 410 Gone if subscription expired
   - Delete subscription from DB on 410 response
   - Retry logic: mark failed attempts, remove after 3-5 failures

3. **Index for performance:**
   - Index by `user_id` (query all subscriptions for user)
   - Index by `endpoint` (dedup, prevent double subscriptions)
   - Track `is_active` flag for soft deletes

4. **Deduplication:**
   - Same browser/domain should have ≤1 active subscription
   - Use `endpoint` as unique constraint
   - Update existing on re-subscription instead of inserting duplicate

---

## 4. Sending Push Notifications from Hono

### Route Handler Pattern

```typescript
import { Hono } from 'hono';
import webpush from 'web-push';

const app = new Hono();

// Configure VAPID
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

// Subscribe endpoint
app.post('/api/notifications/subscribe', async (c) => {
  const subscription = await c.req.json();

  // Validate & store in DB
  if (!subscription.endpoint || !subscription.keys) {
    return c.json({ error: 'Invalid subscription' }, 400);
  }

  try {
    await db.pushSubscriptions.upsert({
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userId: c.get('user').id,
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: 'Storage failed' }, 500);
  }
});

// Send notification endpoint
app.post('/api/notifications/send', async (c) => {
  const { userId, title, body, data } = await c.req.json();

  // Fetch all subscriptions for user
  const subscriptions = await db.pushSubscriptions.findBy({
    userId,
    isActive: true,
  });

  const payload = JSON.stringify({
    title,
    body,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    data,
  });

  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        },
        payload
      )
    )
  );

  // Handle failures
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      const error = (results[i] as PromiseRejectedResult).reason;

      if (error.statusCode === 410) {
        // Subscription expired, remove from DB
        await db.pushSubscriptions.delete(subscriptions[i].id);
      } else {
        // Mark failed attempt
        await db.pushSubscriptions.update(subscriptions[i].id, {
          failedAttempts: (subscriptions[i].failedAttempts || 0) + 1,
          lastFailedAt: new Date(),
        });
      }
    }
  }

  return c.json({
    sent: results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length,
  });
});
```

### Frontend Service Worker Registration

```typescript
// In React component
async function subscribeUser() {
  const registration = await navigator.serviceWorker.register('/sw.js');

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: process.env.REACT_APP_VAPID_PUBLIC_KEY!,
  });

  // Send to backend
  const response = await fetch('/api/notifications/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });

  return response.ok;
}
```

### Service Worker Handler

```typescript
// public/sw.js
self.addEventListener('push', (event) => {
  const payload = event.data?.json() || {};

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      data: payload.data,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      // Focus existing window or open new one
      for (const client of clientList) {
        if (client.url === '/' && 'focus' in client) {
          return (client as any).focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
```

---

## 5. Hono Integration Specifics

### No Built-in Support Required

Hono provides:
- ✅ Standard `Hono` context with `req.json()`, `c.json()`
- ✅ Middleware for auth, logging
- ✅ WebSocket support for real-time updates (alternative to polling)

Hono does **not** provide:
- Push queue management (implement with Bull/BullMQ if needed)
- Retry logic (implement in route handler or queue service)
- Subscription management UI (frontend-only)

### Recommended Architecture

```
Frontend (React)
  ├─ Service Worker registration
  ├─ Subscribe button → POST /api/notifications/subscribe
  └─ WebSocket for live updates (optional)

Hono Routes
  ├─ POST /api/notifications/subscribe (store subscription)
  ├─ POST /api/notifications/send (immediate send)
  ├─ DELETE /api/notifications/subscribe/:id (unsubscribe)
  └─ GET /api/notifications/subscriptions (list user subscriptions)

Database
  └─ push_subscriptions table

Queue Service (Optional)
  └─ Bull job for async batch sends, retries
```

---

## 6. Security Considerations

### VAPID Key Security

| Area | Requirement | Implementation |
|---|---|---|
| **Private Key** | Never expose to frontend | Store in env vars only, server-side routes only |
| **Public Key** | Share with frontend | Include in frontend config or fetch from public endpoint |
| **Rotation** | Periodic (optional but recommended) | Update env var, invalidate old subscriptions |
| **Backup** | Secure encrypted storage | Use secret manager for production |
| **Subject Field** | Monitored email for push service contact | mailto:admin@example.com (real email) |

### Subscription Security

1. **Transport:** Subscribe via HTTPS-only
2. **Validation:** Verify user owns subscription before send
3. **Rate limiting:** Prevent spam (max notifications per user per hour)
4. **Cleanup:** Remove failed subscriptions after 5 failed attempts
5. **Encryption:** Store keys encrypted at rest (if using DB with sensitive data)

### Error Handling

| Status Code | Meaning | Action |
|---|---|---|
| 201 | Sent successfully | Update DB success timestamp |
| 400 | Invalid request | Log error, check subscription format |
| 401 | Unauthorized (VAPID) | Check env vars, regenerate keys |
| 410 | Subscription expired | Delete from DB |
| 429 | Rate limited by push service | Exponential backoff, queue |
| 500+ | Service error | Retry with backoff, alert ops |

---

## 7. Implementation Checklist

- [ ] Install `web-push` dependency: `bun add web-push`
- [ ] Generate VAPID keys: `web-push generate-vapid-keys`
- [ ] Store keys in `.env` (dev) and secret manager (prod)
- [ ] Create `push_subscriptions` DB table
- [ ] Implement POST `/api/notifications/subscribe` route
- [ ] Implement POST `/api/notifications/send` route
- [ ] Add subscription cleanup on 410 errors
- [ ] Implement retry logic with exponential backoff (or use queue)
- [ ] Add Service Worker to serve static `public/sw.js`
- [ ] Test end-to-end: subscribe → send → receive
- [ ] Add push subscription management UI (list, unsubscribe)
- [ ] Document VAPID setup in `docs/deployment-guide.md`

---

## Unresolved Questions

1. **Queue vs. Inline:** Should notifications be sent inline from Hono route (simple, sync) or queued (scalable, resilient)? Depends on volume expectations.
2. **Notification Channels:** Support notification categories (e.g., emails vs. updates)? Requires subscription metadata.
3. **Notification History:** Log sent notifications for audit/debugging? Requires additional table.
4. **Timeout Handling:** What timeout for `webpush.sendNotification()`? Default is likely fine for small batches.
5. **User Notification Preferences:** How to handle users disabling notifications? Subscription deactivation vs. deletion.

---

## Sources

- [web-push npm package](https://www.npmjs.com/package/web-push)
- [web-push GitHub repository](https://github.com/web-push-libs/web-push)
- [Generating a Secure VAPID Key for Node.js](https://iamstepaul.hashnode.dev/generating-a-secure-vapid-key-for-a-nodejs-project)
- [Bun Node.js Compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Pushpad — Web Push Notifications Guide](https://pushpad.xyz/blog/web-push-notifications-store-the-subscription-in-the-backend-database)
- [PushSubscription Storage Best Practices](https://medium.com/schibsted-engineering/how-to-store-subscriptions-a-practical-guide-and-analysis-of-3-selected-databases-dcfd06b747a4)
- [Web Push Protocol — web.dev](https://web.dev/articles/push-notifications-web-push-protocol)
- [Using Web Push with VAPID — rossta.net](https://rossta.net/blog/using-the-web-push-api-with-vapid.html)
- [Web Push Security — Snyk](https://snyk.io/advisor/npm-package/web-push/)
