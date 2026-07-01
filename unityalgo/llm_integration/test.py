import frappe
from .vectorizer import Vectorizer


def main():
	doctype = "Journal Entry"
	docs = frappe.get_all(doctype)
	vectorizer_obj = Vectorizer()
	for i in docs:
		text = vectorizer_obj.document_to_text(frappe.get_doc(doctype, i.name))
		vectors = vectorizer_obj.text_to_vector(text)
		print(vectors)




