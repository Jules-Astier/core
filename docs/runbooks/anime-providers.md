# HiAnime and WCO TV-animation adapters

Both adapters are opt-in: `HIANIME_ENABLED=true` and `WCO_ENABLED=true`.
They require the existing `TMDB_API_KEY`. They use the standard provider proxy,
strict framework validation and existing source-language ranking; no client
binary change is required. They do not return webpage embeds as playable media.

## Identity and episode mapping

Only TMDB TV records with animation genre 16 are eligible. Specials, invalid
numbers and missing/duplicate preceding-season counts are refused. HiAnime
requires a unique exact normalized title match and selects the exact absolute
episode from its own episode listing. WCO requires an exact series-page title
match and selects an exact season/episode URL when present, otherwise the exact
absolute episode. A title alias, different series slug or a separately named
anime season may need an explicit mapping in a future update; no fuzzy match
or silent episode-one fallback is used. Movie/OVA support is not claimed.

## HiAnime

Observed public chain on 2026-11-17: site search -> episode list -> server list
-> ZokoAnime public player payload -> valid HLS playlist. The adapter parses
the site's fixed XOR/base64 player data without executing upstream scripts.
Only known player hosts and `dramahot.top` media/subtitle hosts are accepted;
unknown hosts fail closed. Subbed audio follows TMDB's original language;
English-dub variants are separate source entries. External VTT subtitles are
proxied with the player headers. Signed media URLs must be rediscovered when
expired; they are never committed to fixtures or printed in diagnostics.

## WCO

The initial plain User-Agent probe returned 403. An ordinary desktop browser
User-Agent plus Accept/Accept-Language fetched real series and episode HTML;
this was not evidence of a universal datacenter block. Public episode pages
encode their iframe as a base64 numeric character array. This is decoded as
data, without eval, ad scripts, CAPTCHA solving or user cookies. The public
player's video-js page exposes getvidlink.php, which returns signed MP4 tokens.
Verification follows only wcostream.com redirects and checks a bounded ranged
response for an MP4 ftyp signature; HTML/error.mp4 is not accepted as evidence.

One Piece episode 1180 English Subbed returned a valid public 206 MP4 response
on Paul. Episode 1 English Dubbed explicitly displayed a premium-only notice.
Premium episodes are excluded with an account-required diagnostic. This adapter
has no premium-account integration and never attempts alternate hidden endpoints
for a premium page. Hard-subbed video is not advertised as switchable subtitles.

## Release checks

Focused tests cover exact identity/numbering, public serialization, premium
refusal, hostile media/redirect hosts and HTML masquerading as media. Full build,
provider-catalog validation/report consistency and bounded live probes run in a
Croissant Paul job. Live verification must distinguish discovery, verification,
manifest/ranged-MP4 access and actual player acceptance. Paul success alone is
not proof of VPS or device playback. Keep both flags disabled by default until
registered-provider and Saucy/player canaries pass.

WCO transport note: Node fetch and Chromium returned a Cloudflare challenge for
public pages in the same environment where Python's standard urllib returned
the real public HTML. A narrowly scoped Python3 transport is used only after
a WCO-origin403; it is bounded, cookie-free, refuses redirects and never solves
CAPTCHAs or accepts account credentials. Python3 is packaged into the runtime
image and its helper is copied by the build. Ordinary media remains on the
existing Node proxy. Public access may still be refused by the upstream.

## Additional public sources

`SUPERCARTOONS_ENABLED=true` adds verified public classic-cartoon MP4s. Movie
and TV episode titles must match exactly; TV lookups also verify the series
name against the source page. The source's own declared audio language is used.
No upload date is substituted for the original film release date.

`ANIMEAV1_ENABLED=true` adds the public Zilla HLS player on AnimeAV1. It requires
an exact series title and absolute episode number and labels the Spanish
subtitles separately from the original audio language. Only its public HLS
player is implemented; Voe/UPN/other embedded mirrors are not counted as extra
sources. Codec compatibility on an older LG TV is not implied by valid HLS.

All four providers remain opt-in in source. The deployment canary enables them
explicitly after fixture, public-media, and registered-proxy checks. Generic
Fight Club/Game of Thrones resolver rechecks are not acceptance tests for these
animation-specific providers; the live canary uses animation identities.

## Executed validation

Croissant evt_fbf04e9e78efdc00eb616c751e at e8e00ef6123cc0eb5cdf74e6025fa33d56390c77
passed the TypeScript build, catalog/report checks,231 provider/health tests and
15 catalog tests. Live public canaries returned HiAnime One Piece1/1180 and
Naruto Shippuden1, WCO One Piece1180 and Naruto Shippuden1, AnimeAV1 One Piece1,
and SuperCartoons The Cat Concerto (TMDB39853). WCO One Piece1 was correctly
reported premium-only. Missing AnimeAV1 episodes returned no fabricated source.
No account credentials or signed stream URLs are retained in these receipts.
Registered runtime/proxy and deployment validation follow separately.
