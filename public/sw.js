const CACHE = 'tradeflow-v1'
const SHELL = ['/', '/manifest.json']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Network-first for API calls; cache-first for shell assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/auth') || url.pathname.startsWith('/trade') ||
      url.pathname.startsWith('/xumm') || url.pathname.startsWith('/health') ||
      url.pathname.startsWith('/invite') || url.pathname.startsWith('/trust')) {
    // API: network only
    return
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()))
        return res
      })
      return cached || network
    })
  )
})
