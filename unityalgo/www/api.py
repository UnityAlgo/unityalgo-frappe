import frappe
import requests



# class Algo:
	

@frappe.whitelist(allow_guest=True)
def handle_message(query):
	try:
		# 1. Get the API key securely
		api_key = "AIzaSyAAojD1AYw2um6IzLeeQ0sgKbOcZEjnegg"

		if not api_key:
			return "Error: Gemini API key is not configured in site_config.json."

		# 2. The endpoint (Matching your successful test)
		url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"

		# 3. Headers (-H 'Content-Type: application/json')
		headers = {"Content-Type": "application/json"}

		# 4. Payload (-d '{ "contents": [...] }')
		payload = {"contents": [{"parts": [{"text": query}]}]}

		# 5. Make the POST request (Equivelant to 'curl -X POST')
		response = requests.post(url, headers=headers, json=payload)

		# Check if the API returned an error code (like 400 or 403)
		response.raise_for_status()

		# 6. Parse the JSON response
		response_data = response.json()

		# 7. Extract the text based on the exact JSON structure you received in your terminal
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
