"""Entry point.

  "AutoCaption Engine.exe" --panel                 start the local API server
  "AutoCaption Engine.exe" --panel --self-test     end-to-end self test (JSON lines)
  "AutoCaption Engine.exe" --panel --verify        check files against bin/manifest.json
  "AutoCaption Engine.exe" --panel --version

Every mode requires the launch token the panel provides (see launchkey.py).
"""
from __future__ import annotations

import json
import os
import sys


def main(argv: list[str]) -> int:
    if argv and argv[0] == "worker":
        # The worker is only useful with the server's private socket credentials.
        if "AUTOCAPTION_WORKER_KEY" not in os.environ:
            return 64
        from .worker import main as worker_main

        return worker_main()
    from . import launchkey

    if not launchkey.check():
        sys.stderr.write(launchkey.MESSAGE + "\n")
        return 64
    if "--version" in argv:
        from . import __version__

        print(__version__)
        return 0
    if "--self-test" in argv:
        from .selftest import main as selftest_main

        return selftest_main(argv)
    if "--verify" in argv:
        from . import integrity

        res = integrity.verify(full="--full" in argv)
        print(json.dumps(res, indent=2))
        return 0 if res["ok"] else 1
    from .server import serve

    port = 0
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    return serve(port=port)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
