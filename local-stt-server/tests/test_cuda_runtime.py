from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import cuda_runtime  # noqa: E402


class FakeDistribution:
    def __init__(self, root: Path, files: list[Path]) -> None:
        self.root = root
        self.files = files

    def locate_file(self, entry: Path) -> Path:
        return self.root / "Lib" / "site-packages" / entry


class CudaRuntimeTests(unittest.TestCase):
    def test_required_dlls_are_located_from_distribution_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            entries = [
                Path("nvidia/cublas/bin/cublas64_12.dll"),
                Path("nvidia/cublas/bin/cublasLt64_12.dll"),
                Path("nvidia/cudnn/bin/cudnn64_9.dll"),
            ]
            for entry in entries:
                path = root / "Lib" / "site-packages" / entry
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()

            distribution = FakeDistribution(root, entries)
            with (
                mock.patch.object(cuda_runtime.sys, "prefix", str(root)),
                mock.patch.object(
                    cuda_runtime.metadata,
                    "distribution",
                    return_value=distribution,
                ),
            ):
                found = cuda_runtime.find_cuda_runtime_dlls()

        self.assertEqual(set(found), set(cuda_runtime.CUDA_RUNTIME_DLLS))
        self.assertTrue(all(path.name in found for path in entries))

    def test_registration_updates_only_the_current_process_path(self) -> None:
        original_handles = list(cuda_runtime._DLL_DIRECTORY_HANDLES)
        original_directories = list(cuda_runtime._REGISTERED_DIRECTORIES)
        cuda_runtime._DLL_DIRECTORY_HANDLES.clear()
        cuda_runtime._REGISTERED_DIRECTORIES.clear()
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                cublas_dir = root / "nvidia" / "cublas" / "bin"
                cudnn_dir = root / "nvidia" / "cudnn" / "bin"
                paths = {
                    "cublas64_12.dll": cublas_dir / "cublas64_12.dll",
                    "cublasLt64_12.dll": cublas_dir / "cublasLt64_12.dll",
                    "cudnn64_9.dll": cudnn_dir / "cudnn64_9.dll",
                }
                with (
                    mock.patch.object(cuda_runtime.sys, "platform", "win32"),
                    mock.patch.object(
                        cuda_runtime, "find_cuda_runtime_dlls", return_value=paths
                    ),
                    mock.patch.object(
                        cuda_runtime.os,
                        "add_dll_directory",
                        create=True,
                    ) as add_directory,
                    mock.patch.dict(os.environ, {"PATH": "base-path"}, clear=False),
                ):
                    registered = cuda_runtime.register_cuda_dll_directories()
                    process_path = os.environ["PATH"]

                self.assertEqual(len(registered), 2)
                self.assertEqual(add_directory.call_count, 2)
                self.assertTrue(process_path.endswith("base-path"))
                self.assertIn(str(cublas_dir), process_path)
                self.assertIn(str(cudnn_dir), process_path)
        finally:
            cuda_runtime._DLL_DIRECTORY_HANDLES[:] = original_handles
            cuda_runtime._REGISTERED_DIRECTORIES[:] = original_directories


if __name__ == "__main__":
    unittest.main()
