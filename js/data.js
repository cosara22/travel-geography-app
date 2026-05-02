// 地理DBの統合JSONをロードする共通モジュール
// public/data.json は 地理DB/scripts/export_json.py で生成される

let _cachedData = null;

async function loadGeoData() {
  if (_cachedData) return _cachedData;
  // file:// プロトコルでも動作するよう、パスを相対指定
  const res = await fetch("public/data.json");
  if (!res.ok) {
    throw new Error(`データロード失敗: ${res.status} ${res.statusText}`);
  }
  _cachedData = await res.json();
  return _cachedData;
}

// 配列をシャッフル（Fisher-Yates）
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 配列からランダムにN件取得
function sample(arr, n) {
  return shuffle(arr).slice(0, n);
}

// 画像メタデータ（カテゴリ別、Wikimedia Commons から取得）
// 取得スクリプト: 地理DB/scripts/fetch_wikimedia_images.py
const _imageCache = {};
async function loadImageIndex(category) {
  if (_imageCache[category] !== undefined) return _imageCache[category];
  try {
    const res = await fetch(`public/images/${category}.json`);
    _imageCache[category] = res.ok ? await res.json() : {};
  } catch {
    _imageCache[category] = {};
  }
  return _imageCache[category];
}

// localStorage で学習スコアを管理
const ScoreStore = {
  KEY: "travel-exam-scores",
  load() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY) || "{}");
    } catch {
      return {};
    }
  },
  save(scores) {
    localStorage.setItem(this.KEY, JSON.stringify(scores));
  },
  record(mode, correct) {
    const scores = this.load();
    if (!scores[mode]) scores[mode] = { correct: 0, total: 0 };
    scores[mode].total += 1;
    if (correct) scores[mode].correct += 1;
    this.save(scores);
  },
  reset() {
    localStorage.removeItem(this.KEY);
  },
};
