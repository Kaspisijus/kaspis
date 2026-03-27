import urllib.request, json, os, sys

# Use the admin's trusted header to get a session
# Simulate what nginx does - send a request with the trusted header
req = urllib.request.Request(
    "http://localhost:8080/api/models",
    headers={
        "X-User-Email": "kasparas.ziuraitis@gmail.com"
    }
)
try:
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read().decode())
    print(f"Models count: {len(data.get('data', []))}")
    for m in data.get("data", []):
        mid = m.get('id', '')
        mname = m.get('name', 'no name')
        print(f"  - {mid}: {mname}")
    if not data.get("data"):
        print("MODEL LIST IS EMPTY!")
        print("Full response:", json.dumps(data, indent=2)[:500])
except urllib.error.HTTPError as e:
    body = e.read().decode()[:300]
    print(f"Error {e.code}: {body}")

# Also check the OpenAI models endpoint directly
print("\n--- Direct agent /v1/models ---")
req2 = urllib.request.Request(
    "http://agent:3002/v1/models",
    headers={"Authorization": f"Bearer {os.environ.get('OPENAI_API_KEYS', '')}"}
)
try:
    resp2 = urllib.request.urlopen(req2)
    data2 = json.loads(resp2.read().decode())
    print(f"Agent models: {json.dumps(data2, indent=2)[:300]}")
except Exception as e:
    print(f"Agent error: {e}")
