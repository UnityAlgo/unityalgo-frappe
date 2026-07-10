"""Real-time ingestion hooks.

Wired to doc_events for all DocTypes; only allowlisted ones are (re)indexed, in the
background, after the DB commit — so a document save is never blocked or broken by indexing.
"""

import frappe

from . import ingest


def _allowed(doctype: str) -> bool:
	try:
		return doctype in ingest.get_allowlist()
	except Exception:
		return False


def on_update(doc, method=None):
	if not _allowed(doc.doctype):
		return
	try:
		frappe.enqueue(
			"unityalgo.llm_integration.ingest.index_document",
			queue="long",
			enqueue_after_commit=True,
			doctype=doc.doctype,
			name=doc.name,
		)
	except Exception:
		frappe.log_error("algo ingest enqueue (update) failed", frappe.get_traceback())


def on_trash(doc, method=None):
	if not _allowed(doc.doctype):
		return
	try:
		frappe.enqueue(
			"unityalgo.llm_integration.ingest.delete_document",
			queue="long",
			enqueue_after_commit=True,
			doctype=doc.doctype,
			name=doc.name,
		)
	except Exception:
		frappe.log_error("algo ingest enqueue (trash) failed", frappe.get_traceback())
