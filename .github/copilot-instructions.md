# EV Charging Cloud automation defaults

When the user asks to change pricing templates in EV Charging Cloud, execute the website actions directly with Playwright MCP tools instead of giving only theory.

Interpret these natural-language intents as commands:

1. "Change pricing template to \"<template>\" on charger <charger-name>"
- Open `https://manage.evchargingcloud.com/chargers`.
- Find the charger row by full charger name.
- Open the row three-dot action menu and click "Redaguoti".
- In "Redaguoti įkrovimo stotelę", find "Tarifas: ..." and click the edit pencil next to that line.
- In the "Redaguoti tarifą" dialog, type `<template>` in "Tarifo šablonas".
- Wait for autocomplete and select the matching template option (exact match first, case-insensitive fallback).
- Click "Išsaugoti" in the tariff dialog.
- Close the "Redaguoti įkrovimo stotelę" dialog.
- Report success with charger name and selected template.

2. "Change pricing template to \"<template>\" to all chargers"
- Open `https://manage.evchargingcloud.com/chargers`.
- Apply the same edit flow to every charger visible in the list, then continue through remaining pages if pagination exists.
- For each charger: three-dot menu -> "Redaguoti" -> "Tarifas" line edit -> type/select template in "Tarifo šablonas" -> "Išsaugoti" -> close charger dialog.
- Keep a count of updated chargers and report the final count.

Technical implementation notes (Vuetify autocomplete):
- Use `pressSequentially()` (character-by-character typing) instead of `fill()` to trigger autocomplete.
- Wait ~1s after typing for dropdown to appear.
- Select from dropdown via `.menuable__content__active .v-list-item` filtered by template name.
- Verify selection by checking the "Pavadinimas*" field value changed to match the template.

Safety and reliability rules:
- If a target charger is not found, report "not found" and do not update other chargers unless explicitly requested.
- If multiple templates have similar names, choose exact match first, otherwise ask for confirmation.
- After each save, verify a success toast/message or re-open tariff section to confirm template value.
- Do not store or print credentials in files.
