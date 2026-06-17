from qdrant_client import QdrantClient, PointStruct
from typing import List

API_KEY = """eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZWJkNmNkZGYtYTVhOC00NjdiLTgyZDctZDRmMmUwYjEyMmRlIn0.aRN8Qazr-c9baXzJcEAtI-AlPmsvvR4FLMUgOHLiZ88"""
API_URL = "https://ba6762d8-da34-4962-ab30-cf841bcf8beb.sa-east-1-0.aws.cloud.qdrant.io"


class Database:
	def __init__(self) -> None:
		self.qdrant = self._get_cloud_client()
		# self.quadrant = self._get_quadrant_client()
		pass

	def _get_cloud_client(self):
		return QdrantClient(
			url=API_URL,
			api_key=API_KEY,
		)

	def _get_quadrant_client(self):
		if self.quadrant is not None:
			return self.quadrant

		host = "localhost"
		port = 8333
		return QdrantClient(host, port)

	def add(self, collection_name, vectors: List[int]):
		self.client.upsert(
			collection_name="example_collection",
			points=[
				PointStruct(id=1, vector=[0.05, 0.61, 0.76, 0.74], payload={"city": "Berlin"}),
				PointStruct(id=2, vector=[0.19, 0.81, 0.75, 0.11], payload={"city": "London"}),
			],
		)
		...
