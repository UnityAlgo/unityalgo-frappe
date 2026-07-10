import frappe
import requests
from bs4 import BeautifulSoup
from .utils import is_html


OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "nomic-embed-text"
IGNORE_FIELDS = {"name", "creation", "modified", "modified_by", "owner", "docstatus"}

CHUNK_SIZE = 1600
CHUNK_OVERLAP = 200


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
	"""Split long serialized documents into overlapping chunks for embedding."""
	text = (text or "").strip()
	if len(text) <= size:
		return [text] if text else []
	chunks = []
	start = 0
	step = max(size - overlap, 1)
	while start < len(text):
		chunks.append(text[start : start + size])
		start += step
	return chunks


class Vectorizer:
	def __init__(self, model=DEFAULT_MODEL):
		self.model_name = model
		self.h = BeautifulSoup(features="html.parser")
		try:
			response = requests.get(f"{OLLAMA_URL}/api/tags", timeout=2)
			response.raise_for_status()
		except requests.exceptions.ConnectionError:
			frappe.throw("Ollama server is not running. Please start Ollama.")

	def serialize_value(self, value) -> str:
		if value is None:
			return ""
		text = str(value)
		if is_html(text):
			return self.h.handle(text).strip()
		return text.strip()

	def document_to_text(self, doc) -> str:
		meta_doc = frappe.get_meta(doc.doctype)
		lines = [f"=== {doc.doctype}: {doc.name} ==="]

		for key, field_value in doc.as_dict().items():
			if key in IGNORE_FIELDS:
				continue

			field_meta = meta_doc.get_field(key)
			label = field_meta.label if field_meta and field_meta.label else key.replace("_", " ").title()

			if isinstance(field_value, list):
				if not field_value:
					continue

				child_doctype = field_meta.options if field_meta else key
				lines.append(f"\n-- {label} ({child_doctype}) --")

				for idx, row in enumerate(field_value, start=1):
					lines.append(f"  [{idx}]")
					for k, v in row.items():
						if k in IGNORE_FIELDS:
							continue
						serialized = self.serialize_value(v)
						if not serialized:
							continue
						child_meta = frappe.get_meta(child_doctype).get_field(k) if child_doctype else None
						child_label = (
							child_meta.label
							if child_meta and child_meta.label
							else k.replace("_", " ").title()
						)
						lines.append(f"    {child_label}: {serialized}")

			else:
				serialized = self.serialize_value(field_value)
				if not serialized:
					continue
				lines.append(f"{label}: {serialized}")

		return "\n".join(lines)

	def text_to_vector(self, text: str) -> list[float]:
		response = requests.post(
			f"{OLLAMA_URL}/api/embeddings",
			json={"model": self.model_name, "prompt": text},
			timeout=60,
		)
		response.raise_for_status()
		return response.json().get("embedding", [])

	def document_to_vector(self, doc) -> tuple[str, list[float]]:
		text = self.document_to_text(doc)
		vector = self.text_to_vector(text)
		return text, vector

	def batch_to_vectors(self, docs: list) -> list[dict]:
		if not docs:
			return []

		texts = [self.document_to_text(doc) for doc in docs]
		response = requests.post(
			f"{OLLAMA_URL}/api/embed", json={"model": self.model_name, "input": texts}, timeout=120
		)
		response.raise_for_status()

		embeddings = response.json().get("embeddings", [])

		return [
			{
				"name": doc.name,
				"doctype": doc.doctype,
				"text": text,
				"vector": embedding,
			}
			for doc, text, embedding in zip(docs, texts, embeddings)
		]
