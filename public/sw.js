// The dashboard's service worker: it shows the pushes the server sends
// (server/notify.js) and opens the dashboard when one is tapped. It keeps
// nothing offline: every number comes fresh from /api.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { body: event.data?.text() || '' }; }
  const url = typeof m.url === 'string' && m.url.startsWith('/') ? m.url : '/';
  event.waitUntil(self.registration.showNotification(m.title || 'Abyssol', {
    body: m.body || '', tag: m.tag || undefined, renotify: !!m.tag,
    icon: '/icon-192.png', badge: '/badge-96.png', data: { url }, timestamp: Date.now(),
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      await c.focus();
      if ('navigate' in c) await c.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// A browser that renews a subscription by itself tells the server the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options?.applicationServerKey;
    if (!key) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), kinds: null }) });
    if (event.oldSubscription) await fetch('/api/push', { method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }) });
  })().catch(() => {}));
});
