---
description: "Use when user asks: Change pricing template to <template> on charger <charger-name>"
---
Change pricing template for one charger in EV Charging Cloud.

Inputs:
- templateName: Pricing template name to set.
- chargerName: Full charger display name, for example `iPark.lt stotelė Nr. 13`.

Steps:
1. Navigate to `https://manage.evchargingcloud.com/chargers`.
2. Locate charger row by exact `chargerName`.
3. Open the row three-dot menu and click "Redaguoti".
4. In "Redaguoti įkrovimo stotelę", click the edit pencil on the "Tarifas" line.
5. In "Redaguoti tarifą", clear "Tarifo šablonas" and use `pressSequentially()` to type `templateName` (character-by-character to trigger Vuetify autocomplete).
6. Wait ~1s for the dropdown, then click the matching `.menuable__content__active .v-list-item` (exact match first, case-insensitive fallback).
7. Verify the "Pavadinimas*" field value changed to match the template.
8. Click "Išsaugoti".
9. Close the "Redaguoti įkrovimo stotelę" dialog.
10. Return result: charger name, old/new template (if visible), and success/failure reason.
