"use strict";

const obsidian = require("obsidian");
const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownRenderChild,
  MarkdownView,
  parseYaml,
  editorLivePreviewField,
  editorInfoField,
  EditorSuggest,
  Modal,
  Notice,
} = obsidian;
const { StateField } = require("@codemirror/state");
const { Decoration, EditorView, WidgetType } = require("@codemirror/view");

const DEFAULT_SETTINGS = {
  defaultLevels: "3",
  defaultTitle: "Contents",
  bannerColor: "#8a8a8a",
  bannerTextColor: "#ffffff",
  defaultImage: "",
  livePreview: true,
  tocStyle: "banner", // "banner" (박스) | "text" (CONTENTS 글자) | "list" (목차만) | "biscuit" (비스킷, 눌러서 펼침)
  showLine: true, // true: 점선 있는 스타일 / false: 위키피디아식 깔끔한 목록
  biscuitColor: "#f0cf94", // 비스킷 색
  biscuitLineColor: "#7a4a21", // 비스킷 테두리 + 도트(구멍) 색
  romanAlign: "center", // 로마숫자 정렬: "left" | "center" | "right"
  backToToc: true, // 제목을 누르면 목차로 돌아가기
  biscuitScale: 0.32, // 비스킷 크기 배율 (1 = 320x200 원본 비율 그대로)
  frontmatterSuggest: true, // frontmatter에 toc 를 칠 때 추천 팝업
};

// 플러그인 인스턴스의 app (이미지 경로 변환용)
let APP = null;

/* ---------- 유틸 ---------- */

// toc: 4 / "3-4" / "3, 4" / [3, 4] / "####" / true  →  [3, 4] 같은 레벨 배열
function parseLevels(value, fallbackSpec) {
  if (value === true) value = fallbackSpec;
  if (value === undefined || value === null || value === false) return null;
  const out = new Set();
  const add = (v) => {
    if (Array.isArray(v)) return v.forEach(add);
    if (typeof v === "number") {
      if (v >= 1 && v <= 6) out.add(Math.floor(v));
      return;
    }
    if (typeof v !== "string") return;
    const normalized = v.replace(/\s*[-~]\s*/g, "-");
    for (let part of normalized.split(/[,\s]+/)) {
      part = part.trim();
      if (!part) continue;
      if (/^#{1,6}$/.test(part)) {
        out.add(part.length);
        continue;
      }
      const range = /^h?([1-6])-h?([1-6])$/i.exec(part);
      if (range) {
        let a = +range[1];
        let b = +range[2];
        if (a > b) [a, b] = [b, a];
        for (let l = a; l <= b; l++) out.add(l);
        continue;
      }
      const single = /^h?([1-6])$/i.exec(part);
      if (single) out.add(+single[1]);
    }
  };
  add(value);
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

function validColor(v) {
  if (typeof v !== "string") return null;
  v = v.trim();
  if (!v) return null;
  try {
    return CSS.supports("color", v) ? v : null;
  } catch (e) {
    return null;
  }
}

// "[[img.png]]" / "img.png" / "folder/img.png" / "https://..." → 사용 가능한 URL
function resolveImage(value, sourcePath) {
  // YAML에서 [[img.png]] 는 중첩 배열로 읽히므로 문자열로 풀어준다
  while (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") return null;
  let v = value.trim().replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
  v = v.replace(/^["']|["']$/g, "");
  if (!v) return null;
  if (/^(https?:|data:)/i.test(v)) return v;
  if (!APP) return null;
  let file = APP.metadataCache.getFirstLinkpathDest(v, sourcePath || "");
  if (!file) {
    const f = APP.vault.getAbstractFileByPath(v);
    if (f && f.extension) file = f;
  }
  return file ? APP.vault.getResourcePath(file) : null;
}

function getConfig(fm, settings, sourcePath) {
  if (!fm) return null;
  const levels = parseLevels(fm.toc, settings.defaultLevels);
  if (!levels) return null;
  let title = fm["toc-title"];
  if (title === false) title = "";
  else if (title === undefined || title === null || title === true) title = settings.defaultTitle;
  else title = String(title);

  // 작은 윗줄 문구 ("Table of")
  // toc-title 을 직접 지정하면 기본적으로 숨김 (toc-eyebrow 를 따로 쓰면 그대로 표시)
  const rawTitle = fm["toc-title"];
  const customTitle = rawTitle !== undefined && rawTitle !== null && rawTitle !== true && rawTitle !== false;
  let eyebrow = fm["toc-eyebrow"];
  if (eyebrow === false) eyebrow = "";
  else if (eyebrow === true) eyebrow = "Table of";
  else if (eyebrow === undefined || eyebrow === null) eyebrow = customTitle ? "" : "Table of";
  else eyebrow = String(eyebrow);

  // 배너 색: frontmatter > 플러그인 설정 > 기본 회색
  const color = validColor(fm["toc-color"]) || validColor(settings.bannerColor) || "#8a8a8a";
  const textColor =
    validColor(fm["toc-text-color"]) || validColor(settings.bannerTextColor) || "#ffffff";

  // 로마숫자 정렬: frontmatter > 플러그인 설정 > 가운데
  const alignOf = (v) => {
    v = String(v == null ? "" : v).trim().toLowerCase();
    if (["left", "왼쪽"].includes(v)) return "left";
    if (["right", "오른쪽"].includes(v)) return "right";
    if (["center", "centre", "middle", "가운데", "중앙"].includes(v)) return "center";
    return null;
  };
  const romanAlign = alignOf(fm["toc-roman-align"]) || alignOf(settings.romanAlign) || "center";

  // 비스킷 색: frontmatter > 플러그인 설정 > 기본값
  const biscuitColor =
    validColor(fm["toc-biscuit-color"]) || validColor(settings.biscuitColor) || "#f0cf94";
  const biscuitLine =
    validColor(fm["toc-biscuit-line"]) || validColor(settings.biscuitLineColor) || "#7a4a21";
  let biscuitScale = Number(settings.biscuitScale);
  if (!isFinite(biscuitScale) || biscuitScale <= 0) biscuitScale = 0.32;
  biscuitScale = Math.min(1.5, Math.max(0.2, biscuitScale));

  // 배경 이미지: frontmatter > 설정 기본 이미지 (toc-image: false 로 끌 수 있음)
  let image = null;
  if (fm["toc-image"] !== false) {
    const raw = fm["toc-image"] !== undefined && fm["toc-image"] !== null && fm["toc-image"] !== true
      ? fm["toc-image"]
      : settings.defaultImage;
    if (raw) image = resolveImage(raw, sourcePath);
  }

  // 스타일: banner(박스) | text(UnifrakturMaguntia CONTENTS, 눌러서 펼침)
  let style = String(fm["toc-style"] || "").trim().toLowerCase();
  if (["text", "fraktur", "blackletter", "link"].includes(style)) style = "text";
  else if (["list", "plain", "none", "notitle"].includes(style)) style = "list";
  else if (["biscuit", "cookie", "비스킷"].includes(style)) style = "biscuit";
  else if (["banner", "box"].includes(style)) style = "banner";
  else style = ["text", "list", "biscuit"].includes(settings.tocStyle) ? settings.tocStyle : "banner";

  // list / biscuit 스타일: 제목 없음
  if (style === "list" || style === "biscuit") title = "";

  // 점선: toc-line: false 로 끄면 위키피디아식 목록
  let line = settings.showLine !== false;
  if (fm["toc-line"] === false || /^(false|off|no|none)$/i.test(String(fm["toc-line"]))) line = false;
  else if (fm["toc-line"] === true || /^(true|on|yes)$/i.test(String(fm["toc-line"]))) line = true;

  // 접힘: 명시하면 그대로, 아니면 text 스타일은 접힌 채로 / banner 는 펼친 채로
  let collapsed = style === "text" || style === "biscuit";
  if (fm["toc-collapsed"] === true) collapsed = true;
  else if (fm["toc-collapsed"] === false) collapsed = false;

  // 시작 번호: toc-start: 4 → Ⅳ 부터 시작 (2권이 5장부터 시작할 때 등)
  let start = parseInt(fm["toc-start"], 10);
  if (!Number.isFinite(start) || start < 1) start = 1;
  if (start > 3000) start = 3000;

  return {
    levels, title, eyebrow, color, textColor, image, collapsed, style, line,
    biscuitColor, biscuitLine, biscuitScale, romanAlign, start,
  };
}

function cleanHeading(text) {
  return text
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|==|[*`])/g, "")
    .trim();
}

function pickItems(headings, levels) {
  return headings
    .filter((h) => levels.includes(h.level))
    .map((h) => ({ ...h, rank: levels.indexOf(h.level) }));
}

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/* ---------- 목차 (스케치 스타일) ---------- */

function toRoman(n) {
  const map = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [v, s] of map) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

function buildSketch(root, cfg, items, onClick) {
  const useDetails = cfg.style === "biscuit" || !!cfg.title;
  const box = useDetails ? document.createElement("details") : document.createElement("div");
  box.className =
    "fm-toc-sketch fm-toc-st-" + cfg.style + (cfg.line ? " has-line" : " no-line") + " roman-" + cfg.romanAlign;

  // 로마 숫자 칸 너비: 대제목이 많아 숫자가 길어지면(VIII 등) 칸을 넓혀서
  // 점선 시작점과 소제목 시작점이 항상 같은 위치가 되게 한다
  const majorCount = items.filter((it) => it.rank === 0).length;
  let longest = 1;
  for (let i = 0; i < majorCount; i++) longest = Math.max(longest, toRoman(i + (cfg.start || 1)).length);
  box.style.setProperty("--fm-toc-roman-w", "max(2rem, " + (longest * 0.55 + 0.5).toFixed(2) + "rem)");

  if (cfg.style === "biscuit") {
    // 비스킷 로고 — 눌러서 펼치기 (제목 글자 없음)
    if (!cfg.collapsed) box.open = true;
    const summary = document.createElement("summary");
    summary.className = "fm-toc-biscuit";
    summary.setAttribute("aria-label", "목차 열기/닫기");
    summary.style.setProperty("--fm-bs-color", cfg.biscuitColor);
    summary.style.setProperty("--fm-bs-line", cfg.biscuitLine);
    summary.style.setProperty("--fm-bs-scale", String(cfg.biscuitScale));
    box.appendChild(summary);
  } else if (cfg.title && cfg.style === "text") {
    // CONTENTS (UnifrakturMaguntia) — 눌러서 펼치기
    if (!cfg.collapsed) box.open = true;
    const summary = document.createElement("summary");
    summary.className = "fm-toc-fk-summary";
    summary.textContent = cfg.title;
    box.appendChild(summary);
  } else if (cfg.title) {
    if (!cfg.collapsed) box.open = true;
    const banner = document.createElement("summary");
    banner.className = "fm-toc-sk-banner";
    banner.style.setProperty("--fm-toc-bg", cfg.color);
    banner.style.setProperty("--fm-toc-fg", cfg.textColor);
    if (cfg.image) {
      banner.classList.add("has-image");
      banner.style.backgroundImage = 'url("' + cfg.image.replace(/"/g, "%22") + '")';
    }

    if (cfg.eyebrow) {
      const eyebrow = document.createElement("span");
      eyebrow.className = "fm-toc-sk-eyebrow";
      eyebrow.textContent = cfg.eyebrow;
      banner.appendChild(eyebrow);
    }
    const title = document.createElement("span");
    title.className = "fm-toc-sk-heading";
    title.textContent = cfg.title;
    banner.appendChild(title);

    box.appendChild(banner);
  }

  const content = document.createElement("div");
  content.className = "fm-toc-sk-content";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "fm-toc-empty";
    empty.textContent =
      "선택한 레벨(" + cfg.levels.map((l) => "#".repeat(l)).join(", ") + ")의 제목이 없어요";
    content.appendChild(empty);
  } else {
    // 레벨(rank)마다 따로 번호를 센다.
    // 상위 제목이 나오면 그 아래 레벨의 번호는 01부터 다시 시작.
    const counts = [0, 0, 0, 0, 0, 0, 0];

    items.forEach((it) => {
      counts[it.rank]++;
      for (let r = it.rank + 1; r < counts.length; r++) counts[r] = 0;

      const row = document.createElement("a");
      row.href = "#";

      const label = document.createElement("span");
      const text = document.createElement("span");

      if (it.rank === 0) {
        // 대제목: Ⅰ ------------ 제목
        row.className = "fm-toc-sk-major";
        label.className = "fm-toc-sk-roman";
        label.textContent = toRoman(counts[0] + (cfg.start || 1) - 1);
        text.className = "fm-toc-sk-title";
        text.textContent = it.text;

        const dots = document.createElement("span");
        dots.className = "fm-toc-sk-dots";

        row.appendChild(label);
        row.appendChild(dots);
        row.appendChild(text);
      } else {
        // 소제목: 01 작은 소제목 (대제목마다 번호 초기화)
        row.className = "fm-toc-sk-minor";
        // 들여쓰기는 rem 고정값(글씨가 작아져도 간격 유지), 깊어질수록 글씨 조금씩 작게
        row.style.paddingLeft =
          "calc(var(--fm-toc-sk-sub-indent, 3.6rem) + 0.94rem * " + (it.rank - 1) + ")";
        row.style.fontSize = Math.max(0.64, 0.78 - 0.045 * (it.rank - 1)).toFixed(3) + "rem";
        label.className = "fm-toc-sk-subnum";
        label.textContent = String(counts[it.rank]).padStart(2, "0");
        text.className = "fm-toc-sk-subtitle";
        text.textContent = it.text;

        row.appendChild(label);
        row.appendChild(text);
      }

      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(it);
      });

      content.appendChild(row);
    });
  }

  box.appendChild(content);
  root.appendChild(box);
}

function buildToc(root, cfg, items, onClick) {
  clearEl(root);
  root.classList.add("fm-toc-wrap");
  buildSketch(root, cfg, items, onClick);
}

// 에디터 문서(CodeMirror)에서 frontmatter와 제목을 직접 읽는다 (라이브 프리뷰용)
function scanDoc(doc, settings, path) {
  const n = doc.lines;
  if (n < 2 || doc.line(1).text.trim() !== "---") return null;

  let fmEnd = -1;
  for (let i = 2; i <= n; i++) {
    const t = doc.line(i).text.trim();
    if (t === "---" || t === "...") {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd < 0) return null;

  const yaml = [];
  for (let i = 2; i < fmEnd; i++) yaml.push(doc.line(i).text);
  let fm = null;
  try {
    fm = parseYaml(yaml.join("\n"));
  } catch (e) {
    return null;
  }
  const cfg = getConfig(fm, settings, path);
  if (!cfg) return null;

  const headings = [];
  let fence = null;
  for (let i = fmEnd + 1; i <= n; i++) {
    const text = doc.line(i).text;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (m && m[2].trim()) {
      headings.push({ level: m[1].length, text: cleanHeading(m[2]), line: i - 1 });
    }
  }

  // 본문에 ```toc 코드블록이 있으면 그 자리에 목차를 놓는다 (맨 위 자동 삽입은 하지 않음)
  let marker = false;
  for (let i = fmEnd + 1; i <= n; i++) {
    if (/^\s{0,3}(`{3,}|~{3,})\s*toc\s*$/i.test(doc.line(i).text)) {
      marker = true;
      break;
    }
  }

  const pos = fmEnd < n ? doc.line(fmEnd + 1).from : doc.length;
  const side = fmEnd < n ? -1 : 1;
  return { cfg, items: pickItems(headings, cfg.levels), pos, side, marker };
}

/* ---------- 읽기 모드용 ---------- */

// 읽기 모드: 목차 위치로 스크롤 (목차가 안 보이면 맨 위로)
// 부드러운 스크롤(smooth)은 모바일에서 읽기 모드가 구간을 늦게 그리느라 높이가 바뀌면
// 도중에 멈춰버려서, 즉시 이동 + 도착 위치를 몇 번 다시 확인하는 방식으로 처리한다.
function scrollBackToToc(fromEl) {
  const scroller = fromEl.closest(".markdown-preview-view");
  if (!scroller) return;
  const targetTop = () => {
    const holder = scroller.querySelector(".fm-toc-holder");
    if (!holder) return 0;
    const top =
      holder.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      16;
    return Math.max(0, Math.round(top));
  };
  const go = () => {
    scroller.scrollTop = targetTop();
  };
  go();
  [60, 200, 450].forEach((ms) =>
    setTimeout(() => {
      if (Math.abs(scroller.scrollTop - targetTop()) > 2) go();
    }, ms)
  );
}

function hasTocMarker(text) {
  return typeof text === "string" && /^\s{0,3}(`{3,}|~{3,})\s*toc\s*$/im.test(text);
}

class TocChild extends MarkdownRenderChild {
  constructor(el, plugin, path, initialFm) {
    super(el);
    this.plugin = plugin;
    this.path = path;
    this.initialFm = initialFm;
  }

  onload() {
    this.render();
    this.registerEvent(
      this.plugin.app.metadataCache.on("changed", (file) => {
        if (file.path === this.path) this.render();
      })
    );
  }

  render() {
    const cache = this.plugin.app.metadataCache.getCache(this.path);
    const fm = (cache && cache.frontmatter) || this.initialFm;
    const cfg = getConfig(fm, this.plugin.settings, this.path);
    if (!cfg) {
      clearEl(this.containerEl);
      this.containerEl.classList.remove("fm-toc-wrap");
      return;
    }
    const headings = ((cache && cache.headings) || []).map((h) => ({
      level: h.level,
      text: cleanHeading(h.heading),
      line: h.position.start.line,
    }));
    buildToc(this.containerEl, cfg, pickItems(headings, cfg.levels), (it) =>
      this.plugin.goTo(this.path, it.line)
    );
  }
}

/* ---------- frontmatter 입력 추천 (EditorSuggest) ---------- */

const TOC_KEYS = [
  { key: "toc", desc: "목차 켜기 · 포함할 제목 레벨 (예: 3, 2-3)" },
  { key: "toc-style", desc: "모양: banner · text · list · biscuit" },
  { key: "toc-line", desc: "점선 표시 (false면 위키식 목록)" },
  { key: "toc-roman-align", desc: "로마숫자 정렬: left · center · right" },
  { key: "toc-title", desc: "배너 / CONTENTS 제목 문구" },
  { key: "toc-eyebrow", desc: "제목 위 작은 문구 (Table of)" },
  { key: "toc-color", desc: "배너 배경색" },
  { key: "toc-text-color", desc: "배너 글자색" },
  { key: "toc-image", desc: "배너 배경 이미지 (false로 끄기)" },
  { key: "toc-biscuit-color", desc: "비스킷 색" },
  { key: "toc-biscuit-line", desc: "비스킷 테두리 / 도트 색" },
  { key: "toc-collapsed", desc: "처음부터 접어두기" },
  { key: "toc-start", desc: "로마숫자 시작 번호 (4 → Ⅳ부터)" },
];

// 추천 색상 팔레트 (이름, 색)
const COLOR_SETS = {
  "toc-color": [
    ["회색 (기본)", "#8a8a8a"], ["카멜", "#c9a66b"], ["더스티 블루", "#6b8e9c"], ["세이지", "#8f9e7e"],
    ["더스티 로즈", "#b5838d"], ["인디고", "#4a4e69"], ["차콜", "#2f2f2f"], ["화이트", "#ffffff"],
  ],
  "toc-text-color": [
    ["화이트 (기본)", "#ffffff"], ["블랙", "#000000"], ["크림", "#f5f0e6"], ["차콜", "#2f2f2f"],
  ],
  "toc-biscuit-color": [
    ["기본 비스킷", "#f0cf94"], ["크림", "#f5e6c8"], ["오트밀", "#d9c8a9"], ["캐러멜", "#c9a27a"], ["살구", "#e8b4a0"],
  ],
  "toc-biscuit-line": [
    ["기본 갈색", "#7a4a21"], ["진한 갈색", "#4a2c17"], ["모카", "#8a6d5a"], ["회색", "#555555"],
  ],
};

function levelDesc(spec) {
  const lv = parseLevels(spec);
  return lv ? lv.map((l) => "#".repeat(l)).join(", ") + " 제목" : "";
}

// 키별로 추천할 값 목록
function tocValueOptions(key, settings) {
  const opt = (label, insert, desc, extra, search) => ({
    type: "value",
    label,
    insert,
    desc: desc || "",
    extra: extra || null,
    search: (search || label + " " + insert).toLowerCase(),
  });
  const bool = (t, f) => [opt("true", "true", t), opt("false", "false", f)];

  switch (key) {
    case "toc": {
      const d = String(settings.defaultLevels || "3");
      const out = [opt("true", "true", "기본 레벨 사용 · " + levelDesc(d))];
      ["2", "3", "1-2", "2-3", "3-4"].forEach((v) => out.push(opt(v, v, levelDesc(v))));
      // 프리셋: toc 값과 함께 다른 줄도 같이 채워준다
      out.push(
        opt("🅱 프리셋 · 박스 배너", d, "회색 박스 배너 + 점선", { "toc-style": "banner" }, "프리셋 preset 배너 banner 박스"),
        opt("🅲 프리셋 · CONTENTS 글자", d, "고딕체 CONTENTS, 눌러서 펼침", { "toc-style": "text" }, "프리셋 preset 글자 text contents"),
        opt("🍪 프리셋 · 비스킷", d, "비스킷 모양, 눌러서 펼침", { "toc-style": "biscuit" }, "프리셋 preset 비스킷 biscuit cookie"),
        opt("📄 프리셋 · 목차만", d, "제목 없이 목록만", { "toc-style": "list" }, "프리셋 preset 목차만 list"),
        opt("📃 프리셋 · 위키식 목록", d, "제목 없음 + 점선 없음", { "toc-style": "list", "toc-line": "false" }, "프리셋 preset 위키 wiki 점선")
      );
      return out;
    }
    case "toc-style":
      return [
        opt("banner", "banner", "회색 박스 배너 (제목 줄 있음)"),
        opt("text", "text", "CONTENTS 고딕체 글자, 눌러서 펼침"),
        opt("list", "list", "제목 없이 목차만"),
        opt("biscuit", "biscuit", "비스킷 모양, 눌러서 펼침"),
      ];
    case "toc-line":
      return bool("점선 있음 (Ⅰ ----- 제목)", "점선 없음 (위키식 목록)");
    case "toc-collapsed":
      return bool("처음부터 접어두기", "처음부터 펼쳐두기");
    case "toc-roman-align":
      return [opt("left", "left", "왼쪽"), opt("center", "center", "가운데"), opt("right", "right", "오른쪽")];
    case "toc-title":
      return [
        opt("Contents", "Contents", "영문 기본"),
        opt("목차", "목차"),
        opt("차례", "차례"),
        opt("false", "false", "제목 줄 없애기"),
      ];
    case "toc-eyebrow":
      return [opt("Table of", '"Table of"', "제목 위 작은 문구"), opt("false", "false", "윗줄 숨기기")];
    case "toc-image":
      return [opt("false", "false", "이 노트에서는 배경 이미지 끄기")];
    case "toc-start":
      return ["1", "2", "3", "5"].map((n) => opt(n, n, toRoman(+n) + " 부터 시작"));
    case "toc-color":
    case "toc-text-color":
    case "toc-biscuit-color":
    case "toc-biscuit-line":
      return COLOR_SETS[key].map(([name, hex]) => ({
        type: "value",
        label: name + "  " + hex,
        insert: '"' + hex + '"', // # 는 YAML에서 주석이라 따옴표 필수
        desc: "",
        swatch: hex,
        extra: null,
        search: (name + " " + hex).toLowerCase(),
      }));
    default:
      return [];
  }
}

// frontmatter 안에서 key 줄을 찾아 값을 바꾸고, 없으면 닫는 --- 바로 위에 추가
function setFmKey(editor, key, value) {
  const n = editor.lineCount();
  let end = -1;
  for (let i = 1; i < n; i++) {
    const t = editor.getLine(i).trim();
    if (t === "---" || t === "...") {
      end = i;
      break;
    }
  }
  const last = end > 0 ? end : n;
  for (let i = 1; i < last; i++) {
    if (editor.getLine(i).startsWith(key + ":")) {
      editor.setLine(i, key + ": " + value);
      return;
    }
  }
  const at = Math.min(last, n) - 1;
  editor.replaceRange("\n" + key + ": " + value, { line: at, ch: editor.getLine(at).length });
}

class TocSuggest extends EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor) {
    if (this.plugin.settings.frontmatterSuggest === false) return null;
    if (cursor.line < 1) return null;
    if (editor.getLine(0).trim() !== "---") return null;
    // 커서가 frontmatter 안에 있어야 함
    for (let i = 1; i < cursor.line; i++) {
      const t = editor.getLine(i).trim();
      if (t === "---" || t === "...") return null;
    }
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);

    // 값 입력 중:  toc: |   /   toc-style: bi|
    const v = /^(toc(?:-[a-z-]*)?):([ \t]*)(.*)$/i.exec(before);
    if (v) {
      return {
        start: { line: cursor.line, ch: before.length - v[3].length },
        end: { line: cursor.line, ch: line.length },
        query: v[3],
      };
    }
    // 키 입력 중:  toc  /  toc-st
    if (/^toc(?:-[a-z-]*)?$/i.test(before)) {
      return {
        start: { line: cursor.line, ch: 0 },
        end: { line: cursor.line, ch: line.length },
        query: before,
      };
    }
    return null;
  }

  getSuggestions(ctx) {
    const editor = ctx.editor;
    const lineNo = ctx.start.line;

    if (ctx.start.ch === 0) {
      // 키 추천 (이미 쓴 키는 제외)
      const present = new Set();
      for (let i = 1; i < editor.lineCount(); i++) {
        const t = editor.getLine(i);
        if (t.trim() === "---" || t.trim() === "...") break;
        if (i === lineNo) continue;
        const m = /^([\w-]+)\s*:/.exec(t);
        if (m) present.add(m[1]);
      }
      const q = ctx.query.toLowerCase();
      return TOC_KEYS.filter((k) => k.key.startsWith(q) && !present.has(k.key)).map((k) => ({
        type: "key",
        key: k.key,
        label: k.key,
        desc: k.desc,
      }));
    }

    const m = /^(toc(?:-[a-z-]*)?):/i.exec(editor.getLine(lineNo));
    if (!m) return [];
    const q = ctx.query.replace(/["']/g, "").trim().toLowerCase();
    return tocValueOptions(m[1].toLowerCase(), this.plugin.settings).filter((o) => !q || o.search.includes(q));
  }

  renderSuggestion(item, el) {
    el.addClass("fm-toc-sg");
    if (item.swatch) {
      const sw = el.createSpan({ cls: "fm-toc-sg-swatch" });
      sw.style.backgroundColor = item.swatch;
    }
    el.createSpan({ cls: "fm-toc-sg-label", text: item.label });
    if (item.desc) el.createDiv({ cls: "fm-toc-sg-desc", text: item.desc });
  }

  selectSuggestion(item) {
    const ctx = this.context;
    if (!ctx) return;
    const editor = ctx.editor;
    const lineNo = ctx.start.line;
    this.close();

    if (item.type === "key") {
      editor.replaceRange(item.key + ": ", ctx.start, ctx.end);
      editor.setCursor({ line: lineNo, ch: item.key.length + 2 });
      return;
    }

    editor.replaceRange(item.insert, ctx.start, ctx.end);
    if (item.extra) {
      for (const [k, val] of Object.entries(item.extra)) setFmKey(editor, k, val);
    }
    editor.setCursor({ line: lineNo, ch: ctx.start.ch + item.insert.length });
  }
}

/* ---------- 목차 설정 만들기 (모달 + 미리보기) ---------- */

const MANAGED_KEYS = [
  "toc-style", "toc-line", "toc-roman-align", "toc-title",
  "toc-color", "toc-text-color", "toc-biscuit-color", "toc-biscuit-line",
];

const SAMPLE_ITEMS = [
  { rank: 0, level: 2, text: "서장", line: 0 },
  { rank: 1, level: 3, text: "첫 번째 장면", line: 1 },
  { rank: 1, level: 3, text: "두 번째 장면", line: 2 },
  { rank: 0, level: 2, text: "본문", line: 3 },
  { rank: 1, level: 3, text: "이어지는 이야기", line: 4 },
  { rank: 0, level: 2, text: "종장", line: 5 },
];

const asHex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : fallback);

class TocBuilderModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;

    // 이미 설정이 있으면 그 값으로 시작
    const s = plugin.settings;
    const cache = app.metadataCache.getFileCache(file);
    const fm = (cache && cache.frontmatter) || {};
    const has = fm.toc !== undefined && fm.toc !== null && fm.toc !== false;
    let cfg = null;
    try {
      cfg = getConfig({ ...fm, toc: has ? fm.toc : true }, s, file.path);
    } catch (e) {
      cfg = null;
    }
    let levels = String(s.defaultLevels || "3");
    if (has && fm.toc !== true) levels = Array.isArray(fm.toc) ? fm.toc.join(",") : String(fm.toc);

    this.state = {
      levels,
      style: cfg ? cfg.style : "banner",
      line: cfg ? cfg.line : s.showLine !== false,
      romanAlign: cfg ? cfg.romanAlign : s.romanAlign || "center",
      title: typeof fm["toc-title"] === "string" ? fm["toc-title"] : s.defaultTitle,
      color: asHex(cfg && cfg.color, asHex(s.bannerColor, "#8a8a8a")),
      textColor: asHex(cfg && cfg.textColor, asHex(s.bannerTextColor, "#ffffff")),
      biscuitColor: asHex(cfg && cfg.biscuitColor, asHex(s.biscuitColor, "#f0cf94")),
      biscuitLine: asHex(cfg && cfg.biscuitLine, asHex(s.biscuitLineColor, "#7a4a21")),
    };
  }

  // 플러그인 기본값과 다른 것만 frontmatter에 쓴다 (깔끔하게 유지)
  toFm() {
    const st = this.state;
    const s = this.plugin.settings;
    const out = {};
    const lv = String(st.levels || "").trim();
    if (lv && parseLevels(lv)) out.toc = /^[1-6]$/.test(lv) ? Number(lv) : lv;
    else out.toc = true;

    out["toc-style"] = st.style;
    if (st.line !== (s.showLine !== false)) out["toc-line"] = st.line;
    if (st.romanAlign !== (s.romanAlign || "center")) out["toc-roman-align"] = st.romanAlign;

    const differs = (a, b) => String(a).toLowerCase() !== String(b || "").toLowerCase();
    if (st.style === "banner" || st.style === "text") {
      if (st.title !== s.defaultTitle) out["toc-title"] = st.title === "" ? false : st.title;
    }
    if (st.style === "banner") {
      if (differs(st.color, s.bannerColor)) out["toc-color"] = st.color;
      if (differs(st.textColor, s.bannerTextColor)) out["toc-text-color"] = st.textColor;
    }
    if (st.style === "biscuit") {
      if (differs(st.biscuitColor, s.biscuitColor)) out["toc-biscuit-color"] = st.biscuitColor;
      if (differs(st.biscuitLine, s.biscuitLineColor)) out["toc-biscuit-line"] = st.biscuitLine;
    }
    return out;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("fm-toc-modal");
    contentEl.empty();
    new Setting(contentEl).setName("목차 설정 만들기").setHeading();
    this.controlsEl = contentEl.createDiv();
    contentEl.createEl("div", { cls: "fm-toc-modal-label", text: "미리보기" });
    this.previewEl = contentEl.createDiv({ cls: "fm-toc-modal-preview" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("취소").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("이 노트에 적용").setCta().onClick(() => this.apply()));
    this.renderControls();
    this.renderPreview();
  }

  onClose() {
    this.contentEl.empty();
  }

  renderControls() {
    const el = this.controlsEl;
    el.empty();
    const st = this.state;
    const refresh = () => this.renderPreview();

    new Setting(el).setName("모양").addDropdown((d) =>
      d
        .addOption("banner", "박스 배너")
        .addOption("text", "CONTENTS 글자")
        .addOption("list", "제목 없이 목차만")
        .addOption("biscuit", "비스킷")
        .setValue(st.style)
        .onChange((v) => {
          st.style = v;
          this.renderControls();
          refresh();
        })
    );

    new Setting(el)
      .setName("제목 레벨")
      .setDesc("예: 3 · 2-3 · 2, 4")
      .addText((t) =>
        t.setValue(st.levels).onChange((v) => {
          st.levels = v;
          refresh();
        })
      );

    new Setting(el).setName("점선").addToggle((t) =>
      t.setValue(st.line).onChange((v) => {
        st.line = v;
        refresh();
      })
    );

    new Setting(el).setName("로마숫자 정렬").addDropdown((d) =>
      d
        .addOption("left", "왼쪽")
        .addOption("center", "가운데")
        .addOption("right", "오른쪽")
        .setValue(st.romanAlign)
        .onChange((v) => {
          st.romanAlign = v;
          refresh();
        })
    );

    if (st.style === "banner" || st.style === "text") {
      new Setting(el)
        .setName("제목 문구")
        .setDesc("비우면 제목 줄이 사라져요")
        .addText((t) =>
          t.setValue(st.title).onChange((v) => {
            st.title = v;
            refresh();
          })
        );
    }

    const color = (name, key) =>
      new Setting(el).setName(name).addColorPicker((c) =>
        c.setValue(st[key]).onChange((v) => {
          st[key] = v;
          refresh();
        })
      );

    if (st.style === "banner") {
      color("박스 색상", "color");
      color("박스 글자색", "textColor");
    }
    if (st.style === "biscuit") {
      color("비스킷 색상", "biscuitColor");
      color("비스킷 테두리 / 도트 색상", "biscuitLine");
    }
  }

  renderPreview() {
    const el = this.previewEl;
    el.empty();
    try {
      const cfg = getConfig(this.toFm(), this.plugin.settings, this.file.path);
      if (!cfg) return;
      cfg.collapsed = false; // 미리보기는 항상 펼쳐서 보여줌
      const holder = el.createDiv({ cls: "fm-toc-holder" });
      const inner = holder.createDiv();
      const items = SAMPLE_ITEMS.map((it) => ({ ...it, rank: Math.min(it.rank, cfg.levels.length - 1) }));
      buildToc(inner, cfg, cfg.levels.length > 1 ? items : items.filter((it) => it.rank === 0), () => {});
    } catch (e) {
      console.error("[heading-toc]", e);
    }
  }

  async apply() {
    const out = this.toFm();
    try {
      await this.app.fileManager.processFrontMatter(this.file, (fm) => {
        for (const k of MANAGED_KEYS) {
          if (k in out) fm[k] = out[k];
          else delete fm[k];
        }
        fm.toc = out.toc;
      });
      new Notice("목차 설정을 넣었어요");
      this.close();
    } catch (e) {
      console.error("[heading-toc]", e);
      new Notice("적용 중 오류가 났어요 (콘솔 확인)");
    }
  }
}

/* ---------- 플러그인 ---------- */

module.exports = class HeadingTocPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settingsVersion = 0;
    APP = this.app;

    // 읽기 모드
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const fm = ctx.frontmatter;
      const tocCfg = getConfig(fm, this.settings, ctx.sourcePath);
      if (!tocCfg) return;
      this.attachBackToToc(el, tocCfg);
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      // ```toc 로 위치를 직접 지정한 노트는 맨 위 자동 삽입을 건너뜀
      // (info.text 가 비어 있는 경우를 대비해 파일 내용을 직접 읽어 확인)
      let fullText = info.text;
      if (typeof fullText !== "string" || !fullText) {
        try {
          const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (f) fullText = await this.app.vault.cachedRead(f);
        } catch (e) {
          fullText = "";
        }
      }
      if (hasTocMarker(fullText)) return;
      const cache = this.app.metadataCache.getCache(ctx.sourcePath);
      const first = cache && cache.sections && cache.sections.find((s) => s.type !== "yaml");
      if (!first || first.position.start.line !== info.lineStart) return;

      const holder = document.createElement("div");
      holder.className = "fm-toc-holder";
      el.prepend(holder);
      ctx.addChild(new TocChild(holder, this, ctx.sourcePath, fm));
    });

    // ```toc 코드블록: 원하는 위치에 목차 놓기 (읽기 모드 + 라이브 프리뷰)
    this.registerMarkdownCodeBlockProcessor("toc", (source, el, ctx) => {
      // 코드블록 처리기에서는 ctx.frontmatter 가 비어 있을 수 있어서 캐시에서도 찾는다
      const cache = this.app.metadataCache.getCache(ctx.sourcePath);
      const fm = ctx.frontmatter || (cache && cache.frontmatter) || null;
      const holder = document.createElement("div");
      holder.className = "fm-toc-holder";
      el.appendChild(holder);
      ctx.addChild(new TocChild(holder, this, ctx.sourcePath, fm));
    });

    // 라이브 프리뷰
    this.registerEditorExtension(this.buildEditorExtension());

    // frontmatter 에 toc / toc-style: 등을 치면 추천 팝업
    this.registerEditorSuggest(new TocSuggest(this.app, this));

    // 명령어: 스타일/색/레벨을 골라서 현재 노트 frontmatter 에 넣기
    this.addCommand({
      id: "toc-builder",
      name: "목차 설정 만들기 (스타일 · 색상 · 미리보기)",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (!checking) new TocBuilderModal(this.app, this, f).open();
        return true;
      },
    });

    this.addSettingTab(new TocSettingTab(this.app, this));
  }

  // 읽기 모드: 목차에 포함된 레벨의 제목을 누르면 목차로 돌아가기
  attachBackToToc(el, cfg) {
    el.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const level = +h.tagName[1];
      if (!cfg.levels.includes(level) || h.dataset.fmTocBack) return;
      h.dataset.fmTocBack = "1";
      h.classList.add("fm-toc-back-target");
      h.addEventListener("click", (e) => {
        if (this.settings.backToToc === false) return;
        if (e.target.closest && e.target.closest("a, .heading-collapse-indicator")) return;
        const sel = window.getSelection();
        if (sel && sel.toString()) return; // 글자를 드래그해서 선택 중이면 무시
        scrollBackToToc(h);
      });
    });
  }

  // 라이브 프리뷰: 에디터에서 목차 위치로 스크롤
  scrollToLiveToc(view) {
    // 에디터는 필요한 구간만 그리기 때문에, 먼저 맨 위로 이동시킨 뒤 목차 위치를 맞춘다
    view.dispatch({ effects: EditorView.scrollIntoView(0, { y: "start" }) });
    [0, 60, 200].forEach((ms) =>
      setTimeout(() => {
        const h = view.dom.querySelector(".fm-toc-holder");
        if (h) h.scrollIntoView({ behavior: "instant", block: "start" });
      }, ms)
    );
  }

  buildEditorExtension() {
    const plugin = this;

    class TocWidget extends WidgetType {
      constructor(cfg, items, path) {
        super();
        this.cfg = cfg;
        this.items = items;
        this.path = path;
        this.key = JSON.stringify([cfg, items, path]);
      }
      eq(other) {
        return other.key === this.key;
      }
      toDOM() {
        const holder = document.createElement("div");
        holder.className = "fm-toc-holder";
        holder.addEventListener("mousedown", (e) => e.preventDefault());
        const root = document.createElement("div");
        buildToc(root, this.cfg, this.items, (it) => plugin.goTo(this.path, it.line));
        holder.appendChild(root);
        return holder;
      }
      ignoreEvent() {
        return true;
      }
    }

    const compute = (state) => {
      try {
        if (!plugin.settings.livePreview) return Decoration.none;
        if (!state.field(editorLivePreviewField, false)) return Decoration.none;
        const info = state.field(editorInfoField, false);
        const path = (info && info.file && info.file.path) || "";
        const scan = scanDoc(state.doc, plugin.settings, path);
        if (!scan || scan.marker) return Decoration.none;
        const widget = new TocWidget(scan.cfg, scan.items, path);
        return Decoration.set([
          Decoration.widget({ widget, block: true, side: scan.side }).range(scan.pos),
        ]);
      } catch (e) {
        console.error("[heading-toc]", e);
        return Decoration.none;
      }
    };

    const safeLp = (state) => {
      try {
        return state.field(editorLivePreviewField, false);
      } catch (e) {
        return undefined;
      }
    };

    const field = StateField.define({
      create(state) {
        return { deco: compute(state), lp: safeLp(state), v: plugin.settingsVersion };
      },
      update(val, tr) {
        const lp = safeLp(tr.state);
        if (!tr.docChanged && lp === val.lp && val.v === plugin.settingsVersion) return val;
        return { deco: compute(tr.state), lp, v: plugin.settingsVersion };
      },
      provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
    });

    // 라이브 프리뷰: Ctrl/Cmd + 제목 클릭 → 목차로
    // (그냥 클릭은 제목을 고치려고 커서를 놓는 동작이라 겹치지 않게 보조키를 사용)
    const handlers = EditorView.domEventHandlers({
      click(e, view) {
        try {
          if (plugin.settings.backToToc === false || !plugin.settings.livePreview) return false;
          if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false;
          if (!view.state.field(editorLivePreviewField, false)) return false;
          const target = e.target;
          if (!(target instanceof Element)) return false;
          const line = target.closest(".cm-line");
          const m = line && /HyperMD-header-(\d)/.exec(line.className);
          if (!m) return false;
          const info = view.state.field(editorInfoField, false);
          const path = (info && info.file && info.file.path) || "";
          const scan = scanDoc(view.state.doc, plugin.settings, path);
          if (!scan || !scan.cfg.levels.includes(+m[1])) return false;
          e.preventDefault();
          plugin.scrollToLiveToc(view);
          return true;
        } catch (err) {
          console.error("[heading-toc]", err);
          return false;
        }
      },
    });

    return [field, handlers];
  }

  goTo(path, line) {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    let view = active && active.file && active.file.path === path ? active : null;
    if (!view) {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view.file && leaf.view.file.path === path) {
          view = leaf.view;
          break;
        }
      }
    }
    if (!view) return;
    try {
      if (view.getMode() === "preview") {
        view.leaf.setEphemeralState({ line });
      } else {
        const pos = { line, ch: 0 };
        view.editor.setCursor(pos);
        view.editor.scrollIntoView({ from: pos, to: pos }, true);
      }
    } catch (e) {
      console.error("[heading-toc]", e);
    }
  }

  async persist() {
    await this.saveData(this.settings);
    this.settingsVersion++;
    this.app.workspace.updateOptions();
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      try {
        leaf.view.previewMode && leaf.view.previewMode.rerender(true);
      } catch (e) {
        /* ignore */
      }
    });
  }
};

/* ---------- 설정 화면 ---------- */

class TocSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;

    // 색상 설정 한 줄 (컬러피커 + 기본값 버튼)
    const colorSetting = (name, desc, key) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addColorPicker((c) =>
          c.setValue(settings[key]).onChange(async (v) => {
            settings[key] = v;
            await this.plugin.persist();
          })
        )
        .addExtraButton((b) =>
          b.setIcon("reset").setTooltip("기본값으로").onClick(async () => {
            settings[key] = DEFAULT_SETTINGS[key];
            await this.plugin.persist();
            this.display();
          })
        );
    };

    /* ===== 공통 설정 ===== */
    new Setting(containerEl).setName("공통 설정").setHeading();

    new Setting(containerEl)
      .setName("목차 모양")
      .setDesc(
        "박스 배너 / CONTENTS 글자(눌러서 펼침) / 제목 없이 목차만 / 비스킷(눌러서 펼침). " +
          "노트별로는 `toc-style: banner` · `text` · `list` · `biscuit`"
      )
      .addDropdown((d) =>
        d
          .addOption("banner", "박스 배너")
          .addOption("text", "CONTENTS 글자 (눌러서 펼치기)")
          .addOption("list", "제목 없이 목차만")
          .addOption("biscuit", "비스킷 (눌러서 펼치기)")
          .setValue(settings.tocStyle)
          .onChange(async (v) => {
            settings.tocStyle = v;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("점선 표시")
      .setDesc(
        "켜면 Ⅰ ----- 제목 형태, 끄면 점선 없이 위키피디아처럼 왼쪽 정렬 목록이에요. " +
          "노트별로는 `toc-line: false`"
      )
      .addToggle((t) =>
        t.setValue(settings.showLine).onChange(async (v) => {
          settings.showLine = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("로마숫자 정렬")
      .setDesc("Ⅰ Ⅱ Ⅲ 숫자의 정렬이에요. 노트별로는 `toc-roman-align: left` · `center` · `right`")
      .addDropdown((d) =>
        d
          .addOption("left", "왼쪽")
          .addOption("center", "가운데")
          .addOption("right", "오른쪽")
          .setValue(settings.romanAlign || "center")
          .onChange(async (v) => {
            settings.romanAlign = v;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("기본 레벨")
      .setDesc("frontmatter에 `toc: true`만 적었을 때 쓸 레벨이에요. 예: 3 또는 3-4")
      .addText((t) =>
        t.setValue(settings.defaultLevels).onChange(async (v) => {
          settings.defaultLevels = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("기본 제목")
      .setDesc(
        "박스 배너 / CONTENTS 글자 스타일의 제목이에요. 비워두면 제목 줄이 사라져요. " +
          "(목차만 / 비스킷 스타일에는 제목이 들어가지 않아요)"
      )
      .addText((t) =>
        t.setValue(settings.defaultTitle).onChange(async (v) => {
          settings.defaultTitle = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("라이브 프리뷰에서도 표시")
      .setDesc("끄면 읽기 모드에서만 목차가 보여요.")
      .addToggle((t) =>
        t.setValue(settings.livePreview).onChange(async (v) => {
          settings.livePreview = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("frontmatter 입력 추천")
      .setDesc(
        "소스 모드(또는 속성 표시를 '소스'로 둔 경우)에서 `toc` · `toc-style:` 등을 치면 추천이 떠요. " +
          "속성 UI를 쓴다면 명령어 '목차 설정 만들기'를 쓰세요."
      )
      .addToggle((t) =>
        t.setValue(settings.frontmatterSuggest !== false).onChange(async (v) => {
          settings.frontmatterSuggest = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("제목을 눌러 목차로 돌아가기")
      .setDesc(
        "목차에 포함된 레벨의 제목을 누르면 목차 위치로 돌아가요. " +
          "읽기 모드는 그냥 클릭, 라이브 프리뷰는 Ctrl(Mac은 Cmd) + 클릭이에요. " +
          "(라이브 프리뷰는 그냥 클릭하면 제목 수정용 커서가 놓여야 해서 보조키를 써요)"
      )
      .addToggle((t) =>
        t.setValue(settings.backToToc !== false).onChange(async (v) => {
          settings.backToToc = v;
          await this.plugin.persist();
        })
      );

    /* ===== 박스 스타일 설정 ===== */
    new Setting(containerEl).setName("박스 스타일 설정").setHeading();

    colorSetting(
      "박스 색상",
      "목차 배너 박스의 배경색이에요. 노트별로는 `toc-color: \"#c9a66b\"` 로 바꿀 수 있어요.",
      "bannerColor"
    );

    colorSetting("박스 글자색", "노트별로는 `toc-text-color` 로 지정해요.", "bannerTextColor");

    new Setting(containerEl)
      .setName("기본 배경 이미지 (선택)")
      .setDesc(
        "모든 노트의 박스에 깔 이미지예요. 볼트 안 경로(예: attachments/toc.png)나 URL. " +
          "비워두면 색상만 써요. 노트별로는 `toc-image`, 끄려면 `toc-image: false`."
      )
      .addText((t) =>
        t
          .setPlaceholder("attachments/toc.png")
          .setValue(settings.defaultImage)
          .onChange(async (v) => {
            settings.defaultImage = v.trim();
            await this.plugin.persist();
          })
      );

    /* ===== 비스킷 스타일 설정 ===== */
    new Setting(containerEl).setName("비스킷 스타일 설정").setHeading();

    colorSetting(
      "비스킷 색상",
      "비스킷 본체 색이에요. 노트별로는 `toc-biscuit-color: \"#f0cf94\"`",
      "biscuitColor"
    );

    colorSetting(
      "비스킷 테두리 / 도트 색상",
      "테두리와 구멍(도트) 색이에요. 노트별로는 `toc-biscuit-line: \"#7a4a21\"`",
      "biscuitLineColor"
    );

    new Setting(containerEl)
      .setName("비스킷 크기")
      .setDesc("가로 세로 비율은 그대로 두고 전체 크기만 조절해요. (기본 0.32, 박스 배너 높이와 비슷한 크기)")
      .addSlider((sl) =>
        sl
          .setLimits(0.2, 1.5, 0.02)
          .setValue(settings.biscuitScale)
          .setDynamicTooltip()
          .onChange(async (v) => {
            settings.biscuitScale = v;
            await this.plugin.persist();
          })
      )
      .addExtraButton((b) =>
        b.setIcon("reset").setTooltip("기본값으로").onClick(async () => {
          settings.biscuitScale = DEFAULT_SETTINGS.biscuitScale;
          await this.plugin.persist();
          this.display();
        })
      );
  }
}
