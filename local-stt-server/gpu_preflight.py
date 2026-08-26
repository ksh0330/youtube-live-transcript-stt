from __future__ import annotations

import gc
import sys

from cuda_runtime import (
    CUDA_RUNTIME_DLLS,
    find_cuda_runtime_dlls,
    installed_cuda_package_versions,
    register_cuda_dll_directories,
    windows_dll_loadable,
)


def main() -> int:
    if sys.platform != "win32":
        print("[ERROR] This setup helper currently supports Windows only.")
        return 1

    versions = installed_cuda_package_versions()
    dll_paths = find_cuda_runtime_dlls()
    registered = register_cuda_dll_directories()

    for package, version in versions.items():
        print(f"[OK] {package} {version}")
    for name in CUDA_RUNTIME_DLLS:
        path = dll_paths.get(name)
        if path is None:
            print(f"[ERROR] {name} was not found in the current virtual environment.")
        else:
            print(f"[OK] {name}: {path}")
    for directory in registered:
        print(f"[OK] Process-local DLL directory: {directory}")

    missing = [name for name in CUDA_RUNTIME_DLLS if name not in dll_paths]
    unloadable = [name for name in CUDA_RUNTIME_DLLS if not windows_dll_loadable(name)]
    if missing or unloadable:
        if unloadable:
            print("[ERROR] DLL load failed: " + ", ".join(unloadable))
        return 1

    import numpy as np
    import ctranslate2
    import faster_whisper
    from faster_whisper import WhisperModel

    print(f"[INFO] faster-whisper {faster_whisper.__version__}")
    print(f"[INFO] CTranslate2 {ctranslate2.__version__}")
    print("[INFO] Running small / cuda / float16 inference preflight...")

    model: WhisperModel | None = None
    try:
        model = WhisperModel("small", device="cuda", compute_type="float16")
        segments, _info = model.transcribe(
            np.zeros(16000, dtype=np.float32),
            language="ko",
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            temperature=0.0,
            word_timestamps=False,
        )
        list(segments)
    except Exception as error:
        print(f"[ERROR] GPU inference preflight failed: {error}")
        return 1
    finally:
        if model is not None:
            model.model.unload_model()
            model = None
        gc.collect()

    print("[OK] GPU ready")
    print("[OK] small / cuda / float16")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
