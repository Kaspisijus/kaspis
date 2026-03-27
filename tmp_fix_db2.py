import sqlite3, json
conn = sqlite3.connect("/app/backend/data/webui.db")
c = conn.cursor()

# Read current config
c.execute("SELECT data FROM config WHERE id='1'")
r = c.fetchone()
data = json.loads(r[0])
print("Current config:", json.dumps(data, indent=2))

# Remove the openai key we added - let env vars take over
if "openai" in data:
    del data["openai"]
    c.execute("UPDATE config SET data=? WHERE id='1'", [json.dumps(data)])
    conn.commit()
    print("\nRemoved 'openai' from DB config - env vars will be used instead")

# Verify
c.execute("SELECT data FROM config WHERE id='1'")
r = c.fetchone()
print("\nFinal config:", r[0])

conn.close()
