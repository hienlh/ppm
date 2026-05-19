/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// Workbox injects precache manifest here
precacheAndRoute(self.__WB_MANIFEST);
