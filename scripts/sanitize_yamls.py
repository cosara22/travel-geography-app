"""
原本（個人学習用）の YAML から OSS 公開用の YAML を生成するサニタイザ。

除去フィールド（書籍由来 / 個人メモ）:
  - exam_keywords    : 「観光地理問題集」由来の試験頻出ポイント
  - description      : 同上の解説テキスト
  - notes            : 個人学習メモ
  - source           : 出典書籍名

整形:
  - prefectures.attractions / mountains / islands / lakes / capes / rivers /
    stations / airports / jr_lines のような string 配列について、
    要素のカッコ以降を除去（例: "金閣寺（世界遺産、舎利殿）" → "金閣寺"）
    注: カッコ内に書籍由来の解説が混入するため。

実行:
    python scripts/sanitize_yamls.py --src <SOURCE_DATA_DIR> --dst data/

出力:
    data/{world_heritage,national_parks,onsen,festivals,cuisine,prefectures,transport}/*.yaml
"""
import argparse
import glob
import io
import os
import re
import sys

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import yaml

# 除去するフィールド（書籍引用 / 個人メモ）
STRIP_FIELDS = ("exam_keywords", "description", "notes", "source")

# prefectures の string 配列フィールド: カッコ以降を除去
ARRAY_FIELDS_TO_TRIM = (
    "attractions", "mountains", "islands", "lakes", "capes", "rivers",
    "stations", "airports", "jr_lines",
)

_PAREN_RE = re.compile(r"[（(].*$")


def trim_paren(s: str) -> str:
    """文字列のカッコ以降を除去。書籍由来の解説テキスト混入対策。"""
    if not s:
        return s
    return _PAREN_RE.sub("", s).strip()


def sanitize_value(item: dict) -> dict:
    """1エントリをサニタイズして返す（破壊的変更しない）。"""
    out = {}
    for k, v in item.items():
        if k in STRIP_FIELDS:
            continue
        if k in ARRAY_FIELDS_TO_TRIM and isinstance(v, list):
            # 文字列要素のみカッコ除去（重複は除く、空文字も除く）
            seen = set()
            trimmed = []
            for x in v:
                if isinstance(x, str):
                    t = trim_paren(x)
                    if t and t not in seen:
                        seen.add(t)
                        trimmed.append(t)
                else:
                    trimmed.append(x)
            out[k] = trimmed
        else:
            out[k] = v
    return out


def process_dir(src_dir: str, dst_dir: str) -> int:
    """src_dir 配下の YAML を全てサニタイズして dst_dir に出力。"""
    os.makedirs(dst_dir, exist_ok=True)
    count = 0
    for src_path in sorted(glob.glob(os.path.join(src_dir, "*.yaml"))):
        with open(src_path, encoding="utf-8") as fp:
            data = yaml.safe_load(fp)
        if data is None:
            continue
        cleaned = sanitize_value(data)
        dst_path = os.path.join(dst_dir, os.path.basename(src_path))
        with open(dst_path, "w", encoding="utf-8") as fp:
            yaml.safe_dump(cleaned, fp, allow_unicode=True, sort_keys=False)
        count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", required=True, help="原本データディレクトリ（例: ../旅行業務取扱管理者試験/地理DB/data）")
    parser.add_argument("--dst", default="data", help="出力先ディレクトリ（既定: data/）")
    args = parser.parse_args()

    if not os.path.isdir(args.src):
        print(f"src ディレクトリが見つかりません: {args.src}", file=sys.stderr)
        return 1

    # 各カテゴリディレクトリを処理
    categories = ("prefectures", "world_heritage", "national_parks", "onsen", "festivals", "cuisine", "transport")
    total = 0
    for cat in categories:
        src_cat = os.path.join(args.src, cat)
        if not os.path.isdir(src_cat):
            print(f"  skip: {cat}（ソースに存在しない）")
            continue
        dst_cat = os.path.join(args.dst, cat)
        n = process_dir(src_cat, dst_cat)
        print(f"  {cat}: {n} 件")
        total += n

    print(f"合計: {total} 件をサニタイズしました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
