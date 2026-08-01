# VixSrc egress runbook

## Current finding

The public `https://vixsrc.to` origin permits the supplied movie seed from a
normal residential browser but blocks CinePro's data-center egress. This is an
upstream access-policy decision, not a general network failure:

- The collaborative browser reached the API, embed page, and HLS master with
  HTTP 200 through Cloudflare LHR on residential ASN 5089.
- The CinePro host reached Cloudflare trace endpoints through ARN on hosting
  ASN 24940, but API requests returned HTTP 403.
- A fresh isolated headless browser on the CinePro host was blocked.
- Stock headed Chrome on the CinePro host, with `webdriver=false` and no
  `HeadlessChrome` user-agent marker, was also blocked.
- A valid, task-scoped playlist URL resolved by the working browser still
  returned HTTP 403 when fetched once through the CinePro host.

The bounded assessment used one concurrent flow and 17 intentional VixSrc
document, trace, API, embed, or playlist requests, excluding ordinary static
page assets. No account actions, credentials, persistent cookies, load testing,
or private data were involved. Live tokens were held in memory and discarded.

## Supported production path

VixSrc's public documentation provides a custom-domain workflow:

1. Submit a dedicated domain or delegated subdomain to `/api/domains`.
2. Prove ownership with the returned `_vixsrc-challenge` TXT record.
3. Delegate the dedicated name to the returned nameservers.
4. Set `VIXSRC_BASE_URL=https://<approved-name>` in CinePro.
5. Restart CinePro, clear its source cache, and run the two-identity live gate.

Use a dedicated subdomain so this delegation cannot affect unrelated services.
Do not submit or change DNS until the domain owner explicitly approves the
target name and nameserver delegation.

## Alternative approved egress

If custom-domain delegation is unavailable, all VixSrc resolution and media
traffic must use the same approved egress. Proxying only the API or embed page
is insufficient because the public playlist endpoint also blocks the current
host. The egress must therefore cover:

- API lookup
- Embed HTML
- Master and variant playlists
- Media segments and subtitle/audio playlists

Do not enable a generic open relay. Use a private, authenticated, rate-bounded
transport, keep its credentials outside source control, and verify both CinePro
resolution and Saucy segment playback before enabling the provider.
