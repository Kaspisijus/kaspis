import urllib.request, json

# Get JWT for the admin user from the Open WebUI database
import sqlite3
conn = sqlite3.connect("/app/backend/data/webui.db")
c = conn.cursor()
c.execute("SELECT id FROM user WHERE email='kasparas.ziuraitis@gmail.com'")
user_id = c.fetchone()[0]
c.execute("SELECT token FROM auth WHERE id=?", [user_id])
token = c.fetchone()[0]
conn.close()

print("User ID:", user_id)
print("Token:", token[:30] + "...")

# Call the internal models API
req = urllib.request.Request(
    "http://localhost:8080/api/models",
    headers={"Authorization": f"Bearer {token}"}
)
try:
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read().decode())
    print(f"\nModels count: {len(data.get('data', []))}")
    for m in data.get("data", []):
        print(f"  - {m.get('id')}: {m.get('name', 'no name')}")
except urllib.error.HTTPError as e:
    print("Error:", e.code, e.read().decode()[:300])
