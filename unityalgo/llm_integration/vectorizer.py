import frappe
import html2text
from .utils import is_html
from sentence_transformers import SentenceTransformer
import numpy as np

VECTOR_SIZE = 384

IGNORE_FIELDS = {"doctype", "name", "idx", "owner", "modified_by", "creation", "modified", "docstatus"}

h = html2text.HTML2Text()
h.ignore_links = False
h.body_width = 0

DEFAULT_MODEL = "all-MiniLM-L6-v2"


class Vectorizer:
	def __init__(self, model=DEFAULT_MODEL):
		self._model = None
		self.model_name = model

	def _load_model(self):
		if self._model is not None:
			return

		self._model = SentenceTransformer(self.model_name)

	def serialize_value(self, value) -> str:
		if value is None:
			return ""
		text = str(value)
		if is_html(text):
			return h.handle(text).strip()
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

	def text_to_vector(self, text: str) -> np.ndarray:
		self._load_model()

		vector = self._model.encode(text, normalize_embeddings=True)
		return vector

	def document_to_vector(self, doc) -> tuple[str, np.ndarray]:
		text = self.document_to_text(doc)
		vector = self.text_to_vector(text)
		return text, vector

	def batch_to_vectors(self, docs: list) -> list[dict]:
		self._load_model()
		texts = [self.document_to_text(doc) for doc in docs]
		vectors = self._model.encode(texts, normalize_embeddings=True, show_progress_bar=True)

		return [
			{
				"name": doc.name,
				"doctype": doc.doctype,
				"text": text,
				"vector": vector,
			}
			for doc, text, vector in zip(docs, texts, vectors)
		]
