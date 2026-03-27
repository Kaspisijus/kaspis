import urllib.request, json, sqlite3

conn = sqlite3.connect("/app/backend/data/webui.db")
c = conn.cursor()
c.execute("PRAGMA table_info(auth)")
print("Auth columns:", [r[1] for r in c.fetchall()])
c.execute("SELECT * FROM auth LIMIT 1")
r = c.fetchone()
if r:
    print("Sample auth row:", r)
conn.close()
