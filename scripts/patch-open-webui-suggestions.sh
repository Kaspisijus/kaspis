#!/bin/bash
set -e

echo "Patching Open WebUI suggestions..."

# Define new suggestions
SUGGESTIONS=(
  "Surask vilkiką ABC001"
  "registruok gedimą vilkikui ABC001, skubus, dužęs priekinis langas"
  "Sukurk vairuotoją Petras Petraitis, gimimo metai 1985-01-01"
  "sujunk vilkiką ABC001 su priekaba AE5555"
  "sukurk vairuotojui Jonas Jonaitis kadenciją su vilkiku ABC001 nuo 2026-03-01"
)

# Find potential locations
search_dirs=(
  "/app/backend/dist"
  "/app/dist"
  "/app/frontend/dist"
)

# Look for JavaScript files containing the old suggestions
for dir in "${search_dirs[@]}"; do
  if [ -d "$dir" ]; then
    echo "Searching in $dir..."
    
    # Find all JS files (including minified)
    find "$dir" -type f \( -name "*.js" -o -name "*.jsx" \) 2>/dev/null | while read file; do
      # Check if file contains "Help me study" (one of the default suggestions)
      if grep -q "Help me study" "$file" 2>/dev/null; then
        echo "Found suggestions in: $file"
        
        # Backup original
        cp "$file" "$file.bak"
        
        # Replace suggestions - this is tricky because the file is minified
        # We'll use sed to replace the pattern
        sed -i 's/Help me study[^"]*vocabulary for a college entrance exam/Surask vilkiką ABC001/g' "$file"
        sed -i 's/Overcome procrastination[^"]*give me tips/registruok gedimą vilkikui ABC001, skubus, dužęs priekinis langas/g' "$file"
        sed -i 's/Explain options trading[^"]*if I.m familiar with buying and selling stocks/Sukurk vairuotoją Petras Petraitis, gimimo metai 1985-01-01/g' "$file"
        sed -i 's/Show me a code snippet[^"]*of a website.s sticky header/sujunk vilkiką ABC001 su priekaba AE5555/g' "$file"
        sed -i 's/Give me ideas[^"]*for what to do with my kids. art/sukurk vairuotojui Jonas Jonaitis kadenciją su vilkiku ABC001 nuo 2026-03-01/g' "$file"
        
        echo "Patched: $file"
      fi
    done
  fi
done

echo "Patch complete!"
