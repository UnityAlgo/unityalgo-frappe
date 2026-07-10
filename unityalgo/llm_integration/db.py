import frappe
from typing import List, Dict, Any
from qdrant_client import QdrantClient
from qdrant_client.models import (
	PointStruct,
	VectorParams,
	Distance,
	SparseVectorParams,
	SparseVector,
	Prefetch,
	FusionQuery,
	Fusion,
	Filter,
	FieldCondition,
	MatchValue,
)

DENSE = "dense"
SPARSE = "bm25"


def _point_id(doctype: str, docname: str, chunk_index: int = 0) -> int:
	key = f"{doctype}:{docname}:{chunk_index}"
	return int(frappe.utils.hashlib.md5(key.encode()).hexdigest()[:15], 16)


class Database:
	def __init__(self) -> None:
		self.qdrant = self._get_cloud_client()

	def _get_credentials(self):
		"""Resolve Qdrant URL + API key from AI Settings, falling back to site_config."""
		url = api_key = None
		try:
			settings = frappe.get_cached_doc("AI Settings", "AI Settings")
			url = getattr(settings, "qdrant_url", None)
			if getattr(settings, "qdrant_api_key", None):
				api_key = settings.get_password("qdrant_api_key")
		except Exception:
			pass

		url = url or frappe.conf.get("qdrant_url")
		api_key = api_key or frappe.conf.get("qdrant_api_key")

		if not url:
			frappe.throw("Qdrant URL is not configured (set it in AI Settings or site_config.json).")
		return url, api_key

	def _get_cloud_client(self) -> QdrantClient:
		url, api_key = self._get_credentials()
		return QdrantClient(url=url, api_key=api_key)

	def init_collection(self, collection_name: str, vector_size: int):
		if not self.qdrant.collection_exists(collection_name):
			self.qdrant.create_collection(
				collection_name=collection_name,
				vectors_config=VectorParams(
					size=vector_size,
					distance=Distance.COSINE,
				),
			)
			frappe.log(f"Created Qdrant collection: {collection_name}")

	def add(self, collection_name: str, vectors_data: List[Dict[str, Any]]):
		if not vectors_data:
			return

		points_to_upload = []

		for item in vectors_data:
			point_id = int(
				frappe.utils.hashlib.md5(f"{item['doctype']}:{item['name']}".encode()).hexdigest()[:15], 16
			)

			points_to_upload.append(
				PointStruct(
					id=point_id,
					vector=item["vector"],
					payload={
						# THIS IS THE STRUCTURED DATA (Payload) we talked about!
						"doctype": item["doctype"],
						"docname": item["name"],
						"text": item["text"],
						# You can add more dynamic metadata here if your vectorizer passes it
					},
				)
			)

		self.qdrant.upsert(collection_name=collection_name, points=points_to_upload)

	def delete(self, collection_name: str, doctype: str, docname: str):
		point_id = int(frappe.utils.hashlib.md5(f"{doctype}:{docname}".encode()).hexdigest()[:15], 16)
		self.qdrant.delete(collection_name=collection_name, points_selector=[point_id])

	# ------------------------------------------------------------------ hybrid

	def init_hybrid_collection(self, collection_name: str, vector_size: int = 768):
		"""Create a collection with both a dense and a sparse (BM25) vector."""
		if not self.qdrant.collection_exists(collection_name):
			self.qdrant.create_collection(
				collection_name=collection_name,
				vectors_config={DENSE: VectorParams(size=vector_size, distance=Distance.COSINE)},
				sparse_vectors_config={SPARSE: SparseVectorParams()},
			)
			for field in ("doctype", "docname", "company", "owner", "type"):
				try:
					self.qdrant.create_payload_index(
						collection_name=collection_name, field_name=field, field_schema="keyword"
					)
				except Exception:
					pass
			frappe.logger("algo_chat").info(f"Created hybrid Qdrant collection: {collection_name}")

	def add_hybrid(self, collection_name: str, items: List[Dict[str, Any]]):
		"""Upsert chunks carrying dense + sparse vectors and rich payload.

		Each item: {doctype, docname, chunk_index, dense, sparse:(indices,values), payload}
		"""
		if not items:
			return
		points = []
		for item in items:
			indices, values = item["sparse"]
			points.append(
				PointStruct(
					id=_point_id(item["doctype"], item["docname"], item.get("chunk_index", 0)),
					vector={
						DENSE: item["dense"],
						SPARSE: SparseVector(indices=indices, values=values),
					},
					payload=item["payload"],
				)
			)
		self.qdrant.upsert(collection_name=collection_name, points=points)

	def delete_by_doc(self, collection_name: str, doctype: str, docname: str):
		"""Remove every chunk belonging to one document."""
		if not self.qdrant.collection_exists(collection_name):
			return
		self.qdrant.delete(
			collection_name=collection_name,
			points_selector=Filter(
				must=[
					FieldCondition(key="doctype", match=MatchValue(value=doctype)),
					FieldCondition(key="docname", match=MatchValue(value=docname)),
				]
			),
		)

	def hybrid_search(self, collection_name: str, dense_vec, sparse, limit=15, query_filter=None):
		"""Dense + sparse retrieval fused with Reciprocal Rank Fusion."""
		if not self.qdrant.collection_exists(collection_name):
			return []
		indices, values = sparse
		response = self.qdrant.query_points(
			collection_name=collection_name,
			prefetch=[
				Prefetch(query=dense_vec, using=DENSE, limit=limit * 2, filter=query_filter),
				Prefetch(
					query=SparseVector(indices=indices, values=values),
					using=SPARSE,
					limit=limit * 2,
					filter=query_filter,
				),
			],
			query=FusionQuery(fusion=Fusion.RRF),
			limit=limit,
			with_payload=True,
		)
		return response.points
