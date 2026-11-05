# Floors, groups and rooms

Open **Prostorije** on the dashboard. A room has its own name and a separate **Kat / grupa** selection. The selection can be left at **Kat nije određen**. To split a floor, expand **Uredi katove i grupe**, create names such as `1. kat A` and `1. kat B`, then select a room and save its new group. Groups can be renamed or deleted, and empty groups remain available.

Group deletion preserves rooms, room names, device assignments and all point settings. The rooms move to **Kat nije određen**. A room can also be created with a group while assigning an individual card or moving devices in bulk.

## Saved structure

`device-widgets.json` retains its base `version: 1` and adds an optional, validated organization extension:

```json
{
  "version": 1,
  "organizationVersion": 1,
  "floors": [
    { "id": "floor-a", "name": "1. kat A" },
    { "id": "floor-b", "name": "1. kat B" }
  ],
  "roomDetails": [
    { "id": "room-kitchen-a", "name": "Kitchen", "floorId": "floor-a" },
    { "id": "room-kitchen-b", "name": "Kitchen", "floorId": "floor-b" }
  ],
  "rooms": ["room-kitchen-a", "room-kitchen-b"],
  "devices": [
    { "key": "ES/Device", "room": "room-kitchen-a" }
  ]
}
```

The device's `room` value refers to a stable room ID. The room's `floorId` refers to a stable group ID. Device view models expose `room.id`, `room.label`, `room.floorId` and `room.floorLabel`; floor membership is inherited from the room rather than duplicated on each point. Changing a label does not change these references. Equal room names in different groups remain distinct. Normal create/edit operations reject duplicate names within a group; removing groups can leave separately identified same-name rooms without a group, without merging them.

Existing configurations with names such as `Kitchen · 1. kat` are migrated once: the old reference remains a stable room ID, the display name becomes `Kitchen`, and `floorId` stores its group. Zones such as ZX01–ZX13 retain unknown group membership. Once `organizationVersion` is present, names never infer membership again, including during import. Saved catalog room descriptions supply the initial migration without an EWS crawl. Later automatically discovered room IDs without a saved definition are added without guessing a floor.

## Transfer and persistence

Complete backups with organization data use `format: "iot-electric-dashboard", version: 2`. This prevents old dashboard versions from accepting a backup and silently dropping group information. New dashboards still accept version 1 backups and plain widget arrays, and migrate old room suffixes when needed. A plain widget array retains the destination's current organization. The existing multi-file transaction, backups and recovery journal also cover these fields inside the device settings file.

Group and room edits are serialized through the device settings store and broadcast over the existing `device-settings` event. They do not query or write EWS. The shared device model is used by card rendering, command checks and incremental updates.

API additions:

- `POST /api/floors/create` with `{name}`.
- `POST /api/floors/rename` with `{id, name}`.
- `POST /api/floors/delete` with `{id}`.
- `POST /api/rooms` with `{name, floorId}` creates a room with an independent ID.
- `POST /api/rooms/update` with `{id, name, floorId}` edits its name and group.
- Individual card saves and bulk moves accept `newRoom: {name, floorId}` for atomic room creation with assignment.

Configuration responses, settings responses and events include `floors` and `roomDetails`. Existing room APIs and older unstructured files remain readable.

## Bulk moves across floors

The bulk move dialog has separate **Kat / grupa** and **Prostorija** selectors.
Choosing a group filters rooms by their explicit `floorId`, including empty
registered rooms. Identical names on different floors remain separate choices.
If all selected devices share a known floor, that floor is preselected. Changing
the group clears any previously selected room outside the new group; incoming
room changes are also reconciled while the dialog is open.

**Svi katovi / grupe** lists qualified room names. **Kat nije određen** lists
rooms without a group. A new room requires an explicit group or the unknown
option and is created atomically with the device move using `newRoom.floorId`.
**Bez prostorije** removes the room and its inherited floor; **Automatski prema
serveru** restores automatic assignment. Floor filtering does not change the
meaning of those two actions or modify the room itself.
