import re


def is_html(text: str) -> bool:
	pattern = re.compile(r"<[a-zA-Z][^>]*>|</[a-zA-Z]+>", re.IGNORECASE)
	return bool(pattern.search(text))
