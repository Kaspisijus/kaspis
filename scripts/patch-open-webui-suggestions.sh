#!/bin/bash
set -e

echo "Patching Open WebUI suggestions..."

CONFIG_FILE="/app/backend/open_webui/config.py"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Config file not found: $CONFIG_FILE"
  exit 1
fi

# Backup original
cp "$CONFIG_FILE" "$CONFIG_FILE.bak"

# Python script to patch the suggestions in config.py
python3 << 'EOF'
import re
import sys

config_file = "/app/backend/open_webui/config.py"

try:
    with open(config_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # Replace each suggestion completely - match the dictionary pattern and replace both title and content
    # Pattern: {..., 'title': [...], 'content': "...", ...}
    
    # Suggestion 1: Help me study -> Surask vilkiką ABC001
    content = re.sub(
        r"'title':\s*\['Help me study',\s*'vocabulary for a college entrance exam'\]",
        "'title': ['Surask vilkiką ABC001', '']",
        content
    )
    content = re.sub(
        r"'content':\s*['\"]Help me study vocabulary:[^'\"]*['\"]",
        "'content': \"Surask vilkiką ABC001\"",
        content
    )

    # Suggestion 2: Overcome procrastination -> registruok gedimą vilkikui ABC001
    content = re.sub(
        r"'title':\s*\['Overcome procrastination',\s*'give me tips'\]",
        "'title': ['registruok gedimą vilkikui ABC001, skubus, dužęs priekinis langas', '']",
        content
    )
    content = re.sub(
        r"'content':\s*['\"]Overcome procrastination[^'\"]*['\"]",
        "'content': \"registruok gedimą vilkikui ABC001, skubus, dužęs priekinis langas\"",
        content
    )

    # Suggestion 3: Explain options trading -> Sukurk vairuotoją Petras Petraitis
    content = re.sub(
        r"'title':\s*\['Explain options trading',\s*['\"][^'\"]*['\"]?\]",
        "'title': ['Sukurk vairuotoją Petras Petraitis, gimimo metai 1985-01-01', '']",
        content
    )
    content = re.sub(
        r"'content':\s*['\"]Explain options trading[^'\"]*['\"]",
        "'content': \"Sukurk vairuotoją Petras Petraitis, gimimo metai 1985-01-01\"",
        content
    )

    # Suggestion 4: Show me a code snippet -> sujunk vilkiką ABC001 su priekaba
    content = re.sub(
        r"'title':\s*\['Show me a code snippet',\s*['\"][^'\"]*['\"]?\]",
        "'title': ['sujunk vilkiką ABC001 su priekaba AE5555', '']",
        content
    )
    content = re.sub(
        r"'content':\s*['\"]Show me a code snippet[^'\"]*['\"]",
        "'content': \"sujunk vilkiką ABC001 su priekaba AE5555\"",
        content
    )

    # Suggestion 5: Give me ideas -> sukurk vairuotojui Jonas Jonaitis
    content = re.sub(
        r"'title':\s*\['Give me ideas',\s*['\"][^'\"]*['\"]?\]",
        "'title': ['sukurk vairuotojui Jonas Jonaitis kadenciją su vilkiku ABC001 nuo 2026-03-01', '']",
        content
    )
    content = re.sub(
        r"'content':\s*['\"]Give me ideas[^'\"]*['\"]",
        "'content': \"sukurk vairuotojui Jonas Jonaitis kadenciją su vilkiku ABC001 nuo 2026-03-01\"",
        content
    )

    with open(config_file, 'w', encoding='utf-8') as f:
        f.write(content)

    print("Patched config.py successfully")
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
EOF

echo "Patch complete!"
