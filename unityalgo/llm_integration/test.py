import frappe
from .vectorizer import Vectorizer


def main():
	invoices = frappe.get_all("Purchase Invoice")
	vectorizer_obj = Vectorizer()
	for i in invoices:
		text = vectorizer_obj.document_to_text(frappe.get_doc("Purchase Invoice", i.name))
		vectors = vectorizer_obj.text_to_vector(text)
		print(text)
		print(vectors)
		break
