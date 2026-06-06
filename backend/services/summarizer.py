import json
import re
from typing import Dict, List

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

load_dotenv()


async def generate_note_summary(transcriptions_data, course_domain: str = "일반 전공") -> Dict[str, str]:
    if not transcriptions_data:
        return {}

    if isinstance(transcriptions_data, dict):
        formatted_texts = []
        for slide_num, texts in transcriptions_data.items():
            slide_text = " ".join(texts) if isinstance(texts, list) else str(texts)
            formatted_texts.append(f"--- [슬라이드 {slide_num}] ---\n{slide_text}")
        full_text = "\n\n".join(formatted_texts)
    else:
        full_text = str(transcriptions_data)

    prompt = f"""
    다음은 [{course_domain}] 수업의 실시간 강의에서 슬라이드별로 전사된 텍스트입니다.
    해당 전공 분야의 전문 용어(Terminology)와 문맥을 정확하게 반영하여,
    전체 문맥을 파악한 후 각 슬라이드의 핵심 내용을 마크다운으로 요약하세요.

    [지시사항]
    1. 핵심 키워드에는 **볼드체**, 가독성을 위해 글머리 기호(-)를 사용하세요.
    2. 응답은 반드시 유효한 JSON 형식이어야 합니다! 다른 설명은 절대 추가하지 마세요.
    3. JSON 구조는 슬라이드 번호(문자열)를 Key로, 마크다운 요약(문자열)을 Value로 설정하세요.
        예시: {{"1": "슬라이드 1 요약내용", "2": "슬라이드 2 요약내용"}}

    [전사된 텍스트]:
    {full_text}
    """

    system_text = (
        f"당신은 {course_domain} 분야의 지식을 갖춘 전문 요약 어시스턴트이며, JSON으로만 답변합니다."
    )
    llm = ChatOpenAI(model_name="gpt-4o-mini", temperature=0.2)
    bound_llm = llm.bind(response_format={"type": "json_object"})

    try:
        response = await bound_llm.invoke([
            SystemMessage(content=system_text),
            HumanMessage(content=prompt)
        ])
        if isinstance(response, dict):
            return response
        raw_content = getattr(response, "content", str(response))
        cleaned = re.sub(r"^```json\n|^```\n|\n```$", "", raw_content.strip(), flags=re.MULTILINE)
        return json.loads(cleaned)
    except Exception as exc:
        err_label = type(exc).__name__
        print(f"⚠️ 요약 생성 실패 ({err_label}): {exc}")
        return {"1": f"{err_label}: 요약 데이터를 처리할 수 없습니다."}


async def generate_video_summary(full_text: str, course_domain: str = "일반 전공") -> str:
    if not full_text.strip():
        return "요약할 텍스트가 없습니다."

    prompt = f"""
    다음은 [{course_domain}] 동영상 강의/영상의 전체 음성 전사 텍스트입니다.
    해당 전공 분야의 전문 용어(Terminology)를 최우선으로 고려하여,
    전체 문맥과 흐름을 파악해 핵심 내용을 마크다운(Markdown) 형식의 깔끔한 노트로 정리해주세요.

    [지시사항]
    1. 영상의 가장 중요한 주제를 큰 제목(#)으로 작성하세요.
    2. 주요 내용과 세부 정보를 중제목(##)과 글머리 기호(-)로 구조화하세요.
    3. 핵심 키워드에는 **볼드체**를 사용하세요.
    4. 불필요한 인사말 없이 즉시 요약 본문만 출력하세요.
    5. 응답은 반드시 한국어로 작성되어야 합니다.

    [전사된 텍스트]:
    {full_text}
    """

    system_text = (
        f"당신은 {course_domain} 전공 지식을 바탕으로 영상의 핵심을 완벽하게 짚어내는 전문 요약 어시스턴트입니다."
    )
    llm = ChatOpenAI(model_name="gpt-4o-mini", temperature=0.3)

    try:
        response = await llm.ainvoke([
            SystemMessage(content=system_text),
            HumanMessage(content=prompt)
        ])
        return getattr(response, "content", str(response))
    except Exception as exc:
        err_label = type(exc).__name__
        print(f"⚠️ 영상 요약 실패 ({err_label}): {exc}")
        return f"{err_label}: 요약을 생성할 수 없습니다."