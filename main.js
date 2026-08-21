#!/usr/bin/env node
"use strict";

/**
 * main.js — Node.js port of main.py
 *
 * يولّد تلميحات (hints) فقط لكلمات معتمدة مسبقاً من index.html (Word Codex).
 * مصمَّم للعمل داخل GitHub Actions: يستدعي Gemini REST API مباشرة (fetch)
 * بدون أي SDK بايثون، والمفتاح GEMINI_API_KEY يُقرأ من GitHub Secrets فقط —
 * لا يمر أبداً عبر المتصفح.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// ---------------------------------------------------------------------------
// إعداد اللوغ (يكتب لملف + الشاشة، زي logging.basicConfig بالنسخة الأصلية)
// ---------------------------------------------------------------------------
const LOG_FILE = "puzzle_generation.log";

function logLine(level, msg) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  const line = `${ts} | ${level} | ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch (_) {
    /* لو تعذّرت الكتابة للملف، على الأقل السطر ظهر بالـ console */
  }
}
const log = {
  info: (m) => logLine("INFO", m),
  warning: (m) => logLine("WARNING", m),
  error: (m) => logLine("ERROR", m),
};

// ---------------------------------------------------------------------------
// إعداد Gemini
// ---------------------------------------------------------------------------
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  throw new Error(
    "لم يتم ضبط متغير البيئة GEMINI_API_KEY. " +
      "بالـ GitHub Actions هذا يُضبط عبر Secrets، ومحلياً: export GEMINI_API_KEY='your_key_here'."
  );
}

// يمكن تجاوزه بمتغير بيئة GEMINI_MODEL بدون تعديل الكود، لأن Google تغيّر/توقف
// أسماء الموديلات بين فترة وأخرى (زي ما صار مع gemini-2.5-flash).
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const BATCH_SIZE = 25;
const SLEEP_BETWEEN_CALLS_MS = 1000;
const MAX_CONSECUTIVE_FAILURES_PER_COMBO = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * يطلب من Gemini تلميحاً لكل كلمة في `words` فقط — الكلمات نفسها معتمدة مسبقاً
 * (جاءت من index.html بعد تحقق Datamuse + مراجعة بشرية/تلقائية)، فالنموذج هنا
 * مسؤول فقط عن صياغة التلميح، وليس عن اختيار الكلمة أو الحكم على مدى ارتباطها بالفئة.
 */
function normalizeForLeakCheck(s) {
  return String(s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // إزالة علامات التشكيل (é → e) قبل المقارنة
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * يتحقق إذا كان التلميح "يفشي" الكلمة نفسها — إما مطابقة كاملة أو كجزء من كلمة أطول
 * بالتلميح (مثلاً كلمة "meter" داخل "centimeters"، أو "south" داخل "southern").
 * هذا فحص بسيط بالـ substring، ومتعمد إنه صارم: أفضل نرفض تلميح سليم بالخطأ (نادر)
 * من إننا نمرر تلميح يفضح الجواب مباشرة.
 */
function hintLeaksWord(word, hint) {
  const w = normalizeForLeakCheck(word);
  const h = normalizeForLeakCheck(hint);
  if (w.length < 3) return false; // كلمات قصيرة جداً (1-2 حرف) تعطي إيجابيات كاذبة كثيرة
  return h.includes(w);
}

function buildHintPrompt(category, tier, items, extraReminder = "") {
  const wordLines = items
    .map((it) => {
      const sense = it.clue
        ? `Reference sense it was approved under: "${it.clue}"`
        : "No reference sense provided — use your best judgment for the category.";
      return `- "${it.word}". ${sense}`;
    })
    .join("\n");

  return `
    You are given a list of ALREADY APPROVED words for a word puzzle game.
    Category: ${category}
    Difficulty tier: ${tier}
    Words:
    ${wordLines}

    For EACH word listed above, write one concise, clear, accurate hint.
    - Do NOT invent, skip, merge, or reorder words. Return exactly one entry per input word.
    - CRITICAL — many English words have several unrelated meanings. When a reference sense is
      given for a word, your hint MUST describe THAT SPECIFIC sense, not a different (possibly
      more common) meaning of the same word that has nothing to do with "${category}". For
      example, if "cast" was approved under the knitting sense "to set up the initial row of
      stitches", write the hint about that knitting action — not about acting in a play or
      casting a fishing line.
    - The hint must NEVER contain the target word itself in any form — not as a whole word,
      and not as a substring inside a longer word. For example, if the word is "meter", never
      use "centimeters"; if the word is "south", never use "southern"; if the word is "rule",
      never use "ruler". Rephrase around the concept instead of using any word that contains
      the target word's letters in sequence.
    - Hint difficulty/subtlety should match the '${tier}' tier (easier tiers get more direct hints).
    ${extraReminder}
    Return ONLY a JSON array of objects with keys: "word" (must exactly match an input word),
    "hint" (string).
  `;
}

async function callGeminiOnce(category, tier, items, extraReminder = "") {
  const body = {
    contents: [{ role: "user", parts: [{ text: buildHintPrompt(category, tier, items, extraReminder) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.5, // أقل من نسخة توليد الكلمات، لأن هذا وصف لكلمة معروفة لا اختراع
    },
  };

  const res = await fetch(`${GEMINI_URL}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const payload = await res.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("لا يوجد نص رد صالح من Gemini (candidates/parts فارغة)");
  }

  const data = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error("الرد ليس عبارة عن قائمة JSON");
  }
  return data;
}

/**
 * items: [{ word, clue }] — clue هو التعريف/المعنى المحدد اللي خلى الكلمة تُعتمد أصلاً
 * (اختياري، ممكن يكون null لملفات approved_words.json قديمة ما فيها هذا الحقل).
 */
const DRIFT_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or", "with", "by", "is", "are",
  "was", "were", "be", "been", "its", "this", "that", "as", "such", "from", "not", "also", "used",
  "use", "one", "which", "who", "whom", "whose", "into", "onto", "about", "often", "sometimes",
  "especially", "typically", "usually", "commonly", "generally", "various", "other", "another",
  "some", "any", "many", "much", "more", "most", "less", "least", "very", "quite", "rather",
  "having", "being", "than", "when", "where", "while",
]);

function significantTerms(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !DRIFT_STOPWORDS.has(w));
}

function stemPrefix(w) {
  return w.length >= 5 ? w.slice(0, 5) : w;
}

/**
 * Heuristic safety net for the "Gemini ignored the given reference sense" failure mode — e.g.
 * approved under "(archaic) to mix (metals); to alloy" but the generated hint describes soothing
 * fears instead (a completely different, more common sense of "allay"). Not real semantic
 * verification, just a keyword/stem-overlap check: if the clue has real content words and NONE
 * of them (even loosely, by 5-char stem) show up anywhere in the hint, that's a strong signal
 * the hint drifted to an unintended sense of the word. A clue-less item (no reference sense was
 * available) is never flagged — there's nothing for it to be unfaithful to.
 */
function hintDriftsFromClue(clue, hint) {
  if (!clue) return false;
  const clueTerms = significantTerms(clue);
  if (clueTerms.length === 0) return false;
  const hintStems = new Set(significantTerms(hint).map(stemPrefix));
  return !clueTerms.some((t) => hintStems.has(stemPrefix(t)));
}

async function fetchHintsForBatch(category, tier, items, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let data = await callGeminiOnce(category, tier, items);
      const itemByWord = new Map(items.map((it) => [it.word, it]));

      // فحص إفشاء الكلمة داخل تلميحها — نفصل الصالح عن المسرّب.
      const leaked = data.filter((h) => hintLeaksWord(h?.word ?? "", h?.hint ?? ""));
      let clean = data.filter((h) => !hintLeaksWord(h?.word ?? "", h?.hint ?? ""));

      if (leaked.length > 0) {
        const leakedWords = new Set(leaked.map((h) => h.word));
        const leakedItems = items.filter((it) => leakedWords.has(it.word));
        log.warning(
          `⚠️ ${leaked.length} تلميح يفشي الكلمة نفسها بدفعة (${category}/${tier}): ${JSON.stringify(
            [...leakedWords]
          )} — محاولة إعادة صياغة...`
        );
        try {
          const retryReminder =
            "IMPORTANT: your previous attempt at these exact words accidentally included the " +
            "target word (or it as a substring of another word) in the hint. Rewrite completely " +
            "differently this time, describing the concept without using any word containing those letters in sequence.";
          const fixed = await callGeminiOnce(category, tier, leakedItems, retryReminder);
          for (const h of fixed) {
            if (!hintLeaksWord(h?.word ?? "", h?.hint ?? "")) {
              clean.push(h);
            } else {
              log.warning(`⚠️ استمر تسريب الكلمة '${h.word}' حتى بعد إعادة الصياغة — سيتم تخطيها بهذه الدفعة.`);
            }
          }
        } catch (e) {
          log.warning(`⚠️ فشلت محاولة إعادة صياغة التلميحات المسرّبة (${category}/${tier}): ${e.message}`);
        }
      }

      // فحص الانحراف عن المعنى المعتمد — بس للكلمات اللي فعلاً كان عندها clue مرجعي.
      const drifted = clean.filter((h) => {
        const it = itemByWord.get(h.word);
        return it && hintDriftsFromClue(it.clue, h.hint);
      });
      if (drifted.length > 0) {
        const driftedSet = new Set(drifted.map((h) => h.word));
        clean = clean.filter((h) => !driftedSet.has(h.word));
        const driftedItems = items.filter((it) => driftedSet.has(it.word));
        log.warning(
          `⚠️ ${drifted.length} تلميح يبدو منحرفاً عن المعنى المعتمد بدفعة (${category}/${tier}): ${JSON.stringify(
            [...driftedSet]
          )} — محاولة إعادة الصياغة بالتقيّد الصارم بالمعنى المعتمد...`
        );
        try {
          const retryReminder =
            "IMPORTANT: your previous attempt at these exact words ignored the given reference " +
            "sense and described a different, more common meaning of the word instead. You MUST " +
            "write about the SPECIFIC reference sense given for each word below, even if it is " +
            "rare or archaic — do not substitute a more familiar meaning of the word.";
          const fixed = await callGeminiOnce(category, tier, driftedItems, retryReminder);
          for (const h of fixed) {
            const it = itemByWord.get(h.word);
            const stillLeaks = hintLeaksWord(h?.word ?? "", h?.hint ?? "");
            const stillDrifts = it && hintDriftsFromClue(it.clue, h?.hint ?? "");
            if (!stillLeaks && !stillDrifts) {
              clean.push(h);
            } else {
              log.warning(`⚠️ استمر انحراف/تسريب الكلمة '${h.word}' حتى بعد إعادة الصياغة — سيتم تخطيها بهذه الدفعة.`);
            }
          }
        } catch (e) {
          log.warning(`⚠️ فشلت محاولة إعادة صياغة التلميحات المنحرفة (${category}/${tier}): ${e.message}`);
        }
      }

      return clean;
    } catch (e) {
      if (e instanceof SyntaxError) {
        log.warning(`⚠️ JSON غير صالح (${category}/${tier}), محاولة ${attempt}/${retries}: ${e.message}`);
      } else {
        log.warning(`⚠️ خطأ أثناء جلب تلميحات (${category}/${tier}), محاولة ${attempt}/${retries}: ${e.message}`);
      }
    }
    if (attempt < retries) {
      await sleep(2000 * attempt);
    }
  }

  log.error(`❌ فشلت كل المحاولات لدفعة (${category}/${tier}) بحجم ${items.length}`);
  return [];
}

/** يقرأ ملف approved_words.json المُصدَّر من index.html. */
async function loadApprovedWords(inputPath) {
  const raw = await fsp.readFile(inputPath, "utf-8");
  const items = JSON.parse(raw);

  const cleaned = [];
  const seen = new Set();
  for (const item of items) {
    const word = String(item.word ?? "").trim().toLowerCase();
    const category = String(item.category ?? "").trim();
    const tier = String(item.tier ?? "").trim() || "medium";
    const sourceSeed = item.sourceSeed ?? null;
    // Optional — only present in files exported after this field was added. Absent for older
    // approved_words.json files, which still work fine; they just lose the sense-grounding below.
    const clue = item.clue ? String(item.clue).trim() : null;

    if (!word || !category || seen.has(word)) continue;
    seen.add(word);
    cleaned.push({ word, category, tier, sourceSeed, clue });
  }

  log.info(`📥 تم تحميل ${cleaned.length} كلمة معتمدة من ${inputPath}`);
  return cleaned;
}

/** يستأنف من ملف مخرجات سابق إن وُجد — يتخطى الكلمات التي لديها تلميح بالفعل. */
async function loadExistingOutput(outputPath) {
  if (fs.existsSync(outputPath)) {
    try {
      const jsonStr = await fsp.readFile(outputPath, "utf-8");
      const puzzles = JSON.parse(jsonStr);
      const doneWords = new Set(puzzles.map((p) => String(p.word).trim().toLowerCase()));
      const nextId = puzzles.reduce((max, p) => Math.max(max, p.id), 0) + 1;
      log.info(`🔄 استئناف: ${puzzles.length} لغز بتلميحات جاهزة مسبقاً.`);
      return { puzzles, doneWords, nextId };
    } catch (e) {
      log.warning(`⚠️ تعذّرت قراءة ${outputPath} (${e.message})، سيبدأ من الصفر.`);
    }
  }
  return { puzzles: [], doneWords: new Set(), nextId: 1 };
}

async function saveProgress(puzzles, outputPath) {
  const tmpName = outputPath + ".tmp";
  // بدون ضغط، ومع مسافات بادئة — يخليه قابل للقراءة والمقارنة (diff) مباشرة على GitHub.
  const jsonStr = JSON.stringify(puzzles, null, 2);
  await fsp.writeFile(tmpName, jsonStr, "utf-8");
  await fsp.rename(tmpName, outputPath);
}

function* chunked(seq, size) {
  for (let i = 0; i < seq.length; i += size) {
    yield seq.slice(i, i + size);
  }
}

async function generateHintsForApprovedWords(inputPath, outputPath, batchSize = BATCH_SIZE) {
  const approved = await loadApprovedWords(inputPath);
  // eslint-disable-next-line prefer-const
  let { puzzles, doneWords, nextId } = await loadExistingOutput(outputPath);
  let puzzleId = nextId;

  // تجميع الكلمات المتبقية (التي ليس لها تلميح بعد) حسب (الفئة، المستوى)
  const remainingByCombo = new Map(); // key: `${category}\u0000${tier}` -> items[]
  for (const item of approved) {
    if (doneWords.has(item.word)) continue;
    const key = `${item.category}\u0000${item.tier}`;
    if (!remainingByCombo.has(key)) remainingByCombo.set(key, []);
    remainingByCombo.get(key).push(item);
  }

  const totalRemaining = [...remainingByCombo.values()].reduce((s, v) => s + v.length, 0);
  if (totalRemaining === 0) {
    log.info("✅ كل الكلمات المعتمدة لديها تلميح بالفعل — لا شيء لتوليده.");
    return;
  }
  const puzzleCountBefore = puzzles.length;

  log.info(
    `🚀 بدء توليد تلميحات لـ ${totalRemaining} كلمة عبر ${remainingByCombo.size} تركيبة (فئة/مستوى)...`
  );

  let processed = 0;

  for (const [key, items] of remainingByCombo) {
    const [category, tier] = key.split("\u0000");
    let comboFailures = 0;

    for (const batch of chunked(items, batchSize)) {
      if (comboFailures >= MAX_CONSECUTIVE_FAILURES_PER_COMBO) {
        log.warning(`⏭️ تخطي بقية دفعات (${category}/${tier}) بعد فشل متكرر.`);
        break;
      }

      const hintsData = await fetchHintsForBatch(category, tier, batch);

      if (!hintsData.length) {
        comboFailures += 1;
        await sleep(SLEEP_BETWEEN_CALLS_MS);
        continue;
      }

      // فهرسة الردود حسب الكلمة للتحقق من التطابق (بدل الاعتماد على نفس الترتيب)
      const hintByWord = new Map();
      for (const h of hintsData) {
        const w = String(h.word ?? "").trim().toLowerCase();
        const hint = String(h.hint ?? "").trim();
        if (w && hint) hintByWord.set(w, hint);
      }

      let addedInBatch = 0;
      const missingWords = [];
      for (const item of batch) {
        const word = item.word;
        const hint = hintByWord.get(word);
        if (!hint) {
          missingWords.push(word);
          continue;
        }
        puzzles.push({
          id: puzzleId,
          category,
          tier,
          word,
          hint,
          sourceSeed: item.sourceSeed ?? null,
        });
        puzzleId += 1;
        addedInBatch += 1;
        processed += 1;
      }

      if (missingWords.length) {
        log.warning(
          `⚠️ لم يرجع تلميح لـ ${missingWords.length} كلمة من دفعة (${category}/${tier}): ${JSON.stringify(
            missingWords
          )}`
        );
      }

      comboFailures = addedInBatch > 0 ? 0 : comboFailures + 1;

      log.info(`✅ التقدم: ${processed}/${totalRemaining} | +${addedInBatch} تلميح من (${category}/${tier})`);

      await saveProgress(puzzles, outputPath);
      await sleep(SLEEP_BETWEEN_CALLS_MS);
    }
  }

  log.info(`🎉 اكتمل توليد التلميحات! الإجمالي: ${puzzles.length} لغز في: ${outputPath}`);

  // لو ما اتولّد ولا تلميح واحد رغم وجود كلمات معتمدة، هذا فشل حقيقي (موديل غير متاح،
  // مفتاح خاطئ، خ إلخ) — نرمي خطأ بدل الخروج بهدوء، عشان الـ workflow يفشل بوضوح
  // ولا يوصل لخطوة الـ commit بملف مخرجات ما انكتب أصلاً.
  if (puzzles.length === puzzleCountBefore) {
    throw new Error(
      "لم يتم توليد أي تلميح جديد رغم وجود كلمات معتمدة بانتظار التوليد — راجع رسائل الخطأ أعلاه " +
        "(الأسباب الشائعة: اسم موديل غير متاح/موقوف، أو GEMINI_API_KEY غير صحيح)."
    );
  }
}

// ---------------------------------------------------------------------------
// CLI (بديل argparse — يدعم --input/--output/--batch-size بنفس القيم الافتراضية)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    input: "approved_words.json",
    output: "unique_word_puzzles_with_hints.json",
    batchSize: BATCH_SIZE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--batch-size") args.batchSize = parseInt(argv[++i], 10);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.input)) {
    console.error(
      `❌ لم يتم العثور على ${args.input}. صدّره أولاً من index.html عبر زر 'Export JSON (for AI hints)'.`
    );
    process.exit(1);
  }

  await generateHintsForApprovedWords(args.input, args.output, args.batchSize);
}

if (require.main === module) {
  main().catch((e) => {
    log.error(`💥 خطأ غير متوقع: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  fetchHintsForBatch,
  loadApprovedWords,
  loadExistingOutput,
  saveProgress,
  generateHintsForApprovedWords,
  hintLeaksWord,
  hintDriftsFromClue,
};
