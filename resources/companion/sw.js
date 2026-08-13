// ASIT companion service worker: offline shell + web push.
const CACHE = 'asit-shell-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icon-180.png', '/icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim())
})

// Network-first for the shell (so UI updates land), cache fallback offline.
// API calls are never cached — stale study data is worse than an error.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/api/')) return
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
        return res
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/')))
  )
})

self.addEventListener('push', (e) => {
  let data = { title: 'ASIT', body: '' }
  try {
    data = { ...data, ...e.data.json() }
  } catch {
    data.body = e.data ? e.data.text() : ''
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || undefined,
      icon: '/icon-180.png',
      badge: '/icon-180.png'
    })
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins[0]
      if (win) return win.focus()
      return self.clients.openWindow('/')
    })
  )
})
