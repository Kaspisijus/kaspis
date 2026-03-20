---
description: "Use when user asks: Change pricing template to <template> to all chargers"
---
Change pricing template for all chargers in EV Charging Cloud.

Inputs:
- templateName: Pricing template name to set for all chargers.

Steps:
1. Navigate to `https://manage.evchargingcloud.com/chargers`.
2. Iterate through every charger row on the page:
- Open row three-dot menu and click "Redaguoti".
- In "Redaguoti įkrovimo stotelę", click the edit pencil on the "Tarifas" line.
- In "Redaguoti tarifą", clear "Tarifo šablonas" and use `pressSequentially()` to type `templateName` (character-by-character to trigger Vuetify autocomplete).
- Wait ~1s for dropdown, click matching `.menuable__content__active .v-list-item`.
- Verify "Pavadinimas*" field changed to match template.
- Click "Išsaugoti" and verify update.
- Close the charger dialog and continue to next row.
3. If pagination exists, continue until all pages are completed.
4. Return summary: total updated, failed charger names, and error reasons.

Rules:
- Use exact template match if possible.
- Stop and report if the template option does not exist.
