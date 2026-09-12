# GCN replay notices

These two payloads are official NASA GCN Unified Schema JSON examples for the
same Fermi/GBM trigger, 745121685 / bn240812094.

- fermi-gbm-bn240812094-v1.json is the FLIGHT_POSITION update.
- fermi-gbm-bn240812094-v2.json is the later GROUND_POSITION update for the
  same trigger, with a revised localization.

Source files:

- https://raw.githubusercontent.com/nasa-gcn/gcn-schema/main/gcn/notices/fermi/gbm/trigger.flight2.example.json
- https://raw.githubusercontent.com/nasa-gcn/gcn-schema/main/gcn/notices/fermi/gbm/trigger.ground2.example.json

The JSON payloads are kept unchanged; replay adapters should map their fields
into the immutable Notice domain model without mutating raw.
