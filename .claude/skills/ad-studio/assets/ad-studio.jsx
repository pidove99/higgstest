import { useState, useRef } from "react";
import {
  Clapperboard, Copy, Check, Loader2, Sparkles, RefreshCw,
  Image as ImageIcon, Film, Type, AlertTriangle, Package
} from "lucide-react";

/* ─────────────────────────────────────────────
   AD STUDIO — AI 광고 제작안 생성기
   씬당 1회 분할 API 호출로 토큰 잘림 방지
────────────────────────────────────────────── */

const NO_TEXT_KR =
  "이미지 안이나 영상 안에 한글, 영어, 자막, 로고, 워터마크, UI, 텍스트를 절대 생성하지 말 것.";
const NO_TEXT_EN =
  "Never render any Korean text, English text, subtitles, logos, watermarks, UI, or any text inside the image or video frame.";

const FORMATS = [
  {
    id: "float",
    label: "프리미엄 부유샷",
    desc: "제품이 공중에 떠 있는 럭셔리 매크로 연출",
    guide:
      "제품이 무중력 상태로 공중에 부유하는 프리미엄 연출. 매크로 클로즈업, 느린 회전, 미세 파티클(물방울/빛가루/연기), 스튜디오 림 라이트와 극적인 명암 대비, 슬로우 모션 질감 강조.",
  },
  {
    id: "shortform",
    label: "숏폼 광고",
    desc: "3초 훅, 빠른 컷, 트렌디한 에너지",
    guide:
      "릴스/틱톡 스타일 숏폼 광고. 첫 씬은 강한 비주얼 훅, 빠른 컷 전환, 다이내믹한 핸드헬드 카메라, 생동감 있는 컬러, UGC 느낌의 현실감과 트렌디한 에너지.",
  },
  {
    id: "tvcf",
    label: "TV CF",
    desc: "시네마틱 브랜드 필름 톤",
    guide:
      "TV CF 스타일의 시네마틱 브랜드 필름. 아나모픽 와이드 구도, 정교한 라이팅, 우아한 카메라 무빙(돌리/크레인), 필름 그레인 질감, 감정적 스토리 아크와 브랜드 무드 중심.",
  },
];

const RATIOS = [
  { id: "16:9", label: "16:9", sub: "가로형" },
  { id: "9:16", label: "9:16", sub: "세로형" },
  { id: "1:1", label: "1:1", sub: "정사각" },
];

const MOOD_CHIPS = [
  "프리미엄 / 럭셔리",
  "감성적 / 따뜻한",
  "세련된 / 미니멀",
  "강렬한 / 임팩트",
  "신뢰감 / 전문적인",
  "밝고 산뜻한",
  "트렌디한 숏폼 스타일",
  "영화 같은 시네마틱",
  "홈쇼핑 / 판매 집중형",
  "브랜드 필름 스타일",
];

const C = {
  bg: "#0A0B0E",
  panel: "#12141A",
  panel2: "#171A22",
  field: "#0E1015",
  line: "#262B36",
  lineSoft: "#1D212B",
  text: "#ECEDF1",
  sub: "#9AA0AC",
  dim: "#5E6470",
  amber: "#F0A93B",
  amberSoft: "rgba(240,169,59,0.12)",
  red: "#E5533D",
};

const mono =
  "ui-monospace, SFMono-Regular, Menlo, 'Roboto Mono', monospace";

/* ───────── util ───────── */

function sceneCountFor(duration) {
  return Math.min(5, Math.max(1, Math.ceil(duration / 3)));
}

function timeRanges(duration, count) {
  const ranges = [];
  const step = duration / count;
  for (let i = 0; i < count; i++) {
    ranges.push([Math.round(i * step * 10) / 10, Math.round((i + 1) * step * 10) / 10]);
  }
  return ranges;
}

function tc(sec) {
  const s = Math.floor(sec);
  const f = Math.round((sec - s) * 10);
  return `00:${String(s).padStart(2, "0")}${f ? "." + f : ""}`;
}

function ensureRule(text, isEN) {
  if (!text) return text;
  const has = isEN ? /watermark/i.test(text) : text.includes("워터마크");
  return has ? text.trim() : text.trim() + " " + (isEN ? NO_TEXT_EN : NO_TEXT_KR);
}

// "업로드된 멀티샷 이미지를 시작 프레임으로 사용하여" 류의 문구 제거 (모델이 슬쩍 넣는 경우 대비)
function stripStartFrame(text) {
  if (!text) return text;
  let t = text;
  // KR: "…이미지를 시작 프레임으로 사용하여," 또는 "…시작 프레임으로," 도입부 제거
  t = t.replace(/업로드된\s*[^,.。]*이미지를?\s*시작\s*프레임으로\s*사용하여[,\s]*/g, "");
  t = t.replace(/[^,.。]*시작\s*프레임으로\s*사용하여[,\s]*/g, "");
  // EN: "Using the uploaded ... image as the start frame,"
  t = t.replace(/using\s+the\s+uploaded[^,.]*?as\s+the\s+start\s+frame[,\s]*/gi, "");
  t = t.replace(/[^,.]*as\s+the\s+start\s+frame[,\s]*/gi, "");
  return t.replace(/^\s*[,·]\s*/, "").trim();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }
}

/* ───────── 이미지 처리 & 분석 ───────── */

function fileToResizedBase64(file, maxDim = 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
          resolve({
            base64: dataUrl.split(",")[1],
            mediaType: "image/jpeg",
            preview: dataUrl,
            name: file.name,
          });
        } catch (e) {
          reject(new Error("이미지 변환에 실패했습니다"));
        }
      };
      img.onerror = () => reject(new Error("이미지를 읽을 수 없습니다"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function analyzeProductImage(image) {
  const prompt = `이 제품 이미지를 광고 제작 관점에서 분석하세요. JSON 객체 하나로만 응답. 코드펜스·설명 문장 금지, 문자열 값 안에 줄바꿈 금지.

{"product_desc":"제품 외형·용기·라벨·컬러를 AI 생성 프롬프트에 쓸 수 있게 구체적으로 묘사 (한국어 2~3문장)","palette":"주요 컬러 3~4개 (쉼표 구분)","category":"제품 카테고리 (예: 건강기능식품, 화장품)","style":"이 제품에 가장 어울리는 광고 비주얼 스타일 제안 — 배경·조명·무드 중심 (한국어 1~2문장)","mood_keywords":["어울리는 무드 키워드 3~4개, 각 2~5자"]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mediaType,
                data: image.base64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "분석 API 오류");
  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!raw.trim()) throw new Error("빈 응답을 받았습니다");
  const parsed = extractJSON(raw);
  return {
    product_desc: parsed.product_desc || "",
    palette: parsed.palette || "",
    category: parsed.category || "",
    style: parsed.style || "",
    mood_keywords: Array.isArray(parsed.mood_keywords) ? parsed.mood_keywords : [],
  };
}

/* ───────── API ───────── */

async function generateStoryArc({ form, analysis, count, ranges }) {
  const fmt = FORMATS.find((f) => f.id === form.format);
  const sceneList = ranges
    .map((r, i) => `씬${i + 1}: ${r[0]}~${r[1]}초`)
    .join(" / ");

  const prompt = `당신은 AI 광고 프로덕션의 크리에이티브 디렉터입니다. 아래 브리프로 ${form.duration}초 광고의 전체 스토리 아크를 설계하세요. 씬들이 하나의 이야기로 이어지는 것이 최우선입니다.

[브리프]
- 제품명: ${form.product}
- 소구점: ${form.usp || "제품명에서 유추"}
- 광고 포맷: ${fmt.label} — ${fmt.guide}
- 무드: ${form.mood || "포맷에 어울리는 무드"}
- 화면 비율: ${form.ratio} / 씬 구성: ${sceneList}
${analysis ? `- 제품 분석: ${analysis.product_desc} / 추천 스타일: ${analysis.style}` : ""}

[출력 규칙]
- JSON 객체 하나로만 응답. 코드펜스·설명 문장 금지, 문자열 값 안 줄바꿈 금지.
- concept: 광고 전체를 관통하는 하나의 컨셉과 비주얼 세계관 (배경·조명·톤이 씬 전체에서 어떻게 유지·변화하는지 포함, 한국어 2~3문장)
- beats: 씬 개수(${count}개)와 정확히 같은 길이의 배열. 각 항목은 "이 씬에서 일어나는 일 + 다음 씬으로 어떻게 이어지는지"를 담은 한 문장.
- 씬 간 연결은 제품 위치·카메라 방향·조명 변화가 자연스럽게 이어지거나 의도된 매치컷이 되도록 설계.

{"concept":"...","beats":["씬1 비트","씬2 비트"]}`;

  return await callWithRetry(prompt);
}

async function generateScene({ form, analysis, arc, prevSummary, idx, total, range }) {
  const fmt = FORMATS.find((f) => f.id === form.format);
  const [start, end] = range;
  const dur = Math.round((end - start) * 10) / 10;

  let productLine;
  if (form.hasProductImage && analysis) {
    productLine = `제품 이미지가 업로드되어 참조로 사용됨.
  · 제품 외형 분석: ${analysis.product_desc} (주요 컬러: ${analysis.palette})
  · 이 제품에 어울리는 비주얼 스타일: ${analysis.style} — 씬 연출과 모든 프롬프트에 이 스타일 방향을 반영할 것.
  · 모든 이미지/영상 프롬프트에 "업로드된 제품 이미지를 참조하여 제품의 형태·라벨·컬러·디테일을 그대로 유지할 것"(영문 프롬프트에는 "Use the uploaded product image as the exact reference; preserve the product's shape, label, colors, and details.")이라는 의미를 반드시 포함할 것.`;
  } else if (form.hasProductImage) {
    productLine = `제품 이미지가 별도로 업로드되어 참조로 사용됨. 모든 이미지/영상 프롬프트에 "업로드된 제품 이미지를 참조하여 제품의 형태·라벨·컬러·디테일을 그대로 유지할 것"(영문: "Use the uploaded product image as the exact reference; preserve the product's shape, label, colors, and details.")이라는 의미를 반드시 포함할 것.`;
  } else {
    productLine = `제품 이미지는 없음. 제품명과 소구점을 바탕으로 제품의 외형을 프롬프트 안에서 구체적으로 묘사할 것.`;
  }

  const arcLine =
    arc && arc.concept
      ? `\n[전체 스토리 아크 — 모든 씬이 이 하나의 이야기로 이어져야 함]
- 광고 컨셉·비주얼 세계관: ${arc.concept}
- 이 씬(씬${idx + 1})의 비트: ${(arc.beats && arc.beats[idx]) || ""}
- 컨셉의 배경·조명·톤 세계관을 이 씬에서도 유지할 것 (아크가 의도한 변화가 있는 경우에만 변화).\n`
      : "";

  const prevLine = prevSummary
    ? `\n[직전 씬(씬${idx})의 확정 스토리보드]
${prevSummary}
→ 이 씬은 위 씬의 마지막 상태(제품 위치·카메라 방향·조명)에서 자연스럽게 이어지도록 설계할 것. 연속 동작으로 잇거나, 의도된 매치컷/모션 연결로 전환할 것. 배경 세계관을 이유 없이 바꾸지 말 것.\n`
    : "";

  const brief = `[브리프]
- 제품명: ${form.product}
- 소구점: ${form.usp || "제품명에서 유추"}
- 광고 포맷: ${fmt.label} — ${fmt.guide}
- 무드: ${form.mood || "포맷에 어울리는 무드"}
- 화면 비율: ${form.ratio}
- 전체 길이: ${form.duration}초 / 이 씬(${idx + 1}/${total})의 구간: ${start}~${end}초 (약 ${dur}초)
- ${productLine}
${idx === 0 ? "- 첫 씬: 시청자를 즉시 사로잡는 오프닝 훅.\n" : ""}${idx === total - 1 ? "- 마지막 씬: 스토리를 매듭짓는 제품 히어로샷 클로징.\n" : ""}${arcLine}${prevLine}
[공통 출력 규칙]
- JSON 객체 하나로만 응답. 코드펜스·설명 문장 금지. 문자열 값 안에 줄바꿈 넣지 말 것.
- 각 프롬프트는 2~4문장으로 간결하게. 화면 비율 ${form.ratio}를 명시.
- 이미지 프롬프트는 고품질 광고 키비주얼 제작에 최적화(피사체·구도·조명·질감·컬러 팔레트를 구체적으로).
- 영상 프롬프트는 실제 광고 촬영처럼 카메라 무브·장면 전환·연출·분위기까지 포함.
- 텍스트/로고 금지 규칙 문장은 시스템이 자동으로 덧붙이므로 직접 쓰지 말 것.`;

  // 1차 호출: 스토리보드 + 자막 + 이미지 프롬프트
  const p1 = `당신은 AI 광고 프로덕션의 크리에이티브 디렉터입니다. 광고의 씬 ${idx + 1}/${total}을 설계하세요.

${brief}

image_prompt는 이 씬의 시작 프레임(정지 이미지) 생성용. subtitle은 후반 편집에서 화면에 얹을 한 줄 자막 카피(한국어 15자 내외, 임팩트 있게).

{"storyboard":"연출 설명 (한국어 2~3문장: 장면·카메라·조명·분위기)","subtitle":"자막 한 줄","image_prompt_kr":"...","image_prompt_en":"..."}`;

  const r1 = await callWithRetry(p1);

  // 2차 호출: 영상 프롬프트 (1차 결과를 컨텍스트로 전달해 일관성 유지)
  const p2 = `당신은 AI 광고 프로덕션의 크리에이티브 디렉터입니다. 아래 씬의 시작 프레임 이미지를 ${dur}초간 움직이는 영상 생성 프롬프트를 작성하세요. 카메라 무빙·피사체 모션·속도감 중심으로.

${brief}

[이 씬의 확정 내용]
- 스토리보드: ${r1.storyboard || ""}
- 시작 프레임: ${r1.image_prompt_en || r1.image_prompt_kr || ""}

{"video_prompt_kr":"...","video_prompt_en":"..."}`;

  const r2 = await callWithRetry(p2);

  return {
    storyboard: r1.storyboard || "",
    subtitle: r1.subtitle || "",
    image_prompt_kr: ensureRule(r1.image_prompt_kr, false),
    image_prompt_en: ensureRule(r1.image_prompt_en, true),
    video_prompt_kr: ensureRule(r2.video_prompt_kr, false),
    video_prompt_en: ensureRule(r2.video_prompt_en, true),
    range,
  };
}

/* ───────── 멀티샷 프롬프트 생성 (2단계 분리) ─────────
   STEP 1: 선택 씬들을 합치는 "합성 이미지" 프롬프트(KR/EN)만 생성
   STEP 2: 사용자가 합성 이미지를 업로드하면, 그 이미지(비전)+STEP1 프롬프트+씬 컨텍스트를
           조합해 "영상" 프롬프트(KR/EN) 생성                          */

function buildMultiShotCtx({ form, analysis, arc, picked }) {
  const fmt = FORMATS.find((f) => f.id === form.format);
  const totalDur = picked.reduce((sum, p) => sum + (p.range[1] - p.range[0]), 0);
  const dur = Math.round(totalDur * 10) / 10;
  const n = picked.length;
  const shotList = picked
    .map(
      (p, i) =>
        `샷${i + 1} (약 ${Math.round((p.range[1] - p.range[0]) * 10) / 10}초): ${p.storyboard}`
    )
    .join("\n");

  const ctx = `[멀티샷 브리프]
- 제품명: ${form.product} / 소구점: ${form.usp || "제품명에서 유추"}
- 광고 포맷: ${fmt.label} / 무드: ${form.mood || "포맷에 어울리는 무드"} / 화면 비율: ${form.ratio}
${arc?.concept ? `- 광고 컨셉·비주얼 세계관: ${arc.concept}` : ""}
${analysis ? `- 제품 외형: ${analysis.product_desc}` : ""}
- ${form.hasProductImage ? '제품 이미지가 업로드되어 참조로 사용됨. 프롬프트에 "업로드된 제품 이미지를 참조하여 제품의 형태·라벨·컬러·디테일을 그대로 유지할 것"(영문은 영어로) 의미를 포함할 것.' : "제품 이미지 없음. 제품 외형을 프롬프트 안에서 묘사할 것."}

[선택된 샷들 — 이 순서대로 하나로 합침 (총 ${n}컷 / 영상 ${dur}초)]
${shotList}

[구성 원칙]
- 모든 샷이 하나의 이야기·세계관으로 묶이도록 무드·조명·컬러 팔레트의 일관성 유지.
- 제품·인물·배경·조명·카메라 무브먼트가 컷 사이에서 이질감 없이 자연스럽게 이어지도록 구성.
- 선택한 씬의 핵심 연출은 유지하면서 하나의 완성도 높은 광고처럼 자연스럽게 연결.
- 이미지 프롬프트는 고품질 광고 키비주얼 제작에 최적화. 영상 프롬프트는 실제 광고 촬영처럼 카메라 무브·장면 전환·연출·분위기까지 포함.

[공통 출력 규칙]
- JSON 객체 하나로만 응답. 코드펜스·설명 문장 금지, 문자열 값 안 줄바꿈 금지.
- 텍스트/로고 금지 규칙 문장은 시스템이 자동으로 덧붙이므로 직접 쓰지 말 것.`;

  return { ctx, dur, n };
}

// STEP 1 — 합성 이미지 프롬프트(KR/EN)만 생성
async function generateMultiShotImage({ form, analysis, arc, picked }) {
  const { ctx, dur, n } = buildMultiShotCtx({ form, analysis, arc, picked });

  const pImgKr = `당신은 AI 광고 프로덕션의 크리에이티브 디렉터입니다. 위 ${n}개 샷을 하나의 이미지로 합치는 "멀티 이미지 합성" 프롬프트를 한국어로 작성하세요. ${n}개 장면을 ${form.ratio} 프레임 안에 ${n}분할 그리드(또는 자연스러운 몽타주)로 배치하되, 하나의 통일된 무드·조명·컬러 팔레트로 묶어 한 편의 광고 키비주얼처럼 보이게 하세요. 각 장면의 핵심 피사체·구도를 구체적으로 묘사. 4~5문장, 화면 비율 ${form.ratio} 명시.

${ctx}

{"image_prompt_kr":"..."}`;
  const rImgKr = await callWithRetry(pImgKr);
  if (!rImgKr.image_prompt_kr || !rImgKr.image_prompt_kr.trim())
    throw new Error("멀티샷 합성 이미지(한글) 생성 결과가 비어 있습니다. 선택 씬 수를 줄이거나 다시 시도해주세요.");

  const pImgEn = `Translate and adapt the following Korean composite-image generation prompt into a professional English image generation prompt. It merges ${n} shots into a single ${form.ratio} key visual (grid/montage) with one unified mood, lighting, and color palette. Keep the same structure and detail. Respond with a single JSON object only, no code fences, no line breaks inside string values.

[Korean prompt]
${rImgKr.image_prompt_kr}

{"image_prompt_en":"..."}`;
  const rImgEn = await callWithRetry(pImgEn);

  return {
    sceneIdxs: picked.map((p) => p.idx),
    duration: dur,
    shotCount: n,
    image_prompt_kr: ensureRule(rImgKr.image_prompt_kr, false),
    image_prompt_en: ensureRule(rImgEn.image_prompt_en, true),
  };
}

// STEP 2 — 업로드된 합성 이미지(비전) + STEP1 프롬프트 + 씬 컨텍스트 → 영상 프롬프트(KR/EN)
async function generateMultiShotVideo({ form, analysis, arc, picked, imageResult, uploadedImage }) {
  const { ctx, dur, n } = buildMultiShotCtx({ form, analysis, arc, picked });

  const visionIntro = `당신은 AI 광고 프로덕션의 크리에이티브 디렉터입니다. 사용자가 방금 아래 "멀티샷 스토리보드 이미지"를 실제로 생성해 업로드했습니다. 이 이미지를 기준으로 각 장면(Scene)이 자연스럽게 이어지는 하나의 ${dur}초 광고 영상을 만드는 영상 생성 프롬프트를 한국어로 작성하세요. Higgsfield Seedance 2.0로 현실감 있는 카메라 연출과 자연스러운 움직임을 구현하는 것이 목표입니다.

먼저 업로드된 이미지를 직접 관찰하여 실제 패널 구성·구도·피사체·컬러·조명을 파악하세요. 이 스토리보드 이미지는 총 ${n}개의 Scene(패널)로 구성되어 있습니다. 다음 원칙을 반드시 반영하세요:
- 각 패널을 하나의 독립된 장면으로 인식하여 순서대로 영상을 제작한다.
- 영상은 Scene 1 → Scene ${n}까지 순서대로 자연스럽게 진행하며, 각 장면의 구도와 연출 의도를 최대한 유지한다.
- 다른 패널의 내용이 현재 Scene에 섞이거나 동시에 보이지 않도록 하며, 각 패널은 독립적인 하나의 영상 장면으로 처리한다.
- 제품·인물·배경·색감·조명·디자인은 모든 Scene에서 일관성을 유지하고, 원본 스토리보드의 구도와 디테일을 변경하거나 왜곡하지 않는다.
- 장면 사이 전환(매치컷/모션 연결/조명 연속)을 명시하고, 카메라 무빙·피사체 모션을 각 씬별로 구체적으로 묘사한다.

프롬프트는 각 Scene을 순서대로 서술하는 방식으로 작성하되, "업로드된 멀티샷 이미지를 시작 프레임으로 사용하여" 같은 표현은 절대 쓰지 마세요. 화면 비율 ${form.ratio}을 명시하세요.

[STEP1에서 사용한 스토리보드 이미지 프롬프트(참고)]
${imageResult.image_prompt_kr}

${ctx}

{"video_prompt_kr":"..."}`;

  const rVidKr = await callClaudeVision(visionIntro, uploadedImage);
  if (!rVidKr.video_prompt_kr || !rVidKr.video_prompt_kr.trim())
    throw new Error("멀티샷 영상(한글) 생성 결과가 비어 있습니다. 다시 시도해주세요.");

  const pVidEn = `Translate and adapt the following Korean multi-scene video prompt into a professional English prompt for Higgsfield Seedance 2.0. The storyboard image has ${n} scenes (panels); the video plays each panel as an independent scene in order (Scene 1 → Scene ${n}), keeping each scene's composition and intent, never mixing or showing other panels at the same time, with consistent product, background, color, lighting, and design across scenes and no distortion of the original storyboard, plus scene transitions (match cut / motion link / lighting continuity), realistic camera work and natural motion. Do NOT use any phrase like "using the uploaded multi-shot image as the start frame." Keep aspect ratio ${form.ratio}. Respond with a single JSON object only, no code fences, no line breaks inside string values.

[Korean prompt]
${rVidKr.video_prompt_kr}

{"video_prompt_en":"..."}`;
  let rVidEn;
  try {
    rVidEn = await callWithRetry(pVidEn);
    if (!rVidEn.video_prompt_en || !rVidEn.video_prompt_en.trim()) throw new Error("empty");
  } catch {
    const pVidEnAlt = `You are a creative director for AI ad production writing a single English video prompt for a ${dur}s ad using Higgsfield Seedance 2.0. The storyboard image has ${n} scenes (panels). Treat each panel as an independent scene and play them in order (Scene 1 → Scene ${n}), preserving each scene's composition and directorial intent, never mixing or simultaneously showing other panels, keeping product, background, color, lighting, and design consistent across all scenes with no distortion of the original storyboard. Specify scene transitions (match cut / motion link / lighting continuity) and describe camera moves and subject motion per scene, with realistic camera work and natural movement. Do NOT use any phrase like "using the uploaded multi-shot image as the start frame." Aspect ratio ${form.ratio}. Respond with a single JSON object only, no code fences, no line breaks inside string values.

${ctx}

{"video_prompt_en":"..."}`;
    rVidEn = await callWithRetry(pVidEnAlt);
  }

  return {
    video_prompt_kr: ensureRule(stripStartFrame(rVidKr.video_prompt_kr), false),
    video_prompt_en: ensureRule(stripStartFrame(rVidEn.video_prompt_en), true),
  };
}

// 비전 입력을 받는 Claude 호출 (이미지 + 텍스트)
async function callClaudeVision(prompt, image) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.base64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API 오류");
  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!raw.trim()) throw new Error("빈 응답을 받았습니다");
  return extractJSON(raw);
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API 오류");
  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!raw.trim()) throw new Error("빈 응답을 받았습니다");
  return extractJSON(raw);
}

async function callWithRetry(prompt) {
  try {
    return await callClaude(prompt);
  } catch (e1) {
    // 일시적 오류/파싱 실패 대비 자동 1회 재시도
    try {
      return await callClaude(prompt);
    } catch (e2) {
      throw e2;
    }
  }
}

function extractJSON(raw) {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const a = cleaned.indexOf("{");
  if (a === -1) throw new Error("응답에서 JSON을 찾지 못했습니다");
  const b = cleaned.lastIndexOf("}");
  // 닫는 중괄호가 없으면(잘림) 여는 중괄호부터 끝까지를 대상으로 폴백 파싱
  const body = b > a ? cleaned.slice(a, b + 1) : cleaned.slice(a);

  if (b > a) {
    try {
      return JSON.parse(body);
    } catch {}
    const sanitized0 = body.replace(/[\u0000-\u001F]+/g, " ");
    try {
      return JSON.parse(sanitized0);
    } catch {}
  }

  // 최후 폴백: 키-값 정규식 추출 (응답이 중간에 잘린 경우에도 가능한 필드 복구)
  const sanitized = body.replace(/[\u0000-\u001F]+/g, " ");
  const out = {};
  // 완결된 "key":"value" 쌍
  const re = /"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(sanitized))) {
    out[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
  }
  // 마지막 값이 닫는 따옴표 없이 잘린 경우까지 복구
  const tail = /"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)$/.exec(sanitized);
  if (tail && !(tail[1] in out) && tail[2].length > 0) {
    out[tail[1]] = tail[2].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
  }
  if (Object.keys(out).length === 0) throw new Error("응답 파싱에 실패했습니다");
  return out;
}

/* ───────── small components ───────── */

function CopyBtn({ text, small }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontFamily: mono,
        color: done ? C.amber : C.sub,
        background: done ? C.amberSoft : "transparent",
        border: `1px solid ${done ? C.amber : C.line}`,
        borderRadius: 6,
        padding: small ? "3px 8px" : "5px 10px",
        cursor: "pointer",
        transition: "all .15s",
        flexShrink: 0,
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      {done ? "복사됨" : "복사"}
    </button>
  );
}

function PromptBlock({ tag, lang, text }) {
  return (
    <div
      style={{
        background: C.field,
        border: `1px solid ${C.lineSoft}`,
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            color: C.amber,
          }}
        >
          {tag} · {lang}
        </span>
        <CopyBtn text={text} small />
      </div>
      <p
        style={{
          fontSize: 12.5,
          lineHeight: 1.65,
          color: C.text,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
        }}
      >
        {text}
      </p>
    </div>
  );
}

function Seg({ options, value, onChange, render }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            style={{
              flex: 1,
              padding: "9px 8px",
              borderRadius: 8,
              border: `1px solid ${active ? C.amber : C.line}`,
              background: active ? C.amberSoft : C.field,
              color: active ? C.amber : C.sub,
              cursor: "pointer",
              transition: "all .15s",
              textAlign: "center",
            }}
          >
            {render(o, active)}
          </button>
        );
      })}
    </div>
  );
}

function Label({ children }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        letterSpacing: "0.12em",
        color: C.dim,
        marginBottom: 7,
      }}
    >
      {children}
    </div>
  );
}

/* ───────── main ───────── */

export default function AdStudio() {
  const [form, setForm] = useState({
    product: "",
    usp: "",
    format: "float",
    mood: "",
    duration: 6,
    ratio: "9:16",
    hasProductImage: false,
  });
  const [scenes, setScenes] = useState([]); // {status:'loading'|'done'|'error', data, range}
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [productImage, setProductImage] = useState(null); // {base64, mediaType, preview, name}
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeErr, setAnalyzeErr] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [arc, setArc] = useState(null); // {concept, beats[]}
  const [selected, setSelected] = useState([]); // 멀티샷 선택 씬 인덱스
  const [multi, setMulti] = useState(null); // STEP1: {status, data(image prompts), errMsg}
  const [multiPicked, setMultiPicked] = useState(null); // STEP1 생성 시점의 picked 스냅샷
  const [multiVid, setMultiVid] = useState(null); // STEP2: {status, data(video prompts), errMsg}
  const [multiImg, setMultiImg] = useState(null); // 사용자가 업로드한 합성 이미지
  const [multiDrag, setMultiDrag] = useState(false);
  const cancelRef = useRef(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleImageFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setAnalyzeErr("이미지 파일만 업로드할 수 있습니다");
      return;
    }
    setAnalyzeErr("");
    setAnalysis(null);
    try {
      const img = await fileToResizedBase64(file);
      setProductImage(img);
      setAnalyzing(true);
      const result = await analyzeProductImage(img);
      setAnalysis(result);
    } catch (e) {
      setAnalyzeErr(e?.message || "이미지 분석에 실패했습니다");
    } finally {
      setAnalyzing(false);
    }
  };

  const onFileInput = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일 재선택 허용
    handleImageFile(file);
  };

  const reAnalyze = async () => {
    if (!productImage || analyzing) return;
    setAnalyzeErr("");
    setAnalyzing(true);
    try {
      setAnalysis(await analyzeProductImage(productImage));
    } catch (e) {
      setAnalyzeErr(e?.message || "이미지 분석에 실패했습니다");
    } finally {
      setAnalyzing(false);
    }
  };

  const clearImage = () => {
    setProductImage(null);
    setAnalysis(null);
    setAnalyzeErr("");
  };

  const activeAnalysis = form.hasProductImage ? analysis : null;

  const generate = async () => {
    if (!form.product.trim() || running) return;
    cancelRef.current = false;
    setRunning(true);
    const count = sceneCountFor(form.duration);
    const ranges = timeRanges(form.duration, count);
    setScenes(ranges.map((range) => ({ status: "loading", range, data: null })));
    setArc(null);
    setSelected([]);
    setMulti(null);
    setMultiPicked(null);
    setMultiVid(null);
    setMultiImg(null);

    // 0단계: 전체 스토리 아크 설계 (실패해도 씬 생성은 진행)
    let storyArc = null;
    setProgress("스토리 아크 설계 중…");
    try {
      const a = await generateStoryArc({ form, analysis: activeAnalysis, count, ranges });
      if (a && a.concept) {
        storyArc = {
          concept: a.concept,
          beats: Array.isArray(a.beats) ? a.beats : [],
        };
        setArc(storyArc);
      }
    } catch (e) {
      console.error("스토리 아크 생성 실패, 개별 씬 생성으로 진행:", e);
    }

    let prevSummary = null;
    for (let i = 0; i < count; i++) {
      if (cancelRef.current) break;
      setProgress(`SCENE ${i + 1}/${count} 생성 중…`);
      try {
        const data = await generateScene({
          form, analysis: activeAnalysis, arc: storyArc, prevSummary,
          idx: i, total: count, range: ranges[i],
        });
        prevSummary = data.storyboard || prevSummary;
        setScenes((prev) =>
          prev.map((s, j) => (j === i ? { ...s, status: "done", data } : s))
        );
      } catch (e) {
        console.error(e);
        const errMsg = e?.message || "알 수 없는 오류";
        setScenes((prev) =>
          prev.map((s, j) => (j === i ? { ...s, status: "error", errMsg } : s))
        );
      }
    }
    setProgress("");
    setRunning(false);
  };

  const retryScene = async (i) => {
    const count = scenes.length;
    const prevSummary = i > 0 ? scenes[i - 1]?.data?.storyboard || null : null;
    setScenes((prev) => prev.map((s, j) => (j === i ? { ...s, status: "loading", errMsg: "" } : s)));
    try {
      const data = await generateScene({
        form, analysis: activeAnalysis, arc, prevSummary,
        idx: i, total: count, range: scenes[i].range,
      });
      setScenes((prev) => prev.map((s, j) => (j === i ? { ...s, status: "done", data } : s)));
    } catch (e) {
      const errMsg = e?.message || "알 수 없는 오류";
      setScenes((prev) => prev.map((s, j) => (j === i ? { ...s, status: "error", errMsg } : s)));
    }
  };

  const toggleSelect = (i) => {
    setSelected((prev) =>
      prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort((a, b) => a - b)
    );
  };

  const runMultiShot = async () => {
    if (selected.length < 2 || multi?.status === "loading") return;
    const picked = selected
      .filter((i) => scenes[i]?.status === "done" && scenes[i]?.data)
      .map((i) => ({
        idx: i,
        range: scenes[i].range,
        storyboard: scenes[i].data.storyboard,
      }));
    if (picked.length < 2) return;
    // STEP2 관련 상태 초기화(다시 STEP1을 돌리는 경우)
    setMultiVid(null);
    setMultiImg(null);
    setMultiPicked(picked);
    setMulti({ status: "loading", data: null, errMsg: "" });
    try {
      const data = await generateMultiShotImage({ form, analysis: activeAnalysis, arc, picked });
      setMulti({ status: "done", data, errMsg: "" });
    } catch (e) {
      setMulti({ status: "error", data: null, errMsg: e?.message || "알 수 없는 오류" });
    }
  };

  // STEP2 — 합성 이미지 업로드 → 영상 프롬프트 생성
  const handleMultiImageFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMultiVid({ status: "error", data: null, errMsg: "이미지 파일만 업로드할 수 있습니다" });
      return;
    }
    if (!multi?.data || !multiPicked) return;
    setMultiVid({ status: "loading", data: null, errMsg: "" });
    try {
      const img = await fileToResizedBase64(file);
      setMultiImg(img);
      const data = await generateMultiShotVideo({
        form, analysis: activeAnalysis, arc, picked: multiPicked,
        imageResult: multi.data, uploadedImage: img,
      });
      setMultiVid({ status: "done", data, errMsg: "" });
    } catch (e) {
      setMultiVid({ status: "error", data: null, errMsg: e?.message || "영상 프롬프트 생성에 실패했습니다" });
    }
  };

  const onMultiImageInput = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    handleMultiImageFile(file);
  };

  const multiText = () => {
    if (!multi?.data) return "";
    const d = multi.data;
    let t = `━━━ MULTI-SHOT  [씬 ${d.sceneIdxs.map((i) => i + 1).join(" + ")} · 합성 ${d.shotCount}컷 · 영상 ${d.duration}초] ━━━
[STEP 1] 멀티샷 합성 이미지 생성
▸ 이미지 프롬프트 (KR)
${d.image_prompt_kr}
▸ 이미지 프롬프트 (EN)
${d.image_prompt_en}
`;
    if (multiVid?.status === "done" && multiVid.data) {
      t += `
[STEP 2] 합성 이미지 업로드 → 영상 변환
▸ 영상 프롬프트 (KR)
${multiVid.data.video_prompt_kr}
▸ 영상 프롬프트 (EN)
${multiVid.data.video_prompt_en}
`;
    }
    return t;
  };

  const fullText = () => {
    const fmt = FORMATS.find((f) => f.id === form.format);
    let out = `■ AD STUDIO 제작안\n제품: ${form.product}\n포맷: ${fmt.label} / 무드: ${form.mood || "-"} / 길이: ${form.duration}초 / 비율: ${form.ratio} / 제품 이미지: ${form.hasProductImage ? "포함(참조 업로드)" : "미포함"}\n${arc ? `광고 컨셉: ${arc.concept}\n` : ""}${activeAnalysis ? `제품 분석: ${activeAnalysis.product_desc}\n추천 스타일: ${activeAnalysis.style}\n` : ""}`;
    scenes.forEach((s, i) => {
      if (s.status !== "done") return;
      const d = s.data;
      out += `\n━━━ SCENE ${i + 1}  [${tc(s.range[0])} → ${tc(s.range[1])}] ━━━\n`;
      out += `▸ 스토리보드\n${d.storyboard}\n`;
      out += `▸ 자막 카피\n${d.subtitle}\n`;
      out += `▸ 이미지 프롬프트 (KR)\n${d.image_prompt_kr}\n`;
      out += `▸ 이미지 프롬프트 (EN)\n${d.image_prompt_en}\n`;
      out += `▸ 영상 프롬프트 (KR)\n${d.video_prompt_kr}\n`;
      out += `▸ 영상 프롬프트 (EN)\n${d.video_prompt_en}\n`;
    });
    if (multi?.status === "done") out += `\n${multiText()}`;
    return out;
  };

  const doneCount = scenes.filter((s) => s.status === "done").length;
  const total = form.duration;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.text,
        fontFamily:
          "'Pretendard', -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif",
      }}
    >
      {/* header */}
      <header
        style={{
          borderBottom: `1px solid ${C.lineSoft}`,
          padding: "14px 22px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          position: "sticky",
          top: 0,
          background: "rgba(10,11,14,0.92)",
          backdropFilter: "blur(8px)",
          zIndex: 10,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: C.amberSoft,
            border: `1px solid ${C.amber}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Clapperboard size={15} color={C.amber} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.02em" }}>
            AD STUDIO
          </div>
          <div style={{ fontFamily: mono, fontSize: 10, color: C.dim, letterSpacing: "0.1em" }}>
            AI ADVERTISING PRODUCTION
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {running && (
            <span
              style={{
                fontFamily: mono, fontSize: 11, color: C.amber,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              <span
                style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: C.red, animation: "blink 1s infinite",
                }}
              />
              {progress}
            </span>
          )}
          {doneCount > 0 && !running && <CopyBtn text={fullText()} />}
        </div>
      </header>

      <style>{`
        @keyframes blink { 50% { opacity: .25; } }
        input::placeholder, textarea::placeholder { color: ${C.dim}; }
        input:focus, textarea:focus { outline: none; border-color: ${C.amber} !important; }
        @media (max-width: 900px) { .studio-grid { grid-template-columns: 1fr !important; } }
      `}</style>

      <div
        className="studio-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "340px 1fr",
          gap: 20,
          padding: 20,
          maxWidth: 1240,
          margin: "0 auto",
        }}
      >
        {/* ── 좌측: 브리프 패널 ── */}
        <aside
          style={{
            background: C.panel,
            border: `1px solid ${C.lineSoft}`,
            borderRadius: 12,
            padding: 18,
            alignSelf: "start",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div
            style={{
              fontFamily: mono, fontSize: 11, letterSpacing: "0.15em",
              color: C.amber, borderBottom: `1px solid ${C.lineSoft}`, paddingBottom: 10,
            }}
          >
            PRODUCTION BRIEF
          </div>

          <div>
            <Label>제품명 *</Label>
            <input
              value={form.product}
              onChange={(e) => set("product", e.target.value)}
              placeholder="예: 갓찌뇽 떡볶이 밀키트"
              style={{
                width: "100%", boxSizing: "border-box", background: C.field,
                border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px",
                color: C.text, fontSize: 13,
              }}
            />
          </div>

          <div>
            <Label>소구점</Label>
            <textarea
              value={form.usp}
              onChange={(e) => set("usp", e.target.value)}
              placeholder="예: 3분 완성, 국내산 쌀떡, 비법 소스의 진한 감칠맛"
              rows={3}
              style={{
                width: "100%", boxSizing: "border-box", background: C.field,
                border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px",
                color: C.text, fontSize: 13, resize: "vertical", lineHeight: 1.5,
              }}
            />
          </div>

          <div>
            <Label>광고 포맷</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {FORMATS.map((f) => {
                const active = form.format === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => set("format", f.id)}
                    style={{
                      textAlign: "left", padding: "10px 12px", borderRadius: 8,
                      border: `1px solid ${active ? C.amber : C.line}`,
                      background: active ? C.amberSoft : C.field,
                      cursor: "pointer", transition: "all .15s",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: active ? C.amber : C.text }}>
                      {f.label}
                    </div>
                    <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{f.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Label>무드</Label>
            <input
              value={form.mood}
              onChange={(e) => set("mood", e.target.value)}
              placeholder="직접 입력 또는 아래에서 선택"
              style={{
                width: "100%", boxSizing: "border-box", background: C.field,
                border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px",
                color: C.text, fontSize: 13, marginBottom: 7,
              }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {MOOD_CHIPS.map((m) => {
                const active = form.mood === m;
                return (
                  <button
                    key={m}
                    onClick={() => set("mood", active ? "" : m)}
                    style={{
                      fontSize: 11, padding: "4px 10px", borderRadius: 999,
                      border: `1px solid ${active ? C.amber : C.line}`,
                      background: active ? C.amberSoft : "transparent",
                      color: active ? C.amber : C.sub, cursor: "pointer",
                    }}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Label>
              영상 길이 — {form.duration}초 · 씬 {sceneCountFor(form.duration)}개
            </Label>
            <input
              type="range" min={1} max={15} step={1}
              value={form.duration}
              onChange={(e) => set("duration", Number(e.target.value))}
              style={{ width: "100%", accentColor: C.amber }}
            />
            <div
              style={{
                display: "flex", justifyContent: "space-between",
                fontFamily: mono, fontSize: 10, color: C.dim,
              }}
            >
              <span>1s</span><span>15s</span>
            </div>
          </div>

          <div>
            <Label>화면 비율</Label>
            <Seg
              options={RATIOS}
              value={form.ratio}
              onChange={(v) => set("ratio", v)}
              render={(o, active) => (
                <>
                  <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 700 }}>{o.label}</div>
                  <div style={{ fontSize: 10, color: active ? C.amber : C.dim }}>{o.sub}</div>
                </>
              )}
            />
          </div>

          <button
            onClick={() => set("hasProductImage", !form.hasProductImage)}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "11px 12px",
              borderRadius: 8, cursor: "pointer", textAlign: "left",
              border: `1px solid ${form.hasProductImage ? C.amber : C.line}`,
              background: form.hasProductImage ? C.amberSoft : C.field,
            }}
          >
            <div
              style={{
                width: 32, height: 18, borderRadius: 999, position: "relative",
                background: form.hasProductImage ? C.amber : C.line,
                transition: "background .15s", flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 14, height: 14, borderRadius: "50%", background: C.bg,
                  position: "absolute", top: 2,
                  left: form.hasProductImage ? 16 : 2, transition: "left .15s",
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: form.hasProductImage ? C.amber : C.text, display: "flex", alignItems: "center", gap: 5 }}>
                <Package size={13} /> 제품 이미지 포함
              </div>
              <div style={{ fontSize: 10.5, color: C.dim, marginTop: 2 }}>
                {form.hasProductImage
                  ? "이미지를 업로드하면 AI가 분석해 어울리는 스타일을 반영"
                  : "제품명 기반으로 외형을 프롬프트에서 묘사"}
              </div>
            </div>
          </button>

          {form.hasProductImage && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: -8 }}>
              {!productImage ? (
                <>
                  <label
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      handleImageFile(e.dataTransfer.files?.[0]);
                    }}
                    style={{
                      display: "block",
                      border: `1px dashed ${dragOver ? C.amber : C.line}`,
                      borderRadius: 8,
                      background: dragOver ? C.amberSoft : C.field,
                      padding: "18px 12px", cursor: "pointer",
                      color: C.sub, textAlign: "center", transition: "all .15s",
                    }}
                  >
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={onFileInput}
                    />
                    <ImageIcon size={18} style={{ opacity: 0.6, marginBottom: 6 }} />
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                      제품 이미지 업로드
                    </div>
                    <div style={{ fontSize: 10.5, color: C.dim, marginTop: 3 }}>
                      클릭해서 선택하거나 여기로 드래그하세요
                    </div>
                  </label>
                  {analyzeErr && (
                    <div
                      style={{
                        fontSize: 11, color: C.red, display: "flex",
                        alignItems: "center", gap: 6,
                      }}
                    >
                      <AlertTriangle size={12} /> {analyzeErr}
                    </div>
                  )}
                </>
              ) : (
                <div
                  style={{
                    border: `1px solid ${C.lineSoft}`, borderRadius: 8,
                    background: C.field, padding: 10,
                    display: "flex", flexDirection: "column", gap: 10,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <img
                      src={productImage.preview}
                      alt="제품 이미지"
                      style={{
                        width: 52, height: 52, objectFit: "cover",
                        borderRadius: 6, border: `1px solid ${C.line}`, flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 11.5, color: C.text, overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}
                      >
                        {productImage.name}
                      </div>
                      <div style={{ fontFamily: mono, fontSize: 10, color: analyzing ? C.amber : analysis ? "#7BC47F" : C.dim, marginTop: 2, display: "flex", alignItems: "center", gap: 5 }}>
                        {analyzing && <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} />}
                        {analyzing ? "제품 분석 중…" : analysis ? "분석 완료" : "분석 대기"}
                      </div>
                    </div>
                    <label
                      title="이미지 교체"
                      style={{
                        fontSize: 10.5, fontFamily: mono, color: C.sub,
                        background: "transparent", border: `1px solid ${C.line}`,
                        borderRadius: 6, padding: "4px 8px", cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={onFileInput}
                      />
                      교체
                    </label>
                    <button
                      onClick={clearImage}
                      title="이미지 제거"
                      style={{
                        fontSize: 10.5, fontFamily: mono, color: C.dim,
                        background: "transparent", border: `1px solid ${C.line}`,
                        borderRadius: 6, padding: "4px 8px", cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      ✕
                    </button>
                  </div>

                  {analyzeErr && (
                    <div
                      style={{
                        fontSize: 11, color: C.red, display: "flex",
                        alignItems: "center", gap: 6, flexWrap: "wrap",
                      }}
                    >
                      <AlertTriangle size={12} /> {analyzeErr}
                      <button
                        onClick={reAnalyze}
                        style={{
                          fontSize: 10.5, fontFamily: mono, color: C.red,
                          background: "transparent", border: `1px solid ${C.red}`,
                          borderRadius: 6, padding: "2px 8px", cursor: "pointer",
                        }}
                      >
                        재분석
                      </button>
                    </div>
                  )}

                  {analysis && (
                    <div
                      style={{
                        borderTop: `1px solid ${C.lineSoft}`, paddingTop: 10,
                        display: "flex", flexDirection: "column", gap: 8,
                      }}
                    >
                      <div style={{ fontFamily: mono, fontSize: 9.5, letterSpacing: "0.12em", color: C.amber }}>
                        AI PRODUCT ANALYSIS · {analysis.category}
                      </div>
                      <p style={{ fontSize: 11.5, lineHeight: 1.6, color: C.sub, margin: 0 }}>
                        {analysis.product_desc}
                      </p>
                      <div style={{ fontSize: 11, color: C.dim }}>
                        <span style={{ color: C.sub }}>컬러:</span> {analysis.palette}
                      </div>
                      <div
                        style={{
                          background: C.amberSoft, border: `1px solid ${C.amber}33`,
                          borderRadius: 6, padding: "8px 10px",
                        }}
                      >
                        <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.1em", color: C.amber, marginBottom: 3 }}>
                          추천 비주얼 스타일
                        </div>
                        <p style={{ fontSize: 11.5, lineHeight: 1.55, color: C.text, margin: 0 }}>
                          {analysis.style}
                        </p>
                      </div>
                      {analysis.mood_keywords.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: C.dim }}>추천 무드:</span>
                          {analysis.mood_keywords.map((m) => {
                            const active = form.mood === m;
                            return (
                              <button
                                key={m}
                                onClick={() => set("mood", active ? "" : m)}
                                style={{
                                  fontSize: 10.5, padding: "3px 9px", borderRadius: 999,
                                  border: `1px solid ${active ? C.amber : C.line}`,
                                  background: active ? C.amberSoft : "transparent",
                                  color: active ? C.amber : C.sub, cursor: "pointer",
                                }}
                              >
                                {m}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <button
                        onClick={reAnalyze}
                        disabled={analyzing}
                        style={{
                          alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5,
                          fontSize: 10.5, fontFamily: mono, color: C.dim,
                          background: "transparent", border: `1px solid ${C.line}`,
                          borderRadius: 6, padding: "4px 9px", cursor: analyzing ? "default" : "pointer",
                        }}
                      >
                        <RefreshCw size={10} /> 다시 분석
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <button
            onClick={generate}
            disabled={!form.product.trim() || running || analyzing}
            style={{
              padding: "13px", borderRadius: 9, border: "none",
              background: !form.product.trim() || running || analyzing ? C.line : C.amber,
              color: !form.product.trim() || running || analyzing ? C.dim : "#141005",
              fontSize: 14, fontWeight: 700, cursor: !form.product.trim() || running || analyzing ? "default" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            {running ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <Sparkles size={16} />}
            {running ? "제작안 생성 중…" : analyzing ? "이미지 분석 중…" : "제작안 생성"}
          </button>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </aside>

        {/* ── 우측: 씬 타임라인 ── */}
        <main style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          {scenes.length === 0 ? (
            <div
              style={{
                border: `1px dashed ${C.line}`, borderRadius: 12,
                padding: "70px 20px", textAlign: "center", color: C.dim,
              }}
            >
              <Film size={28} style={{ opacity: 0.5, marginBottom: 12 }} />
              <div style={{ fontSize: 14, color: C.sub, marginBottom: 6 }}>
                브리프를 입력하고 제작안을 생성하세요
              </div>
              <div style={{ fontFamily: mono, fontSize: 11 }}>
                STORYBOARD · SUBTITLE COPY · IMAGE & VIDEO PROMPTS (KR/EN)
              </div>
            </div>
          ) : (
            <>
              {/* 스토리 컨셉 */}
              {arc && (
                <div
                  style={{
                    background: C.panel, border: `1px solid ${C.amber}33`,
                    borderRadius: 10, padding: "12px 14px",
                    display: "flex", gap: 10, alignItems: "flex-start",
                  }}
                >
                  <Film size={14} color={C.amber} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: mono, fontSize: 9.5, letterSpacing: "0.12em", color: C.amber, marginBottom: 4 }}>
                      STORY CONCEPT
                    </div>
                    <p style={{ fontSize: 12.5, lineHeight: 1.65, color: C.text, margin: 0 }}>
                      {arc.concept}
                    </p>
                  </div>
                  <CopyBtn text={arc.concept} small />
                </div>
              )}

              {/* 타임라인 바 */}
              <div
                style={{
                  background: C.panel, border: `1px solid ${C.lineSoft}`,
                  borderRadius: 10, padding: "12px 14px",
                }}
              >
                <div
                  style={{
                    display: "flex", justifyContent: "space-between",
                    fontFamily: mono, fontSize: 10, color: C.dim, marginBottom: 8,
                    letterSpacing: "0.1em",
                  }}
                >
                  <span>TIMELINE — {form.duration}s / {form.ratio}</span>
                  <span>{doneCount}/{scenes.length} SCENES</span>
                </div>
                <div style={{ display: "flex", gap: 3, height: 8 }}>
                  {scenes.map((s, i) => (
                    <div
                      key={i}
                      title={`SCENE ${i + 1}`}
                      style={{
                        flex: (s.range[1] - s.range[0]) / total,
                        borderRadius: 3,
                        background:
                          s.status === "done" ? C.amber
                          : s.status === "error" ? C.red
                          : C.line,
                        opacity: s.status === "loading" ? 0.6 : 1,
                        transition: "background .3s",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* 씬 카드 */}
              {scenes.map((s, i) => (
                <section
                  key={i}
                  style={{
                    background: C.panel, border: `1px solid ${C.lineSoft}`,
                    borderRadius: 12, overflow: "hidden",
                  }}
                >
                  {/* slate header */}
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "11px 16px", background: C.panel2,
                      borderBottom: `1px solid ${C.lineSoft}`,
                    }}
                  >
                    {s.status === "done" && (
                      <button
                        onClick={() => toggleSelect(i)}
                        title="멀티샷에 포함"
                        style={{
                          width: 17, height: 17, borderRadius: 4, flexShrink: 0,
                          border: `1.5px solid ${selected.includes(i) ? C.amber : C.line}`,
                          background: selected.includes(i) ? C.amber : "transparent",
                          cursor: "pointer", display: "flex",
                          alignItems: "center", justifyContent: "center", padding: 0,
                        }}
                      >
                        {selected.includes(i) && <Check size={12} color="#141005" strokeWidth={3} />}
                      </button>
                    )}
                    <span
                      style={{
                        fontFamily: mono, fontSize: 12, fontWeight: 700,
                        color: C.amber, letterSpacing: "0.12em",
                      }}
                    >
                      SCENE {String(i + 1).padStart(2, "0")}
                    </span>
                    <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>
                      {tc(s.range[0])} → {tc(s.range[1])}
                    </span>
                    <div style={{ marginLeft: "auto" }}>
                      {s.status === "loading" && (
                        <Loader2 size={14} color={C.amber} style={{ animation: "spin 1s linear infinite" }} />
                      )}
                      {s.status === "error" && (
                        <button
                          onClick={() => retryScene(i)}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 5,
                            fontSize: 11, fontFamily: mono, color: C.red,
                            background: "transparent", border: `1px solid ${C.red}`,
                            borderRadius: 6, padding: "4px 9px", cursor: "pointer",
                          }}
                        >
                          <RefreshCw size={11} /> 재시도
                        </button>
                      )}
                      {s.status === "done" && (
                        <button
                          onClick={() => retryScene(i)}
                          title="이 씬 다시 생성"
                          style={{
                            background: "transparent", border: "none",
                            color: C.dim, cursor: "pointer", padding: 4,
                          }}
                        >
                          <RefreshCw size={13} />
                        </button>
                      )}
                    </div>
                  </div>

                  {s.status === "loading" && (
                    <div style={{ padding: 22, color: C.dim, fontSize: 12, fontFamily: mono }}>
                      씬 설계 중…
                    </div>
                  )}
                  {s.status === "error" && (
                    <div style={{ padding: 22 }}>
                      <div
                        style={{
                          color: C.red, fontSize: 12.5,
                          display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
                        }}
                      >
                        <AlertTriangle size={14} /> 생성에 실패했습니다. 재시도를 눌러주세요.
                      </div>
                      {s.errMsg && (
                        <div
                          style={{
                            fontFamily: mono, fontSize: 11, color: C.dim,
                            background: C.field, border: `1px solid ${C.lineSoft}`,
                            borderRadius: 6, padding: "8px 10px", wordBreak: "break-all",
                          }}
                        >
                          {s.errMsg}
                        </div>
                      )}
                    </div>
                  )}
                  {s.status === "done" && s.data && (
                    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                      {arc?.beats?.[i] && (
                        <div
                          style={{
                            fontSize: 11, color: C.dim, lineHeight: 1.5,
                            borderLeft: `2px solid ${C.amber}55`, paddingLeft: 8,
                          }}
                        >
                          {arc.beats[i]}
                        </div>
                      )}
                      {/* storyboard */}
                      <div>
                        <div
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6,
                          }}
                        >
                          <span style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: "0.1em", color: C.sub, display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <Clapperboard size={12} color={C.amber} /> STORYBOARD
                          </span>
                          <CopyBtn text={s.data.storyboard} small />
                        </div>
                        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: C.text, margin: 0 }}>
                          {s.data.storyboard}
                        </p>
                      </div>

                      {/* subtitle */}
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          background: C.field, border: `1px solid ${C.lineSoft}`,
                          borderRadius: 8, padding: "10px 12px",
                        }}
                      >
                        <Type size={13} color={C.amber} style={{ flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: mono, fontSize: 9.5, color: C.dim, letterSpacing: "0.1em", marginBottom: 2 }}>
                            자막 카피 (후반 편집용)
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
                            {s.data.subtitle}
                          </div>
                        </div>
                        <CopyBtn text={s.data.subtitle} small />
                      </div>

                      {/* prompts grid */}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                          gap: 10,
                        }}
                      >
                        <PromptBlock tag="IMAGE" lang="KR" text={s.data.image_prompt_kr} />
                        <PromptBlock tag="IMAGE" lang="EN" text={s.data.image_prompt_en} />
                        <PromptBlock tag="VIDEO" lang="KR" text={s.data.video_prompt_kr} />
                        <PromptBlock tag="VIDEO" lang="EN" text={s.data.video_prompt_en} />
                      </div>
                    </div>
                  )}
                </section>
              ))}

              {/* 멀티샷 */}
              {doneCount >= 2 && (
                <section
                  style={{
                    background: C.panel,
                    border: `1px solid ${selected.length >= 2 ? C.amber + "55" : C.lineSoft}`,
                    borderRadius: 12, overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                      padding: "12px 16px", background: C.panel2,
                      borderBottom: multi ? `1px solid ${C.lineSoft}` : "none",
                    }}
                  >
                    <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: C.amber, letterSpacing: "0.12em" }}>
                      MULTI-SHOT
                    </span>
                    <span style={{ fontSize: 11.5, color: C.dim }}>
                      {selected.length >= 2
                        ? `씬 ${selected.map((i) => i + 1).join(" + ")} 선택됨 · STEP 1 합성 이미지 프롬프트 생성`
                        : "씬 카드의 체크박스로 2개 이상 선택하세요. ① STEP 1: 합치는 합성 이미지 프롬프트 생성 → 이미지 제작 후 ② STEP 2: 그 이미지를 업로드하면 영상 프롬프트 생성"}
                    </span>
                    <button
                      onClick={runMultiShot}
                      disabled={selected.length < 2 || multi?.status === "loading"}
                      style={{
                        marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6,
                        fontSize: 12, fontWeight: 700, padding: "7px 14px", borderRadius: 7,
                        border: "none",
                        background: selected.length >= 2 && multi?.status !== "loading" ? C.amber : C.line,
                        color: selected.length >= 2 && multi?.status !== "loading" ? "#141005" : C.dim,
                        cursor: selected.length >= 2 && multi?.status !== "loading" ? "pointer" : "default",
                      }}
                    >
                      {multi?.status === "loading"
                        ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
                        : <Film size={13} />}
                      {multi?.status === "loading" ? "생성 중…" : "STEP 1 이미지 프롬프트 생성"}
                    </button>
                  </div>

                  {multi?.status === "loading" && (
                    <div style={{ padding: 18, color: C.dim, fontSize: 12, fontFamily: mono }}>
                      선택한 씬들을 하나로 합치는 이미지 프롬프트 생성 중… (KR·EN)
                    </div>
                  )}
                  {multi?.status === "error" && (
                    <div style={{ padding: 18 }}>
                      <div style={{ color: C.red, fontSize: 12.5, display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <AlertTriangle size={14} /> 멀티샷 생성에 실패했습니다. 다시 시도해주세요.
                      </div>
                      <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, background: C.field, border: `1px solid ${C.lineSoft}`, borderRadius: 6, padding: "8px 10px", wordBreak: "break-all" }}>
                        {multi.errMsg}
                      </div>
                    </div>
                  )}
                  {multi?.status === "done" && multi.data && (
                    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                        <span style={{ fontFamily: mono, fontSize: 10.5, color: C.sub, letterSpacing: "0.1em" }}>
                          씬 {multi.data.sceneIdxs.map((i) => i + 1).join(" + ")} → 합성 {multi.data.shotCount}컷 · 영상 {multi.data.duration}s · {form.ratio}
                        </span>
                        <CopyBtn text={multiText()} small />
                      </div>

                      {/* STEP 1 — 합성 이미지 */}
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                          <span
                            style={{
                              fontFamily: mono, fontSize: 10, fontWeight: 700, color: "#141005",
                              background: C.amber, borderRadius: 5, padding: "2px 7px",
                            }}
                          >
                            STEP 1
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                            멀티샷 합성 이미지 생성
                          </span>
                          <span style={{ fontSize: 10.5, color: C.dim }}>
                            선택 씬을 한 장으로 합침
                          </span>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                            gap: 10,
                          }}
                        >
                          <PromptBlock tag="합성 IMAGE" lang="KR" text={multi.data.image_prompt_kr} />
                          <PromptBlock tag="합성 IMAGE" lang="EN" text={multi.data.image_prompt_en} />
                        </div>
                      </div>

                      {/* STEP 2 — 합성 이미지 업로드 후 영상 프롬프트 생성 */}
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                          <span
                            style={{
                              fontFamily: mono, fontSize: 10, fontWeight: 700, color: "#141005",
                              background: multiVid?.status === "done" ? C.amber : C.line,
                              borderRadius: 5, padding: "2px 7px",
                            }}
                          >
                            STEP 2
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                            합성 이미지 업로드 → 영상 프롬프트 생성
                          </span>
                        </div>
                        <div style={{ fontSize: 10.5, color: C.dim, marginBottom: 8, paddingLeft: 2 }}>
                          STEP 1 프롬프트로 만든 합성 이미지를 아래에 업로드하면, 그 이미지에 맞춰 영상 프롬프트(한글·영문)를 생성합니다.
                        </div>

                        {/* 업로드 영역 / 미리보기 */}
                        {!multiImg ? (
                          <label
                            onDragOver={(e) => { e.preventDefault(); setMultiDrag(true); }}
                            onDragLeave={() => setMultiDrag(false)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setMultiDrag(false);
                              handleMultiImageFile(e.dataTransfer.files?.[0]);
                            }}
                            style={{
                              display: "block",
                              border: `1px dashed ${multiDrag ? C.amber : C.line}`,
                              borderRadius: 8,
                              background: multiDrag ? C.amberSoft : C.field,
                              padding: "18px 12px", cursor: "pointer",
                              color: C.sub, textAlign: "center", transition: "all .15s",
                            }}
                          >
                            <input type="file" accept="image/*" style={{ display: "none" }} onChange={onMultiImageInput} />
                            <ImageIcon size={18} style={{ opacity: 0.6, marginBottom: 6 }} />
                            <div style={{ fontSize: 12.5, fontWeight: 600 }}>합성 이미지 업로드</div>
                            <div style={{ fontSize: 10.5, color: C.dim, marginTop: 3 }}>
                              클릭해서 선택하거나 여기로 드래그하세요
                            </div>
                          </label>
                        ) : (
                          <div
                            style={{
                              border: `1px solid ${C.lineSoft}`, borderRadius: 8, background: C.field,
                              padding: 10, display: "flex", gap: 10, alignItems: "center",
                            }}
                          >
                            <img
                              src={multiImg.preview}
                              alt="합성 이미지"
                              style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 6, border: `1px solid ${C.line}`, flexShrink: 0 }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 11.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {multiImg.name}
                              </div>
                              <div style={{ fontFamily: mono, fontSize: 10, color: multiVid?.status === "loading" ? C.amber : multiVid?.status === "done" ? "#7BC47F" : C.dim, marginTop: 2, display: "flex", alignItems: "center", gap: 5 }}>
                                {multiVid?.status === "loading" && <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} />}
                                {multiVid?.status === "loading" ? "영상 프롬프트 생성 중…" : multiVid?.status === "done" ? "생성 완료" : "대기"}
                              </div>
                            </div>
                            <label
                              style={{
                                fontSize: 10.5, fontFamily: mono, color: C.sub,
                                background: "transparent", border: `1px solid ${C.line}`,
                                borderRadius: 6, padding: "4px 8px", cursor: "pointer", flexShrink: 0,
                              }}
                            >
                              <input type="file" accept="image/*" style={{ display: "none" }} onChange={onMultiImageInput} />
                              교체
                            </label>
                          </div>
                        )}

                        {multiVid?.status === "error" && (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 11.5, color: C.red, display: "flex", alignItems: "center", gap: 6 }}>
                              <AlertTriangle size={12} /> {multiVid.errMsg}
                            </div>
                            {multiImg && (
                              <button
                                onClick={() => { setMultiImg(null); setMultiVid(null); }}
                                style={{ marginTop: 6, fontSize: 10.5, fontFamily: mono, color: C.dim, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "4px 9px", cursor: "pointer" }}
                              >
                                다시 업로드
                              </button>
                            )}
                          </div>
                        )}

                        {multiVid?.status === "done" && multiVid.data && (
                          <div
                            style={{
                              marginTop: 10,
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                              gap: 10,
                            }}
                          >
                            <PromptBlock tag="영상화 VIDEO" lang="KR" text={multiVid.data.video_prompt_kr} />
                            <PromptBlock tag="영상화 VIDEO" lang="EN" text={multiVid.data.video_prompt_en} />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {doneCount > 0 && (
                <button
                  onClick={async () => { await copyText(fullText()); }}
                  style={{
                    padding: "13px", borderRadius: 9,
                    border: `1px solid ${C.amber}`, background: C.amberSoft,
                    color: C.amber, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  }}
                >
                  <Copy size={15} /> 전체 제작안 복사
                </button>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
