"""
地理DB配下のYAMLファイルをスキーマで検証するスクリプト。

実行方法:
    python 地理DB/scripts/validate.py

依存（任意）:
    pip install pyyaml jsonschema

jsonschema がインストールされていない場合は、必須フィールドの存在のみ簡易チェック。
"""
import glob
import json
import os
import sys
import io

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

try:
    import yaml
except ImportError:
    print("ERROR: PyYAMLが必要です。`pip install pyyaml` を実行してください。")
    sys.exit(1)

try:
    import jsonschema
    HAS_JSONSCHEMA = True
except ImportError:
    HAS_JSONSCHEMA = False
    print("INFO: jsonschemaが未インストールのため、簡易チェックモードで実行します。")
    print("  厳密チェックを行うには `pip install jsonschema` を実行してください。\n")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_DIR = os.path.join(ROOT, "schema")
DATA_DIR = os.path.join(ROOT, "data")

# ディレクトリ → スキーマファイル のマッピング
DIR_TO_SCHEMA = {
    "prefectures":     "prefecture.schema.json",
    "onsen":           "onsen.schema.json",
    "world_heritage":  "world_heritage.schema.json",
    "national_parks":  "national_park.schema.json",
    "festivals":       "festival.schema.json",
    "cuisine":         "cuisine.schema.json",
    "transport":       "transport.schema.json",
}


def load_schema(name: str):
    path = os.path.join(SCHEMA_DIR, name)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def check_required(data: dict, schema: dict, path: str) -> list[str]:
    """jsonschemaがない場合のフォールバック: 必須フィールドの存在のみチェック。"""
    errors = []
    for field in schema.get("required", []):
        if field not in data:
            errors.append(f"{path}: 必須フィールド '{field}' が不足")
    return errors


def main() -> int:
    total = 0
    failed = 0
    errors_all: list[str] = []

    schemas: dict[str, dict] = {}
    for dirname, schema_name in DIR_TO_SCHEMA.items():
        schemas[dirname] = load_schema(schema_name)

    for dirname, schema in schemas.items():
        target_dir = os.path.join(DATA_DIR, dirname)
        if not os.path.isdir(target_dir):
            continue
        files = sorted(glob.glob(os.path.join(target_dir, "*.yaml")))
        for f in files:
            total += 1
            with open(f, encoding="utf-8") as fp:
                data = yaml.safe_load(fp)

            if HAS_JSONSCHEMA:
                try:
                    jsonschema.validate(instance=data, schema=schema)
                except jsonschema.ValidationError as e:
                    failed += 1
                    errors_all.append(f"{f}: {e.message}")
            else:
                errs = check_required(data, schema, f)
                if errs:
                    failed += 1
                    errors_all.extend(errs)

    print(f"検証対象: {total}ファイル")
    if errors_all:
        print(f"NG: {failed}ファイルでエラー")
        for e in errors_all:
            print(f"  - {e}")
        return 1
    else:
        print(f"OK: 全{total}ファイル妥当")
        return 0


if __name__ == "__main__":
    sys.exit(main())
