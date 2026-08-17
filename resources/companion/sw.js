// ASIT companion service worker: offline shell + web push.
//
// This is what makes the phone app OPEN when the PC is off. Without a cached
// shell there is nothing to load — the saved to-dos and review cards in
// localStorage are unreachable because the page itself never renders.
//
// Bump CACHE whenever the shell changes so old copies are evicted.
const CACHE = 'asit-shell-v4'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-180.png', '/icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE)
      // Individually, NOT addAll: addAll is atomic, so one 404 (an icon that
      // didn't ship, say) would leave the whole app with no offline shell.
      await Promise.all(
        SHELL.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => (res.ok ? c.put(url, res) : null))
            .catch(() => null)
        )
      )
    })()
  )
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // API calls are never cached — the app keeps its own copy of the data in
  // localStorage, and a stale cached response would defeat its offline logic.
  if (url.pathname.startsWith('/api/')) return

  // A navigation is the case that matters when the PC is off: always fall
  // back to the cached shell so the app opens instead of showing a browser
  // error page.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy))
          return res
        })
        .catch(async () => (await caches.match('/')) || (await caches.match('/index.html')) || Response.error())
    )
    return
  }

  // Everything else (icons, manifest): network-first so updates land, cache
  // fallback so they still resolve offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req))
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
