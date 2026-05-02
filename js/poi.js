// OSM由来 POI のカテゴリ定義と描画ヘルパー

const POI_CATEGORIES = {
  onsen:        { emoji: "♨️", color: "#dc2626", label: "温泉",        priority: 1 },
  castle:       { emoji: "🏯", color: "#92400e", label: "城",          priority: 1 },
  shrine:       { emoji: "⛩️", color: "#b91c1c", label: "神社",        priority: 2 },
  temple:       { emoji: "🛕", color: "#7c3aed", label: "寺",          priority: 2 },
  mountain:     { emoji: "⛰️", color: "#65a30d", label: "山",          priority: 1 },
  volcano:      { emoji: "🌋", color: "#dc2626", label: "火山",        priority: 1 },
  cape:         { emoji: "🌊", color: "#0d9488", label: "岬",          priority: 1 },
  beach:        { emoji: "🏖️", color: "#fbbf24", label: "海岸",        priority: 2 },
  waterfall:    { emoji: "💧", color: "#06b6d4", label: "滝",          priority: 1 },
  cliff:        { emoji: "🪨", color: "#78716c", label: "断崖",        priority: 2 },
  cave:         { emoji: "🕳️", color: "#525252", label: "洞窟",        priority: 2 },
  viewpoint:    { emoji: "🌄", color: "#0369a1", label: "展望台",      priority: 2 },
  museum:       { emoji: "🏛️", color: "#0891b2", label: "博物館・美術館", priority: 2 },
  attraction:   { emoji: "🗾", color: "#059669", label: "観光名所",    priority: 1 },
  zoo_aquarium: { emoji: "🐠", color: "#0d9488", label: "動物園/水族館", priority: 2 },
  theme_park:   { emoji: "🎢", color: "#e11d48", label: "テーマパーク", priority: 2 },
  monument:     { emoji: "🗿", color: "#525252", label: "記念碑",      priority: 3 },
  ruins:        { emoji: "🏛️", color: "#a16207", label: "遺跡・廃墟",  priority: 3 },
  religious:    { emoji: "🛐", color: "#6366f1", label: "宗教施設",    priority: 3 },
  other:        { emoji: "📍", color: "#64748b", label: "その他",      priority: 3 },
};

// 試験頻出として優先表示するカテゴリ（priority 1）
const PRIORITY_CATEGORIES = new Set(
  Object.entries(POI_CATEGORIES)
    .filter(([_, info]) => info.priority === 1)
    .map(([key]) => key)
);
