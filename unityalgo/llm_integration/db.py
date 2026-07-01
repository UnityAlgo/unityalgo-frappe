import frappe
from typing import List, Dict, Any
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, VectorParams, Distance


API_KEY = """eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6YTdmMDY1ZTAtODRhOC00ODE0LThiNmQtMjVkODEwYWM3NzNlIn0.mL3GQ-KvLbwufknZo56YtSMzjlwQlfgwZ0dlYST3XuY"""
API_URL = "https://cc6d761c-1b48-4029-98ac-1c05ac3935a6.eu-central-1-0.aws.cloud.qdrant.io"


class Database:
	def __init__(self) -> None:
		self.qdrant = self._get_cloud_client()

	def _get_cloud_client(self) -> QdrantClient:
		return QdrantClient(
			url=API_URL,
			api_key=API_KEY,
		)

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
