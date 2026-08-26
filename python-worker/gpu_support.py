"""Windows CUDA runtime support: locates and enables the NVIDIA cuBLAS/cuDNN
DLLs shipped as official NVIDIA PyPI packages (nvidia-cublas-cu12,
nvidia-cudnn-cu12), without requiring the end user to install the CUDA
Toolkit, without touching the system-wide PATH, and scoped to only the
process that calls enable_gpu_dll_dirs().

These packages are published by NVIDIA's own PyPI organization specifically
so ML applications can vendor the CUDA runtime as a normal pip dependency
(this is the same mechanism PyTorch/TensorFlow's GPU wheels rely on). See
the bundled license at <site-packages>/nvidia_cudnn_cu12-*/licenses/License.txt
for the exact redistribution terms -- distribution "as incorporated in
object code format into a software application" is permitted under section
1.2, subject to the conditions listed there.
"""

import os
import sys
import glob
import importlib.metadata

REQUIRED_DLLS = [
    'cublas64_12.dll',
    'cublasLt64_12.dll',
    'cudnn64_9.dll',
    'cudnn_ops64_9.dll',
    'cudnn_cnn64_9.dll',
    'cudnn_graph64_9.dll',
]


def _site_packages_dir():
    # Works for both a venv's Scripts/python.exe and the portable runtime's
    # top-level python.exe (site-packages is Lib/site-packages relative to
    # the interpreter either way on Windows).
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    candidates = [
        os.path.join(exe_dir, 'Lib', 'site-packages'),
        os.path.join(exe_dir, '..', 'Lib', 'site-packages'),
    ]
    for c in candidates:
        c = os.path.abspath(c)
        if os.path.isdir(c):
            return c
    return None


def find_nvidia_dll_dirs():
    site_packages = _site_packages_dir()
    if not site_packages:
        return []
    return sorted(glob.glob(os.path.join(site_packages, 'nvidia', '*', 'bin')))


def enable_gpu_dll_dirs():
    """Adds the nvidia-*-cu12 packages' bin dirs to this process's DLL search
    path only (os.add_dll_directory is process-scoped) and prefixes PATH for
    this process/its children as a defensive fallback. Never touches the
    persistent system/user PATH registry values.
    """
    dirs = find_nvidia_dll_dirs()
    added = []
    for d in dirs:
        try:
            os.add_dll_directory(d)
            added.append(d)
        except (OSError, AttributeError):
            pass
    if added:
        os.environ['PATH'] = os.pathsep.join(added) + os.pathsep + os.environ.get('PATH', '')
    return added


def check_required_dlls():
    """Returns (ok, missing_list, checked_dirs)."""
    dirs = find_nvidia_dll_dirs()
    if not dirs:
        return False, REQUIRED_DLLS, []
    found = set()
    for d in dirs:
        for f in os.listdir(d):
            found.add(f.lower())
    missing = [name for name in REQUIRED_DLLS if name.lower() not in found]
    return len(missing) == 0, missing, dirs


def get_package_versions():
    versions = {}
    for pkg in ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12']:
        try:
            versions[pkg] = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            versions[pkg] = None
    return versions
