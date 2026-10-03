"""Hardware / version diagnostics. No tokens, no user content."""
from __future__ import annotations

import ctypes
import os
import platform
import shutil
import subprocess
import sys

from . import __version__, integrity, paths

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def total_ram_bytes() -> int | None:
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            return int(st.ullTotalPhys)
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    except Exception:  # noqa: BLE001
        return None
    return None


def cpu_name() -> str:
    if sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        except OSError:
            pass
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "Unknown CPU"


def gpu_info() -> dict:
    info: dict = {"cudaDevices": 0, "name": None}
    try:
        import ctranslate2

        info["cudaDevices"] = int(ctranslate2.get_cuda_device_count())
    except Exception as exc:  # noqa: BLE001
        info["error"] = type(exc).__name__
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run([smi, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
                                 capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=10,
                                 creationflags=_NO_WINDOW)
            line = (out.stdout or "").strip().splitlines()
            if line:
                parts = [p.strip() for p in line[0].split(",")]
                info["name"] = parts[0]
                if len(parts) > 1:
                    info["memory"] = parts[1]
                if len(parts) > 2:
                    info["driver"] = parts[2]
        except (OSError, subprocess.SubprocessError):
            pass
    return info


def free_disk_bytes(path) -> int | None:
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return None


def diagnostics(app=None) -> dict:
    """What the panel's Diagnostics page shows: hardware and engine state only.
    Component versions are written to the engine log instead."""
    ram = total_ram_bytes()
    gpu = gpu_info()
    return {
        "engineVersion": __version__,
        "platform": (integrity.load_manifest() or {}).get("platform", f"{sys.platform}-{platform.machine()}"),
        "os": f"{platform.system()} {platform.release()} ({platform.version()})",
        "cpu": cpu_name(),
        "cpuCores": os.cpu_count(),
        "ramGB": round(ram / 1024**3, 1) if ram else None,
        "gpu": {"available": bool(gpu.get("cudaDevices")), "name": gpu.get("name"), "memory": gpu.get("memory")},
        "tempFreeGB": (lambda b: round(b / 1024**3, 1) if b else None)(free_disk_bytes(paths.temp_root())),
        "engineRunning": bool(app and app.jobs.worker.alive()),
        "logsDir": str(paths.logs_dir()),
        "engineDir": str(paths.backend_root()),
    }


def component_versions() -> dict:
    """Detailed versions for the engine log (not shown in the panel)."""
    m = integrity.load_manifest() or {}
    return {k: v for k, v in m.items() if k.endswith("Version")}
