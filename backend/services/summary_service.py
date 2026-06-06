from typing import Dict, List

from langchain_core.messages import HumanMessage, SystemMessage

from backend.core.llm_client import LLMClient


class SummaryService:
    """Map-reduce summarization service that grounds every statement with [MM:SS]."""

    def __init__(self, llm_client: LLMClient, chunk_token_limit: int = 800):
        self.llm_client = llm_client
        self.chunk_token_limit = chunk_token_limit

    async def summarize_paragraphs(self, paragraphs: List[Dict]) -> Dict:
        if not paragraphs:
            return {"chunk_summaries": [], "hierarchical_summary": "No paragraphs provided."}

        chunks = self._chunk_paragraphs(paragraphs)
        chunk_summaries = []

        for idx, chunk in enumerate(chunks):
            summary = await self._map_chunk(chunk, idx)
            chunk_summaries.append(
                {
                    "chunk_id": idx + 1,
                    "start": chunk[0].get("start", 0.0),
                    "summary": summary
                }
            )

        hierarchical = await self._reduce(chunk_summaries)
        return {
            "chunk_summaries": chunk_summaries,
            "hierarchical_summary": hierarchical
        }

    def _chunk_paragraphs(self, paragraphs: List[Dict]) -> List[List[Dict]]:
        chunks: List[List[Dict]] = []
        current: List[Dict] = []
        current_tokens = 0

        for paragraph in paragraphs:
            text = paragraph.get("text", "")
            if not text:
                continue

            tokens = max(len(text.split()), 1)
            if current and current_tokens + tokens > self.chunk_token_limit:
                chunks.append(current)
                current = []
                current_tokens = 0

            current.append(paragraph)
            current_tokens += tokens

        if current:
            chunks.append(current)

        return chunks

    async def _map_chunk(self, chunk: List[Dict], idx: int) -> str:
        chunk_block = "\n".join(self._format_paragraph(p) for p in chunk)
        prompt = [
            SystemMessage(content=(
                "You are a precise summarization assistant. "
                "For the provided paragraphs, return 3 concise bullet points that highlight the main ideas. "
                "Each bullet must end with a timestamp [MM:SS] inferred from the paragraph's start time and tiny changes "
                "in wording are allowed to make the citation natural."
            )),
            HumanMessage(content=(
                f"Chunk {idx + 1} paragraphs:\n{chunk_block}\n"
                f"The timestamp for each bullet must use the earliest paragraph start time that is relevant to the idea."
            ))
        ]
        return await self.llm_client.chat(prompt)

    async def _reduce(self, chunk_summaries: List[Dict]) -> str:
        joined = "\n\n".join(
            f"Chunk {item['chunk_id']} (start {self._format_time(item['start'])}): {item['summary']}"
            for item in chunk_summaries
        )
        prompt = [
            SystemMessage(content=(
                "You are crafting a hierarchical outline (Main Topic -> Subtopics -> Key Details). "
                "Each sentence or bullet must end with a timestamp [MM:SS] derived from the original chunk start times."
            )),
            HumanMessage(content=(
                f"Combine the following chunk-level analyses into a single structured summary:\n{joined}\n"
                "Format:\nMain Topic: ...\n- Subtopic: ... (include [MM:SS])\n  - Key Detail: ... (include [MM:SS])"
            ))
        ]
        return await self.llm_client.chat(prompt)

    def _format_paragraph(self, paragraph: Dict) -> str:
        speaker = paragraph.get("speaker", "Speaker")
        mmss = self._format_time(paragraph.get("start", 0.0))
        text = paragraph.get("text", "").strip()
        return f"[{mmss}] ({speaker}) {text}"

    @staticmethod
    def _format_time(seconds: float) -> str:
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes:02d}:{secs:02d}"
