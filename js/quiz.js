// 問題演習ロジック
// 文字ベース7モード + 写真ベース5モード

let GEO = null;
let IMAGES = {}; // {category: {id: imgInfo}} — 写真モードで使用
let ATTRACTION_TO_PREF = {}; // 観光地名 → 都道府県名（写真モード用）
let currentQuestion = null;
let currentMode = null;

// 写真モードで使うため、各カテゴリの画像インデックスを並列ロードする
async function loadImagesForQuiz() {
  const cats = ["world_heritage", "national_parks", "onsen", "festivals", "cuisine", "attractions"];
  const results = await Promise.all(cats.map(c => loadImageIndex(c)));
  cats.forEach((c, i) => { IMAGES[c] = results[i]; });
}

// 観光地名 → 都道府県名 のマップ（attractions JSONには県情報がないため data から構築）
function buildAttractionToPrefMap(data) {
  const map = {};
  for (const pref of Object.values(data.prefectures)) {
    for (const name of (pref.attractions || [])) {
      if (!map[name]) map[name] = pref.name;
    }
  }
  return map;
}

// 画像インデックスからランダムに [id, imgInfo] を返す
function pickRandomImageEntry(category) {
  const entries = Object.entries(IMAGES[category] || {});
  if (entries.length === 0) return null;
  return entries[Math.floor(Math.random() * entries.length)];
}

// id → name の解決（カテゴリによってキーの意味が違う）
// world_heritage/national_parks/onsen/festivals/cuisine は id がキー → GEO[cat][id].name
// attractions は名前そのものがキー
function imageEntryToName(category, id) {
  if (category === "attractions") return id;
  return GEO[category]?.[id]?.name || id;
}

const MODES = {
  pref_attractions: {
    label: "都道府県 → 観光地",
    icon: "🏯",
    description: "都道府県名から代表的な観光地を当てる",
    generate: (data) => {
      const prefs = Object.values(data.prefectures).filter(p => p.attractions && p.attractions.length > 0);
      const target = prefs[Math.floor(Math.random() * prefs.length)];
      const correct = target.attractions[Math.floor(Math.random() * target.attractions.length)];
      // 他の都道府県の観光地から3つ選んで誤答に
      const otherAttractions = prefs
        .filter(p => p.id !== target.id)
        .flatMap(p => p.attractions)
        .filter(a => a !== correct);
      const wrongs = sample(otherAttractions, 3);
      return {
        question: `「${target.name}」にある観光地はどれか？`,
        choices: shuffle([correct, ...wrongs]),
        answer: correct,
        hint: target.region || "",
      };
    },
  },

  attraction_to_pref: {
    label: "観光地 → 都道府県",
    icon: "🗾",
    description: "観光地名から所在の都道府県を当てる",
    generate: (data) => {
      const prefs = Object.values(data.prefectures).filter(p => p.attractions && p.attractions.length > 0);
      const target = prefs[Math.floor(Math.random() * prefs.length)];
      const attraction = target.attractions[Math.floor(Math.random() * target.attractions.length)];
      const others = prefs.filter(p => p.id !== target.id);
      const wrongs = sample(others, 3).map(p => p.name);
      return {
        question: `「${attraction}」がある都道府県はどれか？`,
        choices: shuffle([target.name, ...wrongs]),
        answer: target.name,
        hint: target.region || "",
      };
    },
  },

  onsen_to_pref: {
    label: "温泉 → 都道府県",
    icon: "♨️",
    description: "温泉名から所在の都道府県を当てる",
    generate: (data) => {
      const onsenList = Object.values(data.onsen);
      const target = onsenList[Math.floor(Math.random() * onsenList.length)];
      const others = Object.values(data.prefectures).filter(p => p.name !== target.prefecture);
      const wrongs = sample(others, 3).map(p => p.name);
      return {
        question: `「${target.name}」がある都道府県はどれか？`,
        choices: shuffle([target.prefecture, ...wrongs]),
        answer: target.prefecture,
        hint: target.tags ? `タグ: ${target.tags.join(", ")}` : "",
      };
    },
  },

  world_heritage: {
    label: "世界遺産の所在",
    icon: "🌍",
    description: "世界遺産名からその所在地（県）を当てる",
    generate: (data) => {
      const heritageList = Object.values(data.world_heritage);
      const target = heritageList[Math.floor(Math.random() * heritageList.length)];
      const correct = target.prefectures.join("・");
      const others = Object.values(data.prefectures).filter(p => !target.prefectures.includes(p.name));
      const wrongs = sample(others, 3).map(p => p.name);
      return {
        question: `世界遺産「${target.name}」の所在県は？`,
        choices: shuffle([correct, ...wrongs]),
        answer: correct,
        hint: `登録年: ${target.year} / 種別: ${target.type === "natural" ? "自然遺産" : "文化遺産"}`,
      };
    },
  },

  national_park: {
    label: "国立公園 → 都道府県",
    icon: "🏔️",
    description: "国立公園名からまたがる都道府県を当てる",
    generate: (data) => {
      const parkList = Object.values(data.national_parks);
      const target = parkList[Math.floor(Math.random() * parkList.length)];
      const correct = target.prefectures.join("・");
      const others = Object.values(data.prefectures).filter(p => !target.prefectures.includes(p.name));
      const wrongs = sample(others, 3).map(p => p.name);
      return {
        question: `「${target.name}」を擁する都道府県は？`,
        choices: shuffle([correct, ...wrongs]),
        answer: correct,
        hint: target.prefectures ? target.prefectures.join("・") : "",
      };
    },
  },

  cuisine_to_pref: {
    label: "郷土料理・特産品 → 都道府県",
    icon: "🍜",
    description: "郷土料理や特産品から所在の都道府県を当てる",
    generate: (data) => {
      const list = Object.values(data.cuisine);
      const target = list[Math.floor(Math.random() * list.length)];
      const others = Object.values(data.prefectures).filter(p => p.name !== target.prefecture);
      const wrongs = sample(others, 3).map(p => p.name);
      return {
        question: `「${target.name}」の発祥／産地はどこか？`,
        choices: shuffle([target.prefecture, ...wrongs]),
        answer: target.prefecture,
        hint: target.tags ? target.tags.join(", ") : "",
      };
    },
  },

  airport_code: {
    label: "空港 → 3文字コード",
    icon: "✈️",
    description: "空港名から3文字コードを当てる",
    generate: (data) => {
      const airports = Object.values(data.transport).filter(t => t.type === "airport" && t.code);
      const target = airports[Math.floor(Math.random() * airports.length)];
      const others = airports.filter(a => a.code !== target.code);
      const wrongs = sample(others, 3).map(a => a.code);
      return {
        question: `「${target.name}」の3文字コードは？`,
        choices: shuffle([target.code, ...wrongs]),
        answer: target.code,
        hint: target.prefectures ? target.prefectures.join("・") : "",
      };
    },
  },

  // ===== 写真モード =====

  photo_attraction: {
    label: "📸 写真 → 観光地名",
    icon: "📸",
    description: "写真を見て観光地の名前を当てる",
    requiresImages: ["attractions"],
    generate: (data) => {
      const entry = pickRandomImageEntry("attractions");
      if (!entry) return null;
      const [name, img] = entry;
      const allNames = Object.keys(IMAGES.attractions);
      const wrongs = sample(allNames.filter(n => n !== name), 3);
      return {
        question: "この観光地は？",
        image: img,
        choices: shuffle([name, ...wrongs]),
        answer: name,
        hint: ATTRACTION_TO_PREF[name] || "",
      };
    },
  },

  photo_attraction_to_pref: {
    label: "📸 写真 → 所在県（観光地）",
    icon: "🗾",
    description: "観光地の写真を見て所在の都道府県を当てる",
    requiresImages: ["attractions"],
    generate: (data) => {
      const entry = pickRandomImageEntry("attractions");
      if (!entry) return null;
      const [name, img] = entry;
      const correctPref = ATTRACTION_TO_PREF[name];
      if (!correctPref) return null;
      const others = Object.values(data.prefectures).filter(p => p.name !== correctPref);
      const wrongs = sample(others, 3).map(p => p.name);
      return {
        question: `この観光地はどの都道府県？`,
        image: img,
        choices: shuffle([correctPref, ...wrongs]),
        answer: correctPref,
        hint: name,
      };
    },
  },

  photo_world_heritage: {
    label: "📸 写真 → 世界遺産名",
    icon: "🌍",
    description: "世界遺産の写真を見て名前を当てる",
    requiresImages: ["world_heritage"],
    generate: (data) => {
      const entry = pickRandomImageEntry("world_heritage");
      if (!entry) return null;
      const [id, img] = entry;
      const correctName = imageEntryToName("world_heritage", id);
      const allItems = Object.values(data.world_heritage);
      const others = allItems.filter(h => h.name !== correctName);
      const wrongs = sample(others, 3).map(h => h.name);
      return {
        question: "この世界遺産は？",
        image: img,
        choices: shuffle([correctName, ...wrongs]),
        answer: correctName,
        hint: data.world_heritage[id]?.prefectures?.join("・") || "",
      };
    },
  },

  photo_onsen: {
    label: "📸 写真 → 温泉名",
    icon: "♨️",
    description: "温泉の写真を見て名前を当てる",
    requiresImages: ["onsen"],
    generate: (data) => {
      const entry = pickRandomImageEntry("onsen");
      if (!entry) return null;
      const [id, img] = entry;
      const correctName = imageEntryToName("onsen", id);
      const allItems = Object.values(data.onsen);
      const others = allItems.filter(o => o.name !== correctName);
      const wrongs = sample(others, 3).map(o => o.name);
      return {
        question: "この温泉は？",
        image: img,
        choices: shuffle([correctName, ...wrongs]),
        answer: correctName,
        hint: data.onsen[id]?.prefecture || "",
      };
    },
  },

  photo_cuisine: {
    label: "📸 写真 → 郷土料理名",
    icon: "🍜",
    description: "郷土料理・特産品の写真を見て名前を当てる",
    requiresImages: ["cuisine"],
    generate: (data) => {
      const entry = pickRandomImageEntry("cuisine");
      if (!entry) return null;
      const [id, img] = entry;
      const correctName = imageEntryToName("cuisine", id);
      const allItems = Object.values(data.cuisine);
      const others = allItems.filter(c => c.name !== correctName);
      const wrongs = sample(others, 3).map(c => c.name);
      return {
        question: "この料理・特産は？",
        image: img,
        choices: shuffle([correctName, ...wrongs]),
        answer: correctName,
        hint: data.cuisine[id]?.prefecture || "",
      };
    },
  },
};

function showModes() {
  const container = document.getElementById("mode-list");
  container.innerHTML = Object.entries(MODES).map(([key, m]) => `
    <button data-mode="${key}" class="mode-btn block w-full text-left bg-white rounded-lg shadow hover:shadow-lg p-5 border-l-4 border-blue-500 transition-shadow">
      <div class="flex items-center gap-3">
        <span class="text-3xl">${m.icon}</span>
        <div class="flex-1">
          <div class="font-bold text-slate-800">${m.label}</div>
          <div class="text-xs text-slate-500 mt-1">${m.description}</div>
        </div>
        <span class="text-blue-500">▶</span>
      </div>
    </button>
  `).join("");
  container.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => startQuiz(btn.dataset.mode));
  });
}

function startQuiz(mode) {
  currentMode = mode;
  document.getElementById("mode-screen").classList.add("hidden");
  document.getElementById("quiz-screen").classList.remove("hidden");
  document.getElementById("quiz-mode-label").textContent = MODES[mode].icon + " " + MODES[mode].label;
  nextQuestion();
}

function nextQuestion() {
  // 写真モードで画像が未ロード等で生成失敗した場合、最大10回リトライ
  let q = null;
  for (let i = 0; i < 10 && !q; i++) {
    q = MODES[currentMode].generate(GEO);
  }
  if (!q) {
    document.getElementById("question-text").textContent = "出題データを準備できませんでした。モードを変えてください。";
    document.getElementById("choices").innerHTML = "";
    return;
  }
  currentQuestion = q;
  renderQuestion();
}

function renderQuestion() {
  const q = currentQuestion;

  // 写真モード: 質問の上に画像を表示する
  const photoEl = document.getElementById("question-photo");
  if (q.image) {
    photoEl.innerHTML = `
      <a href="${q.image.page_url}" target="_blank" rel="noopener" class="block">
        <img src="${q.image.thumb_url}" alt="出題画像" loading="lazy"
             class="w-full max-h-72 object-contain rounded mb-2 bg-slate-100"
             onerror="this.style.display='none'">
      </a>
      <p class="text-[10px] text-slate-400 text-right">📷 ${q.image.author} /
        <a href="${q.image.license_url}" target="_blank" rel="noopener" class="hover:underline">${q.image.license}</a>
      </p>`;
    photoEl.classList.remove("hidden");
  } else {
    photoEl.innerHTML = "";
    photoEl.classList.add("hidden");
  }

  document.getElementById("question-text").textContent = q.question;
  document.getElementById("hint-text").textContent = "";  // 正解時に表示するためここでは空
  const choicesEl = document.getElementById("choices");
  choicesEl.innerHTML = q.choices.map((c, i) => `
    <button data-choice="${c}" class="choice-btn block w-full text-left bg-white rounded shadow hover:bg-blue-50 px-4 py-3 border-2 border-slate-200 transition">
      <span class="inline-block w-6 h-6 mr-3 rounded-full bg-blue-100 text-blue-700 text-center font-bold leading-6">${"ABCD"[i]}</span>
      <span class="text-slate-800">${c}</span>
    </button>
  `).join("");
  choicesEl.querySelectorAll(".choice-btn").forEach(btn => {
    btn.addEventListener("click", () => answerSelected(btn.dataset.choice, btn));
  });
  document.getElementById("feedback").innerHTML = "";
  document.getElementById("next-btn").classList.add("hidden");
}

function answerSelected(choice, btn) {
  const isCorrect = choice === currentQuestion.answer;
  ScoreStore.record(MODES[currentMode].label, isCorrect);

  // 全ての選択肢を無効化＋色付け
  document.querySelectorAll(".choice-btn").forEach(b => {
    b.disabled = true;
    if (b.dataset.choice === currentQuestion.answer) {
      b.classList.add("border-emerald-500", "bg-emerald-50");
    } else if (b === btn && !isCorrect) {
      b.classList.add("border-red-500", "bg-red-50");
    } else {
      b.classList.add("opacity-60");
    }
  });

  // フィードバック（正解時もヒントを表示するとより学習効果あり）
  const fb = document.getElementById("feedback");
  const hintLine = currentQuestion.hint ? `<div class="text-xs text-slate-600 mt-1">💡 ${currentQuestion.hint}</div>` : "";
  if (isCorrect) {
    fb.innerHTML = `<div class="bg-emerald-100 text-emerald-800 p-3 rounded font-bold">✅ 正解！${hintLine}</div>`;
  } else {
    fb.innerHTML = `<div class="bg-red-100 text-red-800 p-3 rounded">❌ 不正解。正解は「<strong>${currentQuestion.answer}</strong>」${hintLine}</div>`;
  }
  document.getElementById("next-btn").classList.remove("hidden");
  updateScoreBar();
}

function updateScoreBar() {
  const scores = ScoreStore.load();
  const s = scores[MODES[currentMode].label];
  if (!s) return;
  const pct = s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0;
  document.getElementById("score-bar-text").textContent = `${s.correct} / ${s.total} (${pct}%)`;
  document.getElementById("score-bar-fill").style.width = `${pct}%`;
}

(async () => {
  try {
    // GEO と画像インデックスを並列ロード
    GEO = await loadGeoData();
    await loadImagesForQuiz();
    ATTRACTION_TO_PREF = buildAttractionToPrefMap(GEO);
    showModes();
  } catch (e) {
    document.body.innerHTML = `<div class="p-6 text-red-700">データロード失敗: ${e.message}<br><small>※ ローカルサーバー経由（python -m http.server）で開いてください。</small></div>`;
  }

  document.getElementById("next-btn").addEventListener("click", nextQuestion);
  document.getElementById("back-btn").addEventListener("click", () => {
    document.getElementById("quiz-screen").classList.add("hidden");
    document.getElementById("mode-screen").classList.remove("hidden");
  });
})();
