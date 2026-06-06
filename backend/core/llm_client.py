import asyncio
import json
import os
import re
from typing import List, Optional, Dict

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage


class LLMClient:
    def __init__(self, model_name: str = "gpt-4o-mini", temperature: float = 0.2):
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise EnvironmentError("OPENAI_API_KEY is required for LLMClient")

        self.client = ChatOpenAI(
            openai_api_key=api_key,
            model_name=model_name,
            temperature=temperature
        )

    async def translate_text(self, text: str, target_lang: str = "ko", course_domain: str = "General") -> str:
        domain_context = course_domain or "General"
        prompt = [
            SystemMessage(
                content=(
                    f"You are a bilingual translation assistant that keeps paragraphs fluent. "
                    f"Translate this text in the context of {domain_context} and ensure domain-specific terminology is translated accurately."
                )
            ),
            HumanMessage(content=f"Translate the following into {target_lang}: {text}")
        ]
        response = await self._chat(prompt)
        return response

    async def map_summary(self, chunk_text: str) -> str:
        prompt = [
            SystemMessage(content="You are a summarization agent; keep answers concise and grounded."),
            HumanMessage(content=f"Summarize this chunk: {chunk_text}")
        ]
        return await self._chat(prompt)

    async def reduce_summary(self, summaries: List[str]) -> str:
        prompt = [
            SystemMessage(content="You are assembling a hierarchical outline with timestamps."),
            HumanMessage(content="\n\n".join(summaries))
        ]
        return await self._chat(prompt)

    async def chat(self, messages: List) -> str:
        return await self._chat(messages)

    async def _chat(self, messages):
        result = await asyncio.to_thread(self.client.invoke, messages)
        content = getattr(result, "content", None)
        if content:
            return content.strip()
        return str(result).strip()

    async def group_sentences_semantically(self, sentences_data: List[Dict]) -> Optional[List[List[int]]]:
        if not sentences_data:
            return []

        trimmed_sentences = []
        for sentence in sentences_data:
            text = sentence.get("text", "").strip()
            if not text:
                continue
            trimmed_sentences.append({
                "sentence_id": sentence.get("sentence_id"),
                "text": text if len(text) <= 400 else text[:400].rsplit(" ", 1)[0] + "…",
                "speaker": sentence.get("speaker", "Speaker 1")
            })

        if not trimmed_sentences:
            return []

        messages = [
            SystemMessage(content="You are a semantic chunking assistant that groups related sentences together."),
            HumanMessage(content=(
                "Given the following sentences with their unique IDs, group them into logical paragraphs. "
                "Respond ONLY with a JSON object that contains a single key `chunks`, whose value is a list of "
                "arrays. Each array represents a paragraph and contains the `sentence_id`s (integers) in the order "
                "they should appear. Do NOT invent sentence IDs or add any explanation text. Here are the sentences:\n"
                f"{json.dumps(trimmed_sentences, ensure_ascii=False)}"
            ))
        ]

        response = await self._chat(messages)
        payload = self._parse_json_payload(response)
        if not payload:
            return []
        raw_chunks = payload.get("chunks")
        if not isinstance(raw_chunks, list):
            return []

        structured_chunks: List[List[int]] = []
        for chunk in raw_chunks:
            if not isinstance(chunk, list):
                continue
            chunk_ids: List[int] = []
            for value in chunk:
                if isinstance(value, int):
                    chunk_ids.append(value)
                elif isinstance(value, str) and value.isdigit():
                    chunk_ids.append(int(value))
            if chunk_ids:
                structured_chunks.append(chunk_ids)

        return structured_chunks

    def _parse_json_payload(self, text: str) -> Optional[Dict]:
        cleaned = text.strip()
        cleaned = re.sub(r"```json|```", "", cleaned).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start != -1 and end != -1 and end > start:
                candidate = cleaned[start : end + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    pass
        return None
