# backend/services/translator.py

from deep_translator import GoogleTranslator
import asyncio

async def translate_text(text: str, target_lang: str = "ko", course_domain: str = "General") -> str:
    if not text or not text.strip():
        return text
        
    try:
        # Google Translate 무료 API 사용 (실시간, 속도 빠름, 횟수 제한 없음)
        # 동기 함수이므로 asyncio.to_thread로 감싸서 비동기로 실행
        translated = await asyncio.to_thread(
            GoogleTranslator(source='auto', target=target_lang).translate, 
            text
        )
        return translated
    except Exception as e:
        print(f"번역 실패: {e}")
        return text  # 번역 실패 시 에러 내지 말고 원래 영어 텍스트 반환
