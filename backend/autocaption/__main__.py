"""Entry point.

  AutoCaptionBackend.exe                 start the local API server
  AutoCaptionBackend.exe --self-test     run the end-to-end self test (JSON lines)
  AutoCaptionBackend.exe --verify        check backend files against manifest.json
  AutoCaptionBackend.exe --version
"""
from __future__ import annotations

import json
import sys


def main(argv: list[str]) -> int:
    if argv and argv[0] == "worker":
        from .worker import main as worker_main

        return worker_main()
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
