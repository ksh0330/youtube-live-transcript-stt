from __future__ import annotations

import ctypes
import os
import sys
from importlib import metadata
from pathlib import Path

CUDA_RUNTIME_DISTRIBUTIONS = (
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12",
)
CUDA_RUNTIME_DLLS = (
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "cudnn64_9.dll",
)

_DLL_DIRECTORY_HANDLES: list[object] = []
_REGISTERED_DIRECTORIES: list[Path] = []


def installed_cuda_package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for distribution_name in CUDA_RUNTIME_DISTRIBUTIONS:
        try:
            versions[distribution_name] = metadata.version(distribution_name)
        except metadata.PackageNotFoundError:
            continue
    return versions


def find_cuda_runtime_dlls() -> dict[str, Path]:
    """Locate required DLLs from NVIDIA distributions installed in this Python env."""
    wanted = {name.lower(): name for name in CUDA_RUNTIME_DLLS}
    found: dict[str, Path] = {}
    environment_root = Path(sys.prefix).resolve()

    for distribution_name in CUDA_RUNTIME_DISTRIBUTIONS:
        try:
            distribution = metadata.distribution(distribution_name)
        except metadata.PackageNotFoundError:
            continue

        for entry in distribution.files or ():
            canonical_name = wanted.get(entry.name.lower())
            if not canonical_name or canonical_name in found:
                continue
            candidate = Path(distribution.locate_file(entry)).resolve()
            try:
                candidate.relative_to(environment_root)
            except ValueError:
                continue
            if candidate.is_file():
                found[canonical_name] = candidate

    return found


def register_cuda_dll_directories() -> tuple[Path, ...]:
    """Register venv NVIDIA DLL folders for this process only."""
    if sys.platform != "win32" or not hasattr(os, "add_dll_directory"):
        return ()

    directories = sorted({path.parent for path in find_cuda_runtime_dlls().values()})
    for directory in directories:
        if directory in _REGISTERED_DIRECTORIES:
            continue
        _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(directory)))
        _REGISTERED_DIRECTORIES.append(directory)

    # CTranslate2 4.8.1 loads CUDA libraries by name at inference time and does
    # not resolve os.add_dll_directory entries on Windows. Updating this process
    # environment keeps the change local while covering that native load path.
    current_path = os.environ.get("PATH", "")
    current_entries = {
        entry.casefold() for entry in current_path.split(os.pathsep) if entry
    }
    path_prefix = [
        str(directory)
        for directory in _REGISTERED_DIRECTORIES
        if str(directory).casefold() not in current_entries
    ]
    if path_prefix:
        os.environ["PATH"] = os.pathsep.join(path_prefix + [current_path])
    return tuple(_REGISTERED_DIRECTORIES)


def windows_dll_loadable(name: str) -> bool:
    if sys.platform != "win32":
        return True

    try:
        library = ctypes.WinDLL(name)
    except OSError:
        return False

    handle = library._handle
    if handle:
        free_library = ctypes.windll.kernel32.FreeLibrary
        free_library.argtypes = [ctypes.c_void_p]
        free_library.restype = ctypes.c_int
        free_library(handle)
    return True
