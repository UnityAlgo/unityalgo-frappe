"""LLM-based re-ranking of retrieved candidates.

After hybrid (dense + sparse) fusion returns a broad candidate set, a single cheap LLM
pass reorders them by true relevance to the query and keeps the top_k. Falls back to the
fusion order on any error, and caches the ordering per (query + candidate set) in Redis.
"""

import hashlib
import json
import re

import frappe

RERANK_SYSTEM = (
	"You are a search re-ranker. Given a user question and numbered context snippets, "
	"choose which snippets are actually relevant. Respond with ONLY a JSON array of the "
	"0-based indices, most relevant first. Example: [3, 0, 5]"
)


def _cache_key(query, candidates, top_k):
	ids = "|".join(f"{c.get('doctype')}:{c.get('docname')}:{c.get('chunk_index', 0)}" for c in candidates)
	raw = f"{top_k}:{query}:{ids}"
	return "algo:rerank:" + hashlib.sha256(raw.encode()).hexdigest()


def _parse_order(text, n):
	m = re.search(r"\[[\d,\s]*\]", text or "")
	if not m:
		return []
	try:
		order = json.loads(m.group(0))
	except ValueError:
		return []
	seen, clean = set(), []
	for i in order:
		if isinstance(i, int) and 0 <= i < n and i not in seen:
			seen.add(i)
			clean.append(i)
	return clean


def rerank(query, candidates, top_k, llm):
	"""Return the top_k most relevant candidates, reordered by an LLM."""
	if not candidates:
		return []
	if len(candidates) <= top_k:
		return candidates

	key = _cache_key(query, candidates, top_k)
	try:
		cached = frappe.cache().get_value(key)
		if cached:
			order = json.loads(cached)
			picked = [candidates[i] for i in order if 0 <= i < len(candidates)]
			if picked:
				return picked[:top_k]
	except Exception:
		pass

	snippets = "\n\n".join(
		f"[{i}] ({c.get('doctype')}: {c.get('docname')})\n{(c.get('text') or '')[:300]}"
		for i, c in enumerate(candidates)
	)
	prompt = (
		f"Question: {query}\n\nSnippets:\n{snippets}\n\n"
		f"Return the {top_k} most relevant snippet indices as a JSON array, most relevant first."
	)

	try:
		raw = llm.simple_complete(prompt, system=RERANK_SYSTEM, max_tokens=100)
		order = _parse_order(raw, len(candidates))
	except Exception:
		order = []

	if not order:
		return candidates[:top_k]

	# Fill any leftover slots with the remaining fusion order so we always return top_k.
	remaining = [i for i in range(len(candidates)) if i not in order]
	full_order = (order + remaining)[:top_k]
	try:
		frappe.cache().set_value(key, json.dumps(full_order), expires_in_sec=3600)
	except Exception:
		pass
	return [candidates[i] for i in full_order]
