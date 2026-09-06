"""Optional live recapture into a NEW directory; deterministic replay never uses this.

Usage: python3 scripts/source-evidence/capture.py <retained-manifest.json> <new-directory>
The retained manifest supplies the finite URL inventory. A new capture requires a
fresh scope/visual review; this command never copies old expected facts or gates.
"""

import datetime
import hashlib
import json
import pathlib
import sys
import time
import urllib.request


def capture(request, directory):
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    headers = {"User-Agent": "CardKeepr evidence research", "Accept-Encoding": "identity"}
    with urllib.request.urlopen(
        urllib.request.Request(request["url"], headers=headers), timeout=90
    ) as response:
        body = response.read()
        response_headers = response.headers.as_bytes()
        status = response.status
        final_url = response.url
        content_type = response.headers.get_content_type()
    (directory / request["body"]).write_bytes(body)
    (directory / request["headers"]).write_bytes(response_headers)
    return {
        "id": request["id"],
        "url": request["url"],
        "finalUrl": final_url,
        "startedAt": started,
        "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": status,
        "body": request["body"],
        "headers": request["headers"],
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "headersSha256": hashlib.sha256(response_headers).hexdigest(),
        "requestHeaders": headers,
        "contentType": content_type,
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source = json.loads(pathlib.Path(sys.argv[1]).read_text())
    directory = pathlib.Path(sys.argv[2])
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "raw").mkdir()
    captures = []
    for request in source["captures"]:
        captures.append(capture(request, directory))
        # Persist successes even when a later request fails. This is an inventory,
        # deliberately not an approved complete evidence-pack manifest.
        (directory / "capture-inventory.json").write_text(
            json.dumps({"classification": "unreviewed-live-capture", "captures": captures}, indent=2) + "\n"
        )
        print(request["id"], captures[-1]["bytes"], flush=True)
        time.sleep(1)


if __name__ == "__main__":
    main()
