// MS Game Service Worker: Navigation network-first (Updates landen sofort),
// statische Assets cache-first. Nur same-origin GET; POSTs (ntfy) unberührt.
'use strict';
// WICHTIG: Cache-Version bei Bedarf hochzaehlen (z.B. nach kritischen Fixes)!
// Der Name ist der EINZIGE Trigger, der activate() dazu bringt, alte Caches
// zu loeschen (siehe unten) - ohne Versionswechsel koennte auf manchen
// Geraeten dauerhaft eine veraltete/kaputte gecachte Version als Offline-
// Fallback ueberleben, selbst nach etlichen Deployments.
const CACHE = 'msgame-v8';
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => { }));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Netz zuerst: no-cache-Meta der Seite bleibt wirksam, offline Fallback aus Cache
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { });
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/')))
    );
    return;
  }

  // Assets (Icons, Manifest): Cache zuerst, sonst Netz + nachcachen
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { });
      }
      return res;
    }))
  );
});
