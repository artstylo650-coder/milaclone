'use strict';

// Minimal service worker. It exists so browsers treat Milaclone as an
// installable app (Chrome/Edge: menu → "Instalar Milaclone"); everything still
// comes from the local server, nothing is cached, so an update shows up at once.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
