#!/usr/bin/env python3
"""Package only the generated reading material for a local PC, never deployment state."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
FOLDER = "jeju-atlas-workshop"
ASSET_SUFFIXES = {".css", ".js", ".svg", ".png", ".ico", ".woff", ".woff2", ".txt"}


def package_handbook(site, output):
    site, output = Path(site), Path(output)
    if site.is_symlink() or not site.is_dir() or output.is_symlink():
        raise ValueError("Use a generated site directory and a regular ZIP output path")
    site_root, output_path = site.resolve(), output.resolve()
    if site_root == output_path or site_root in output_path.parents:
        raise ValueError("Write the ZIP outside the site directory")
    marker = site / ".workshop-site.json"
    if not marker.is_file() or marker.is_symlink() or marker.stat().st_size > 65536:
        raise ValueError("Build the workshop site before packaging")
    manifest = json.loads(marker.read_text())
    if manifest.get("generator") != "jeju-atlas-workshop/v1":
        raise ValueError("Unexpected site generator")
    pages = manifest.get("pages")
    if (not isinstance(pages, list) or not all(isinstance(name, str) for name in pages)
            or "index.html" not in pages or len(pages) != len(set(pages))):
        raise ValueError("The site page manifest is incomplete")
    for name in pages:
        if (not isinstance(name, str) or PurePosixPath(name).is_absolute()
                or ".." in PurePosixPath(name).parts or not name.endswith(".html")
                or not (site / name).is_file()):
            raise ValueError("The generated site is missing a declared page")
    files, total = [], 0
    for path in sorted(site.rglob("*")):
        if path.is_symlink():
            raise ValueError("Do not package symlinks")
        if not path.is_file():
            continue
        relative = path.relative_to(site).as_posix()
        if relative == ".workshop-site.json":
            continue
        parts = PurePosixPath(relative).parts
        allowed = (relative in pages
                   or (parts[0] == "assets" and path.suffix.lower() in ASSET_SUFFIXES)
                   or (len(parts) == 2 and parts[0] == "prompts" and path.suffix == ".md"))
        if not allowed or any(part.startswith(".") for part in parts):
            raise ValueError("Unexpected or private file in site: " + relative)
        total += path.stat().st_size
        if total > 64 * 1024 * 1024:
            raise ValueError("Handbook exceeds the expected static-file size")
        files.append((relative, path))
    instructions = (
        "제주 아틀라스 워크숍 — 로컬 PC 교재\n\n"
        "1. ZIP을 압축 해제합니다. 압축 파일 안에서 index.html만 직접 열지 마세요.\n"
        "2. jeju-atlas-workshop/index.html을 브라우저로 엽니다.\n"
        "3. chapters, reference, assets, prompts 폴더를 함께 유지합니다.\n"
        "4. 명령과 선택한 Codex·Kiro CLI·Claude Code는 실습 EC2 터미널에서 실행합니다.\n"
        "5. EC2에는 제주 아틀라스 전체 Git 저장소가 필요합니다.\n\n"
        "이 묶음은 읽기용입니다. AWS 키, 실습 설정, 배포 상태, DB, 런타임 ZIP은 포함하지 않습니다.\n"
        "prompts/*.md는 EC2에서 선택한 AI CLI에 전달할 공통 프롬프트 카드입니다.\n"
    ).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".handbook-", suffix=".zip", dir=output.parent, delete=False) as temp:
            temporary = Path(temp.name)
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, contents in [("START-HERE.txt", instructions),
                                   *((name, path.read_bytes()) for name, path in files)]:
                info = zipfile.ZipInfo(FOLDER + "/" + name, date_time=(2026, 9, 11, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, contents)
        temporary.chmod(0o644)
        temporary.replace(output)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(digest + "  " + output.name + "\n")
    return {"archive": str(output), "entryPoint": FOLDER + "/index.html", "files": len(files) + 1,
            "pages": len(pages), "bytes": output.stat().st_size, "sha256": digest,
            "cloudDeploymentIncluded": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", type=Path, default=ROOT / "workshop/site")
    parser.add_argument("--output", type=Path,
                        default=ROOT / "workshop/.local/downloads/jeju-atlas-workshop-handbook.zip")
    args = parser.parse_args()
    print(json.dumps(package_handbook(args.site, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, FileNotFoundError) as error:
        print("Handbook: " + str(error), file=sys.stderr)
        raise SystemExit(2) from None
