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
const zlib = require("zlib");

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
async function fetchHintsForBatch(category, tier, words, retries = 3) {
  const wordsListStr = JSON.stringify(words);
  const prompt = `
    You are given a list of ALREADY APPROVED words for a word puzzle game.
    Category: ${category}
    Difficulty tier: ${tier}
    Words: ${wordsListStr}

    For EACH word in the list, write one concise, clear, accurate hint.
    - Do NOT invent, skip, merge, or reorder words. Return exactly one entry per input word.
    - The hint must not simply restate the word or an obvious substring of it.
    - Hint difficulty/subtlety should match the '${tier}' tier (easier tiers get more direct hints).

    Return ONLY a JSON array of objects with keys: "word" (must exactly match an input word),
    "hint" (string).
  `;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.5, // أقل من نسخة توليد الكلمات، لأن هذا وصف لكلمة معروفة لا اختراع
    },
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
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

  log.error(`❌ فشلت كل المحاولات لدفعة (${category}/${tier}) بحجم ${words.length}`);
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

    if (!word || !category || seen.has(word)) continue;
    seen.add(word);
    cleaned.push({ word, category, tier, sourceSeed });
  }

  log.info(`📥 تم تحميل ${cleaned.length} كلمة معتمدة من ${inputPath}`);
  return cleaned;
}

/** يستأنف من ملف مخرجات سابق إن وُجد — يتخطى الكلمات التي لديها تلميح بالفعل. */
async function loadExistingOutput(outputPath) {
  if (fs.existsSync(outputPath)) {
    try {
      const compressed = await fsp.readFile(outputPath);
      const jsonStr = zlib.gunzipSync(compressed).toString("utf-8");
      const puzzles = JSON.parse(jsonStr);
      const doneWords = new Set(puzzles.map((p) => p.word));
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
  const jsonStr = JSON.stringify(puzzles);
  const compressed = zlib.gzipSync(Buffer.from(jsonStr, "utf-8"));
  await fsp.writeFile(tmpName, compressed);
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
    const wordLookup = new Map(items.map((i) => [i.word, i]));

    for (const batch of chunked(items, batchSize)) {
      if (comboFailures >= MAX_CONSECUTIVE_FAILURES_PER_COMBO) {
        log.warning(`⏭️ تخطي بقية دفعات (${category}/${tier}) بعد فشل متكرر.`);
        break;
      }

      const batchWords = batch.map((b) => b.word);
      const hintsData = await fetchHintsForBatch(category, tier, batchWords);

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
      for (const word of batchWords) {
        const hint = hintByWord.get(word);
        if (!hint) {
          missingWords.push(word);
          continue;
        }
        const src = wordLookup.get(word);
        puzzles.push({
          id: puzzleId,
          category,
          tier,
          word,
          hint,
          sourceSeed: src.sourceSeed ?? null,
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
    output: "unique_word_puzzles_with_hints.json.gz",
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
};
