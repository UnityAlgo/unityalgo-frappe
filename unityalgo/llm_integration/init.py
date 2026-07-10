from .utils import get_navigations_data
from .db import Database
from .vectorizer import Vectorizer, chunk_text
from . import sparse as sparse_mod


def main():
	collection_name = "navigation"
	db = Database()
	vectorizer = Vectorizer()

	# Recreate as a hybrid (dense + sparse) collection.
	if db.qdrant.collection_exists(collection_name):
		db.qdrant.delete_collection(collection_name)
	db.init_hybrid_collection(collection_name, vector_size=768)

	items = []
	data = get_navigations_data()
	for item in data:
		for idx, chunk in enumerate(chunk_text(item["text"])):
			items.append(
				{
					"doctype": "Navigation",
					"docname": item["id"],
					"chunk_index": idx,
					"dense": vectorizer.text_to_vector(chunk),
					"sparse": sparse_mod.sparse_embed(chunk),
					"payload": {
						"doctype": "Navigation",
						"docname": item["id"],
						"chunk_index": idx,
						"text": chunk,
						"title": item["id"],
						"type": item.get("type", "navigation"),
					},
				}
			)

	if items:
		db.add_hybrid(collection_name, items)
		print(f"Navigation sync complete! Uploaded {len(items)} chunks.")
	else:
		print("No navigation data found to sync.")
