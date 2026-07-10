import json
import re
import time

import frappe
import requests

from unityalgo.llm_integration.db import Database
from unityalgo.llm_integration.contexts import (
	DIRECTIVE_CONTEXT,
	INSTRUCTION_CONTEXT,
	RICH_OUTPUT_CONTEXT,
	AGENT_DIRECTIVE_CONTEXT,
	AGENT_INSTRUCTION_CONTEXT,
)
from unityalgo.llm_integration import cache
from unityalgo.llm_integration import data_tools
from unityalgo.llm_integration import sparse as sparse_mod
from unityalgo.llm_integration import rerank as rerank_mod

MAX_TOOL_ITERS = 6

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

ANTHROPIC_MODEL = "claude-opus-4-8"
ANTHROPIC_MAX_TOKENS = 4096

OPENAI_MODEL = "gpt-4o-mini"
OPENAI_MAX_TOKENS = 4096

EMBED_MODEL = "nomic-embed-text"
RAG_TOP_K = 3
RAG_SCORE_THRESHOLD = 0.35


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
		if self.provider == "anthropic":
			return getattr(self.settings, "anthropic_model", None) or ANTHROPIC_MODEL
		if self.provider == "openai":
			return getattr(self.settings, "openai_model", None) or OPENAI_MODEL
		return self.settings.gemini_model or GEMINI_MODEL

	def stream_response(self, contents, system=None):
		"""Dispatch a streaming completion to the configured provider.

		``system`` is the stable, cacheable prefix (persona + retrieved context +
		instructions). Providers place it in their native system slot so it can be
		cached and kept out of the volatile message turns.
		"""
		if self.provider == "ollama":
			yield from self._stream_ollama(contents, system)
		elif self.provider == "gemini":
			yield from self._stream_gemini(contents, system)
		elif self.provider == "anthropic":
			yield from self._stream_anthropic(contents, system)
		elif self.provider == "openai":
			yield from self._stream_openai(contents, system)
		else:
			frappe.throw(f"Unknown LLM provider: {self.provider}")

	# ------------------------------------------------------------------ Gemini

	def _get_gemini_api_key(self):
		api_key = self.settings.gemini_api_key
		if not api_key:
			frappe.throw("Gemini API key is not configured in AI Settings")
		return api_key

	def _stream_gemini(self, contents, system=None):
		api_key = self._get_gemini_api_key()
		url = GEMINI_STREAM_URL.format(model=self.get_model(), api_key=api_key)
		payload = {"contents": contents}
		if system:
			payload["system_instruction"] = {"parts": [{"text": system}]}
		response = self._open_gemini_stream(url, payload)

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

	# ------------------------------------------------------------------ Ollama

	def _get_ollama_host(self):
		host = self.settings.ollama_host
		if not host:
			frappe.throw("Ollama host is not configured in AI Settings")
		return host.rstrip("/")

	def _stream_ollama(self, contents, system=None):
		host = self._get_ollama_host()
		url = f"{host}{OLLAMA_CHAT_PATH}"
		messages = self._to_role_messages(contents)
		if system:
			messages = [{"role": "system", "content": system}] + messages

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

	# --------------------------------------------------------------- Anthropic

	def _stream_anthropic(self, contents, system=None):
		try:
			import anthropic
		except ImportError:
			frappe.throw("The 'anthropic' package is not installed. Run: bench pip install anthropic")

		api_key = self.settings.anthropic_api_key
		if not api_key:
			frappe.throw("Anthropic API key is not configured in AI Settings")

		client = anthropic.Anthropic(api_key=api_key)
		messages = self._to_role_messages(contents)

		# Send the stable context as a cache-controlled system block so repeated
		# requests with the same prefix are billed at cache-read rates.
		system_param = anthropic.NOT_GIVEN
		if system:
			system_param = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]

		try:
			with client.messages.stream(
				model=self.get_model(),
				max_tokens=ANTHROPIC_MAX_TOKENS,
				system=system_param,
				messages=messages,
			) as stream:
				for text in stream.text_stream:
					if text:
						yield text
		except anthropic.RateLimitError as e:
			raise RateLimitError(str(e))
		except anthropic.APIError as e:
			raise LLMError(str(e))

	# ------------------------------------------------------------------ OpenAI

	def _stream_openai(self, contents, system=None):
		try:
			from openai import OpenAI
			import openai
		except ImportError:
			frappe.throw("The 'openai' package is not installed. Run: bench pip install openai")

		api_key = self.settings.openai_api_key
		if not api_key:
			frappe.throw("OpenAI API key is not configured in AI Settings")

		client = OpenAI(api_key=api_key)
		messages = self._to_role_messages(contents)
		if system:
			messages = [{"role": "system", "content": system}] + messages

		try:
			stream = client.chat.completions.create(
				model=self.get_model(),
				messages=messages,
				max_tokens=OPENAI_MAX_TOKENS,
				stream=True,
			)
			for chunk in stream:
				if not chunk.choices:
					continue
				piece = chunk.choices[0].delta.content
				if piece:
					yield piece
		except openai.RateLimitError as e:
			raise RateLimitError(str(e))
		except openai.OpenAIError as e:
			raise LLMError(str(e))

	# ------------------------------------------------------------------ shared

	@staticmethod
	def _to_role_messages(contents):
		"""Flatten internal ``{role, parts:[{text}]}`` items into ``{role, content}``.

		The internal ``model`` role maps to ``assistant`` (OpenAI/Anthropic/Ollama).
		"""
		messages = []
		for item in contents:
			role = "user" if item.get("role") == "user" else "assistant"
			text = "".join(part.get("text", "") for part in item.get("parts", []))
			messages.append({"role": role, "content": text})
		return messages

	def _get_query_embedding(self, text: str) -> list:
		"""Get embeddings for the user's question using Ollama, with a Redis cache."""

		if not text or not text.strip():
			frappe.throw("Cannot search for an empty query.")

		cached = cache.get_cached_embedding(text)
		if cached:
			return cached

		host = self._get_ollama_host()
		url = f"{host}/api/embeddings"
		model = getattr(self.settings, "embedding_model", None) or EMBED_MODEL

		try:
			response = requests.post(
				url,
				json={"model": model, "prompt": text.strip()},
				timeout=30,
			)
			response.raise_for_status()

			data = response.json()
			embedding = data.get("embedding")

			if not embedding or len(embedding) == 0:
				frappe.log_error(
					"Ollama Embedding Error",
					f"Ollama returned empty embedding for text: {text[:50]}. Response: {data}",
				)
				raise Exception("Ollama failed to generate an embedding vector.")

			cache.set_cached_embedding(text, embedding)
			return embedding

		except requests.exceptions.ConnectionError:
			frappe.throw("Could not reach Ollama to generate embeddings. Is it running?")
		except Exception as e:
			if "Ollama failed" not in str(e):
				frappe.log_error("Embedding Fetch Error", str(e))
			raise e


	def _retrieve_context(self, user_query: str):
		cached = cache.get_cached_context(user_query)
		if cached is not None:
			try:
				data = json.loads(cached)
				return data.get("context", ""), data.get("sources", [])
			except (TypeError, ValueError):
				return cached, []

		top_k = int(getattr(self.settings, "rerank_top_k", None) or getattr(self.settings, "rag_top_k", None) or RAG_TOP_K)
		fetch = max(15, top_k * 3)

		db = Database()
		dense = self._get_query_embedding(user_query)
		sparse = sparse_mod.sparse_embed(user_query)

		candidates, seen = [], set()
		for collection in ("documents", "navigation"):
			try:
				points = db.hybrid_search(collection, dense, sparse, limit=fetch)
			except Exception as e:
				frappe.log_error(f"Hybrid search error for {collection}", str(e))
				continue
			for p in points:
				payload = p.payload or {}
				text = payload.get("text", "")
				if not text or text in seen:
					continue

				seen.add(text)
				candidates.append({
					"text": text,
					"doctype": payload.get("doctype", "Unknown"),
					"docname": payload.get("docname", ""),
					"chunk_index": payload.get("chunk_index", 0),
					"title": payload.get("title") or payload.get("docname", ""),
				})

		if not candidates:
			cache.set_cached_context(user_query, json.dumps({"context": "", "sources": []}))
			return "", []

		if getattr(self.settings, "rerank_enabled", 1):
			candidates = rerank_mod.rerank(user_query, candidates, top_k, self)
		else:
			candidates = candidates[:top_k]

		lines, sources = [], []
		for i, c in enumerate(candidates, start=1):
			url = None
			if c["doctype"] not in ("Navigation", "Unknown") and c["docname"]:
				slug = c["doctype"].lower().replace(" ", "-")
				url = f"/app/{slug}/{c['docname']}"
			sources.append({
				"n": i, "doctype": c["doctype"], "docname": c["docname"],
				"title": c["title"], "url": url,
			})
			lines.append(f"[{i}] ({c['doctype']}: {c['docname']})\n{c['text']}")

		context_string = "Relevant context (cite sources inline as [n]):\n\n" + "\n\n".join(lines)
		cache.set_cached_context(user_query, json.dumps({"context": context_string, "sources": sources}))
		return context_string, sources

	# ------------------------------------------------------- single completion

	def simple_complete(self, prompt, system=None, max_tokens=512):
		"""One non-streaming completion (no tools). Used by rerank + evaluation."""
		contents = [{"role": "user", "parts": [{"text": prompt}]}]
		if self.provider == "anthropic":
			import anthropic

			client = anthropic.Anthropic(api_key=self.settings.anthropic_api_key)
			resp = client.messages.create(
				model=self.get_model(), max_tokens=max_tokens,
				system=system or anthropic.NOT_GIVEN,
				messages=self._to_role_messages(contents),
			)
			return "".join(b.text for b in resp.content if b.type == "text")
		if self.provider == "openai":
			from openai import OpenAI

			client = OpenAI(api_key=self.settings.openai_api_key)
			msgs = self._to_role_messages(contents)
			if system:
				msgs = [{"role": "system", "content": system}, *msgs]
			resp = client.chat.completions.create(
				model=self.get_model(), messages=msgs, max_tokens=max_tokens,
			)
			return resp.choices[0].message.content or ""
		if self.provider == "gemini":
			api_key = self._get_gemini_api_key()
			url = (
				"https://generativelanguage.googleapis.com/v1beta/models/"
				f"{self.get_model()}:generateContent?key={api_key}"
			)
			payload = {"contents": contents}
			if system:
				payload["system_instruction"] = {"parts": [{"text": system}]}
			resp = requests.post(url, json=payload, timeout=60)
			resp.raise_for_status()
			cands = resp.json().get("candidates") or []
			parts = cands[0].get("content", {}).get("parts", []) if cands else []
			return "".join(p.get("text", "") for p in parts if "text" in p)
		# ollama
		host = self._get_ollama_host()
		msgs = self._to_role_messages(contents)
		if system:
			msgs = [{"role": "system", "content": system}, *msgs]
		resp = requests.post(
			f"{host}{OLLAMA_CHAT_PATH}",
			json={"model": self.get_model(), "messages": msgs, "stream": False},
			timeout=OLLAMA_TIMEOUT,
		)
		resp.raise_for_status()
		return resp.json().get("message", {}).get("content", "") or ""

	# ---------------------------------------------------------------- tool calling

	@staticmethod
	def _chunk_text(text, size=24):
		"""Split the final answer into stream-sized pieces to preserve the typing effect."""
		for i in range(0, len(text or ""), size):
			yield text[i : i + size]

	# Matches a ```json ... ``` (or bare ``` ... ```) fenced block, to catch weak models
	# that *describe* a query instead of emitting a real tool call.
	_QUERY_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)

	@classmethod
	def _extract_described_query(cls, text):
		"""If the model printed a query JSON instead of calling the tool, return that dict."""
		for m in cls._QUERY_FENCE_RE.finditer(text or ""):
			try:
				obj = json.loads(m.group(1))
			except ValueError:
				continue
			if isinstance(obj, dict) and isinstance(obj.get("doctype"), str):
				return obj
		return None

	@staticmethod
	def _format_rescue(output):
		"""Turn a raw query result into a valid answer (short note + real table)."""
		if output.get("error"):
			return f"I tried to fetch that data but couldn't: {output['error']}"
		rows = output.get("rows") or []
		if not rows:
			return "I ran that query but found no matching records."
		columns = list(rows[0].keys())
		table = {
			"columns": columns,
			"rows": [[r.get(c) for c in columns] for r in rows],
		}
		return (
			f"Here are the results from **{output.get('doctype', 'the records')}** "
			f"({output.get('count', len(rows))} row(s)):\n\n"
			f"```algo:table\n{json.dumps(table, default=str)}\n```"
		)

	def _run_agent_loop(self, messages, call_round, add_results):
		"""Provider-agnostic agentic loop: call -> execute tools -> feed results -> repeat."""
		text = ""
		rescued = False
		for _ in range(MAX_TOOL_ITERS):
			text, tool_calls = call_round(messages)
			if not tool_calls:
				# Rescue path: a weak model may write the query as text instead of calling
				# the tool. Execute it once and return real data rather than prose.
				if not rescued:
					described = self._extract_described_query(text)
					if described:
						rescued = True
						output = data_tools.query_frappe_data(**described)
						return self._format_rescue(output)
				return text
			results = []
			for tc in tool_calls:
				output = data_tools.execute_tool(tc["name"], tc.get("args") or {})
				results.append({"id": tc["id"], "name": tc["name"], "output": output})
			add_results(messages, results)
		return text or "I couldn't finish that within the tool-call limit. Please refine your question."

	@staticmethod
	def _openai_style_tools():
		return [
			{"type": "function", "function": {
				"name": t["name"], "description": t["description"], "parameters": t["input_schema"],
			}}
			for t in data_tools.TOOL_DEFS
		]

	# -- Anthropic -----------------------------------------------------------

	def _agent_anthropic(self, contents, system):
		import anthropic

		if not self.settings.anthropic_api_key:
			frappe.throw("Anthropic API key is not configured in AI Settings")
		client = anthropic.Anthropic(api_key=self.settings.anthropic_api_key)
		tools = [
			{"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]}
			for t in data_tools.TOOL_DEFS
		]
		system_param = (
			[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
			if system else anthropic.NOT_GIVEN
		)

		def call_round(messages):
			try:
				resp = client.messages.create(
					model=self.get_model(), max_tokens=ANTHROPIC_MAX_TOKENS,
					system=system_param, messages=messages, tools=tools,
				)
			except anthropic.RateLimitError as e:
				raise RateLimitError(str(e))
			except anthropic.APIError as e:
				raise LLMError(str(e))
			messages.append({"role": "assistant", "content": resp.content})
			text = "".join(b.text for b in resp.content if b.type == "text")
			tool_calls = [
				{"id": b.id, "name": b.name, "args": b.input}
				for b in resp.content if b.type == "tool_use"
			]
			return text, tool_calls

		def add_results(messages, results):
			messages.append({"role": "user", "content": [
				{"type": "tool_result", "tool_use_id": r["id"], "content": json.dumps(r["output"], default=str)}
				for r in results
			]})

		return self._to_role_messages(contents), call_round, add_results

	# -- OpenAI --------------------------------------------------------------

	def _agent_openai(self, contents, system):
		from openai import OpenAI
		import openai

		if not self.settings.openai_api_key:
			frappe.throw("OpenAI API key is not configured in AI Settings")
		client = OpenAI(api_key=self.settings.openai_api_key)
		tools = self._openai_style_tools()

		messages = self._to_role_messages(contents)
		if system:
			messages = [{"role": "system", "content": system}, *messages]

		def call_round(messages):
			try:
				resp = client.chat.completions.create(
					model=self.get_model(), messages=messages, tools=tools,
					tool_choice="auto", max_tokens=OPENAI_MAX_TOKENS,
				)
			except openai.RateLimitError as e:
				raise RateLimitError(str(e))
			except openai.OpenAIError as e:
				raise LLMError(str(e))
			msg = resp.choices[0].message
			raw_calls = msg.tool_calls or []
			assistant_msg = {"role": "assistant", "content": msg.content or ""}
			if raw_calls:
				assistant_msg["tool_calls"] = [
					{"id": tc.id, "type": "function",
					 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
					for tc in raw_calls
				]
			messages.append(assistant_msg)
			tool_calls = []
			for tc in raw_calls:
				try:
					args = json.loads(tc.function.arguments or "{}")
				except ValueError:
					args = {}
				tool_calls.append({"id": tc.id, "name": tc.function.name, "args": args})
			return (msg.content or ""), tool_calls

		def add_results(messages, results):
			for r in results:
				messages.append({
					"role": "tool", "tool_call_id": r["id"],
					"content": json.dumps(r["output"], default=str),
				})

		return messages, call_round, add_results

	# -- Gemini --------------------------------------------------------------

	def _agent_gemini(self, contents, system):
		api_key = self._get_gemini_api_key()
		url = (
			"https://generativelanguage.googleapis.com/v1beta/models/"
			f"{self.get_model()}:generateContent?key={api_key}"
		)
		tools = [{"function_declarations": [
			{"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}
			for t in data_tools.TOOL_DEFS
		]}]
		base_payload = {"tools": tools}
		if system:
			base_payload["system_instruction"] = {"parts": [{"text": system}]}

		def call_round(messages):
			payload = dict(base_payload, contents=messages)
			resp = requests.post(url, json=payload, timeout=120)
			if resp.status_code == 429:
				raise RateLimitError("Gemini API rate limit hit")
			resp.raise_for_status()
			candidates = resp.json().get("candidates") or []
			parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
			messages.append({"role": "model", "parts": parts})
			text = "".join(p.get("text", "") for p in parts if "text" in p)
			tool_calls = []
			for p in parts:
				fc = p.get("functionCall")
				if fc:
					tool_calls.append({"id": fc["name"], "name": fc["name"], "args": fc.get("args", {})})
			return text, tool_calls

		def add_results(messages, results):
			messages.append({"role": "user", "parts": [
				{"functionResponse": {"name": r["name"], "response": {"result": r["output"]}}}
				for r in results
			]})

		# Gemini uses the internal contents format directly (roles: user / model).
		return [dict(item) for item in contents], call_round, add_results

	# -- Ollama --------------------------------------------------------------

	def _agent_ollama(self, contents, system):
		host = self._get_ollama_host()
		url = f"{host}{OLLAMA_CHAT_PATH}"
		tools = self._openai_style_tools()

		messages = self._to_role_messages(contents)
		if system:
			messages = [{"role": "system", "content": system}, *messages]

		def call_round(messages):
			try:
				resp = requests.post(
					url,
					json={"model": self.get_model(), "messages": messages, "tools": tools, "stream": False},
					timeout=OLLAMA_TIMEOUT,
				)
				resp.raise_for_status()
			except requests.exceptions.ConnectionError:
				frappe.throw(f"Could not reach Ollama at {host}. Is it running?")
			msg = resp.json().get("message", {}) or {}
			messages.append(msg)
			raw_calls = msg.get("tool_calls") or []
			tool_calls = []
			for i, tc in enumerate(raw_calls):
				fn = tc.get("function", {})
				args = fn.get("arguments") or {}
				if isinstance(args, str):
					try:
						args = json.loads(args)
					except ValueError:
						args = {}
				tool_calls.append({"id": f"call_{i}", "name": fn.get("name"), "args": args})
			return msg.get("content", "") or "", tool_calls

		def add_results(messages, results):
			for r in results:
				messages.append({
					"role": "tool", "tool_name": r["name"],
					"content": json.dumps(r["output"], default=str),
				})

		return messages, call_round, add_results

	def _stream_with_tools(self, contents, system):
		setup = {
			"anthropic": self._agent_anthropic,
			"openai": self._agent_openai,
			"gemini": self._agent_gemini,
			"ollama": self._agent_ollama,
		}.get(self.provider)
		if not setup:
			frappe.throw(f"Unknown LLM provider: {self.provider}")

		messages, call_round, add_results = setup(contents, system)
		final_text = self._run_agent_loop(messages, call_round, add_results)
		yield from self._chunk_text(final_text)

	# ---------------------------------------------------------------------- RAG

	def stream_response_with_rag(self, contents, user_query: str):
		self.last_sources = []
		if not user_query or not user_query.strip():
			yield from self.stream_response(contents)
			return

		try:
			context_string, sources = self._retrieve_context(user_query)
			frappe.log_error("context_string", context_string)
			self.last_sources = sources
		except Exception as e:
			frappe.log_error("RAG Context Fetch Failed", str(e))
			context_string = ""

		parts = [AGENT_DIRECTIVE_CONTEXT]
		if context_string:
			parts.append(context_string)
		parts.extend([AGENT_INSTRUCTION_CONTEXT, RICH_OUTPUT_CONTEXT])
		system_prompt = "\n\n".join(parts)

		try:
			yield from self._stream_with_tools(contents, system_prompt)
		except (RateLimitError, LLMError):
			raise
		except Exception as e:
			# If tool calling is unsupported/misbehaves (e.g. an Ollama model without tools),
			# degrade gracefully to a plain semantic answer instead of crashing.
			frappe.log_error("Tool-calling path failed; falling back", str(e))
			fallback_system = "\n\n".join(
				[DIRECTIVE_CONTEXT, context_string, INSTRUCTION_CONTEXT, RICH_OUTPUT_CONTEXT]
			) if context_string else None
			yield from self.stream_response(contents, system=fallback_system)
