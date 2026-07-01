import json
import time

import frappe
import requests

from unityalgo.llm_integration.db import Database
from unityalgo.llm_integration.contexts import DIRECTIVE_CONTEXT

GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_STREAM_URL = (
	"https://generativelanguage.googleapis.com/v1beta/models/"
	"{model}:streamGenerateContent?alt=sse&key={api_key}"
)
GEMINI_MAX_RETRIES = 3
GEMINI_RETRY_BACKOFF_SECONDS = 5

OLLAMA_MODEL = "gemma2:4b"
OLLAMA_CHAT_PATH = "/api/chat"
OLLAMA_TIMEOUT = 120


class LLMError(Exception):
	pass


class RateLimitError(LLMError):
	pass


class LLM:
	def __init__(self, provider=None):
		self.settings = frappe.get_doc("AI Settings", "AI Settings")
		self.provider = provider or self.settings.provider or "gemini"

	def get_model(self):
		if self.provider == "ollama":
			return self.settings.ollama_model or OLLAMA_MODEL
		return self.settings.gemini_model or GEMINI_MODEL

	def stream_response(self, contents):
		if self.provider == "ollama":
			yield from self._stream_ollama(contents)
		elif self.provider == "gemini":
			yield from self._stream_gemini(contents)
		else:
			frappe.throw(f"Unknown LLM provider: {self.provider}")

	def _get_gemini_api_key(self):
		api_key = self.settings.gemini_api_key
		if not api_key:
			frappe.throw("Gemini API key is not configured in AI Settings")
		return api_key

	def _get_ollama_host(self):
		host = self.settings.ollama_host
		if not host:
			frappe.throw("Ollama host is not configured in AI Settings")
		return host.rstrip("/")

	def _stream_gemini(self, contents):
		api_key = self._get_gemini_api_key()
		url = GEMINI_STREAM_URL.format(model=self.get_model(), api_key=api_key)
		response = self._open_gemini_stream(url, {"contents": contents})

		with response:
			for raw_line in response.iter_lines(decode_unicode=True):
				if not raw_line or not raw_line.startswith("data:"):
					continue

				payload = raw_line[len("data:") :].strip()
				if payload == "[DONE]":
					break

				chunk = json.loads(payload)
				piece = self._extract_gemini_text(chunk)
				if piece:
					yield piece

	def _open_gemini_stream(self, url, payload):
		last_error = None

		for attempt in range(1, GEMINI_MAX_RETRIES + 1):
			response = requests.post(url, json=payload, stream=True, timeout=120)

			if response.status_code == 429:
				try:
					frappe.log_error(title="Gemini 429 Details", message=str(response.json()))
				except Exception:
					frappe.log_error(title="Gemini 429 Text", message=response.text)

				retry_after = response.headers.get("Retry-After")
				wait_seconds = (
					int(retry_after)
					if retry_after and retry_after.isdigit()
					else GEMINI_RETRY_BACKOFF_SECONDS * attempt
				)
				response.close()
				last_error = RateLimitError(
					f"Gemini API rate limit hit (attempt {attempt}/{GEMINI_MAX_RETRIES})"
				)
				if attempt == GEMINI_MAX_RETRIES:
					raise last_error
				time.sleep(wait_seconds)
				continue

			response.raise_for_status()
			return response

		raise last_error

	@staticmethod
	def _extract_gemini_text(chunk):
		candidates = chunk.get("candidates") or []
		if not candidates:
			return ""
		parts = candidates[0].get("content", {}).get("parts") or []
		return "".join(part.get("text", "") for part in parts)

	def _stream_ollama(self, contents):
		host = self._get_ollama_host()
		url = f"{host}{OLLAMA_CHAT_PATH}"
		messages = self._to_ollama_messages(contents)

		try:
			response = requests.post(
				url,
				json={"model": self.get_model(), "messages": messages, "stream": True},
				stream=True,
				timeout=OLLAMA_TIMEOUT,
			)
			response.raise_for_status()
		except requests.exceptions.ConnectionError:
			frappe.throw(f"Could not reach Ollama at {host}. Is it running and reachable on the network?")

		with response:
			for raw_line in response.iter_lines(decode_unicode=True):
				if not raw_line:
					continue

				chunk = json.loads(raw_line)
				if chunk.get("error"):
					raise LLMError(chunk["error"])

				piece = chunk.get("message", {}).get("content", "")
				if piece:
					yield piece

				if chunk.get("done"):
					break

	@staticmethod
	def _to_ollama_messages(contents):
		messages = []
		for item in contents:
			role = "user" if item.get("role") == "user" else "assistant"
			text = "".join(part.get("text", "") for part in item.get("parts", []))
			messages.append({"role": role, "content": text})
		return messages

	def _get_query_embedding(self, text: str) -> list:
		"""Quickly get embeddings for the user's question using Ollama"""

		# 1. PREVENT EMPTY STRINGS: Ollama returns [] if prompt is empty
		if not text or not text.strip():
			frappe.throw("Cannot search for an empty query.")

		host = self._get_ollama_host()
		url = f"{host}/api/embeddings"

		try:
			response = requests.post(
				url,
				json={"model": "nomic-embed-text", "prompt": text.strip()},
				timeout=30,  # Increased timeout slightly
			)
			response.raise_for_status()  # Force an error if Ollama returns 4xx/5xx

			data = response.json()
			embedding = data.get("embedding")

			# 2. VALIDATE THE VECTOR: Ensure it's not None or empty
			if not embedding or len(embedding) == 0:
				frappe.log_error(
					"Ollama Embedding Error",
					f"Ollama returned empty embedding for text: {text[:50]}. Response: {data}",
				)
				raise Exception("Ollama failed to generate an embedding vector.")

			return embedding

		except requests.exceptions.ConnectionError:
			frappe.throw("Could not reach Ollama to generate embeddings. Is it running?")
		except Exception as e:
			# Catch any other weird Ollama JSON parsing errors
			if "Ollama failed" not in str(e):
				frappe.log_error("Embedding Fetch Error", str(e))
			raise e

	def stream_response_with_rag(self, contents, user_query: str):
		print("content + user query")

		print(contents)
		print(user_query)
		db = Database()
		context_string = ""

		if not user_query or not user_query.strip():
			yield from self.stream_response(contents)
			return

		try:
			query_vector = self._get_query_embedding(user_query)
			collections_to_search = ["navigation"]  # Add "frappe_transactions" here later!
			all_results = []

			for collection in collections_to_search:
				try:
					response = db.qdrant.query_points(
						collection_name=collection,
						query=query_vector,
						limit=3,
					)
					all_results.extend(response.points)

				except Exception as e:
					frappe.log_error(f"Qdrant search error for {collection}", str(e))
			print("all_results")
			print(all_results)
			if all_results:
				context_parts = []
				seen_texts = set()

				for res in all_results:
					text = res.payload.get("text", "")
					if text and text not in seen_texts:
						seen_texts.add(text)
						source = res.payload.get("doctype", "Unknown")
						docname = res.payload.get("docname", "")
						context_parts.append(f"--- {source}: {docname} ---\n{text}")

				context_string = "Here is relevant context from the Frappe database:\n\n" + "\n\n".join(
					context_parts[:5]
				)

		except Exception as e:
			frappe.log_error("RAG Context Fetch Failed", str(e))
			# If Qdrant/Ollama fails, fallback to normal chat instead of crashing
			yield from self.stream_response(contents)
			return

		# 2. If no context was found in Qdrant, just chat normally
		if not context_string:
			yield from self.stream_response(contents)
			return

		# 3. If we HAVE context, inject it and send to LLM
		rag_contents = [item.copy() for item in contents]
		last_user_idx = -1
		for i in range(len(rag_contents) - 1, -1, -1):
			if rag_contents[i].get("role") == "user":
				last_user_idx = i
				break

		if last_user_idx != -1:
			original_text = "".join(
				part.get("text", "") for part in rag_contents[last_user_idx].get("parts", [])
			)
			new_text = f"""{DIRECTIVE_CONTEXT}
			User Question: {original_text}
			=== DATABASE CONTEXT START ===
			{context_string}
			=== DATABASE CONTEXT END ===
			{INSTRUCTION_CONTEXT}"""

			rag_contents[last_user_idx]["parts"] = [{"text": new_text}]

		yield from self.stream_response(rag_contents)
