import os
import json
import gzip
import time
from google import genai
from google.genai import types

# 1. إعداد عميل Gemini
API_KEY = os.environ.get("GEMINI_API_KEY", "YOUR_GEMINI_API_KEY")
client = genai.Client(api_key=API_KEY)

# الفئات المستخرجة والمستويات
categories = [
    "metals", "food", "grain", "animals", "magic", 
    "cloth", "sea", "stone", "herbs", "nature", 
    "war", "royalty", "music", "weather", "stars"
]

difficulties = ["easy", "medium", "hard", "advanced"]

def fetch_batch_puzzles(category, difficulty, count=20):
    """
    جلب مجموعة من الألغاز الفريدة والدقيقة لفئة ومستوى محددين
    """
    prompt = f"""
    Generate {count} UNIQUE and highly accurate word puzzles for a word puzzle game.
    Category: {category}
    Difficulty: {difficulty}
    
    Requirements:
    - Words must strictly belong to the category '{category}'.
    - Difficulty level '{difficulty}' must match the obscurity or length of the word.
    - Provide concise, clear hints.
    
    Return ONLY a JSON array of objects with keys: "word" (string), "hint" (string).
    """

    try:
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.7 # تنوع إبداعي لمنع تكرار الكلمات
            )
        )
        return json.loads(response.text)
    except Exception as e:
        print(f"⚠️ خطأ أثناء جلب بيانات ({category} - {difficulty}): {e}")
        return []

def generate_50k_unique_puzzles(target_count=100):
    unique_words = set() # لضمان عدم تكرار أي كلمة إطلاقاً
    all_puzzles = []
    file_name = "unique_word_puzzles_50k.json.gz"
    
    puzzle_id = 1
    print(f"🚀 بدء توليد {target_count} لغز فريد ودقيق...")

    while len(all_puzzles) < target_count:
        for cat in categories:
            for diff in difficulties:
                if len(all_puzzles) >= target_count:
                    break

                # طلب 25 لغز في كل دفعة
                puzzles_data = fetch_batch_puzzles(cat, diff, count=25)
                
                added_in_batch = 0
                for item in puzzles_data:
                    word = item.get("word", "").strip().lower()
                    hint = item.get("hint", "").strip()

                    # التأكد من صحة الكلمة وعدم تكرارها سابقةً
                    if word and word not in unique_words and len(word) > 1:
                        unique_words.add(word)
                        all_puzzles.append({
                            "id": puzzle_id,
                            "category": cat,
                            "difficulty": diff,
                            "word": word,
                            "hint": hint
                        })
                        puzzle_id += 1
                        added_in_batch += 1
                        
                        if len(all_puzzles) >= target_count:
                            break

                print(f"✅ الإجمالي الحقيقي: {len(all_puzzles)} / {target_count} | تمت إضافة {added_in_batch} لغز فريد من ({cat} - {diff})")
                
                # تأخير بسيط لحماية الـ API من تجاوز معدل الطلبات (Rate Limit)
                time.sleep(1)

        # حفظ احترازي للتقدم كلما زاد العدد
        with gzip.open(file_name, "wt", encoding="utf-8") as f:
            json.dump(all_puzzles, f, ensure_ascii=False)

    print(f"\n🎉 اكتمل التوليد بنجاح! تم حفظ {len(all_puzzles)} لغز فريد تماماً في: {file_name}")

if __name__ == "__main__":
    generate_50k_unique_puzzles(50000)
