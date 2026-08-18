import os
import json
import gzip
import time
import logging
import argparse
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# إعداد اللوغ
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler("puzzle_generation.log", encoding="utf-8"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# إعداد عميل Gemini
# ---------------------------------------------------------------------------
API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError(
        "لم يتم ضبط متغير البيئة GEMINI_API_KEY. "
        "شغّل: export GEMINI_API_KEY='your_key_here' قبل تشغيل السكربت."
    )
client = genai.Client(api_key=API_KEY)

BATCH_SIZE = 25
SLEEP_BETWEEN_CALLS = 1.0
MAX_CONSECUTIVE_FAILURES_PER_COMBO = 5


def fetch_hints_for_batch(category, tier, words, retries=3):
    """
    يطلب من Gemini تلميحاً لكل كلمة في `words` فقط — الكلمات نفسها معتمدة مسبقاً
    (جاءت من index.html بعد تحقق Datamuse + مراجعة بشرية/تلقائية)، فالنموذج هنا
    مسؤول فقط عن صياغة التلميح، وليس عن اختيار الكلمة أو الحكم على مدى ارتباطها بالفئة.
    """
    words_list_str = json.dumps(words, ensure_ascii=False)
    prompt = f"""
    You are given a list of ALREADY APPROVED words for a word puzzle game.
    Category: {category}
    Difficulty tier: {tier}
    Words: {words_list_str}

    For EACH word in the list, write one concise, clear, accurate hint.
    - Do NOT invent, skip, merge, or reorder words. Return exactly one entry per input word.
    - The hint must not simply restate the word or an obvious substring of it.
    - Hint difficulty/subtlety should match the '{tier}' tier (easier tiers get more direct hints).

    Return ONLY a JSON array of objects with keys: "word" (must exactly match an input word),
    "hint" (string).
    """

    for attempt in range(1, retries + 1):
        try:
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.5  # أقل من نسخة توليد الكلمات، لأن هذا وصف لكلمة معروفة لا اختراع
                )
            )
            data = json.loads(response.text)
            if not isinstance(data, list):
                raise ValueError("الرد ليس عبارة عن قائمة JSON")
            return data

        except json.JSONDecodeError as e:
            log.warning(f"⚠️ JSON غير صالح ({category}/{tier}), محاولة {attempt}/{retries}: {e}")
        except Exception as e:
            log.warning(f"⚠️ خطأ أثناء جلب تلميحات ({category}/{tier}), محاولة {attempt}/{retries}: {e}")

        if attempt < retries:
            time.sleep(2 * attempt)

    log.error(f"❌ فشلت كل المحاولات لدفعة ({category}/{tier}) بحجم {len(words)}")
    return []


def load_approved_words(input_path):
    """يقرأ ملف approved_words.json المُصدَّر من index.html."""
    with open(input_path, "r", encoding="utf-8") as f:
        items = json.load(f)

    cleaned = []
    seen = set()
    for item in items:
        word = str(item.get("word", "")).strip().lower()
        category = str(item.get("category", "")).strip()
        tier = str(item.get("tier", "")).strip() or "medium"
        source_seed = item.get("sourceSeed")

        if not word or not category or word in seen:
            continue
        seen.add(word)
        cleaned.append({
            "word": word,
            "category": category,
            "tier": tier,
            "sourceSeed": source_seed
        })

    log.info(f"📥 تم تحميل {len(cleaned)} كلمة معتمدة من {input_path}")
    return cleaned


def load_existing_output(output_path):
    """يستأنف من ملف مخرجات سابق إن وُجد — يتخطى الكلمات التي لديها تلميح بالفعل."""
    if os.path.exists(output_path):
        try:
            with gzip.open(output_path, "rt", encoding="utf-8") as f:
                puzzles = json.load(f)
            done_words = {p["word"] for p in puzzles}
            next_id = max((p["id"] for p in puzzles), default=0) + 1
            log.info(f"🔄 استئناف: {len(puzzles)} لغز بتلميحات جاهزة مسبقاً.")
            return puzzles, done_words, next_id
        except Exception as e:
            log.warning(f"⚠️ تعذّرت قراءة {output_path} ({e})، سيبدأ من الصفر.")
    return [], set(), 1


def save_progress(puzzles, output_path):
    tmp_name = output_path + ".tmp"
    with gzip.open(tmp_name, "wt", encoding="utf-8") as f:
        json.dump(puzzles, f, ensure_ascii=False)
    os.replace(tmp_name, output_path)


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def generate_hints_for_approved_words(input_path, output_path, batch_size=BATCH_SIZE):
    approved = load_approved_words(input_path)
    puzzles, done_words, puzzle_id = load_existing_output(output_path)

    # تجميع الكلمات المتبقية (التي ليس لها تلميح بعد) حسب (الفئة، المستوى)
    remaining_by_combo = {}
    for item in approved:
        if item["word"] in done_words:
            continue
        key = (item["category"], item["tier"])
        remaining_by_combo.setdefault(key, []).append(item)

    total_remaining = sum(len(v) for v in remaining_by_combo.values())
    if total_remaining == 0:
        log.info("✅ كل الكلمات المعتمدة لديها تلميح بالفعل — لا شيء لتوليده.")
        return

    log.info(f"🚀 بدء توليد تلميحات لـ {total_remaining} كلمة عبر {len(remaining_by_combo)} تركيبة (فئة/مستوى)...")

    combo_failures = {}
    processed = 0

    for (category, tier), items in remaining_by_combo.items():
        combo_failures[(category, tier)] = 0
        word_lookup = {i["word"]: i for i in items}

        for batch in chunked(items, batch_size):
            if combo_failures[(category, tier)] >= MAX_CONSECUTIVE_FAILURES_PER_COMBO:
                log.warning(f"⏭️ تخطي بقية دفعات ({category}/{tier}) بعد فشل متكرر.")
                break

            batch_words = [b["word"] for b in batch]
            hints_data = fetch_hints_for_batch(category, tier, batch_words)

            if not hints_data:
                combo_failures[(category, tier)] += 1
                time.sleep(SLEEP_BETWEEN_CALLS)
                continue

            # فهرسة الردود حسب الكلمة للتحقق من التطابق (بدل الاعتماد على نفس الترتيب)
            hint_by_word = {}
            for h in hints_data:
                w = str(h.get("word", "")).strip().lower()
                hint = str(h.get("hint", "")).strip()
                if w and hint:
                    hint_by_word[w] = hint

            added_in_batch = 0
            missing_words = []
            for word in batch_words:
                hint = hint_by_word.get(word)
                if not hint:
                    missing_words.append(word)
                    continue

                src = word_lookup[word]
                puzzles.append({
                    "id": puzzle_id,
                    "category": category,
                    "tier": tier,
                    "word": word,
                    "hint": hint,
                    "sourceSeed": src.get("sourceSeed")
                })
                puzzle_id += 1
                added_in_batch += 1
                processed += 1

            if missing_words:
                log.warning(
                    f"⚠️ لم يرجع تلميح لـ {len(missing_words)} كلمة من دفعة ({category}/{tier}): "
                    f"{missing_words}"
                )

            combo_failures[(category, tier)] = 0 if added_in_batch > 0 else combo_failures[(category, tier)] + 1

            log.info(
                f"✅ التقدم: {processed}/{total_remaining} | "
                f"+{added_in_batch} تلميح من ({category}/{tier})"
            )

            save_progress(puzzles, output_path)
            time.sleep(SLEEP_BETWEEN_CALLS)

    log.info(f"🎉 اكتمل توليد التلميحات! الإجمالي: {len(puzzles)} لغز في: {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="يولّد تلميحات (hints) فقط لكلمات معتمدة مسبقاً من index.html (Word Codex)."
    )
    parser.add_argument(
        "--input", default="approved_words.json",
        help="ملف JSON المصدَّر من index.html (زر 'Export JSON (for AI hints)')."
    )
    parser.add_argument(
        "--output", default="unique_word_puzzles_with_hints.json.gz",
        help="ملف المخرجات النهائي (يدعم الاستئناف تلقائياً إن وُجد)."
    )
    parser.add_argument(
        "--batch-size", type=int, default=BATCH_SIZE,
        help="عدد الكلمات في كل طلب لـ Gemini."
    )
    args = parser.parse_args()

    if not os.path.exists(args.input):
        raise SystemExit(
            f"❌ لم يتم العثور على {args.input}. "
            "صدّره أولاً من index.html عبر زر 'Export JSON (for AI hints)'."
        )

    generate_hints_for_approved_words(args.input, args.output, args.batch_size)
