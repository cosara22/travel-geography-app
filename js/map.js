// 地図表示ロジック（GeoJSON ベースの本物の都道府県境界マップ）
// 沖縄県は本土から離れすぎるため、左上にデフォルメ配置する。
// 「市区町村を表示」トグルで、選択中の県の市区町村レイヤーを遅延ロードして描画。

let GEO = null;
let GEOJSON = null;
let selectedId = null;

let showMunicipalities = false;
const municipalitiesCache = {}; // prefId → GeoJSON

let showPOIs = false;
let poiFilterMode = "yaml"; // "yaml" = YAMLマッチのみ / "priority" = 主要カテゴリ / "all" = 全件
const poiCache = {}; // prefId → POI list

const SVG_WIDTH = 760;
const SVG_HEIGHT = 700;

// 詳細パネル上部の拡大地図
const ZOOM_W = 320, ZOOM_H = 320, ZOOM_PAD = 12;
const ZOOM_MIN_SCALE = 1 / 1.5;  // 初期から1.5倍まで縮小可能
const ZOOM_MAX_SCALE = 16;        // 初期から16倍まで拡大可能
const PREF_BBOX_OVERRIDE = {};    // 必要時に { tokyo: [lngMin, latMin, lngMax, latMax] } 等

const zoomMapState = {
  initialViewBox: null,  // { x, y, w, h } 県選択時にセット
  viewBox: null,         // 現在の表示範囲
  isDragging: false,
  dragStart: null,       // { clientX, clientY, vbX, vbY }
  pinchStart: null,      // { distance, viewBox }
  dragMoved: false,      // クリック判定用（移動5px未満ならクリック扱い）
  interactionsBound: false,
};

// 本土の投影範囲（沖縄を除く）
const MAINLAND_BOUNDS = {
  lngMin: 128.5, lngMax: 146.0,
  latMin: 30.5,  latMax: 45.7,
};

// 沖縄を本土から切り出して左上（北海道の左横）に表示するためのパラメータ
const OKINAWA_FRAME = { x: 10, y: 30, w: 220, h: 160 };
const OKINAWA_BOUNDS = {
  lngMin: 122.7, lngMax: 131.4,
  latMin: 24.0,  latMax: 27.2,
};

// 経度緯度 → SVG座標 への投影（本土用）
function projectMainland(lng, lat) {
  const x = (lng - MAINLAND_BOUNDS.lngMin) / (MAINLAND_BOUNDS.lngMax - MAINLAND_BOUNDS.lngMin) * SVG_WIDTH;
  const y = (MAINLAND_BOUNDS.latMax - lat) / (MAINLAND_BOUNDS.latMax - MAINLAND_BOUNDS.latMin) * SVG_HEIGHT;
  return [x, y];
}

// 経度緯度 → SVG座標 への投影（沖縄用：左上の枠内に収める）
function projectOkinawa(lng, lat) {
  const x = OKINAWA_FRAME.x +
    (lng - OKINAWA_BOUNDS.lngMin) / (OKINAWA_BOUNDS.lngMax - OKINAWA_BOUNDS.lngMin) * OKINAWA_FRAME.w;
  const y = OKINAWA_FRAME.y +
    (OKINAWA_BOUNDS.latMax - lat) / (OKINAWA_BOUNDS.latMax - OKINAWA_BOUNDS.latMin) * OKINAWA_FRAME.h;
  return [x, y];
}

// 都道府県IDに応じた投影関数
function getProjectionFn(prefId) {
  return prefId === "okinawa" ? projectOkinawa : projectMainland;
}

// ===== 拡大地図用ヘルパー =====

// シューレース公式によるリング面積（緯度経度の二乗、緯度補正なし）
function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

// 多角形の bbox（外環ベース）
function ringBBox(ring) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

// 県のbboxを面積閾値ベースで計算。最大ポリゴンの areaThreshold (デフォ30%) 以上の面積を持つ
// ポリゴン群を統合してbboxを取る。離島が多い県でも主要本島群がカバーされる。
function computeBBox(feature, areaThreshold = 0.3) {
  const geom = feature.geometry;
  const polygons = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  // 各ポリゴンの外環の面積とbbox
  const items = polygons.map(poly => {
    const outer = poly[0];
    return { area: ringArea(outer), bbox: ringBBox(outer) };
  });
  if (items.length === 0) return null;
  const maxArea = Math.max(...items.map(i => i.area));
  const threshold = maxArea * areaThreshold;
  const survivors = items.filter(i => i.area >= threshold);
  // 統合bbox
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const { bbox } of survivors) {
    if (bbox[0] < minLng) minLng = bbox[0];
    if (bbox[1] < minLat) minLat = bbox[1];
    if (bbox[2] > maxLng) maxLng = bbox[2];
    if (bbox[3] > maxLat) maxLat = bbox[3];
  }
  return [minLng, minLat, maxLng, maxLat];
}

// bbox にフィットする投影関数を生成。アスペクト比を保つよう短辺方向にパディングを足す
function makeFittedProjection(bbox, w, h, pad) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const lngRange = maxLng - minLng || 1e-6;
  const latRange = maxLat - minLat || 1e-6;
  const sx = innerW / lngRange;
  const sy = innerH / latRange;
  const scale = Math.min(sx, sy);
  const offsetX = pad + (innerW - lngRange * scale) / 2;
  const offsetY = pad + (innerH - latRange * scale) / 2;
  return (lng, lat) => [
    offsetX + (lng - minLng) * scale,
    offsetY + (maxLat - lat) * scale,
  ];
}

// クライアント座標 → SVG ユーザー座標
function clientToSVG(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// GeoJSONのMultiPolygon/Polygon → SVG path d 文字列
function geometryToPath(geometry, projectFn) {
  const polys = geometry.type === "MultiPolygon"
    ? geometry.coordinates
    : [geometry.coordinates];

  return polys.map(polygon =>
    polygon.map(ring =>
      ring.map((coord, i) => {
        const [x, y] = projectFn(coord[0], coord[1]);
        return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
      }).join("") + "Z"
    ).join(" ")
  ).join(" ");
}

// GeoJSONのnam_jaから地理DBのprefecture id（hokkaido等）を逆引き
function findPrefId(nameJa) {
  for (const [id, c] of Object.entries(PREF_COORDS)) {
    if (c.name === nameJa) return id;
  }
  return null;
}

function buildMap() {
  const svg = document.getElementById("japan-map");
  svg.setAttribute("viewBox", `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`);
  svg.innerHTML = ""; // 既存内容クリア

  // 凡例
  const legendG = document.getElementById("region-legend");
  legendG.innerHTML = Object.entries(REGION_COLORS).map(([region, color]) => `
    <span class="inline-flex items-center gap-1 mr-3">
      <span class="w-3 h-3 rounded-sm inline-block border border-slate-400" style="background:${color}"></span>
      <span class="text-xs text-slate-600">${region}</span>
    </span>
  `).join("");

  // 沖縄の枠（破線の四角）
  const okiFrame = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  okiFrame.setAttribute("x", OKINAWA_FRAME.x);
  okiFrame.setAttribute("y", OKINAWA_FRAME.y);
  okiFrame.setAttribute("width", OKINAWA_FRAME.w);
  okiFrame.setAttribute("height", OKINAWA_FRAME.h);
  okiFrame.setAttribute("fill", "none");
  okiFrame.setAttribute("stroke", "#cbd5e1");
  okiFrame.setAttribute("stroke-dasharray", "4,4");
  svg.appendChild(okiFrame);

  const okiLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  okiLabel.setAttribute("x", OKINAWA_FRAME.x + 8);
  okiLabel.setAttribute("y", OKINAWA_FRAME.y - 4);
  okiLabel.setAttribute("font-size", "11");
  okiLabel.setAttribute("fill", "#94a3b8");
  okiLabel.textContent = "沖縄県（縮尺別）";
  svg.appendChild(okiLabel);

  // レイヤー構造（描画順: 下→上）
  const prefLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  prefLayer.setAttribute("id", "prefecture-layer");
  svg.appendChild(prefLayer);

  const municipalityLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  municipalityLayer.setAttribute("id", "municipality-layer");
  svg.appendChild(municipalityLayer);

  const labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labelLayer.setAttribute("id", "label-layer");
  svg.appendChild(labelLayer);

  const poiLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  poiLayer.setAttribute("id", "poi-layer");
  svg.appendChild(poiLayer);

  // 47都道府県のパスを描画
  GEOJSON.features.forEach(feature => {
    const nameJa = feature.properties.nam_ja;
    const prefId = findPrefId(nameJa);
    if (!prefId) return;

    const pref = GEO.prefectures[prefId];
    if (!pref) return;

    const projectFn = getProjectionFn(prefId);
    const d = geometryToPath(feature.geometry, projectFn);
    const color = REGION_COLORS[pref.region] || "#94a3b8";

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", color);
    path.setAttribute("stroke", "#475569");
    path.setAttribute("stroke-width", "0.5");
    path.setAttribute("stroke-linejoin", "round");
    path.dataset.id = prefId;
    path.classList.add("pref-path");
    path.style.cursor = "pointer";
    path.style.transition = "fill 0.15s, stroke-width 0.15s";

    path.addEventListener("click", () => selectPref(prefId));
    path.addEventListener("mouseenter", () => {
      if (selectedId !== prefId) {
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke", "#1e293b");
      }
    });
    path.addEventListener("mouseleave", () => {
      if (selectedId !== prefId) {
        path.setAttribute("stroke-width", "0.5");
        path.setAttribute("stroke", "#475569");
      }
    });

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = pref.name;
    path.appendChild(title);

    prefLayer.appendChild(path);
  });

  // ラベル（PREF_COORDSの県庁所在地座標を使う）
  Object.entries(PREF_COORDS).forEach(([id, coord]) => {
    const pref = GEO.prefectures[id];
    if (!pref) return;
    const [x, y] = getProjectionFn(id)(coord.lng, coord.lat);

    const fontSize = id === "hokkaido" ? 13 : 9;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", x);
    label.setAttribute("y", y);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", fontSize);
    label.setAttribute("fill", "#1e293b");
    label.setAttribute("pointer-events", "none");
    label.style.userSelect = "none";
    label.style.fontWeight = "500";
    label.setAttribute("stroke", "white");
    label.setAttribute("stroke-width", "2");
    label.setAttribute("paint-order", "stroke fill");
    label.textContent = pref.name.replace(/[県府都道]$/, "");
    label.classList.add("pref-label");
    label.dataset.id = id;
    labelLayer.appendChild(label);
  });
}

// ===== 市区町村レイヤー =====

async function ensureMunicipalitiesLoaded(prefId) {
  if (municipalitiesCache[prefId]) return municipalitiesCache[prefId];
  const code = GEO.prefectures[prefId].code; // "01" 〜 "47"
  const res = await fetch(`public/municipalities/${code}.json?v=6`);
  if (!res.ok) throw new Error(`市区町村データ取得失敗: ${prefId} (${res.status})`);
  const data = await res.json();
  municipalitiesCache[prefId] = data;
  return data;
}

function clearMunicipalityLayer() {
  const layer = document.getElementById("municipality-layer");
  if (layer) layer.innerHTML = "";
}

async function renderMunicipalitiesFor(prefId) {
  const layer = document.getElementById("municipality-layer");
  if (!layer) return;

  // ローディング表示
  document.getElementById("municipality-status").textContent =
    `「${GEO.prefectures[prefId].name}」の市区町村を読み込み中…`;

  let data;
  try {
    data = await ensureMunicipalitiesLoaded(prefId);
  } catch (e) {
    document.getElementById("municipality-status").textContent = `エラー: ${e.message}`;
    return;
  }

  // 別の県を選択したら無視（非同期競合対策）
  if (selectedId !== prefId) return;

  layer.innerHTML = "";
  const projectFn = getProjectionFn(prefId);
  const pref = GEO.prefectures[prefId];
  const baseColor = REGION_COLORS[pref.region] || "#94a3b8";

  data.features.forEach(feat => {
    const d = geometryToPath(feat.geometry, projectFn);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", baseColor);
    path.setAttribute("fill-opacity", "0.55");
    path.setAttribute("stroke", "white");
    path.setAttribute("stroke-width", "0.3");
    path.style.cursor = "pointer";
    path.style.transition = "fill-opacity 0.15s, stroke-width 0.15s";

    const props = feat.properties;
    const fullName = (props.N03_003 || "") + (props.N03_004 || "");

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${fullName} (${props.N03_007 || ""})`;
    path.appendChild(title);

    path.addEventListener("mouseenter", () => {
      path.setAttribute("fill-opacity", "0.85");
      path.setAttribute("stroke-width", "1.2");
      path.setAttribute("stroke", "#1d4ed8");
      updateMunicipalityHover(props);
    });
    path.addEventListener("mouseleave", () => {
      path.setAttribute("fill-opacity", "0.55");
      path.setAttribute("stroke-width", "0.3");
      path.setAttribute("stroke", "white");
    });
    path.addEventListener("click", (e) => {
      e.stopPropagation();
      updateMunicipalityHover(props, true);
    });

    layer.appendChild(path);
  });

  document.getElementById("municipality-status").textContent =
    `市区町村: ${data.features.length}件 表示中`;
}

function updateMunicipalityHover(props, persistent = false) {
  const el = document.getElementById("hovered-municipality");
  if (!el) return;
  const fullName = (props.N03_003 || "") + (props.N03_004 || "");
  el.innerHTML = `
    <div class="${persistent ? "bg-blue-50" : "bg-slate-50"} rounded p-2 mb-3 border-l-4 ${persistent ? "border-blue-500" : "border-slate-300"}">
      <div class="font-bold text-slate-800">${fullName}</div>
      <div class="text-xs text-slate-500 mt-1">
        都道府県: ${props.N03_001 || ""}
        ${props.N03_002 ? ` / ${props.N03_002}` : ""}
        / コード: ${props.N03_007 || ""}
      </div>
    </div>
  `;
}

function clearMunicipalityHover() {
  const el = document.getElementById("hovered-municipality");
  if (el) el.innerHTML = "";
}

// ===== POI レイヤー =====

async function ensurePOIsLoaded(prefId) {
  if (poiCache[prefId]) return poiCache[prefId];
  const code = GEO.prefectures[prefId].code;
  const res = await fetch(`public/osm_pois/${code}.json?v=6`);
  if (!res.ok) {
    if (res.status === 404) {
      // まだ取得できていない県（バッチ処理中など）
      return { pois: [], pending: true };
    }
    throw new Error(`POI取得失敗: ${prefId} (${res.status})`);
  }
  const data = await res.json();
  poiCache[prefId] = data;
  return data;
}

function clearPOILayer() {
  const layer = document.getElementById("poi-layer");
  if (layer) layer.innerHTML = "";
}

function filterPOIs(pois, mode) {
  if (mode === "all") return pois;
  if (mode === "yaml") return pois.filter(p => p.matches_yaml);
  if (mode === "priority") {
    // YAMLマッチ + 試験頻出カテゴリ
    return pois.filter(p =>
      p.matches_yaml || PRIORITY_CATEGORIES.has(p.category)
    );
  }
  return pois;
}

async function renderPOIsFor(prefId) {
  const layer = document.getElementById("poi-layer");
  if (!layer) return;

  const statusEl = document.getElementById("poi-status");
  if (statusEl) statusEl.textContent = `「${GEO.prefectures[prefId].name}」のPOIを読み込み中…`;

  let data;
  try {
    data = await ensurePOIsLoaded(prefId);
  } catch (e) {
    if (statusEl) statusEl.textContent = `POIエラー: ${e.message}`;
    return;
  }

  if (selectedId !== prefId) return; // 競合対策

  if (data.pending) {
    if (statusEl) statusEl.textContent = "この県のPOIはまだ取得されていません（取得スクリプト実行中）";
    return;
  }

  layer.innerHTML = "";
  const projectFn = getProjectionFn(prefId);
  const allPOIs = data.pois || [];
  const filtered = filterPOIs(allPOIs, poiFilterMode);

  filtered.forEach(poi => {
    const [x, y] = projectFn(poi.lng, poi.lat);
    const cat = POI_CATEGORIES[poi.category] || POI_CATEGORIES.other;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${x.toFixed(1)}, ${y.toFixed(1)})`);
    g.style.cursor = "pointer";

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", poi.matches_yaml ? "5" : "3.5");
    circle.setAttribute("fill", cat.color);
    // 白フチは廃止。識別性は CSS の drop-shadow で確保
    circle.setAttribute("stroke", "none");
    circle.style.transition = "r 0.15s, stroke-width 0.15s";
    g.appendChild(circle);

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${cat.emoji} ${poi.name}（${cat.label}）`;
    g.appendChild(title);

    g.addEventListener("mouseenter", () => {
      circle.setAttribute("r", "8");
      updatePOIHover(poi, cat);
    });
    g.addEventListener("mouseleave", () => {
      circle.setAttribute("r", poi.matches_yaml ? "5" : "3.5");
    });
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      updatePOIHover(poi, cat, true);
    });

    layer.appendChild(g);
  });

  if (statusEl) {
    const counts = `表示中: ${filtered.length}件 / 全${allPOIs.length}件`;
    const breakdown = ` (♨️${countCat(filtered, 'onsen')} 🏯${countCat(filtered, 'castle')} ⛰️${countCat(filtered, 'mountain')} ⛩️${countCat(filtered, 'shrine')} 🛕${countCat(filtered, 'temple')})`;
    statusEl.textContent = counts + breakdown;
  }
}

function countCat(pois, cat) {
  return pois.filter(p => p.category === cat).length;
}

function updatePOIHover(poi, cat, persistent = false) {
  const el = document.getElementById("hovered-poi");
  if (!el) return;
  const wikiLink = poi.wikipedia
    ? `<a class="text-blue-600 hover:underline ml-1" target="_blank" rel="noopener" href="https://ja.wikipedia.org/wiki/${encodeURIComponent(poi.wikipedia.split(":").pop())}">Wikipedia</a>`
    : "";
  const elev = poi.elevation ? ` / 標高${poi.elevation}m` : "";
  const matchBadge = poi.matches_yaml
    ? '<span class="text-xs bg-amber-100 text-amber-700 px-1.5 rounded ml-2">⭐ 注目</span>'
    : "";
  el.innerHTML = `
    <div class="${persistent ? "bg-blue-50 border-blue-500" : "bg-slate-50 border-slate-300"} rounded p-2 mb-3 border-l-4">
      <div class="font-bold text-slate-800">${cat.emoji} ${poi.name}${matchBadge}</div>
      <div class="text-xs text-slate-500 mt-1">
        カテゴリ: ${cat.label}${elev} ${wikiLink}
      </div>
    </div>
  `;
}

function clearPOIHover() {
  const el = document.getElementById("hovered-poi");
  if (el) el.innerHTML = "";
}

// ===== 拡大地図 =====

function setZoomViewBox(x, y, w, h) {
  zoomMapState.viewBox = { x, y, w, h };
  const svg = document.getElementById("zoom-map");
  if (svg) svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  updateZoomStatusLabel();
  updateZoomElementSizes();
}

// 拡大縮小に合わせてピンの半径を逆スケールで調整し、画面上のサイズを一定に保つ。
// ストローク幅は CSS の vector-effect: non-scaling-stroke で対応済み。
function updateZoomElementSizes() {
  if (!zoomMapState.viewBox || !zoomMapState.initialViewBox) return;
  const scale = zoomMapState.initialViewBox.w / zoomMapState.viewBox.w;
  // scale > 1 = 拡大中 → 半径を1/scaleに縮小（画面上は同じサイズに見える）
  const poiCircles = document.querySelectorAll("#zoom-pois .zoom-poi circle");
  poiCircles.forEach(c => {
    const baseR = parseFloat(c.dataset.baseR) || 4;
    c.setAttribute("r", (baseR / scale).toFixed(2));
  });
}

function updateZoomStatusLabel() {
  const el = document.getElementById("zoom-map-status");
  if (!el || !zoomMapState.viewBox || !zoomMapState.initialViewBox) return;
  const scale = zoomMapState.initialViewBox.w / zoomMapState.viewBox.w;
  el.textContent = `×${scale.toFixed(2)}`;
}

function resetZoomView() {
  if (!zoomMapState.initialViewBox) return;
  const { x, y, w, h } = zoomMapState.initialViewBox;
  setZoomViewBox(x, y, w, h);
}

function zoomAt(factor, svgX, svgY) {
  if (!zoomMapState.viewBox || !zoomMapState.initialViewBox) return;
  const { x, y, w, h } = zoomMapState.viewBox;
  const newW = w / factor;
  const newH = h / factor;
  const initialW = zoomMapState.initialViewBox.w;
  const newScale = initialW / newW;
  if (newScale < ZOOM_MIN_SCALE || newScale > ZOOM_MAX_SCALE) return;
  const newX = svgX - (svgX - x) * (newW / w);
  const newY = svgY - (svgY - y) * (newH / h);
  setZoomViewBox(newX, newY, newW, newH);
}

function zoomCentered(factor) {
  if (!zoomMapState.viewBox) return;
  const cx = zoomMapState.viewBox.x + zoomMapState.viewBox.w / 2;
  const cy = zoomMapState.viewBox.y + zoomMapState.viewBox.h / 2;
  zoomAt(factor, cx, cy);
}

function clearZoomMap() {
  const svg = document.getElementById("zoom-map");
  if (!svg) return;
  ["zoom-pref-outline", "zoom-municipalities", "zoom-pois"].forEach(id => {
    const g = document.getElementById(id);
    if (g) g.innerHTML = "";
  });
}

function ensureZoomLayers(svg) {
  // 描画順（下→上）: 市町村 → 県境（外枠線） → POIピン
  let muni = document.getElementById("zoom-municipalities");
  let outline = document.getElementById("zoom-pref-outline");
  let poi = document.getElementById("zoom-pois");
  if (!muni) {
    muni = document.createElementNS("http://www.w3.org/2000/svg", "g");
    muni.setAttribute("id", "zoom-municipalities");
    svg.appendChild(muni);
  }
  if (!outline) {
    outline = document.createElementNS("http://www.w3.org/2000/svg", "g");
    outline.setAttribute("id", "zoom-pref-outline");
    svg.appendChild(outline);
  }
  if (!poi) {
    poi = document.createElementNS("http://www.w3.org/2000/svg", "g");
    poi.setAttribute("id", "zoom-pois");
    svg.appendChild(poi);
  }
  return { outline, muni, poi };
}

async function renderZoomedMap(prefId) {
  const svg = document.getElementById("zoom-map");
  if (!svg) return;

  // 初期化
  const titleEl = document.getElementById("zoom-map-title");
  if (titleEl) titleEl.textContent = `🔍 ${GEO.prefectures[prefId].name}`;

  const layers = ensureZoomLayers(svg);
  layers.outline.innerHTML = "";
  layers.muni.innerHTML = "";
  layers.poi.innerHTML = "";

  // 該当県の feature を取得
  const prefName = GEO.prefectures[prefId].name;
  const feature = GEOJSON.features.find(f => f.properties.nam_ja === prefName);
  if (!feature) return;

  // bbox 決定（override 優先）
  let bbox = PREF_BBOX_OVERRIDE[prefId];
  if (!bbox) bbox = computeBBox(feature, 0.3);
  if (!bbox) return;

  // アスペクト比補正: bbox を ZOOM_W:ZOOM_H に合わせて短辺方向に拡張
  const targetAspect = ZOOM_W / ZOOM_H;
  const lngRange = bbox[2] - bbox[0];
  const latRange = bbox[3] - bbox[1];
  const bboxAspect = lngRange / latRange;
  if (bboxAspect > targetAspect) {
    // 横長すぎ → 縦を拡張
    const newLatRange = lngRange / targetAspect;
    const cy = (bbox[1] + bbox[3]) / 2;
    bbox = [bbox[0], cy - newLatRange / 2, bbox[2], cy + newLatRange / 2];
  } else {
    // 縦長すぎ → 横を拡張
    const newLngRange = latRange * targetAspect;
    const cx = (bbox[0] + bbox[2]) / 2;
    bbox = [cx - newLngRange / 2, bbox[1], cx + newLngRange / 2, bbox[3]];
  }

  const proj = makeFittedProjection(bbox, ZOOM_W, ZOOM_H, ZOOM_PAD);

  // 県境（外枠線のみ。塗りは透明、stroke のみ表示）
  const outlineD = geometryToPath(feature.geometry, proj);
  const outlinePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  outlinePath.setAttribute("d", outlineD);
  // SVG属性で直接指定（CSSが効かない場合の保険）
  outlinePath.setAttribute("fill", "none");
  outlinePath.setAttribute("stroke", "#475569");
  outlinePath.setAttribute("stroke-width", "1.2");
  outlinePath.setAttribute("stroke-linejoin", "round");
  outlinePath.setAttribute("vector-effect", "non-scaling-stroke");
  outlinePath.setAttribute("pointer-events", "none");
  outlinePath.classList.add("zoom-pref-outline");
  layers.outline.appendChild(outlinePath);

  // viewBox を初期値にリセット
  zoomMapState.initialViewBox = { x: 0, y: 0, w: ZOOM_W, h: ZOOM_H };
  setZoomViewBox(0, 0, ZOOM_W, ZOOM_H);

  // 市町村レイヤー（常に表示。全国地図側のトグル状態には依存しない）
  {
    const pref = GEO.prefectures[prefId];
    const baseColor = REGION_COLORS[pref.region] || "#94a3b8";
    let muniData;
    try {
      muniData = await ensureMunicipalitiesLoaded(prefId);
    } catch (e) {
      muniData = null;
    }
    if (muniData && selectedId === prefId) {
      muniData.features.forEach(feat => {
        const md = geometryToPath(feat.geometry, proj);
        const mp = document.createElementNS("http://www.w3.org/2000/svg", "path");
        mp.setAttribute("d", md);
        mp.setAttribute("fill", baseColor);
        mp.classList.add("zoom-muni-path");
        const props = feat.properties;
        const fullName = (props.N03_003 || "") + (props.N03_004 || "");
        const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
        t.textContent = `${fullName} (${props.N03_007 || ""})`;
        mp.appendChild(t);
        mp.addEventListener("mouseenter", () => updateMunicipalityHover(props));
        mp.addEventListener("click", (e) => {
          e.stopPropagation();
          if (zoomMapState.dragMoved) return;
          updateMunicipalityHover(props, true);
        });
        layers.muni.appendChild(mp);
      });
    }
  }

  // POI レイヤー
  if (showPOIs) {
    let poiData;
    try {
      poiData = await ensurePOIsLoaded(prefId);
    } catch (e) {
      poiData = null;
    }
    if (poiData && !poiData.pending && selectedId === prefId) {
      const filtered = filterPOIs(poiData.pois || [], poiFilterMode);
      filtered.forEach(poi => {
        const [px, py] = proj(poi.lng, poi.lat);
        const cat = POI_CATEGORIES[poi.category] || POI_CATEGORIES.other;
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("transform", `translate(${px.toFixed(1)}, ${py.toFixed(1)})`);
        g.classList.add("zoom-poi");

        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        const baseR = poi.matches_yaml ? 6 : 4;
        c.setAttribute("r", String(baseR));
        c.dataset.baseR = String(baseR);
        c.setAttribute("fill", cat.color);
        // 白フチは廃止。識別性は CSS の drop-shadow で確保
        c.setAttribute("stroke", "none");
        g.appendChild(c);

        const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
        t.textContent = `${cat.emoji} ${poi.name}（${cat.label}）`;
        g.appendChild(t);

        g.addEventListener("mouseenter", () => updatePOIHover(poi, cat));
        g.addEventListener("click", (e) => {
          e.stopPropagation();
          if (zoomMapState.dragMoved) return;
          updatePOIHover(poi, cat, true);
        });
        layers.poi.appendChild(g);
      });
      // 描画後に現在のズーム比でサイズ調整（拡大中に再描画されたケース対応）
      updateZoomElementSizes();
    }
  }
}

// ===== 拡大地図インタラクション（ズーム/パン/タッチ） =====

function setupZoomMapInteractions() {
  if (zoomMapState.interactionsBound) return;
  const svg = document.getElementById("zoom-map");
  if (!svg) return;
  zoomMapState.interactionsBound = true;

  // ホイールズーム
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const pt = clientToSVG(svg, e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    zoomAt(factor, pt.x, pt.y);
  }, { passive: false });

  // マウスドラッグ
  svg.addEventListener("mousedown", (e) => {
    if (!zoomMapState.viewBox) return;
    zoomMapState.isDragging = true;
    zoomMapState.dragMoved = false;
    zoomMapState.dragStart = {
      clientX: e.clientX, clientY: e.clientY,
      vbX: zoomMapState.viewBox.x, vbY: zoomMapState.viewBox.y,
    };
    svg.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", (e) => {
    if (!zoomMapState.isDragging || !zoomMapState.dragStart) return;
    const dx = e.clientX - zoomMapState.dragStart.clientX;
    const dy = e.clientY - zoomMapState.dragStart.clientY;
    if (Math.hypot(dx, dy) > 5) zoomMapState.dragMoved = true;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgDx = -dx / ctm.a;
    const svgDy = -dy / ctm.d;
    setZoomViewBox(
      zoomMapState.dragStart.vbX + svgDx,
      zoomMapState.dragStart.vbY + svgDy,
      zoomMapState.viewBox.w,
      zoomMapState.viewBox.h,
    );
  });
  window.addEventListener("mouseup", () => {
    if (zoomMapState.isDragging) {
      zoomMapState.isDragging = false;
      svg.style.cursor = "grab";
      // 5px未満ならクリック扱い、5px以上ならクリック抑制（POIピン側で参照）
      // dragMoved フラグはクリック処理で参照後にリセット
      setTimeout(() => { zoomMapState.dragMoved = false; }, 0);
    }
  });

  // タッチ操作（1本指パン + 2本指ピンチ）
  svg.addEventListener("touchstart", (e) => {
    if (!zoomMapState.viewBox) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      zoomMapState.isDragging = true;
      zoomMapState.dragMoved = false;
      zoomMapState.dragStart = {
        clientX: t.clientX, clientY: t.clientY,
        vbX: zoomMapState.viewBox.x, vbY: zoomMapState.viewBox.y,
      };
    } else if (e.touches.length === 2) {
      zoomMapState.isDragging = false;
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      zoomMapState.pinchStart = {
        distance: dist,
        viewBox: { ...zoomMapState.viewBox },
        midSVG: clientToSVG(svg, (t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2),
      };
    }
  }, { passive: false });

  svg.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && zoomMapState.isDragging && zoomMapState.dragStart) {
      const t = e.touches[0];
      const dx = t.clientX - zoomMapState.dragStart.clientX;
      const dy = t.clientY - zoomMapState.dragStart.clientY;
      if (Math.hypot(dx, dy) > 5) zoomMapState.dragMoved = true;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const svgDx = -dx / ctm.a;
      const svgDy = -dy / ctm.d;
      setZoomViewBox(
        zoomMapState.dragStart.vbX + svgDx,
        zoomMapState.dragStart.vbY + svgDy,
        zoomMapState.viewBox.w,
        zoomMapState.viewBox.h,
      );
    } else if (e.touches.length === 2 && zoomMapState.pinchStart) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const factor = dist / zoomMapState.pinchStart.distance;
      const initialW = zoomMapState.initialViewBox.w;
      const baseW = zoomMapState.pinchStart.viewBox.w;
      const newW = baseW / factor;
      const newScale = initialW / newW;
      if (newScale < ZOOM_MIN_SCALE || newScale > ZOOM_MAX_SCALE) return;
      const newH = zoomMapState.pinchStart.viewBox.h / factor;
      const mid = zoomMapState.pinchStart.midSVG;
      const baseX = zoomMapState.pinchStart.viewBox.x;
      const baseY = zoomMapState.pinchStart.viewBox.y;
      const newX = mid.x - (mid.x - baseX) * (newW / baseW);
      const newY = mid.y - (mid.y - baseY) * (newH / zoomMapState.pinchStart.viewBox.h);
      setZoomViewBox(newX, newY, newW, newH);
    }
  }, { passive: false });

  svg.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      zoomMapState.isDragging = false;
      zoomMapState.pinchStart = null;
      setTimeout(() => { zoomMapState.dragMoved = false; }, 0);
    }
  });

  // ボタン
  document.getElementById("zoom-in-btn")?.addEventListener("click", () => zoomCentered(1.5));
  document.getElementById("zoom-out-btn")?.addEventListener("click", () => zoomCentered(1 / 1.5));
  document.getElementById("zoom-reset-btn")?.addEventListener("click", resetZoomView);
}

// ===== 県選択 =====

async function selectPref(id) {
  selectedId = id;

  // 全パスのスタイルをリセット
  document.querySelectorAll(".pref-path").forEach(p => {
    p.setAttribute("stroke-width", "0.5");
    p.setAttribute("stroke", "#475569");
  });

  // 選択中のパスを強調
  const selectedPath = document.querySelector(`.pref-path[data-id="${id}"]`);
  if (selectedPath) {
    selectedPath.setAttribute("stroke-width", "2.5");
    selectedPath.setAttribute("stroke", "#1d4ed8");
  }

  const pref = GEO.prefectures[id];
  if (!pref) return;

  // 関連する世界遺産・国立公園を抽出
  const heritage = Object.values(GEO.world_heritage).filter(h => h.prefectures.includes(pref.name));
  const parks = Object.values(GEO.national_parks).filter(p => p.prefectures.includes(pref.name));

  // 画像インデックスを並列ロード（キャッシュされるので2回目以降は瞬時）
  const [
    whImg, npImg, onsenImg, festImg, cuisineImg, attractionsImg,
    mountainsImg, islandsImg, lakesImg, capesImg, riversImg,
    stationsImg, airportsImg, jrLinesImg,
  ] = await Promise.all([
    loadImageIndex("world_heritage"),
    loadImageIndex("national_parks"),
    loadImageIndex("onsen"),
    loadImageIndex("festivals"),
    loadImageIndex("cuisine"),
    loadImageIndex("attractions"),
    loadImageIndex("mountains"),
    loadImageIndex("islands"),
    loadImageIndex("lakes"),
    loadImageIndex("capes"),
    loadImageIndex("rivers"),
    loadImageIndex("stations"),
    loadImageIndex("airports"),
    loadImageIndex("jr_lines"),
  ]);

  // 県内の観光資源について「名前 → 画像」のマップを構築するヘルパー。
  // pref.{onsen,festivals,cuisine} は文字列配列なので、GEOから ID を逆引きする。
  const buildNameImageMap = (geoCategory, imgIndex) => {
    const map = {};
    Object.values(geoCategory).forEach(item => {
      if (item.name && imgIndex[item.id]) {
        map[item.name] = imgIndex[item.id];
      }
    });
    return map;
  };
  const onsenNameMap = buildNameImageMap(GEO.onsen, onsenImg);
  const festNameMap = buildNameImageMap(GEO.festivals, festImg);
  const cuisineNameMap = buildNameImageMap(GEO.cuisine, cuisineImg);

  const sections = [];

  // 説明書き付きの名前（例「有馬温泉（日本三名泉…）」）を短縮形に正規化
  // pref.{onsen,festivals,cuisine,attractions} には説明書き入りの名前が入るが、
  // 画像JSONのキーは短縮形（GEO[cat][id].name）のことがある
  const normalize = (s) => s ? s.split(/[（(]/)[0].trim() : s;

  // imageMap が指定されると items を画像つきカードで表示する
  const renderList = (title, emoji, items, imageMap = null) => {
    if (!items || items.length === 0) return "";
    const renderItem = (it) => {
      const img = imageMap && (imageMap[it] || imageMap[normalize(it)]);
      if (!img) {
        // 画像未取得は inline-block チップで表示（figureと混在しても綺麗に並ぶ）
        const chipMargin = imageMap ? "inline-block m-1 align-top" : "";
        return `<span class="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded ${chipMargin}">${it}</span>`;
      }
      const credit = `${img.author || "Unknown"} / ${img.license || ""}`.replace(/"/g, "&quot;");
      return `
        <figure class="inline-block w-32 m-1 align-top">
          <a href="${img.page_url}" target="_blank" rel="noopener">
            <img src="${img.thumb_url}" alt="${it}" loading="lazy"
                 class="w-32 h-20 object-cover rounded shadow-sm"
                 onerror="this.style.display='none'">
          </a>
          <figcaption class="text-xs text-slate-700 mt-1 leading-tight">${it}<br>
            <a href="${img.license_url}" target="_blank" rel="noopener"
               class="text-[10px] text-slate-400 hover:underline truncate block" title="${credit}">📷 ${img.author} / ${img.license}</a>
          </figcaption>
        </figure>`;
    };
    const containerClass = imageMap ? "" : "flex flex-wrap gap-1";
    return `
      <div class="mb-4">
        <h4 class="text-sm font-bold text-slate-700 mb-1">${emoji} ${title} <span class="text-xs text-slate-400 font-normal">(${items.length})</span></h4>
        <div class="${containerClass}">
          ${items.map(renderItem).join("")}
        </div>
      </div>
    `;
  };

  sections.push(`
    <div class="mb-4 pb-3 border-b">
      <h3 class="text-2xl font-bold text-slate-800">${pref.name}</h3>
      <p class="text-xs text-slate-500 mt-1">${pref.region} / ${pref.capital} / JIS ${pref.code}</p>
    </div>
  `);
  sections.push('<div id="hovered-poi"></div>');
  sections.push('<div id="hovered-municipality"></div>');
  if (heritage.length > 0) {
    const whMap = {};
    heritage.forEach(h => { if (whImg[h.id]) whMap[h.name] = whImg[h.id]; });
    sections.push(renderList("世界遺産", "🌍", heritage.map(h => h.name), whMap));
  }
  if (parks.length > 0) {
    const npMap = {};
    parks.forEach(p => { if (npImg[p.id]) npMap[p.name] = npImg[p.id]; });
    sections.push(renderList("国立公園", "🏔️", parks.map(p => p.name), npMap));
  }
  // attractions, mountains 等は prefectures.<field> から集約され、
  // 画像JSONのキーが「名前そのもの」（説明書き含む）なので imageIndex を直接渡す。
  // renderList 内の normalize() でカッコ以前の短縮形でも引けるようになっている。
  sections.push(renderList("観光地", "🏯", pref.attractions, attractionsImg));
  sections.push(renderList("温泉", "♨️", pref.onsen, onsenNameMap));
  sections.push(renderList("祭り", "🎌", pref.festivals, festNameMap));
  sections.push(renderList("郷土料理・特産", "🍜", pref.cuisine, cuisineNameMap));
  sections.push(renderList("空港", "✈️", pref.airports, airportsImg));
  sections.push(renderList("JR路線", "🚄", pref.jr_lines, jrLinesImg));
  sections.push(renderList("主要駅", "🚉", pref.stations, stationsImg));
  sections.push(renderList("岬", "🌊", pref.capes, capesImg));
  sections.push(renderList("島嶼", "🏝️", pref.islands, islandsImg));
  sections.push(renderList("湖沼", "💧", pref.lakes, lakesImg));
  sections.push(renderList("山・峠", "⛰️", pref.mountains, mountainsImg));
  sections.push(renderList("川", "🌀", pref.rivers, riversImg));
  // 詳細情報は Wikipedia 記事へリンク（OSS 版では試験対策テキストを保持しない）
  const wikiUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(pref.name)}`;
  sections.push(`
    <div class="mt-4 p-3 bg-blue-50 rounded text-sm">
      <a href="${wikiUrl}" target="_blank" rel="noopener" class="text-blue-700 hover:underline font-medium">
        📖 Wikipedia: ${pref.name} の記事を読む →
      </a>
    </div>
  `);

  document.getElementById("detail-panel").innerHTML = sections.join("");

  // 市区町村レイヤー処理
  if (showMunicipalities) {
    renderMunicipalitiesFor(id);
  } else {
    clearMunicipalityLayer();
    document.getElementById("municipality-status").textContent = "";
  }

  // POI レイヤー処理
  if (showPOIs) {
    renderPOIsFor(id);
  } else {
    clearPOILayer();
    const statusEl = document.getElementById("poi-status");
    if (statusEl) statusEl.textContent = "";
  }

  // 拡大地図（aside上部）
  renderZoomedMap(id);
}

// ===== 初期化 =====

(async () => {
  try {
    const [geo, geojsonRes] = await Promise.all([
      loadGeoData(),
      fetch("public/japan.geojson?v=6"),
    ]);
    if (!geojsonRes.ok) throw new Error("japan.geojson の取得失敗");
    GEO = geo;
    GEOJSON = await geojsonRes.json();

    buildMap();
    setupZoomMapInteractions();
    selectPref("hokkaido");
  } catch (e) {
    document.body.innerHTML = `<div class="p-6 text-red-700">データロード失敗: ${e.message}<br><small>※ ローカルサーバー経由（python -m http.server）で開いてください。</small></div>`;
    return;
  }

  // 市区町村トグル
  const toggle = document.getElementById("toggle-municipalities");
  if (toggle) {
    toggle.addEventListener("change", (e) => {
      showMunicipalities = e.target.checked;
      if (showMunicipalities && selectedId) {
        renderMunicipalitiesFor(selectedId);
      } else {
        clearMunicipalityLayer();
        clearMunicipalityHover();
        document.getElementById("municipality-status").textContent = "";
      }
      // 拡大地図にも反映
      if (selectedId) renderZoomedMap(selectedId);
    });
  }

  // POIトグル
  const poiToggle = document.getElementById("toggle-pois");
  if (poiToggle) {
    poiToggle.addEventListener("change", (e) => {
      showPOIs = e.target.checked;
      if (showPOIs && selectedId) {
        renderPOIsFor(selectedId);
      } else {
        clearPOILayer();
        clearPOIHover();
        const statusEl = document.getElementById("poi-status");
        if (statusEl) statusEl.textContent = "";
      }
      // 拡大地図にも反映
      if (selectedId) renderZoomedMap(selectedId);
    });
  }

  // POI フィルタモード
  const filterRadios = document.querySelectorAll('input[name="poi-filter"]');
  filterRadios.forEach(r => {
    r.addEventListener("change", (e) => {
      poiFilterMode = e.target.value;
      if (showPOIs && selectedId) {
        renderPOIsFor(selectedId);
      }
      // 拡大地図にも反映
      if (selectedId) renderZoomedMap(selectedId);
    });
  });
})();
