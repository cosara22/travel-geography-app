"""
全国47都道府県の市区町村境界GeoJSONをダウンロード・軽量化するスクリプト。

データソース: smartnews-smri/japan-topography
  https://github.com/smartnews-smri/japan-topography
  ライセンス: 商用利用可（出典: 国土交通省 国土数値情報）

実行方法:
    python 地理DB/scripts/download_municipalities.py

出力先: webapp/public/municipalities/{01..47}.json
"""
import json
import os
import sys
import io
import time
import urllib.request

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "municipalities")
os.makedirs(OUT_DIR, exist_ok=True)

BASE_URL = (
    "https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/"
    "data/municipality/geojson/s0010/N03-21_{:02d}_210101.json"
)


def round_ring(ring, precision=3):
    """座標を3桁に丸めて連続する重複を除去"""
    rounded = [[round(c[0], precision), round(c[1], precision)] for c in ring]
    cleaned = [rounded[0]]
    for c in rounded[1:]:
        if c != cleaned[-1]:
            cleaned.append(c)
    return cleaned if len(cleaned) >= 4 else None


def simplify(geom):
    if geom["type"] == "Polygon":
        rings = [r for r in (round_ring(ring) for ring in geom["coordinates"]) if r]
        return {"type": "Polygon", "coordinates": rings} if rings else None
    elif geom["type"] == "MultiPolygon":
        polys = []
        for poly in geom["coordinates"]:
            rings = [r for r in (round_ring(ring) for ring in poly) if r]
            if rings:
                polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    return geom


def main():
    total_size = 0
    total_features = 0
    for code in range(1, 48):
        url = BASE_URL.format(code)
        print(f"  [{code:02d}] ダウンロード中...", end="", flush=True)

        with urllib.request.urlopen(url) as res:
            raw_size = int(res.headers.get("content-length", 0))
            data = json.loads(res.read().decode("utf-8"))

        # 各featureのgeometryを軽量化
        new_features = []
        for feat in data["features"]:
            g = simplify(feat["geometry"])
            if g:
                feat["geometry"] = g
                new_features.append(feat)
        data["features"] = new_features

        out = os.path.join(OUT_DIR, f"{code:02d}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

        new_size = os.path.getsize(out)
        total_size += new_size
        total_features += len(new_features)
        compression = (1 - new_size / raw_size) * 100 if raw_size > 0 else 0
        print(f" 元 {raw_size//1024}KB → 圧縮後 {new_size//1024}KB"
              f" ({len(new_features)}市区町村, -{compression:.0f}%)")

        time.sleep(0.2)  # GitHubへの負荷を抑制

    print()
    print(f"完了: 47ファイル, 合計 {total_size//1024}KB ({total_size/1024/1024:.1f}MB)")
    print(f"市区町村合計: {total_features}件")


if __name__ == "__main__":
    sys.exit(main() or 0)
