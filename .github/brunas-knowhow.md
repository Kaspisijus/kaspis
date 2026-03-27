# Brunas TMS — Agent Knowledge Base

Lessons learned, common pitfalls, and verified patterns.
Admin can add entries by saying "prisimink" / "remember this" during a conversation.

---

## Vehicles
- `search_vehicles` searches active vehicles first, then falls back to all statuses automatically. If the vehicle has status 1 (Disassembled), always mention that to the user.
- Vehicle status values: 0=Active, 1=Disassembled, 2=Sold, 3=ReRegistered, 4=Temp, 5=Unexploited, 9=Deleted.
- A plate number like "ABC001" can exist as both a vehicle AND a trailer — always check both if the user says "surask".

## Trailers


## Carriages


## Cadencies


## Drivers


## General
