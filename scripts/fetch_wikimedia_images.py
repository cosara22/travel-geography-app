"""
Wikidata + Wikimedia Commons から data.json の各エントリの画像メタデータを取得する。

処理フロー:
  1. webapp/public/data.json を読み込む
  2. 対象カテゴリの各 name を Wikipedia ja API で Q-ID 解決
  3. Wikidata SPARQL で Q-ID → P18 (image) のファイル名を一括取得
  4. Commons API で thumb_url / license / author を取得
  5. webapp/public/images/{category}.json に書き出し

実行方法:
    python 地理DB/scripts/fetch_wikimedia_images.py --category world_heritage
    python 地理DB/scripts/fetch_wikimedia_images.py --category national_parks
    python 地理DB/scripts/fetch_wikimedia_images.py --category all
    python 地理DB/scripts/fetch_wikimedia_images.py --category world_heritage --force

出力先:
    webapp/public/images/{category}.json
    webapp/public/images/index.json     ← 目次

ライセンス: 取得した画像は各々のライセンス (CC BY-SA 4.0 等) に従って利用すること。
出典: Wikimedia Commons / Wikidata (CC0)
"""
import argparse
import datetime
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_JSON_PATH = os.path.join(ROOT, "public", "data.json")
OUT_DIR = os.path.join(ROOT, "public", "images")
INDEX_JSON = os.path.join(OUT_DIR, "index.json")

USER_AGENT = "NipponGeoQuest/1.0 (https://github.com/cosara22/travel-geography-app; portfolio)"

WIKIPEDIA_API = "https://ja.wikipedia.org/w/api.php"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

VALID_CATEGORIES = (
    "world_heritage", "national_parks", "onsen", "festivals", "cuisine",
    "attractions", "mountains", "islands", "lakes", "capes", "rivers",
    "stations", "airports", "jr_lines",
)

# prefectures.<field> から集約する疑似カテゴリ（attractions と同じパターン）
PREFECTURE_FIELD_CATEGORIES = (
    "attractions", "mountains", "islands", "lakes", "capes", "rivers",
    "stations", "airports", "jr_lines",
)

THUMB_WIDTH = 400


def http_get_json(url: str, max_retry: int = 4) -> dict:
    """指数バックオフ付きHTTP GET (JSON)."""
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    })
    for attempt in range(max_retry):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < max_retry - 1:
                wait = 2 ** attempt
                print(f"  HTTP {e.code} → {wait}s 待機してリトライ", flush=True)
                time.sleep(wait)
                continue
            raise
        except urllib.error.URLError as e:
            if attempt < max_retry - 1:
                wait = 2 ** attempt
                print(f"  URLError {e.reason} → {wait}s 待機してリトライ", flush=True)
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"max retry exceeded: {url}")


# ===== Step 1: Q-ID 解決 (Wikipedia ja API) =====

# カテゴリ別の曖昧性回避サフィックス（"○○" → "○○ (温泉)" 等）
_DISAMBIG_SUFFIX = {
    "world_heritage": [" (世界遺産)"],
    "national_parks": [" (国立公園)"],
    "onsen":          [" (温泉)"],
    "festivals":      [" (祭)", " (祭り)"],
    "cuisine":        [" (料理)"],
    "mountains":      [" (山)"],
    "islands":        [" (島)"],
    "lakes":          [" (湖)"],
    "rivers":         [" (川)"],
    "stations":       [" (駅)", "駅"],
    "airports":       [" (空港)", "空港"],
    "jr_lines":       [" (鉄道)", "線"],
}

# 名前を簡略化するための区切り文字
_PAREN_CHARS = ("（", "(", "〈", "［", "[")
_HYPHEN_CHARS = ("-", "―", "‐", "－", "—")


def simplify_name(name: str, category: str = "") -> list:
    """元の名前から検索候補を派生させる。元の名前自体は含めない。

    例:
      '西大寺会陽（はだか祭り）' → ['西大寺会陽']
      '平泉-仏国土（浄土）を表す...' → ['平泉-仏国土', '平泉']
      '知床' (category=world_heritage) → ['知床 (世界遺産)']
    """
    candidates = []
    seen = {name}

    def add(s: str):
        s = s.strip()
        if s and len(s) >= 2 and s not in seen:
            candidates.append(s)
            seen.add(s)

    # 1. カッコ以降を除去
    base = name
    for paren in _PAREN_CHARS:
        if paren in base:
            base = base.split(paren)[0].strip()
            add(base)
            break

    # 2. ハイフン以降を除去（最初のセグメントを採用）
    for hyphen in _HYPHEN_CHARS:
        if hyphen in base:
            short = base.split(hyphen)[0].strip()
            add(short)
            base = short
            break

    # 3. カテゴリ別サフィックス（曖昧性回避用）
    for suf in _DISAMBIG_SUFFIX.get(category, []):
        add(base + suf)

    return candidates


def _resolve_qids_batch(names: list) -> dict:
    """1ラウンドのQ-ID解決（フォールバックなし）。50件ずつバッチ。"""
    result = {}
    for i in range(0, len(names), 50):
        batch = names[i:i + 50]
        params = {
            "action": "query",
            "format": "json",
            "prop": "pageprops",
            "ppprop": "wikibase_item",
            "redirects": "1",
            "titles": "|".join(batch),
            "maxlag": "5",
        }
        url = WIKIPEDIA_API + "?" + urllib.parse.urlencode(params)
        data = http_get_json(url)
        redirects = {r["from"]: r["to"] for r in data.get("query", {}).get("redirects", [])}
        normalized = {n["from"]: n["to"] for n in data.get("query", {}).get("normalized", [])}
        title_to_qid = {}
        for page in data.get("query", {}).get("pages", {}).values():
            title = page.get("title")
            qid = page.get("pageprops", {}).get("wikibase_item")
            if title and qid:
                title_to_qid[title] = qid
        for original in batch:
            t = normalized.get(original, original)
            t = redirects.get(t, t)
            if t in title_to_qid:
                result[original] = title_to_qid[t]
        time.sleep(0.5)
    return result


def resolve_qids(names: list, category: str = "") -> dict:
    """記事タイトル(日本語) → Q-ID の辞書。失敗時はsimplify_nameでフォールバック。"""
    # ラウンド1: 元の名前
    result = _resolve_qids_batch(names)

    failed = [n for n in names if n not in result]
    if not failed:
        return result

    # ラウンド2: 派生候補で再試行（候補→元の名前 の対応を保持）
    cand_to_original = {}
    for original in failed:
        for cand in simplify_name(original, category):
            # 同じ候補が複数の元名に対応する可能性は低いが、最初を優先
            cand_to_original.setdefault(cand, original)

    if cand_to_original:
        print(f"  フォールバック試行: {len(failed)} 件 → {len(cand_to_original)} 候補", flush=True)
        cand_results = _resolve_qids_batch(list(cand_to_original.keys()))
        for cand, qid in cand_results.items():
            original = cand_to_original[cand]
            if original not in result:
                result[original] = qid
                print(f"    解決: '{original}' → '{cand}' = {qid}", flush=True)

    return result


# ===== Step 2: SPARQL で P18 (image) を取得 =====

def fetch_images(qids: list) -> dict:
    """Q-ID 配列 → {qid: commons_filename} を返す。100件ずつバッチ。"""
    result = {}
    for i in range(0, len(qids), 100):
        batch = qids[i:i + 100]
        values = " ".join(f"wd:{q}" for q in batch)
        sparql = f"""
        SELECT ?item ?image WHERE {{
          VALUES ?item {{ {values} }}
          ?item wdt:P18 ?image.
        }}
        """
        params = {"query": sparql, "format": "json"}
        url = WIKIDATA_SPARQL + "?" + urllib.parse.urlencode(params)
        data = http_get_json(url)
        for binding in data.get("results", {}).get("bindings", []):
            qid = binding["item"]["value"].rsplit("/", 1)[-1]
            image_url = binding["image"]["value"]
            # 例: http://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg
            filename = urllib.parse.unquote(image_url.rsplit("/", 1)[-1])
            # 同じQIDに複数画像がある場合は最初のもの優先（SPARQL上の順序は不定だが、ここでは1枚で十分）
            if qid not in result:
                result[qid] = filename
        time.sleep(1.0)  # SPARQL は 1 req/sec
    return result


# ===== Step 2.5: Wikipedia pageimages フォールバック (B案) =====
# Q-IDはあるが P18 (image) が未設定のものに対し、Wikipedia記事のリード画像を取得。
# 商用利用安全のため、画像が Commons hosted (/wikipedia/commons/) のものに限定し、
# ja.wikipedia.org の Fair Use ローカルアップロードは除外する。

_COMMONS_URL_RE = re.compile(r"^https?://upload\.wikimedia\.org/wikipedia/commons/")


def fetch_pageimages_fallback(names: list) -> dict:
    """記事タイトル配列 → {original_name: filename} を返す。
    Commons hosted のもののみ。ja-Wikipedia ローカルアップロードは除外。"""
    result = {}
    for i in range(0, len(names), 50):
        batch = names[i:i + 50]
        params = {
            "action": "query",
            "format": "json",
            "prop": "pageimages",
            "piprop": "original",
            "redirects": "1",
            "titles": "|".join(batch),
            "maxlag": "5",
        }
        url = WIKIPEDIA_API + "?" + urllib.parse.urlencode(params)
        data = http_get_json(url)
        redirects = {r["from"]: r["to"] for r in data.get("query", {}).get("redirects", [])}
        normalized = {n["from"]: n["to"] for n in data.get("query", {}).get("normalized", [])}

        # title → (filename, source_url) を構築
        title_to_image = {}
        for page in data.get("query", {}).get("pages", {}).values():
            title = page.get("title")
            original = page.get("original") or {}
            source = original.get("source", "")
            if not title or not source:
                continue
            # 商用安全フィルタ: Commons hosted 限定
            if not _COMMONS_URL_RE.match(source):
                continue
            # pageimage フィールドからファイル名取得（拡張子付き）
            filename = page.get("pageimage")
            if filename:
                title_to_image[title] = filename

        # 元の名前と紐付け（リダイレクト・正規化を吸収）
        for original in batch:
            t = normalized.get(original, original)
            t = redirects.get(t, t)
            if t in title_to_image:
                result[original] = title_to_image[t]
        time.sleep(0.5)
    return result


# ===== Step 3: Commons から thumb_url / license / author 取得 =====

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_PD_SELF_RE = re.compile(r"I,\s*the copyright holder of this work", re.IGNORECASE)
_AUTHOR_MAX_LEN = 60


def clean_author(text: str) -> str:
    """Artist フィールドからHTML除去＋PD-selfテンプレ等の長文を整形。"""
    if not text:
        return "Unknown"
    text = _HTML_TAG_RE.sub("", text)
    text = _WHITESPACE_RE.sub(" ", text).strip()
    # PD-self テンプレの本文が混入しているケース → 著者名は不明として扱う
    if _PD_SELF_RE.search(text):
        return "Anonymous (Public domain)"
    # 「Public domainPublic domain...」のような重複テンプレ語を先頭から除去
    for noise in ("Public domainPublic domain", "Public domain", "CC0CC0", "false"):
        if text.startswith(noise):
            text = text[len(noise):].strip()
    # 過剰に長い場合は省略
    if len(text) > _AUTHOR_MAX_LEN:
        text = text[:_AUTHOR_MAX_LEN].rstrip() + "…"
    return text or "Unknown"


def fetch_commons_meta(filenames: list) -> dict:
    """Commons ファイル名配列 → {filename: meta} を返す。50件ずつバッチ。"""
    result = {}
    for i in range(0, len(filenames), 50):
        batch = filenames[i:i + 50]
        titles = "|".join(f"File:{name}" for name in batch)
        params = {
            "action": "query",
            "format": "json",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": str(THUMB_WIDTH),
            "titles": titles,
            "maxlag": "5",
        }
        url = COMMONS_API + "?" + urllib.parse.urlencode(params)
        data = http_get_json(url)
        for page in data.get("query", {}).get("pages", {}).values():
            title = page.get("title", "")
            if not title.startswith("File:"):
                continue
            filename = title[len("File:"):]
            iinfo_list = page.get("imageinfo", [])
            if not iinfo_list:
                continue
            iinfo = iinfo_list[0]
            ext = iinfo.get("extmetadata", {})
            result[filename] = {
                "thumb_url":   iinfo.get("thumburl") or iinfo.get("url"),
                "page_url":    iinfo.get("descriptionurl"),
                "license":     ext.get("LicenseShortName", {}).get("value", "Unknown"),
                "license_url": ext.get("LicenseUrl", {}).get("value", ""),
                "author":      clean_author(ext.get("Artist", {}).get("value", "")),
            }
        time.sleep(0.5)
    return result


# ===== カテゴリ単位の処理 =====

def collect_prefecture_field(data: dict, field: str) -> dict:
    """全都道府県の prefectures.<field> (string配列) を集約。
    { name: {name, prefecture} } を返す。名前が ID 代わり。"""
    result = {}
    for pref in data.get("prefectures", {}).values():
        for name in pref.get(field) or []:
            if name and name not in result:
                result[name] = {"name": name, "prefecture": pref.get("name")}
    return result


def process_category(category: str, data: dict, force: bool = False) -> dict:
    """1カテゴリを処理して metadata 辞書を返す。"""
    # prefectures.<field> から集約する疑似カテゴリ（attractions, mountains 等）
    if category in PREFECTURE_FIELD_CATEGORIES:
        items = collect_prefecture_field(data, category)
    elif category not in data:
        print(f"[{category}] data.json に存在しません", flush=True)
        return {}
    else:
        items = data[category]
    out_path = os.path.join(OUT_DIR, f"{category}.json")
    existing = {}
    if not force and os.path.isfile(out_path):
        with open(out_path, encoding="utf-8") as fp:
            existing = json.load(fp)

    # name → id の対応を作る
    todo = {}  # {name: id}
    for item_id, item in items.items():
        if not force and item_id in existing:
            continue
        name = item.get("name")
        if name:
            todo[name] = item_id

    if not todo:
        print(f"[{category}] 全 {len(items)} 件は既に取得済み（--force で再取得）", flush=True)
        return existing

    print(f"[{category}] {len(todo)} 件を取得します…", flush=True)

    # Step 1: Q-ID 解決（失敗時は simplify_name で再試行）
    name_to_qid = resolve_qids(list(todo.keys()), category=category)
    print(f"[{category}] Q-ID解決: {len(name_to_qid)}/{len(todo)}", flush=True)

    # Step 2: 画像ファイル名取得（SPARQL の P18）
    qids = list(set(name_to_qid.values()))
    qid_to_file = fetch_images(qids)
    print(f"[{category}] P18画像取得: {len(qid_to_file)}/{len(qids)}", flush=True)

    # Step 2.5: P18 が無い項目について Wikipedia pageimages フォールバック (B案)
    # Q-IDは取れたが画像URLが取れなかった名前を抽出
    name_to_filename = {}
    for name in todo:
        qid = name_to_qid.get(name)
        if qid and qid in qid_to_file:
            name_to_filename[name] = qid_to_file[qid]
    pageimg_targets = [n for n in todo if n not in name_to_filename and n in name_to_qid]
    if pageimg_targets:
        print(f"[{category}] pageimages フォールバック試行: {len(pageimg_targets)} 件", flush=True)
        page_filenames = fetch_pageimages_fallback(pageimg_targets)
        for name, fn in page_filenames.items():
            name_to_filename[name] = fn
        print(f"[{category}] pageimages 補完: +{len(page_filenames)} 件", flush=True)

    # Step 3: Commons メタ取得
    files = list(set(name_to_filename.values()))
    file_to_meta = fetch_commons_meta(files)
    print(f"[{category}] license取得: {len(file_to_meta)}/{len(files)}", flush=True)

    # 統合（P18 と pageimages 両方を考慮）
    today = datetime.date.today().isoformat()
    new_entries = {}
    for name, item_id in todo.items():
        qid = name_to_qid.get(name)
        filename = name_to_filename.get(name)
        if not filename:
            continue
        meta = file_to_meta.get(filename)
        if not meta or not meta.get("thumb_url"):
            continue
        new_entries[item_id] = {
            "qid":         qid or "",
            "thumb_url":   meta["thumb_url"],
            "page_url":    meta["page_url"],
            "license":     meta["license"],
            "license_url": meta["license_url"],
            "author":      meta["author"],
            "fetched_at":  today,
        }

    # 既存とマージ
    merged = {**existing, **new_entries}
    print(f"[{category}] 新規 {len(new_entries)} 件 + 既存 {len(existing)} 件 = 合計 {len(merged)} 件", flush=True)

    # 失敗ログ
    failed = [name for name in todo if todo[name] not in new_entries and todo[name] not in existing]
    if failed:
        print(f"[{category}] 失敗: {len(failed)} 件 ({', '.join(failed[:5])}{'…' if len(failed) > 5 else ''})", flush=True)

    return merged


def write_index(updated_categories: dict) -> None:
    """index.json を更新（既存とマージ）。"""
    existing = {}
    if os.path.isfile(INDEX_JSON):
        with open(INDEX_JSON, encoding="utf-8") as fp:
            existing = json.load(fp)
    today = datetime.date.today().isoformat()
    for cat, entries in updated_categories.items():
        existing[cat] = {
            "file": f"{cat}.json",
            "count": len(entries),
            "updated": today,
        }
    with open(INDEX_JSON, "w", encoding="utf-8") as fp:
        json.dump(existing, fp, ensure_ascii=False, indent=2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--category", required=True,
                        choices=list(VALID_CATEGORIES) + ["all"],
                        help="取得対象のカテゴリ")
    parser.add_argument("--force", action="store_true",
                        help="既存エントリも再取得")
    args = parser.parse_args()

    if not os.path.isfile(DATA_JSON_PATH):
        print(f"data.json が見つかりません: {DATA_JSON_PATH}", file=sys.stderr)
        return 1

    with open(DATA_JSON_PATH, encoding="utf-8") as fp:
        data = json.load(fp)

    os.makedirs(OUT_DIR, exist_ok=True)

    targets = list(VALID_CATEGORIES) if args.category == "all" else [args.category]
    updated = {}
    for cat in targets:
        result = process_category(cat, data, force=args.force)
        if result:
            out_path = os.path.join(OUT_DIR, f"{cat}.json")
            with open(out_path, "w", encoding="utf-8") as fp:
                json.dump(result, fp, ensure_ascii=False, indent=2)
            print(f"[{cat}] 出力: {out_path}", flush=True)
            updated[cat] = result

    if updated:
        write_index(updated)
        print(f"目次更新: {INDEX_JSON}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
