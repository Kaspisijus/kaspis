import os
print("OPENAI_API_BASE_URLS:", os.environ.get("OPENAI_API_BASE_URLS"))
print("OPENAI_API_KEYS:", os.environ.get("OPENAI_API_KEYS", "")[:20] + "...")
print("ENABLE_OPENAI_API:", os.environ.get("ENABLE_OPENAI_API"))
print("OPENAI_API_BASE_URL:", os.environ.get("OPENAI_API_BASE_URL"))
print("OPENAI_API_KEY:", os.environ.get("OPENAI_API_KEY"))

# Try to import open_webui config and check what it resolved to
try:
    # Check if the persistent values override env vars
    import sqlite3, json
    conn = sqlite3.connect("/app/backend/data/webui.db")
    c = conn.cursor()
    c.execute("SELECT data FROM config WHERE id='1'")
    r = c.fetchone()
    data = json.loads(r[0])
    print("\nDB config:", json.dumps(data, indent=2))
    conn.close()
except Exception as e:
    print("DB error:", e)

# Direct test: fetch from agent
import urllib.request
api_key = os.environ.get("OPENAI_API_KEYS", "")
base_url = os.environ.get("OPENAI_API_BASE_URLS", "")
print(f"\nDirect fetch to {base_url}/models ...")
try:
    req = urllib.request.Request(
        f"{base_url}/models",
        headers={"Authorization": f"Bearer {api_key}"}
    )
    resp = urllib.request.urlopen(req)
    print("Success:", resp.read().decode()[:200])
except Exception as e:
    print("Failed:", e)
