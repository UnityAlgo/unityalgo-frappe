"""Sparse (keyword) embeddings for hybrid retrieval.

Provides the "keyword" arm of the knowledge store so exact tokens (invoice numbers,
codes, names) match even when dense embeddings miss them.

Uses fastembed's BM25 model when available; otherwise falls back to a dependency-free
hashed term-frequency encoder. Both return a Qdrant-compatible (indices, values) pair,
so retrieval code doesn't care which backend produced them.
"""

import hashlib
import math
import re

_HASH_DIM = 2 ** 20  # index space for the fallback encoder
_model = None  # None = untried, False = unavailable, else the fastembed model


def _get_model():
	global _model
	if _model is False:
		return None
	if _model is None:
		try:
			from fastembed import SparseTextEmbedding

			_model = SparseTextEmbedding("Qdrant/bm25")
		except Exception:
			_model = False
			return None
	return _model


def _hashed_tf(text):
	tokens = re.findall(r"[a-z0-9]+", (text or "").lower())
	counts = {}
	for tok in tokens:
		if len(tok) < 2:
			continue
		idx = int(hashlib.md5(tok.encode()).hexdigest()[:8], 16) % _HASH_DIM
		counts[idx] = counts.get(idx, 0) + 1
	if not counts:
		return [], []
	indices = list(counts.keys())
	values = [1.0 + math.log(c) for c in counts.values()]
	return indices, values


def sparse_embed(text: str):
	"""Return (indices, values) for a Qdrant sparse vector."""
	model = _get_model()
	if model is not None:
		try:
			emb = next(iter(model.embed([text or ""])))
			return list(emb.indices.tolist()), list(emb.values.tolist())
		except Exception:
			pass
	return _hashed_tf(text)
