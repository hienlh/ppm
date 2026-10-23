# `src/services/share-host/`

## Map

- `share-host-worker.ts` (the `__share_host__` process) + `share-host-gateway.ts` (what it lets through: `/s`, `/s/*`, `/assets/share-*`), `share-host-supervision.ts` (the supervisor's half: worker, connector, what PPM's own connector must carry), `share-host-connector.ts` (one cloudflared with restart and backoff), `share-host-args.ts` (argv and ingress files), `share-host-config.ts` (the `share_host` row and the plan), `share-host-status.ts` (reading `status.json`), `share-host-setup.service.ts` (Settings' setup flow). Docs `docs/architecture/workspace-and-ui.md` → Share links → The review address

## Gotchas

- **Two connectors on one tunnel share its traffic, whatever their routes say**: Cloudflare spreads a hostname's requests over every connector of a tunnel, so a share-host connector routing only the share hostname next to PPM's routing only PPM's would answer half of each with 404s. In `shared` mode exactly one runs: PPM's own (carrying both, via `ingressForPpmConnector`) while PPM's public link is on, the share host's (`shared-own`) while it is off. A `retunnel` hands the tunnel over: the supervisor stops one connector as it starts the other.
- **Bun's `process.ppid` never changes once read, in the main thread too**: `src/services/schedule-script/CLAUDE.md` records it inside a Worker; measured here, a worker whose supervisor died kept reporting the dead pid while `/proc/self/stat` already named the process it had been reparented to. `parentAlive` reads `/proc/self/stat` (falling back to `process.kill(parent, 0)` off Linux), and `share-host-worker-process.test.ts` kills a real parent to pin it.
- **The supervisor reads PPM's tunnel row only at boot and on `retunnel`, not on `reshare`**: `reshare` re-reads `share_host` alone. The named-tunnel routes send `retunnel` themselves, but a script or test that changes the `tunnel` row and sends only `reshare` gets a plan built on the old PPM tunnel (a `shared` review address reported unavailable, say).
