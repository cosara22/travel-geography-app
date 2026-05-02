"""
data/ 配下のYAMLファイルを統合して public/data.json を出力するスクリプト。

実行方法:
    python scripts/export_json.py

出力先:
    public/data.json （ブラウザが読み込む統合データ）

依存:
    pip install pyyaml
"""
import glob
import json
import os
import sys
import io

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import yaml

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
OUT_PATH = os.path.join(PROJECT_ROOT, "public", "data.json")


def load_dir(name: str) -> dict:
    """data/{name}/*.yaml を全て読み込んで {id: data} の辞書にする。"""
    target = os.path.join(DATA_DIR, name)
    items: dict = {}
    if not os.path.isdir(target):
        return items
    for f in sorted(glob.glob(os.path.join(target, "*.yaml"))):
        with open(f, encoding="utf-8") as fp:
            d = yaml.safe_load(fp)
        if d and "id" in d:
            items[d["id"]] = d
    return items


def main() -> int:
    result = {
        "prefectures":     load_dir("prefectures"),
        "world_heritage":  load_dir("world_heritage"),
        "national_parks":  load_dir("national_parks"),
        "onsen":           load_dir("onsen"),
        "festivals":       load_dir("festivals"),
        "cuisine":         load_dir("cuisine"),
        "transport":       load_dir("transport"),
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"出力: {OUT_PATH}")
    print(f"サイズ: {size_kb:.1f} KB")
    print()
    print("統計:")
    for key, items in result.items():
        print(f"  {key}: {len(items)} 件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
