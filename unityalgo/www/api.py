import frappe
import requests



# class Algo:
	

@frappe.whitelist(allow_guest=True)
def handle_message(query):
	try:
		api_key = "AIzaSyAAojD1AYw2um6IzLeeQ0sgKbOcZEjnegg"
		if not api_key:
			return "Error: Gemini API key is not configured in site_config.json."

		url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"

		headers = {"Content-Type": "application/json"}
		payload = {"contents": [{"parts": [{"text": query}]}]}
		response = requests.post(url, headers=headers, json=payload)
		response.raise_for_status()
		response_data = response.json()
		if "candidates" in response_data and len(response_data["candidates"]) > 0:
			ai_text = response_data["candidates"][0]["content"]["parts"][0]["text"]

			# Return the text. Frappe will send this to your JS as `r.message`
			return ai_text
		else:
			return "I received an unexpected response format from the API."

	except requests.exceptions.RequestException as e:
		# Hide the API key in the logs just in case it fails
		safe_error_msg = str(e).replace(api_key, "***HIDDEN_API_KEY***") if api_key else str(e)

		frappe.log_error(title="Gemini API Network Error", message=f"Request failed: {safe_error_msg}")
		return "I'm sorry, I encountered a network error while connecting to the AI."

	except Exception as e:
		frappe.log_error(title="Gemini API General Error", message=str(e))
		return "I'm sorry, an unexpected error occurred while processing your request."
