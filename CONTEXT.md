# homebridge-shelly-ds9

A Homebridge plugin that exposes Shelly Gen2/Gen3/Gen4 devices to HomeKit via mDNS discovery and WebSocket RPC.

## Language

### Devices

**Component**:
A device part addressable by its ID, e.g. `switch:0` or `temperature:100`. The per-component config convention (`switch:0.type`, `temperature:100.history`) names components.
_Avoid_: channel, port, endpoint

**Device profile**:
A device's runtime mode that changes which components it exposes, e.g. a Plus 2PM in cover mode vs relay mode.
_Avoid_: mode, device type

**Device delegate**:
The per-model module that maps one discovered device to its accessories.
_Avoid_: device handler, device mapper

**Add-on peripheral**:
A temperature or humidity sensor component (ID ≥ 100) attached via the Shelly Sensor Add-on. A temperature and a humidity peripheral sharing one ID form a single climate accessory.
_Avoid_: sensor extension

### Accessories

**Accessory**:
The plugin's unit of HomeKit exposure: one named identity (e.g. a switch, a climate sensor) carrying a set of abilities. Identified by `${deviceId}-${accessoryId}`.
_Avoid_: device (for a single accessory), node

**Platform accessory**:
The homebridge-owned cache object an accessory projects into HomeKit, identified by the accessory's UUID.
_Avoid_: cached accessory, bridge item

**Ability**:
One HomeKit-facing behaviour attached to an accessory — roughly one HomeKit service — with its own active/inactive lifecycle.
_Avoid_: feature, trait, service (when meaning an ability)

### History

**Reading**:
A sensor value arriving from a component; the unit the recorder consumes.
_Avoid_: measurement, value event

**History entry**:
One persisted sensor reading displayed in history charts (Eve, Home+). Temperature and humidity are recorded independently: one entry per kind.
_Avoid_: sample, data point

**WeatherHistoryRecorder**:
The single owner of an accessory's weather history: readings go in, history entries come out.
_Avoid_: history service, fakegato wrapper, history logger
