"""Redis-backed caching for the RAG pipeline.

Two independent caches, both keyed by a hash of their input:

- Query embeddings: expensive to compute (Ollama round-trip). Cached ~24h.
- Retrieved context strings: a full embed + Qdrant search. Cached ~1h so a repeated
  or lightly reworded question skips the whole retrieval step.

Everything degrades gracefully: if Redis is unavailable the getters return None and
callers fall through to recompute.
"""

import hashlib
import json

import frappe

EMBED_PREFIX = "algo:emb:"
CONTEXT_PREFIX = "algo:ctx:"

EMBED_TTL = 24 * 60 * 60  # 24 hours
CONTEXT_TTL = 60 * 60  # 1 hour


def _hash(text: str) -> str:
	return hashlib.sha256((text or "").strip().lower().encode("utf-8")).hexdigest()


def get_cached_embedding(text: str):
	"""Return a cached embedding vector for ``text`` or ``None``."""
	try:
		raw = frappe.cache().get_value(EMBED_PREFIX + _hash(text))
		return json.loads(raw) if raw else None
	except Exception:
		return None


def set_cached_embedding(text: str, vector: list) -> None:
	try:
		frappe.cache().set_value(
			EMBED_PREFIX + _hash(text), json.dumps(vector), expires_in_sec=EMBED_TTL
		)
	except Exception:
		# Caching is best-effort; never break the request over a cache write.
		pass


def get_cached_context(query: str):
	"""Return a cached retrieved-context string for ``query`` or ``None``."""
	try:
		return frappe.cache().get_value(CONTEXT_PREFIX + _hash(query))
	except Exception:
		return None


def set_cached_context(query: str, context_string: str) -> None:
	try:
		frappe.cache().set_value(
			CONTEXT_PREFIX + _hash(query), context_string or "", expires_in_sec=CONTEXT_TTL
		)
	except Exception:
		pass
