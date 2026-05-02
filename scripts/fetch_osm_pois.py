"""
OpenStreetMap (Overpass API) から各都道府県の観光資源 POI を取得するスクリプト。

取得対象:
  - 温泉、観光地、博物館、神社、寺、城、史跡、山、滝、岬、海岸 等

ライセンス: OSM データは ODbL (出典: © OpenStreetMap contributors)

実行方法:
    python 地理DB/scripts/fetch_osm_pois.py [--code 01]   # 特定の県だけ
    python 地理DB/scripts/fetch_osm_pois.py                # 47県全部（中断・再開可能）

出力先:
    webapp/public/osm_pois/{01..47}.json
    地理DB/data/osm_pois/{01..47}.json

47県全部だと 30-60 分程度。Overpass API への負荷を避けるため 1 県あたり 3 秒待機。
"""
import argparse
import json
import os
import sys
import io
import time
import urllib.parse
import urllib.request
import urllib.error
import yaml

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEO_DB_DIR = os.path.join(ROOT, "data")
OUT_DIR_DB = os.path.join(GEO_DB_DIR, "osm_pois")
OUT_DIR_WEBAPP = os.path.join(ROOT, "public", "osm_pois")
PREF_DIR = os.path.join(GEO_DB_DIR, "prefectures")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Overpass クエリ: 試験対策で重要な観光資源カテゴリのみ
QUERY_TEMPLATE = """
[out:json][timeout:180];
area["name"="{name}"][admin_level=4]->.pref;
(
  // 温泉
  node["natural"="hot_spring"](area.pref);
  node["amenity"="public_bath"](area.pref);
  // 観光地
  node["tourism"~"^(attraction|viewpoint|museum|theme_park|zoo|aquarium|gallery)$"](area.pref);
  way["tourism"~"^(theme_park|zoo|aquarium|museum)$"](area.pref);
  // 神社・寺
  node["amenity"="place_of_worship"]["religion"~"^(shinto|buddhist)$"](area.pref);
  way["amenity"="place_of_worship"]["religion"~"^(shinto|buddhist)$"](area.pref);
  node["historic"="shinto_shrine"](area.pref);
  // 城・史跡
  node["historic"~"^(castle|archaeological_site|monument|memorial|ruins|fort)$"](area.pref);
  way["historic"~"^(castle|archaeological_site|fort)$"](area.pref);
  // 自然地形
  node["natural"~"^(peak|volcano|cape|beach|cliff|cave_entrance)$"](area.pref);
  node["waterway"="waterfall"](area.pref);
);
out center body;
"""


def classify_poi(tags: dict) -> str:
    """OSM タグから試験対策用カテゴリに分類"""
    natural = tags.get("natural")
    tourism = tags.get("tourism")
    historic = tags.get("historic")
    amenity = tags.get("amenity")
    religion = tags.get("religion")
    waterway = tags.get("waterway")

    if natural == "hot_spring":
        return "onsen"
    if amenity == "public_bath":
        return "onsen"
    if amenity == "place_of_worship":
        if religion == "shinto":
            return "shrine"
        if religion == "buddhist":
            return "temple"
        return "religious"
    if historic == "shinto_shrine":
        return "shrine"
    if historic in ["castle", "fort"]:
        return "castle"
    if historic in ["monument", "memorial"]:
        return "monument"
    if historic in ["archaeological_site", "ruins"]:
        return "ruins"
    if tourism == "museum":
        return "museum"
    if tourism == "viewpoint":
        return "viewpoint"
    if tourism in ["zoo", "aquarium"]:
        return "zoo_aquarium"
    if tourism == "theme_park":
        return "theme_park"
    if tourism == "gallery":
        return "museum"
    if tourism == "attraction":
        return "attraction"
    if natural == "peak":
        return "mountain"
    if natural == "volcano":
        return "volcano"
    if natural == "cape":
        return "cape"
    if natural == "cliff":
        return "cliff"
    if natural == "beach":
        return "beach"
    if natural == "cave_entrance":
        return "cave"
    if waterway == "waterfall":
        return "waterfall"
    return "other"


# 47都道府県コード→名前
PREFECTURES = [
    ("01", "北海道", "hokkaido"),    ("02", "青森県", "aomori"),
    ("03", "岩手県", "iwate"),       ("04", "宮城県", "miyagi"),
    ("05", "秋田県", "akita"),       ("06", "山形県", "yamagata"),
    ("07", "福島県", "fukushima"),   ("08", "茨城県", "ibaraki"),
    ("09", "栃木県", "tochigi"),     ("10", "群馬県", "gunma"),
    ("11", "埼玉県", "saitama"),     ("12", "千葉県", "chiba"),
    ("13", "東京都", "tokyo"),       ("14", "神奈川県", "kanagawa"),
    ("15", "新潟県", "niigata"),     ("16", "富山県", "toyama"),
    ("17", "石川県", "ishikawa"),    ("18", "福井県", "fukui"),
    ("19", "山梨県", "yamanashi"),   ("20", "長野県", "nagano"),
    ("21", "岐阜県", "gifu"),        ("22", "静岡県", "shizuoka"),
    ("23", "愛知県", "aichi"),       ("24", "三重県", "mie"),
    ("25", "滋賀県", "shiga"),       ("26", "京都府", "kyoto"),
    ("27", "大阪府", "osaka"),       ("28", "兵庫県", "hyogo"),
    ("29", "奈良県", "nara"),        ("30", "和歌山県", "wakayama"),
    ("31", "鳥取県", "tottori"),     ("32", "島根県", "shimane"),
    ("33", "岡山県", "okayama"),     ("34", "広島県", "hiroshima"),
    ("35", "山口県", "yamaguchi"),   ("36", "徳島県", "tokushima"),
    ("37", "香川県", "kagawa"),      ("38", "愛媛県", "ehime"),
    ("39", "高知県", "kochi"),       ("40", "福岡県", "fukuoka"),
    ("41", "佐賀県", "saga"),        ("42", "長崎県", "nagasaki"),
    ("43", "熊本県", "kumamoto"),    ("44", "大分県", "oita"),
    ("45", "宮崎県", "miyazaki"),    ("46", "鹿児島県", "kagoshima"),
    ("47", "沖縄県", "okinawa"),
]


def normalize_name(name: str) -> str:
    """名前から括弧書きの補足を除去（例: 「立石寺（山寺、奥の細道...）」→「立石寺」）"""
    for ch in ["（", "(", "「"]:
        if ch in name:
            return name.split(ch)[0].strip()
    return name.strip()


def extract_yaml_names(pref_id: str) -> set:
    """既存YAML から名前リストを抽出（マッチング用）"""
    yaml_path = os.path.join(PREF_DIR, f"{pref_id}.yaml")
    if not os.path.isfile(yaml_path):
        return set()
    with open(yaml_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    names = set()
    for key in ("attractions", "onsen", "festivals", "cuisine",
                "world_heritage", "national_parks", "capes", "islands",
                "lakes", "mountains", "rivers"):
        for item in data.get(key, []) or []:
            n = normalize_name(item)
            if n:
                names.add(n)
    return names


def fetch_overpass(name: str, retries: int = 3) -> dict:
    """Overpass API にクエリを投げて結果を取得"""
    query = QUERY_TEMPLATE.format(name=name)
    # Overpass は data=<query> の form-encoded を期待
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                OVERPASS_URL,
                data=encoded,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "travel-exam-study-app/1.0 (educational use)",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=240) as res:
                return json.loads(res.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            last_err = e
            wait = (attempt + 1) * 10
            print(f"   リトライ {attempt + 1}/{retries} ({wait}秒待機): {e}")
            time.sleep(wait)
    raise RuntimeError(f"Overpass取得失敗: {last_err}")


def normalize_element(el: dict) -> dict | None:
    tags = el.get("tags") or {}
    name = tags.get("name") or tags.get("name:ja")
    if not name:
        return None

    # 座標取得（way/relation の場合は center を使う）
    if el["type"] == "node":
        lat = el.get("lat")
        lng = el.get("lon")
    else:
        center = el.get("center") or {}
        lat = center.get("lat")
        lng = center.get("lon")
    if lat is None or lng is None:
        return None

    category = classify_poi(tags)
    poi = {
        "name": name,
        "lat": round(lat, 5),
        "lng": round(lng, 5),
        "category": category,
        "osm_id": f"{el['type']}/{el['id']}",
    }
    # 試験対策で有用な追加情報
    if "name:en" in tags:
        poi["name_en"] = tags["name:en"]
    if "ele" in tags:
        try:
            poi["elevation"] = int(float(tags["ele"]))
        except ValueError:
            pass
    if "wikipedia" in tags:
        poi["wikipedia"] = tags["wikipedia"]
    if "wikidata" in tags:
        poi["wikidata"] = tags["wikidata"]
    return poi


def process_prefecture(code: str, name: str, pref_id: str, *, force: bool = False) -> dict:
    out_path_db = os.path.join(OUT_DIR_DB, f"{code}.json")
    out_path_webapp = os.path.join(OUT_DIR_WEBAPP, f"{code}.json")

    if os.path.exists(out_path_db) and not force:
        with open(out_path_db, encoding="utf-8") as f:
            existing = json.load(f)
        return {"skipped": True, "count": len(existing.get("pois", []))}

    # OSM から取得
    data = fetch_overpass(name)
    elements = data.get("elements", [])

    pois = []
    for el in elements:
        norm = normalize_element(el)
        if norm:
            pois.append(norm)

    # 重複排除（同じ name + category + 近接座標）
    seen = set()
    deduped = []
    for p in pois:
        key = (p["name"], p["category"], round(p["lat"], 3), round(p["lng"], 3))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(p)
    pois = deduped

    # 既存YAMLとマッチング
    yaml_names = extract_yaml_names(pref_id)
    matched = 0
    for poi in pois:
        poi_normalized = normalize_name(poi["name"])
        for yname in yaml_names:
            if yname in poi_normalized or poi_normalized in yname:
                poi["matches_yaml"] = True
                matched += 1
                break

    # カテゴリ別カウント
    category_count = {}
    for p in pois:
        category_count[p["category"]] = category_count.get(p["category"], 0) + 1

    result = {
        "code": code,
        "name": name,
        "pref_id": pref_id,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "OpenStreetMap (Overpass API), © OpenStreetMap contributors",
        "license": "ODbL 1.0",
        "category_count": category_count,
        "yaml_match_count": matched,
        "pois": pois,
    }

    # 両方のディレクトリに保存（地理DB側がマスター、webapp側が配信用）
    os.makedirs(OUT_DIR_DB, exist_ok=True)
    os.makedirs(OUT_DIR_WEBAPP, exist_ok=True)
    for path in [out_path_db, out_path_webapp]:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    return {"skipped": False, "count": len(pois), "matched": matched, "categories": category_count}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", help="特定の都道府県コード（例: 01）のみ取得")
    parser.add_argument("--force", action="store_true", help="既存ファイルがあっても再取得")
    parser.add_argument("--sleep", type=float, default=3.0, help="県間の待機秒数")
    args = parser.parse_args()

    targets = PREFECTURES
    if args.code:
        targets = [t for t in PREFECTURES if t[0] == args.code]
        if not targets:
            print(f"未知の都道府県コード: {args.code}")
            return 1

    total_pois = 0
    for i, (code, name, pref_id) in enumerate(targets, 1):
        print(f"[{i}/{len(targets)}] {code} {name} ({pref_id})")
        try:
            r = process_prefecture(code, name, pref_id, force=args.force)
            if r["skipped"]:
                print(f"   スキップ（既存 {r['count']}件）")
            else:
                cats = r["categories"]
                cat_str = ", ".join(f"{k}:{v}" for k, v in sorted(cats.items(), key=lambda x: -x[1])[:5])
                print(f"   取得 {r['count']}件 (YAMLマッチ {r['matched']}件)")
                print(f"   主要カテゴリ: {cat_str}")
            total_pois += r["count"]
        except Exception as e:
            print(f"   エラー: {e}")

        if i < len(targets):
            time.sleep(args.sleep)

    print(f"\n完了: 総POI数 {total_pois}")


if __name__ == "__main__":
    sys.exit(main() or 0)
