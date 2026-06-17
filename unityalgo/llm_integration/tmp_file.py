import frappe
import html2text
import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import (
    VectorParams,
    Distance,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
)
from .utils import is_html

IGNORE_FIELDS = {"doctype", "name", "idx", "owner", "modified_by", "creation", "modified", "docstatus"}

h = html2text.HTML2Text()
h.ignore_links = False
h.body_width = 0

COLLECTION_NAME = "frappe_docs"
VECTOR_SIZE = 384  # all-MiniLM-L6-v2 output dims


class Vectorizer:
    def __init__(
        self,
        qdrant_host: str = "localhost",
        qdrant_port: int = 6333,
        model_name: str = "all-MiniLM-L6-v2",
    ):
        self.model_name = model_name
        self._model = None

        self.qdrant = QdrantClient(host=qdrant_host, port=qdrant_port)
        self._ensure_collection()

    # ------------------------------------------------------------------ #
    #  Setup                                                               #
    # ------------------------------------------------------------------ #

    def _ensure_collection(self):
        """Create Qdrant collection if it doesn't exist."""
        existing = [c.name for c in self.qdrant.get_collections().collections]
        if COLLECTION_NAME not in existing:
            self.qdrant.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(
                    size=VECTOR_SIZE,
                    distance=Distance.COSINE,
                ),
            )
            # Index payload fields for fast filtering
            self.qdrant.create_payload_index(
                collection_name=COLLECTION_NAME,
                field_name="doctype",
                field_schema="keyword",
            )
            self.qdrant.create_payload_index(
                collection_name=COLLECTION_NAME,
                field_name="docname",
                field_schema="keyword",
            )

    def _load_model(self):
        """Lazy-load the embedding model on first use."""
        if self._model is not None:
            return
        try:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_name)
        except ImportError:
            raise ImportError("Run: pip install sentence-transformers")

    # ------------------------------------------------------------------ #
    #  Serialization                                                       #
    # ------------------------------------------------------------------ #

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
            label = (
                field_meta.label
                if field_meta and field_meta.label
                else key.replace("_", " ").title()
            )

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

    # ------------------------------------------------------------------ #
    #  Vectorization                                                       #
    # ------------------------------------------------------------------ #

    def text_to_vector(self, text: str) -> np.ndarray:
        self._load_model()
        return self._model.encode(text, normalize_embeddings=True)

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

    # ------------------------------------------------------------------ #
    #  Qdrant Operations                                                   #
    # ------------------------------------------------------------------ #

    def _doc_to_point(self, doc) -> PointStruct:
        """Convert a Frappe doc into a Qdrant PointStruct."""
        text, vector = self.document_to_vector(doc)

        # Stable integer ID from doc name for upsert idempotency
        point_id = abs(hash(f"{doc.doctype}::{doc.name}")) % (2**53)

        return PointStruct(
            id=point_id,
            vector=vector.tolist(),
            payload={
                "docname": doc.name,
                "doctype": doc.doctype,
                "text": text,
                "company": getattr(doc, "company", None),
            },
        )

    def index_document(self, doc):
        """Upsert a single Frappe document into Qdrant."""
        point = self._doc_to_point(doc)
        self.qdrant.upsert(collection_name=COLLECTION_NAME, points=[point])

    def index_documents(self, docs: list, batch_size: int = 64):
        """
        Upsert a list of Frappe documents in batches.
        Encodes embeddings in bulk for speed, then upserts in chunks.
        """
        self._load_model()

        texts = [self.document_to_text(doc) for doc in docs]
        vectors = self._model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=True,
            batch_size=batch_size,
        )

        points = [
            PointStruct(
                id=abs(hash(f"{doc.doctype}::{doc.name}")) % (2**53),
                vector=vector.tolist(),
                payload={
                    "docname": doc.name,
                    "doctype": doc.doctype,
                    "text": text,
                    "company": getattr(doc, "company", None),
                },
            )
            for doc, text, vector in zip(docs, texts, vectors)
        ]

        # Upload in chunks to avoid overwhelming Qdrant
        for i in range(0, len(points), batch_size):
            self.qdrant.upsert(
                collection_name=COLLECTION_NAME,
                points=points[i : i + batch_size],
            )

    def delete_document(self, doctype: str, name: str):
        """Remove a document from the index."""
        point_id = abs(hash(f"{doctype}::{name}")) % (2**53)
        self.qdrant.delete(
            collection_name=COLLECTION_NAME,
            points_selector=[point_id],
        )

    def search(
        self,
        query: str,
        doctype: str = None,
        company: str = None,
        top_k: int = 5,
    ) -> list[dict]:
        """
        Semantic search over indexed documents.

        Args:
            query:   Natural language query string
            doctype: Optional filter e.g. "Purchase Invoice"
            company: Optional filter e.g. "Unity Algo"
            top_k:   Number of results to return

        Returns:
            List of {name, doctype, text, score}
        """
        query_vector = self.text_to_vector(query)

        # Build optional filters
        conditions = []
        if doctype:
            conditions.append(FieldCondition(key="doctype", match=MatchValue(value=doctype)))
        if company:
            conditions.append(FieldCondition(key="company", match=MatchValue(value=company)))

        search_filter = Filter(must=conditions) if conditions else None

        hits = self.qdrant.search(
            collection_name=COLLECTION_NAME,
            query_vector=query_vector.tolist(),
            query_filter=search_filter,
            limit=top_k,
            with_payload=True,
        )

        return [
            {
                "name": h.payload["docname"],
                "doctype": h.payload["doctype"],
                "text": h.payload["text"],
                "score": round(h.score, 4),
            }
            for h in hits
        ]