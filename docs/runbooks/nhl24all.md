# NHL24ALL live sources

NHL Web owns schedules (`nhl:<official-game-id>`). The NHL24ALL provider enriches
those events by exact game ID, so NHL games appear in the existing website Live
tab without a second schedule or duplicate title matching. API-Sports IDs alone
are not treated as NHL IDs.

`NHLWEB_ENABLED=true` and `NHL24ALL_ENABLED=true` enable the integration (both
are the defaults). `NHL24ALL_ENABLED=false` disables only this source. Deploy the
core containing `src/providers/nhl24all`; enabling an environment variable on an
older CinePro image does not add the provider. Local compose builds use `../core`
by default. Deployment/image/release pins must be updated by the release flow;
this source change does not claim an already deployed release.

The provider reads the public homepage's JSON snapshot without evaluating scripts.
Only a game with status `L`, a matching media event with status `L`, and a flavor
with **explicitly null** entitlements qualifies. Scheduled, replay, over, scrapped,
postponed and canceled feeds never become live sources. Premium sessions,
cookies, signatures, credentials and browser-execution fallback are not used.
Encrypted playlists and unexpected media hosts fail closed.

A source request POSTs the public feed and flavor IDs to the client-declared API
host, validates HLS master/one variant and returns the existing CinePro proxy URL.
The provider does not download segments. Refresh gets a fresh media URL; the
stable feed label/ID keeps the existing web source-recovery matching consistent.
The source response cache defaults to 30 seconds; this is not a claimed upstream
URL expiry. Warm-up/unavailable feeds return diagnostics and allow a later
explicit source refresh. There is no retry or entitlement escalation loop.

Network limits: two feed resolutions at once, four feeds maximum, 10-second
request/body deadline, 1 MiB schedule, 16 KiB API response, 128 KiB master and
512 KiB variant, measured after Fetch decompression. Redirects are rejected.
The only accepted media origin family is HTTPS `mlb9.com` and its subdomains.
Host changes require research/code review, not arbitrary runtime URL input.
Never log upstream media URLs or error bodies: opaque access strings can occur
in paths as well as queries. Schedule snapshots cache for 30 seconds with
single-flight loading. Event manifest cache defaults to 60 seconds; NHL/API-Sports
schedule providers retain their own independent endpoint caches.

## Evidence and release limits

On 2026-11-17 a public free Sportsnet **replay** returned an HLS master, complete
variant and a bounded 64 KiB TS segment range. The advertised replay was H.264 /
AAC-LC, 640x360; no live game was available during the investigation. That is not
a live-provider playback acceptance result. Deterministic tests cover event joins,
public-only filtering, source renewal, partial failures and request boundaries.

Before release promotion, establish permission for this new source (including
proxying/recording as applicable), then validate an explicitly public live flavor
during an actual live window. Confirm moving playlists, expiry/refresh and real
browser/native/webOS playback. Public reachability is not redistribution
permission. Do not generalize other Saucy sources' permissions to this site.
No account, DRM, paywall or challenge bypass is part of this integration.
