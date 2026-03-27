import sqlite3, json

conn = sqlite3.connect("/app/backend/data/webui.db")
c = conn.cursor()

c.execute("SELECT data FROM config WHERE id='1'")
r = c.fetchone()
data = json.loads(r[0])

# Set the OpenAI config using the exact PersistentConfig paths
data["openai"] = {
    "enable": True,
    "api_base_urls": ["http://agent:3002/v1"],
    "api_keys": ["xNRA24gpqDQuKs6hHwbzESnYiZWLmXFc"],
    "api_configs": {}
}

# Also disable Ollama to stop the errors
data["ollama"] = {
    "enable": False,
    "base_urls": []
}

# Set default model
data["ui"]["default_models"] = "brunas-agent"

c.execute("UPDATE config SET data=? WHERE id='1'", [json.dumps(data)])
conn.commit()

print("Updated config:")
print(json.dumps(data, indent=2))
conn.close()
