// 47都道府県の県庁所在地の緯度経度
// 地図表示で各県を地理的に正しい位置に配置するために使用
const PREF_COORDS = {
  hokkaido:  { lat: 43.064, lng: 141.348, name: "北海道" },
  aomori:    { lat: 40.825, lng: 140.741, name: "青森県" },
  iwate:     { lat: 39.704, lng: 141.153, name: "岩手県" },
  miyagi:    { lat: 38.269, lng: 140.872, name: "宮城県" },
  akita:     { lat: 39.719, lng: 140.103, name: "秋田県" },
  yamagata:  { lat: 38.241, lng: 140.364, name: "山形県" },
  fukushima: { lat: 37.750, lng: 140.468, name: "福島県" },
  ibaraki:   { lat: 36.342, lng: 140.447, name: "茨城県" },
  tochigi:   { lat: 36.566, lng: 139.884, name: "栃木県" },
  gunma:     { lat: 36.391, lng: 139.060, name: "群馬県" },
  saitama:   { lat: 35.857, lng: 139.649, name: "埼玉県" },
  chiba:     { lat: 35.605, lng: 140.123, name: "千葉県" },
  tokyo:     { lat: 35.690, lng: 139.692, name: "東京都" },
  kanagawa:  { lat: 35.448, lng: 139.643, name: "神奈川県" },
  niigata:   { lat: 37.902, lng: 139.024, name: "新潟県" },
  toyama:    { lat: 36.696, lng: 137.211, name: "富山県" },
  ishikawa:  { lat: 36.595, lng: 136.626, name: "石川県" },
  fukui:     { lat: 36.065, lng: 136.222, name: "福井県" },
  yamanashi: { lat: 35.664, lng: 138.568, name: "山梨県" },
  nagano:    { lat: 36.651, lng: 138.181, name: "長野県" },
  gifu:      { lat: 35.391, lng: 136.722, name: "岐阜県" },
  shizuoka:  { lat: 34.977, lng: 138.383, name: "静岡県" },
  aichi:     { lat: 35.180, lng: 136.907, name: "愛知県" },
  mie:       { lat: 34.730, lng: 136.509, name: "三重県" },
  shiga:     { lat: 35.005, lng: 135.869, name: "滋賀県" },
  kyoto:     { lat: 35.021, lng: 135.756, name: "京都府" },
  osaka:     { lat: 34.686, lng: 135.520, name: "大阪府" },
  hyogo:     { lat: 34.691, lng: 135.183, name: "兵庫県" },
  nara:      { lat: 34.685, lng: 135.833, name: "奈良県" },
  wakayama:  { lat: 34.226, lng: 135.168, name: "和歌山県" },
  tottori:   { lat: 35.504, lng: 134.238, name: "鳥取県" },
  shimane:   { lat: 35.472, lng: 133.051, name: "島根県" },
  okayama:   { lat: 34.662, lng: 133.935, name: "岡山県" },
  hiroshima: { lat: 34.396, lng: 132.460, name: "広島県" },
  yamaguchi: { lat: 34.186, lng: 131.471, name: "山口県" },
  tokushima: { lat: 34.066, lng: 134.559, name: "徳島県" },
  kagawa:    { lat: 34.340, lng: 134.044, name: "香川県" },
  ehime:     { lat: 33.842, lng: 132.766, name: "愛媛県" },
  kochi:     { lat: 33.560, lng: 133.531, name: "高知県" },
  fukuoka:   { lat: 33.607, lng: 130.418, name: "福岡県" },
  saga:      { lat: 33.249, lng: 130.299, name: "佐賀県" },
  nagasaki:  { lat: 32.745, lng: 129.874, name: "長崎県" },
  kumamoto:  { lat: 32.790, lng: 130.742, name: "熊本県" },
  oita:      { lat: 33.238, lng: 131.613, name: "大分県" },
  miyazaki:  { lat: 31.911, lng: 131.424, name: "宮崎県" },
  kagoshima: { lat: 31.560, lng: 130.558, name: "鹿児島県" },
  okinawa:   { lat: 26.213, lng: 127.681, name: "沖縄県" },
};

// 緯度経度 → SVG座標 への投影
// 日本本土の範囲を画面に収める単純な等緯距図法
function projectCoords(lat, lng, width, height) {
  // 投影範囲（沖縄含む）
  const LAT_MIN = 24, LAT_MAX = 46;
  const LNG_MIN = 122, LNG_MAX = 146;
  const x = (lng - LNG_MIN) / (LNG_MAX - LNG_MIN) * width;
  const y = (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * height;
  return [x, y];
}

const REGION_COLORS = {
  "北海道":     "#a8e6cf",
  "東北":       "#dcedc1",
  "関東":       "#ffd3b6",
  "中部":       "#ffaaa5",
  "近畿":       "#ff8b94",
  "中国":       "#a8d8ea",
  "四国":       "#aa96da",
  "九州・沖縄": "#fcbad3",
};
