from .utils import get_navigations_data
from .db import Database
from .vectorizer import Vectorizer


def main():
	collection_name = "navigation"
	db = Database()
	vectorizer = Vectorizer()

	db.init_collection(collection_name=collection_name, vector_size=768)
	if not db.qdrant.collection_exists(collection_name):
		db.qdrant.create_payload_index(
			collection_name=collection_name, field_name="type", field_schema="keyword"
		)

	vectors_to_upload = []

	data = get_navigations_data()
	for item in data:
		print(f"Vectorizing: {item['id']}...")
		vector = vectorizer.text_to_vector(item["text"])
		vectors_to_upload.append(
			{"name": item["id"], "doctype": "Navigation", "text": item["text"], "vector": vector}
		)

	if vectors_to_upload:
		print(f"Uploading {len(vectors_to_upload)} navigation vectors to Qdrant...")
		db.add(collection_name=collection_name, vectors_data=vectors_to_upload)
		print("Navigation sync complete!")
	else:
		print("No navigation data found to sync.")
