import os
import aiohttp

API_KEY = os.getenv("AI_API_KEY")
API_URL = os.getenv(
    "AI_ENDPOINT",
    "https://api.openai.com/v1/chat/completions"
)

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

async def chat(prompt: str) -> str:
    payload = {
        "model": "gpt-3.5-turbo",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(API_URL, json=payload, headers=HEADERS) as r:
            data = await r.json()
            return data["choices"][0]["message"]["content"]
