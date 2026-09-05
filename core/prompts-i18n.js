/**
 * ============================================================================
 * PROMPTS I18N — Language-specific prompt variants
 * ============================================================================
 * Single source of truth for all localised prompt strings.
 *
 * Both the agentic planner and the summarizer pick their system prompt from
 * here based on the user's CJK Tokenizer Mode setting, which doubles as the
 * "story language" selector.
 *
 * Supported modes (mirrors CJK_TOKENIZER_MODES in bm25-scorer.js):
 *   intl            → English / Latin           (English examples)
 *   jieba           → Simplified Chinese         (简体中文 examples)
 *   jieba_tw        → Traditional Chinese        (繁體中文 examples)
 *   tiny_segmenter  → Japanese                   (日本語 examples)
 *   korean          → Korean                     (한국어 examples)
 *   others          → Any other language          (English examples + language notice)
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC PLANNER SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
// Shared structural header — output format, filter rules, question type guide.
// Language rule + examples are in the per-language blocks below.

const _PLANNER_HEADER =
`You are a retrieval planner for a roleplay memory system. Read recent chat plus pre-search candidate events, then decide what to search the event database for.

Filterable event fields: event_type, importance (1–10), characters, locations, factions, items, concepts (themes), keywords, DateTime.

Output STRICT JSON with exactly three fields:

  queries    1–4 short search strings (5–15 words). LANGUAGE: match the recent
             chat — CHECK the chat's language before writing (English chat →
             English queries; Chinese chat → Chinese queries; Japanese → Japanese;
             etc.). Each query MUST differ on at least one of these axes — not
             just wording:
               • TIME        (early arc vs recent vs aftermath)
               • PERSPECTIVE (character A's view vs character B's view)
               • GRANULARITY (specific event vs general pattern over time)
               • FACET       (action vs emotion vs setting vs dialogue vs consequence)
               • RELATION    (X with Y vs X alone vs X versus Z)
             Paraphrase check: if two queries share ≥3 content words OR differ only by
             wording / synonyms, they are paraphrases — DROP one and replace it with a
             different axis (e.g. lead-up history, reaction from another character,
             setting context, consequence).
             Genre note: in slice-of-life / dating / workplace stories, prefer pattern +
             key-moment pairs over causal chains. Causal chains fit RPG/mystery/thriller.

  filters    Optional:
               characters_any, locations_any, factions_any, items_any, concepts_any,
               event_type_any  — arrays of strings
               importance_gte  — number 1–10

  rationale  One sentence in the story language. Debug only — not used in retrieval.

══ FILTER RULES ══════════════════════════════════════════════════════

concepts_any = THEME words in the story language.
  • Never mix languages here. Never put proper nouns here.
  • If a theme word appears in your queries, also put it in concepts_any — it is the
    strongest anchor for sparse-vector matching.

characters_any / locations_any / items_any / factions_any = proper nouns in whatever
form they appear in the chat (keep original script/spelling).

importance_gte: set 6–7 to skip filler events for "remember when…" questions.
Over-filtering on characters_any is fine; avoid over-constraining locations/factions.

══ QUESTION TYPE GUIDE ═══════════════════════════════════════════════

  "why X?"        → one query per causal stage: cause → act → aftermath
  "at location?"  → events at that place
  "the [event]?"  → the event itself + lead-up history that caused it + key participants + consequences
  "remember...?"  → event + result + reactions; don't over-filter (user may misremember)
  "Z's reaction?" → Z's events around that moment
  Vague/open      → broad queries, fewer filters

`;

const _PLANNER_FOOTER =
`Return ONLY the JSON object. No commentary, no markdown fences, no preamble.`;

// ── Per-language EXAMPLES blocks ─────────────────────────────────────────────

const _PLANNER_EXAMPLES_INTL =
`══ LANGUAGE RULE ═════════════════════════════════════════════════════
Write ALL queries in English. Never mix languages.
Proper nouns (names, places, items) keep their exact form from the chat.

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — Causal "why" chain (plot-driven, RPG/mystery/thriller):
User: "Do you remember why we had to pay the ransom?"
{
  "queries": [
    "kidnapping ransom payment negotiation",
    "hostage capture arrest imprisonment",
    "rescue aftermath emotional reaction"
  ],
  "filters": {
    "concepts_any": ["ransom", "kidnapping", "rescue"]
  },
  "rationale": "Causal chain — different TIME slices: capture → negotiation → payment → rescue aftermath."
}

Example 2 — Slice-of-life / character state pattern (mixed-axis decomposition):
User: "How has Yuki been adjusting to the dorm?"
{
  "queries": [
    "Yuki dorm move-in first impression",
    "Yuki mealtime conversations roommates",
    "Yuki study routine late night habits",
    "Yuki mood shifts recent weeks"
  ],
  "filters": {
    "characters_any": ["Yuki"]
  },
  "rationale": "Mixed axes — arrival event (TIME), social pattern (FACET), daily habit (GRANULARITY), emotional trajectory (FACET)."
}

`;

const _PLANNER_EXAMPLES_JIEBA_TW =
`══ 語言規則 ══════════════════════════════════════════════════════════
所有 queries 及 concepts_any 必須以繁體中文書寫，不得混入英文或其他語言。
例外：人名、地名、物品名稱保留原文形式（英文名稱不翻譯）。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果「為何」鏈 (劇情驅動 / RPG / 推理 / 懸疑)：
User: 我對 Mayla 説 "你記得我當時為甚麼為你贖身嗎?"
{
  "queries": [
    "Mayla 贖身 2萬金幣付款",
    "Mayla 綁架 被擄走 監禁",
    "贖金談判 老闆 中介",
    "Mayla 獲救 後續 情感反應"
  ],
  "filters": {
    "characters_any": ["Mayla"],
    "concepts_any": ["贖身", "綁架", "獲救"]
  },
  "rationale": "因果鏈，TIME 軸分段：綁架→談判→付款→救出反應。"
}

Example 2 — 日常狀態 / 角色適應 (混合軸分解)：
User: "Fern 最近過得怎麼樣？"
{
  "queries": [
    "Fern 加入眷屬 初次反應",
    "Fern 與其他眷屬 日常互動",
    "Fern 訓練 學習 進步",
    "Fern 情緒變化 最近幾日"
  ],
  "filters": {
    "characters_any": ["Fern"]
  },
  "rationale": "混合軸：加入事件 (TIME)、社交模式 (FACET)、能力成長 (GRANULARITY)、情感軌跡 (FACET)。"
}

`;

const _PLANNER_EXAMPLES_JIEBA =
`══ 语言规则 ══════════════════════════════════════════════════════════
所有 queries 及 concepts_any 必须以简体中文书写，不得混入英文或其他语言。
例外：人名、地名、物品名称保留原文形式（英文名称不翻译）。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果"为何"链 (剧情驱动 / RPG / 推理 / 悬疑)：
User: 我对 Mayla 说 "你还记得我当时为什么为你赎身吗?"
{
  "queries": [
    "Mayla 赎身 2万金币付款",
    "Mayla 绑架 被掳走 监禁",
    "赎金谈判 老板 中介",
    "Mayla 获救 后续 情感反应"
  ],
  "filters": {
    "characters_any": ["Mayla"],
    "concepts_any": ["赎身", "绑架", "获救"]
  },
  "rationale": "因果链，TIME 轴分段：绑架→谈判→付款→救出反应。"
}

Example 2 — 日常状态 / 角色适应 (混合轴分解)：
User: "Fern 最近过得怎么样？"
{
  "queries": [
    "Fern 加入眷属 初次反应",
    "Fern 与其他眷属 日常互动",
    "Fern 训练 学习 进步",
    "Fern 情绪变化 最近几日"
  ],
  "filters": {
    "characters_any": ["Fern"]
  },
  "rationale": "混合轴：加入事件 (TIME)、社交模式 (FACET)、能力成长 (GRANULARITY)、情感轨迹 (FACET)。"
}

`;

const _PLANNER_EXAMPLES_TINY_SEGMENTER =
`══ 言語ルール ════════════════════════════════════════════════════════
queriesおよびconcepts_anyはすべて日本語で記述する。他の言語を混在させない。
例外：人名・地名・物品名は会話中の元の表記をそのまま使用する。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果「なぜ」チェーン (プロット駆動 / RPG / ミステリー / スリラー)：
User: "なぜあのとき身代金を払わなければならなかったの覚えてる？"
{
  "queries": [
    "身代金 誘拐 拘束 監禁",
    "交渉 支払い 解放 救出",
    "救出 後の感情 反応 関係"
  ],
  "filters": {
    "concepts_any": ["身代金", "誘拐", "救出"]
  },
  "rationale": "因果連鎖、TIME 軸の分割：誘拐→交渉→支払い→救出後。"
}

Example 2 — 日常的状況・キャラクターの適応 (混合軸の分解)：
User: "ユキは寮の生活にどう馴染んでる？"
{
  "queries": [
    "ユキ 寮 引っ越し 最初の印象",
    "ユキ ルームメイト 食事 会話",
    "ユキ 勉強 夜 習慣",
    "ユキ 気分 変化 最近"
  ],
  "filters": {
    "characters_any": ["ユキ"]
  },
  "rationale": "混合軸：到着 (TIME)、社交パターン (FACET)、日常習慣 (GRANULARITY)、感情の推移 (FACET)。"
}

`;

const _PLANNER_EXAMPLES_KOREAN =
`══ 언어 규칙 ════════════════════════════════════════════════════════
모든 queries 및 concepts_any는 한국어로만 작성한다. 다른 언어를 섞지 않는다.
예외: 인명·지명·아이템명은 대화에서 사용된 원래 표기를 그대로 유지한다.

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 인과 「왜」 체인 (플롯 중심 / RPG / 미스터리 / 스릴러):
User: "우리가 왜 몸값을 내야 했는지 기억해?"
{
  "queries": [
    "납치 몸값 협상 지불",
    "인질 체포 감금 구금",
    "구출 이후 감정 반응"
  ],
  "filters": {
    "concepts_any": ["몸값", "납치", "구출"]
  },
  "rationale": "인과 사슬, TIME 축 분할: 납치→협상→지불→구출 이후."
}

Example 2 — 일상생활 / 캐릭터 적응 (혼합 축 분해):
User: "유키는 기숙사 생활에 어떻게 적응하고 있어?"
{
  "queries": [
    "유키 기숙사 입주 첫 인상",
    "유키 룸메이트 식사 대화",
    "유키 공부 밤 습관",
    "유키 기분 변화 최근"
  ],
  "filters": {
    "characters_any": ["유키"]
  },
  "rationale": "혼합 축: 도착 사건 (TIME), 사회적 패턴 (FACET), 일상 습관 (GRANULARITY), 감정 변화 (FACET)."
}

`;

const _PLANNER_EXAMPLES_OTHERS =
`══ LANGUAGE RULE ═════════════════════════════════════════════════════
Detect the story language from the chat. Write ALL queries and concepts_any
in that language only. Do NOT default to English — match the roleplay language.
Proper nouns (names, places, items) keep their exact form from the chat.

══ EXAMPLES (shown in English — apply the same pattern in your detected language) ══

Example 1 — Causal "why" chain (plot-driven, RPG/mystery/thriller):
User: "Do you remember why we had to pay the ransom?"
{
  "queries": [
    "kidnapping ransom payment negotiation",
    "hostage capture arrest imprisonment",
    "rescue aftermath emotional reaction"
  ],
  "filters": {
    "concepts_any": ["ransom", "kidnapping", "rescue"]
  },
  "rationale": "Causal chain — different TIME slices: capture → negotiation → payment → rescue aftermath."
}

Example 2 — Slice-of-life / character state pattern (mixed-axis decomposition):
User: "How has Yuki been adjusting to the dorm?"
{
  "queries": [
    "Yuki dorm move-in first impression",
    "Yuki mealtime conversations roommates",
    "Yuki study routine late night habits",
    "Yuki mood shifts recent weeks"
  ],
  "filters": {
    "characters_any": ["Yuki"]
  },
  "rationale": "Mixed axes — arrival event (TIME), social pattern (FACET), daily habit (GRANULARITY), emotional trajectory (FACET)."
}

`;

const _PLANNER_PROMPTS = {
    intl:           _PLANNER_HEADER + _PLANNER_EXAMPLES_INTL           + _PLANNER_FOOTER,
    jieba:          _PLANNER_HEADER + _PLANNER_EXAMPLES_JIEBA           + _PLANNER_FOOTER,
    jieba_tw:       _PLANNER_HEADER + _PLANNER_EXAMPLES_JIEBA_TW        + _PLANNER_FOOTER,
    tiny_segmenter: _PLANNER_HEADER + _PLANNER_EXAMPLES_TINY_SEGMENTER  + _PLANNER_FOOTER,
    korean:         _PLANNER_HEADER + _PLANNER_EXAMPLES_KOREAN          + _PLANNER_FOOTER,
    others:         _PLANNER_HEADER + _PLANNER_EXAMPLES_OTHERS          + _PLANNER_FOOTER,
};

/**
 * Returns the agentic planner system prompt for the given story language mode.
 * Falls back to the English (intl) prompt for unknown modes.
 *
 * @param {string} [mode] - Value from CJK_TOKENIZER_MODES (e.g. 'jieba_tw')
 * @returns {string}
 */
export function getAgenticPlannerPrompt(mode) {
    return Object.prototype.hasOwnProperty.call(_PLANNER_PROMPTS, mode) ? _PLANNER_PROMPTS[mode] : _PLANNER_PROMPTS.intl;
}


// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT SUMMARIZE PROMPT
// ─────────────────────────────────────────────────────────────────────────────

const _SUMMARIZE_INTL =
`You are a story memory archivist. Compress the following roleplay excerpt into a dense 2-10 sentence summary optimized for semantic search and retrieval.

Requirements:
- If a Date or Date + Time is in the main text, always include that in your summary.
- Preserve ALL proper nouns exactly as written: character names, location names, item names, organization names, and titles
- Capture: who is present, where the scene takes place, what actions occurred, any significant items or abilities referenced, and the emotional/relationship dynamics
- Write in English
- Be factual and information-dense — no filler phrases, no meta-commentary, no interpretation
- Output only the summary with no preamble or explanation

Story excerpt:
{{text}}`;

const _SUMMARIZE_JIEBA_TW =
`你是故事記憶檔案員。將以下角色扮演片段壓縮成一段2至10句的摘要，針對語義搜尋和檢索進行優化。

要求：
- 如果正文中有日期或日期加時間，請務必在摘要中包含。
- 完整保留所有專有名詞：角色名稱、地點名稱、物品名稱、組織名稱和頭銜
- 涵蓋：在場人物、場景發生地點、發生的行動、任何重要的物品或能力，以及情感╱關係動態
- 以繁體中文撰寫
- 以事實為依據，資訊密集——不使用填充詞、不加入後設評論、不作詮釋
- 僅輸出摘要，不加前言或說明

故事片段：
{{text}}`;

const _SUMMARIZE_JIEBA =
`你是故事记忆档案员。将以下角色扮演片段压缩成一段2至10句的摘要，针对语义搜索和检索进行优化。

要求：
- 如果正文中有日期或日期加时间，请务必在摘要中包含。
- 完整保留所有专有名词：角色名称、地点名称、物品名称、组织名称和称号
- 涵盖：在场人物、场景发生地点、发生的行动、任何重要的物品或能力，以及情感╱关系动态
- 以简体中文撰写
- 以事实为依据，信息密集——不使用填充词、不加入元评论、不作诠释
- 仅输出摘要，不加前言或说明

故事片段：
{{text}}`;

const _SUMMARIZE_TINY_SEGMENTER =
`あなたはストーリーの記憶アーカイバーです。以下のロールプレイの抜粋を、セマンティック検索と検索に最適化された2〜10文の密度の高い要約に圧縮してください。

要件：
- 本文に日付または日付＋時刻がある場合は、必ず要約に含めてください。
- すべての固有名詞をそのまま保持する：キャラクター名、場所名、アイテム名、組織名、称号
- 捉えること：誰が存在するか、場面はどこで起きるか、どんな行動が起きたか、重要なアイテムや能力、感情╱関係のダイナミクス
- 日本語で記述する
- 事実に基づき情報密度を高く——つなぎ言葉なし、メタコメントなし、解釈なし
- 前置きや説明なしに要約のみを出力する

ストーリーの抜粋：
{{text}}`;

const _SUMMARIZE_KOREAN =
`당신은 스토리 기억 아카이버입니다. 다음 롤플레이 발췌문을 시맨틱 검색 및 검색에 최적화된 2~10문장의 간결한 요약으로 압축하세요.

요건:
- 본문에 날짜 또는 날짜+시간이 있으면 반드시 요약에 포함하세요.
- 모든 고유명사를 그대로 보존하세요: 캐릭터 이름, 장소 이름, 아이템 이름, 조직 이름, 직함
- 다음을 포함하세요: 등장 인물, 장면 장소, 발생한 행동, 중요한 아이템이나 능력, 감정/관계 역학
- 한국어로 작성하세요
- 사실에 기반하여 정보 밀도를 높게 유지하세요 — 불필요한 표현, 메타 해설, 해석 없이
- 서문이나 설명 없이 요약만 출력하세요

스토리 발췌:
{{text}}`;

const _SUMMARIZE_OTHERS =
`You are a story memory archivist. Compress the following roleplay excerpt into a dense 2-10 sentence summary optimized for semantic search and retrieval.

Requirements:
- If a Date or Date + Time is in the main text, always include that in your summary.
- Preserve ALL proper nouns exactly as written: character names, location names, item names, organization names, and titles
- Capture: who is present, where the scene takes place, what actions occurred, any significant items or abilities referenced, and the emotional/relationship dynamics
- IMPORTANT: Write in the same language as the story excerpt — do not translate into English or any other language. Match the story's language exactly.
- Be factual and information-dense — no filler phrases, no meta-commentary, no interpretation
- Output only the summary with no preamble or explanation

Story excerpt:
{{text}}`;

const _SUMMARIZE_PROMPTS = {
    intl:           _SUMMARIZE_INTL,
    jieba:          _SUMMARIZE_JIEBA,
    jieba_tw:       _SUMMARIZE_JIEBA_TW,
    tiny_segmenter: _SUMMARIZE_TINY_SEGMENTER,
    korean:         _SUMMARIZE_KOREAN,
    others:         _SUMMARIZE_OTHERS,
};

/**
 * Returns the default summarization prompt for the given story language mode.
 * Falls back to the English (intl) prompt for unknown modes.
 *
 * @param {string} [mode] - Value from CJK_TOKENIZER_MODES (e.g. 'jieba_tw')
 * @returns {string}
 */
export function getDefaultSummarizePrompt(mode) {
    return Object.prototype.hasOwnProperty.call(_SUMMARIZE_PROMPTS, mode) ? _SUMMARIZE_PROMPTS[mode] : _SUMMARIZE_PROMPTS.intl;
}


// ─────────────────────────────────────────────────────────────────────────────
// EVENTBASE EXTRACTION PROMPT
// ─────────────────────────────────────────────────────────────────────────────
// The extraction prompt is sent to the LLM for every chat window during
// EventBase ingestion. It tells the LLM to return a JSON array of structured
// event records. Mostly the same across languages — what varies is:
//   1. The LANGUAGE rule (which language to write string fields in)
//   2. The VALID OUTPUT EXAMPLES (shown in the target language so the LLM
//      anchors on the right script)
// Everything else (event_type list, importance guide, schema fields) stays
// shared since it's instructional metadata for the LLM, not output.

// ── Shared TOP: intro + ABSOLUTE RULES heading ───────────────────────────────
const _EXTRACTION_TOP =
`You are a story event archivist for a roleplay session. Extract ONLY narratively significant story events from the excerpt below.

=========================
ABSOLUTE RULES (DO NOT BREAK)
=========================
`;

// ── Per-language LANGUAGE rule (Rule 1) ──────────────────────────────────────
const _EXTRACTION_LANG_INTL =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in English.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS examples for this language (see full rules in OUTPUT SCHEMA below):
       GOOD: "sacrifice", "trust", "obligation", "isolation", "redemption", "the cost of victory"
       BAD:  "Mayla" (character), "tavern" (location), "sword" (item),
             "combat" (action), "leveling up" (mechanic)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_JIEBA =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Simplified Chinese (简体中文).
   - DO NOT convert to Traditional Chinese.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 范例（完整规则见下方 OUTPUT SCHEMA）：
       好的概念：「赎身」、「失踪的父亲」、「信仰」、「情感依附」、「亲情」、「孤独」、「背叛」
       不要放：「梅拉」(人名)、「酒馆」(地点)、「魔导石」(物品)、
                「战斗」(动作)、「升级」(机制)、「食腐蟹」(怪物名)、
                「属性点分配」(游戏机制)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_JIEBA_TW =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Traditional Chinese (繁體中文).
   - DO NOT convert to Simplified Chinese.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 範例（完整規則見下方 OUTPUT SCHEMA）：
       好的概念：「贖身」、「失蹤的父親」、「信仰」、「情感依附」、「親情」、「孤獨」、「背叛」
       不要放：「梅拉」(人名)、「酒館」(地點)、「魔導石」(物品)、
                「戰鬥」(動作)、「升級」(機制)、「食腐蟹」(怪物名)、
                「屬性點分配」(遊戲機制)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_TINY_SEGMENTER =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Japanese (日本語).
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 例（詳しいルールは下の OUTPUT SCHEMA を参照）：
       良い概念：「誓い」、「罪悪感」、「信頼」、「孤独」、「親子の絆」、「贖罪」、「裏切り」
       不可：「メイラ」(人名)、「酒場」(場所)、「剣」(アイテム)、
              「戦闘」(動作)、「レベルアップ」(ゲーム機構)、
              「食腐蟹」(モンスター名)、「ステータス振り分け」(機構)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_KOREAN =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Korean (한국어).
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 예시 (전체 규칙은 아래 OUTPUT SCHEMA 참조):
       좋은 개념: "맹세", "부녀의 정", "신뢰", "고독", "속죄", "배신", "희생"
       나쁨: "메이라" (인명), "주막" (장소), "검" (아이템),
             "전투" (행동), "레벨업" (게임 메커닉),
             "식부해" (몬스터 이름), "능력치 분배" (게임 메커닉)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_OTHERS =
`1. LANGUAGE — MANDATORY:
   - Detect the dominant language of the excerpt. All string fields MUST be in THAT language.
   - Do NOT default to English unless the excerpt is in English.
   - If the excerpt mixes languages, follow the dominant language of each individual field's source content.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS examples (English shown — translate the SHAPE into the detected language):
       GOOD (abstract themes that recur): "sacrifice", "trust", "obligation",
             "isolation", "redemption", "the cost of victory"
       BAD  (entity / action / mechanic — belong in OTHER fields):
             a character name → characters, a location → locations,
             an item → items, a specific battle → keywords / summary,
             "leveling up" → keywords (it's a game mechanic, not a theme)
   - Violating this rule makes the output invalid.

`;

// ── Shared middle: Rules 2, 3, and full OUTPUT SCHEMA ────────────────────────
// This is instructional text for the LLM, not output content, so it stays in
// English regardless of story language. The schema fields are also defined here
// since their structure is identical across languages.
const _EXTRACTION_RULES_BODY =
`2. EVENT COUNT:
   - Return AT MOST {{maxCount}} events.
   - Return as many real events as actually occurred — do not artificially cap or pad.
   - Zero events ([]) is correct only when the excerpt is pure filler with no character interaction, relationship movement, world information, or narrative consequence whatsoever.
   - DO NOT invent events. DO NOT duplicate the same event under different names.

3. WHEN TO RETURN ZERO EVENTS ([]):
   Return [] if BOTH of the following are true:
   a) The excerpt does not contain any event that maps to the defined event_type list above.
   OR
   b) It does map to an event_type, but the event has no lasting consequence worth retrieving later.

   THE ONE-WEEK TEST — ask yourself: "If someone reads this story one week from now, would knowing this event change their understanding of the characters, world, or plot?"
   - If YES → extract it.
   - If NO → skip it.

   Examples that FAIL the test (return []):
   - The party has dinner at home with no plot discussion.
   - The main character teases the heroine playfully with no consequence.
   - Characters chat about the weather or daily routine.

   Examples that PASS the test (extract):
   - Main character pays for the heroine's freedom — her status permanently changed. Money involved is a concrete detail worth remembering.
   - A promise or oath is made — it shapes future obligations.
   - A character's inner fear or secret is revealed — it reframes past or future behaviour.

   Sexual / intimate scenes: return [] UNLESS the scene contains a confession, promise, relationship change, revelation, or any narrative consequence that would still matter one week later. The intimacy itself is not the event — extract only what changes.

=========================
OUTPUT SCHEMA
=========================
Return ONLY a valid JSON array. No prose. No markdown. No code fences.

Each event object MUST have these fields:
- event_type: one of [main_quest_update, side_quest_update, combat, travel, discovery, dialogue_significant, relationship_change, character_introduction, character_state_change, item_acquired, item_lost, faction_change, location_change, revelation, promise_or_oath, betrayal, death, other]
- importance: integer 1-10. Use the one-week test: higher = more likely to matter one week later.
  Anchor your score against these per-type guidelines:

  PERMANENT / IRREVERSIBLE changes score highest — they reshape the story permanently.
  EPHEMERAL moments score lowest — they happened but leave no lasting trace.

  main_quest_update:    7-10 (major milestone/turning point), 4-6 (incremental progress)
  side_quest_update:    3-6  (completion or key step), 1-3 (minor update)
  combat:               2-4  (routine fight, won or lost), 6-8 (boss or pivotal battle),
                        9-10 (combat that kills a major character or changes the story permanently)
  travel:               1-2  (moving between locations), 3-5 (arrival at a key destination that opens new story)
  discovery:            3-5  (minor lore or clue), 6-8 (world-changing revelation or hidden truth uncovered)
  dialogue_significant: 3-5  (key conversation, character insight), 6-8 (confession, confrontation, defining moment)
  relationship_change:  5-7  (gradual shift in trust/bond), 8-10 (permanent status change — e.g. freed from slavery, marriage, sworn enemy)
  character_introduction: 3-5 (new named character joins), 6-8 (introduction of a major antagonist or pivotal NPC)
  character_state_change: 4-6 (injury, level-up, mood shift), 7-9 (permanent transformation — power gained, identity revealed, disability)
  item_acquired:        1-3  (common item), 5-7 (plot-critical item or unique artifact)
  item_lost:            1-3  (minor loss), 6-8 (loss of a plot-critical item or irreplaceable object)
  faction_change:       6-9  (political/social alignment shifted — alliances broken or formed)
  location_change:      1-2  (routine travel), 3-5 (arrival at a narratively important new location)
  revelation:           6-8  (important hidden truth exposed), 9-10 (revelation that fundamentally reframes the story or a character)
  promise_or_oath:      5-7  (significant promise between characters), 8-9 (binding oath with major consequences)
  betrayal:             7-10 (trust broken — scale with how close the relationship was and how severe the consequences)
  death:                6-8  (minor/enemy character), 9-10 (death of a named ally or major character)
  other:                1-4  (flavor worth remembering), 5-7 (genuinely significant but doesn't fit other types)
- summary: 2-8 dense sentences capturing WHO did WHAT, the key detail, the emotional/narrative impact, and any important consequences or reactions. SAME LANGUAGE AS EXCERPT (see Rule 1)
- cause: short explanation of why it happened, SAME LANGUAGE AS EXCERPT (may be "")
- result: outcome / state change, SAME LANGUAGE AS EXCERPT (may be "")
- characters: array of proper-noun names, EXACT ORIGINAL SCRIPT
- locations: array of strings, EXACT ORIGINAL SCRIPT
- factions: array of strings, EXACT ORIGINAL SCRIPT
- DateTime: ISO 8601 string (e.g., "2024-01-01T12:00:00Z") representing when the event occurred in the story timeline, if it can be determined from the excerpt; otherwise omit or set to null.
- items: array of strings, EXACT ORIGINAL SCRIPT
- concepts: array of 2-5 strings, SAME LANGUAGE AS EXCERPT.
  Concepts are ABSTRACT THEMES — the answer to "what is this event ABOUT,
  beyond what literally happened?". They are NOT a second copy of keywords,
  and they are NOT a place for entity names.

  RULES — apply ALL THREE before adding a term to concepts:
    (a) NOT-ENTITY:    Must NOT be a character, location, item, faction,
                       monster, organization, or game stat/mechanic. Those
                       go in their own fields. If you can point to it on a
                       map, hold it in your hand, or look it up in a rules
                       book, it is not a concept.
    (b) NOT-ACTION:    Must NOT be a specific verb or event. A single combat,
                       a level-up, a trade, a quest hand-in are NOT concepts.
                       The IDEA behind them ("the cost of victory", "trust
                       building", "betrayal of loyalty") IS a concept.
    (c) GENERALIZES:   Must be broad enough to apply to multiple events
                       across the story (themes recur). If the term only
                       fits this one specific event, it is a keyword,
                       not a concept.

  Language-specific GOOD / BAD examples appear in Rule 1 above. Refer to
  those — do NOT use examples from a different language than the excerpt.

  Self-check before returning: for each concept you wrote, ask "could this
  be a recurring theme across multiple events in this story?". If no,
  move it to keywords or remove it. Fewer good concepts beats more weak ones.
- keywords: array of 8-15 strings, SAME LANGUAGE AS EXCERPT. Search aids used by a keyword retrieval engine — be GENEROUS and INCLUSIVE. Include every distinctive term that a future query about this event might use: key actions/verbs, distinctive objects/items, emotional or thematic tags, unique concepts, and any rare/specific noun that isn't generic filler. DO NOT pad with generic words. Quality matters but err on the side of MORE rather than fewer — sparse keywords cause retrieval misses. CRITICAL: keywords MUST be in the same language as the excerpt (see Rule 1). NEVER output a different language in this field.
- open_threads: array of strings, SAME LANGUAGE AS EXCERPT (unresolved questions/promises)
- should_persist: boolean (false for ephemeral moments unlikely to matter later)

=========================
VALID OUTPUT EXAMPLES
=========================
Zero events (filler scene):
[]

`;

// ── Per-language EXAMPLES (one localized example per variant) ────────────────
const _EXTRACTION_EXAMPLES_INTL =
`One event (English excerpt):
[{"event_type":"relationship_change","importance":7,"summary":"Aria takes the blame for Leon's mistake in front of the commander, shielding him from punishment at personal cost. Leon is visibly shaken by her sacrifice and vows to repay her.","cause":"Leon froze during the mission briefing and Aria covered for him without hesitation.","result":"Leon feels indebted to Aria; their dynamic shifts from rivalry to fragile trust.","characters":["Aria","Leon","Commander Voss"],"locations":["Command Tent"],"factions":["Iron Company"],"DateTime":null,"items":[],"concepts":["sacrifice","debt","trust"],"keywords":["blame","shield","punishment","mistake","sacrifice","debt","trust","rivalry","vow","repay","commander","mission briefing","froze","covered"],"open_threads":["Will Leon repay Aria?","How will Commander Voss react if he finds out?"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_JIEBA =
`One event (Simplified Chinese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"师傅承诺帮梅拉寻找失踪的父亲暗影之翼。","cause":"梅拉在房间中央哭着请求帮助。","result":"寻找暗影之翼成为队伍的核心目标。","characters":["梅拉","师父"],"locations":["星月绿洲顶楼公寓"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","items":[],"concepts":["失踪的父亲","承诺","亲情"],"keywords":["暗影之翼","寻找父亲","承诺","哭泣","请求","失踪","核心目标","队伍任务","誓言","亲情"],"open_threads":["确定暗影之翼是生是死"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_JIEBA_TW =
`One event (Traditional Chinese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"師傅承諾幫梅拉尋找失蹤的父親暗影之翼。","cause":"梅拉在房間中央哭著請求幫助。","result":"尋找暗影之翼成為隊伍的核心目標。","characters":["梅拉","師父"],"locations":["星月綠洲頂樓公寓"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","items":[],"concepts":["失蹤的父親","承諾","親情"],"keywords":["暗影之翼","尋找父親","承諾","哭泣","請求","失蹤","核心目標","隊伍任務","誓言","親情"],"open_threads":["確定暗影之翼是生是死"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_TINY_SEGMENTER =
`One event (Japanese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"師匠はメイラの行方不明の父・影の翼を見つけることを約束した。","cause":"メイラが部屋の中央で泣きながら助けを求めた。","result":"影の翼の捜索がパーティーの中心目標となった。","characters":["メイラ","師匠"],"locations":["星月オアシス最上階アパート"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","items":[],"concepts":["行方不明の父","誓い","親子の絆"],"keywords":["影の翼","父の捜索","約束","泣く","懇願","行方不明","中心目標","パーティーの任務","誓い","親子の絆"],"open_threads":["影の翼の生死を確認する"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_KOREAN =
`One event (Korean excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"스승은 메이라의 실종된 아버지 그림자의 날개를 찾아주기로 약속했다.","cause":"메이라가 방 한가운데서 울며 도움을 청했다.","result":"그림자의 날개를 찾는 것이 파티의 핵심 목표가 되었다.","characters":["메이라","스승"],"locations":["성월 오아시스 옥상 아파트"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","items":[],"concepts":["실종된 아버지","약속","부녀의 정"],"keywords":["그림자의 날개","아버지 찾기","약속","울음","간청","실종","핵심 목표","파티 임무","맹세","부녀의 정"],"open_threads":["그림자의 날개의 생사 확인"],"should_persist":true}]

`;

// "others" reuses the English example with a notice — the LLM will follow the
// LANGUAGE rule from this variant's _EXTRACTION_LANG block to write its own
// output in whatever language the excerpt actually uses.
const _EXTRACTION_EXAMPLES_OTHERS =
`One event (English excerpt — apply the same field structure in your detected language):
[{"event_type":"relationship_change","importance":7,"summary":"Aria takes the blame for Leon's mistake in front of the commander, shielding him from punishment at personal cost. Leon is visibly shaken by her sacrifice and vows to repay her.","cause":"Leon froze during the mission briefing and Aria covered for him without hesitation.","result":"Leon feels indebted to Aria; their dynamic shifts from rivalry to fragile trust.","characters":["Aria","Leon","Commander Voss"],"locations":["Command Tent"],"factions":["Iron Company"],"DateTime":null,"items":[],"concepts":["sacrifice","debt","trust"],"keywords":["blame","shield","punishment","mistake","sacrifice","debt","trust","rivalry","vow","repay","commander","mission briefing","froze","covered"],"open_threads":["Will Leon repay Aria?","How will Commander Voss react if he finds out?"],"should_persist":true}]

`;

// ── Shared FOOTER: the excerpt slot ──────────────────────────────────────────
const _EXTRACTION_FOOTER =
`=========================
EXCERPT
=========================
{{text}}`;

const _EXTRACTION_PROMPTS = {
    intl:           _EXTRACTION_TOP + _EXTRACTION_LANG_INTL           + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_INTL           + _EXTRACTION_FOOTER,
    jieba:          _EXTRACTION_TOP + _EXTRACTION_LANG_JIEBA          + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_JIEBA          + _EXTRACTION_FOOTER,
    jieba_tw:       _EXTRACTION_TOP + _EXTRACTION_LANG_JIEBA_TW       + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_JIEBA_TW       + _EXTRACTION_FOOTER,
    tiny_segmenter: _EXTRACTION_TOP + _EXTRACTION_LANG_TINY_SEGMENTER + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_TINY_SEGMENTER + _EXTRACTION_FOOTER,
    korean:         _EXTRACTION_TOP + _EXTRACTION_LANG_KOREAN         + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_KOREAN         + _EXTRACTION_FOOTER,
    others:         _EXTRACTION_TOP + _EXTRACTION_LANG_OTHERS         + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_OTHERS         + _EXTRACTION_FOOTER,
};

/**
 * Returns the EventBase extraction prompt template for the given story
 * language mode. The template still contains the {{text}} and {{maxCount}}
 * placeholders — buildExtractionPrompt() in eventbase-schema.js substitutes
 * those before sending to the LLM.
 *
 * Falls back to the English (intl) prompt for unknown modes.
 *
 * @param {string} [mode] - Value from CJK_TOKENIZER_MODES (e.g. 'jieba_tw')
 * @returns {string}
 */
export function getEventBaseExtractionPrompt(mode) {
    return Object.prototype.hasOwnProperty.call(_EXTRACTION_PROMPTS, mode) ? _EXTRACTION_PROMPTS[mode] : _EXTRACTION_PROMPTS.intl;
}


// ─────────────────────────────────────────────────────────────────────────────
// PLANNER USER MESSAGE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the user-message portion of the planner prompt. Combines recent chat,
 * the current user message, and a summary of pre-search candidates.
 *
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.recentTurns - Past chat (oldest first)
 * @param {string} params.userMessage - Current user input verbatim
 * @param {object[]} params.candidates - Pre-search event candidates (already trimmed)
 * @returns {string} The user-message text
 */
export function buildPlannerUserMessage({ recentTurns, userMessage, candidates }) {
    const parts = [];

    parts.push('Recent chat (oldest first):');
    if (!recentTurns || recentTurns.length === 0) {
        parts.push('  (no recent context — start of conversation)');
    } else {
        recentTurns.forEach((turn, idx) => {
            const idxLabel = `[-${recentTurns.length - idx}]`;
            const speaker = turn.speaker || (turn.is_user ? '{{user}}' : '{{character}}');
            // Soft-trim each turn to ~600 chars so very long replies don't blow the budget.
            const body = (turn.text || '').slice(0, 600);
            const ellipsis = (turn.text || '').length > 600 ? '...' : '';
            parts.push(`  ${idxLabel} ${speaker}: ${body}${ellipsis}`);
        });
    }

    parts.push('');
    parts.push('Current user message:');
    parts.push(`  ${userMessage || '(empty)'}`);

    parts.push('');
    parts.push('Candidate events from pre-search (top by similarity, may be incomplete):');
    if (!candidates || candidates.length === 0) {
        parts.push('  (none — DB returned no semantic matches)');
    } else {
        candidates.forEach((ev, i) => {
            parts.push(_formatCandidateLine(ev, i + 1));
        });
    }

    parts.push('');
    parts.push('Plan retrieval. Return strict JSON only.');

    return parts.join('\n');
}

/**
 * One-line summary of a candidate event for the planner prompt.
 * Format: E<N> [score] type — text (chars: [...], concepts: [...], importance: X)
 */
function _formatCandidateLine(ev, idx) {
    const score = typeof ev._finalScore === 'number' ? ev._finalScore.toFixed(2)
        : typeof ev.score === 'number' ? ev.score.toFixed(2)
        : typeof ev.vectorScore === 'number' ? ev.vectorScore.toFixed(2)
        : '—';
    const type = ev.event_type || ev.metadata?.event_type || 'event';
    const text = (ev.text || ev.metadata?.text || '').replace(/\s+/g, ' ').slice(0, 90);
    const chars = (ev.characters || ev.metadata?.characters || []).slice(0, 4).join(', ');
    const concepts = (ev.concepts || ev.metadata?.concepts || []).slice(0, 4).join(', ');
    const importance = ev.importance ?? ev.metadata?.importance ?? '?';

    const meta = [
        chars ? `chars: [${chars}]` : '',
        concepts ? `concepts: [${concepts}]` : '',
        `importance: ${importance}`,
    ].filter(Boolean).join(' | ');

    return `  E${idx} [${score}] ${type} — ${text}\n      ${meta}`;
}
