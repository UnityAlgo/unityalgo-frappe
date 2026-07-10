"""Ingestion pipeline: parse -> chunk -> embed (dense + sparse) -> tag -> upsert.

Indexes an allowlist of unstructured DocTypes into the hybrid ``documents`` collection so
the retriever can ground answers on real business content (notes, tickets, descriptions).
Real-time freshness is driven by doc_events (see sync.py); bulk (re)index via reindex_allowlist.
"""

import frappe

from .db import Database, DENSE, SPARSE
from .vectorizer import Vectorizer, chunk_text
from . import sparse as sparse_mod

COLLECTION = "documents"
VECTOR_SIZE = 768

DEFAULT_INGEST_DOCTYPES = ["Note", "ToDo", "Comment", "Item", "Project", "Task"]


def get_allowlist() -> list[str]:
	"""Allowlisted DocTypes from AI Settings (comma-separated) or a sensible default."""
	try:
		raw = frappe.db.get_single_value("AI Settings", "ingest_doctypes")
	except Exception:
		raw = None
	if raw:
		names = [d.strip() for d in raw.replace("\n", ",").split(",") if d.strip()]
	else:
		names = list(DEFAULT_INGEST_DOCTYPES)
	# Only keep DocTypes that actually exist on this site.
	return [d for d in names if frappe.db.exists("DocType", d)]


def _build_payload(doc, meta, chunk, chunk_index):
	title_field = meta.get_title_field() if meta else None
	return {
		"doctype": doc.doctype,
		"docname": doc.name,
		"chunk_index": chunk_index,
		"text": chunk,
		"title": doc.get(title_field) if title_field else doc.name,
		"module": getattr(meta, "module", None),
		"company": doc.get("company"),
		"owner": doc.get("owner"),
		"modified": str(doc.get("modified") or ""),
		"type": "document",
	}


def index_document(doctype: str, name: str):
	"""(Re)index a single document into the hybrid collection. Idempotent."""
	if doctype not in get_allowlist():
		return
	if not frappe.db.exists(doctype, name):
		return

	db = Database()
	db.init_hybrid_collection(COLLECTION, VECTOR_SIZE)

	vectorizer = Vectorizer()
	doc = frappe.get_doc(doctype, name)
	meta = frappe.get_meta(doctype)
	text = vectorizer.document_to_text(doc)
	chunks = chunk_text(text)

	# Replace any previous chunks for this document first (handles shrinking edits).
	db.delete_by_doc(COLLECTION, doctype, name)
	if not chunks:
		return

	items = []
	for idx, chunk in enumerate(chunks):
		items.append(
			{
				"doctype": doctype,
				"docname": name,
				"chunk_index": idx,
				"dense": vectorizer.text_to_vector(chunk),
				"sparse": sparse_mod.sparse_embed(chunk),
				"payload": _build_payload(doc, meta, chunk, idx),
			}
		)
	db.add_hybrid(COLLECTION, items)


def delete_document(doctype: str, name: str):
	"""Remove a document's chunks from the hybrid collection."""
	try:
		Database().delete_by_doc(COLLECTION, doctype, name)
	except Exception:
		frappe.log_error("ingest.delete_document failed", frappe.get_traceback())


@frappe.whitelist()
def trigger_reindex():
	"""Queue a full reindex in the background (called by the AI Settings button)."""
	frappe.only_for("System Manager")
	frappe.enqueue(
		"unityalgo.llm_integration.ingest.reindex_allowlist", queue="long", timeout=3600
	)
	return {"queued": True}


@frappe.whitelist()
def reindex_allowlist():
	"""Bulk (re)index every allowlisted DocType. Enqueued from the settings button."""
	allowlist = get_allowlist()
	total = 0
	for doctype in allowlist:
		names = frappe.get_all(doctype, pluck="name", limit_page_length=0)
		for name in names:
			try:
				index_document(doctype, name)
				total += 1
			except Exception:
				frappe.log_error(f"reindex failed for {doctype} {name}", frappe.get_traceback())
	frappe.logger("algo_chat").info(f"Reindexed {total} documents across {len(allowlist)} DocTypes")
	return {"indexed": total, "doctypes": allowlist}
