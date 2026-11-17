"""Bounded, public WCO HTML transport. No cookies, credentials or challenge solving."""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    request = json.loads(sys.stdin.buffer.read(8192))
    url = urllib.parse.urlsplit(request["url"])
    if (url.scheme != "https" or url.hostname != "www.wco.tv" or url.port
            or url.username or url.password or url.fragment):
        raise ValueError("Unsupported public page")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.wco.tv/",
    }
    opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))
    try:
        response = opener.open(urllib.request.Request(request["url"], headers=headers), timeout=12)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        if response.status != 200:
            print(json.dumps({"status": response.status, "body": ""}))
            return
        body = response.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise ValueError("Public page too large")
        print(json.dumps({"status": 200, "body": body.decode("utf-8")}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never log URLs, player tokens, body contents, environment or tracebacks.
        print(json.dumps({"status": 502, "body": ""}))
        sys.exit(1)
