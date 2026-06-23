<a href="https://github.com/lucavb/homebridge-shelly-ds9"><img src="homebridge-shelly-ng.png" height="120"></a>

# homebridge-shelly-ds9

[![npm-version](https://badgen.net/npm/v/@lucavb/homebridge-shelly-ds9)](https://www.npmjs.com/package/@lucavb/homebridge-shelly-ds9)

[Homebridge](https://homebridge.io) plugin for [Shelly](https://shelly.cloud) Gen2/Gen3/Gen4 devices,
enabling HomeKit support via mDNS discovery and WebSocket RPC.

## Supported devices

- [Shelly Plus 1 + V3](https://kb.shelly.cloud/knowledge-base/shelly-plus-1)
- [Shelly 1L Gen3](https://kb.shelly.cloud/knowledge-base/shelly-1l-gen3)
- [Shelly Plus 1 PM + V3](https://kb.shelly.cloud/knowledge-base/shelly-plus-1pm)
- [Shelly Plus 1 Mini + V3](https://kb.shelly.cloud/knowledge-base/shelly-plus-1-mini)
- [Shelly Plus 1 PM Mini + V3](https://kb.shelly.cloud/knowledge-base/shelly-plus-1pm-mini)
- [Shelly Plus PM Mini + V3](https://kb.shelly.cloud/knowledge-base/shelly-plus-pm-mini)
- [Shelly Plus 2 PM](https://kb.shelly.cloud/knowledge-base/shelly-plus-2pm)
- [Shelly Plus i4](https://kb.shelly.cloud/knowledge-base/shelly-plus-i4)
- [Shelly Plus I4 DC](https://kb.shelly.cloud/knowledge-base/shelly-plus-i4-dc)
- [Shelly Plus Plug US](https://kb.shelly.cloud/knowledge-base/shelly-plus-plug-us)
- [Shelly Plus Plug S](https://kb.shelly.cloud/knowledge-base/shelly-plus-plug-s-1)
- [Shelly Plus Plug UK](https://kb.shelly.cloud/knowledge-base/shelly-plus-plug-uk)
- [Shelly Plus Plug IT](https://kb.shelly.cloud/knowledge-base/shelly-plus-plug-it)
- [Shelly Plus 0-10V Dimmer](https://kb.shelly.cloud/knowledge-base/shelly-plus-0-10v-dimmer)
- [Shelly Plug S Gen3 Eu](https://kb.shelly.cloud/knowledge-base/shelly-plug-s-mtr-gen3)
- [Shelly AZ Plug Gen3](https://kb.shelly.cloud/knowledge-base/shelly-az-plug-gen3)
- [Shelly Outdoor Plug S Gen3](https://kb.shelly.cloud/knowledge-base/shelly-outdoor-plug-s-gen3)
- [Shelly Plug M Gen3](https://kb.shelly.cloud/knowledge-base/shelly-plug-m-gen3)
- [Shelly Plug PM Gen3](https://kb.shelly.cloud/knowledge-base/shelly-plug-pm-gen3)
- [Shelly Dimmer 0/1-10V PM Gen3](https://kb.shelly.cloud/knowledge-base/shelly-dimmer-0-1-10v-pm-gen3)
- [Shelly Dimmer Gen3](https://kb.shelly.cloud/knowledge-base/shelly-dimmer-gen3)
- [Shelly Pro 1](https://kb.shelly.cloud/knowledge-base/shelly-pro-1)
- [Shelly Pro 1 PM](https://kb.shelly.cloud/knowledge-base/shelly-pro-1pm)
- [Shelly Pro 2](https://kb.shelly.cloud/knowledge-base/shelly-pro-2)
- [Shelly Pro 2 PM](https://kb.shelly.cloud/knowledge-base/shelly-pro-2pm)
- [Shelly Pro 3](https://kb.shelly.cloud/knowledge-base/shelly-pro-3-v1)
- [Shelly Pro 4 PM](https://kb.shelly.cloud/knowledge-base/shelly-pro-4pm)
- [Shelly Pro Dual Cover PM](https://kb.shelly.cloud/knowledge-base/shelly-pro-dual-cover-pm)
- [Shelly Pro Dimmer 1PM](https://kb.shelly.cloud/knowledge-base/shelly-pro-dimmer-1pm)
- [Shelly Pro Dimmer 0/1-10V PM](https://kb.shelly.cloud/knowledge-base/shelly-pro-dimmer-0-1-10v-pm)
- [Shelly Pro Dimmer 2PM](https://kb.shelly.cloud/knowledge-base/shelly-pro-dimmer-2pm)
- [Shelly 1 Gen4](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen4/Shelly1G4)
- [Shelly 1PM Gen4](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen4/Shelly1PMG4)
- [Shelly 2PM Gen4](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen4/Shelly2PMG4)
- [Shelly 1 Gen4 ANZ](https://kb.shelly.cloud/knowledge-base/shelly-1-gen4-anz)
- [Shelly 1PM Gen4 ANZ](https://kb.shelly.cloud/knowledge-base/shelly-1pm-gen4-anz)
- [Shelly 2PM Gen4 ANZ](https://kb.shelly.cloud/knowledge-base/shelly-2pm-gen4-anz)
- [Shelly 1 Mini Gen4](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen4/ShellyMini1G4)
- [Shelly 1 PM Mini Gen4](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen4/ShellyMini1PMG4/)
- [Shelly Plug US Gen4](https://kb.shelly.cloud/knowledge-base/shelly-plug-us-gen4)
- [Shelly Power Strip 4 Gen4](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen4/ShellyPowerStripG4/)

## Installation

Either install this plugin through [Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x)
or manually by following these instructions:

1. Install Homebridge by [following the instructions](https://github.com/homebridge/homebridge/wiki).
2. Install this plugin by running `npm install -g @lucavb/homebridge-shelly-ds9`.
3. Add this plugin to the Homebridge config.json:

```
"platforms": [
  {
    "platform": "ShellyDS9",
    "name": "Shelly DS9"
  }
]
```

By default, devices will be discovered on your local network using mDNS and
WebSockets will then be used to communicate with them.

## Shelly Sensor Add-on

Compatible host devices with the [Shelly Plus Add-on](https://kb.shelly.cloud/knowledge-base/shelly-plus-add-on) can expose DS18B20 and DHT22 peripherals as HomeKit sensors.

**Prerequisites (configured in the Shelly web UI, not in Homebridge):**

1. Enable the add-on under **Settings → Add-on** and reboot the host device (`addon_type` must be `sensor`).
2. Add peripherals under **Peripherals** (DS18B20 temperature probes and/or a DHT22).
3. Reboot again after adding or removing peripherals.

**HomeKit accessories created by this plugin:**

| Add-on peripheral                               | HomeKit service                                |
| ----------------------------------------------- | ---------------------------------------------- |
| DS18B20 (`temperature:100`–`104`)               | Temperature Sensor                             |
| DHT22 (`temperature:N` + `humidity:N`, same ID) | Temperature + Humidity Sensor on one accessory |

DS18B20 and DHT22 cannot be used on the same 1-Wire bus. Add-on digital/analog inputs are not supported yet.

Per-sensor exclusion is available via `temperature:100.exclude` and `humidity:100.exclude` in the device config (component IDs 100–199).

## Configuration

The following configuration options are available. Note that they are all optional.

```
{
  "devices": [
    {
      "id": "e.g. shellyplus1-abcdef123456",
      "name": "My Device",
      "exclude": false,
      "hostname": "e.g. 192.168.1.200",
      "password": "pa$$word",
      "switch:0": {
        "exclude": false,
        "type": "switch"
      },
      "switch:1": {
        "exclude": false,
        "type": "outlet"
      },
      "switch:2": {
        "exclude": false,
        "type": "switch"
      },
      "switch:3": {
        "exclude": false,
        "type": "switch"
      },
      "cover:0": {
        "exclude": false,
        "type": "windowCovering"
      },
      "temperature:100": {
        "exclude": false
      },
      "humidity:100": {
        "exclude": false
      }
    }
  ],
  "mdns": {
    "enable": true,
    "interface": "e.g. eth0 or 192.168.1.100"
  },
  "websocket": {
    "requestTimeout": 10,
    "pingInterval": 60,
    "reconnectInterval": [ 5, 10, 30, 60, 300, 600 ]
  }
}
```

See below for descriptions of each configuration option.

| Option                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices`                          | An array of one or more objects with options for specific devices.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `devices. id`                      | The device ID, e.g. `shellyplus1-abcdef123456`. Find it in the Shelly app under device settings, or in the device web UI hostname.                                                                                                                                                                                                                                                                                                                                                 |
| `devices. name`                    | The name of the device. This will be shown in the homebridge log and will be used as the default name when the device is added to HomeKit. Note though that setting this value after the device has been added will not change the name in HomeKit. If no name is specified, this plugin will use the device name set in the Shelly app, or the name of the device model.                                                                                                          |
| `devices. exclude`                 | Set this option to `true` to make this plugin ignore this device.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `devices. hostname`                | The IP address or hostname of the device. Set this value if your device can't be discovered automatically.                                                                                                                                                                                                                                                                                                                                                                         |
| `devices. password`                | The password to use if authentication has been enabled for the device.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `devices. switch:0-3.exclude`      | Set this option to `true` to prevent the switch with the specified index number from being added to HomeKit.                                                                                                                                                                                                                                                                                                                                                                       |
| `devices. switch:0-3.type`         | The type of accessory used to represent the switch with the specified index number. Available options are `"outlet"` and `"switch"` (default).                                                                                                                                                                                                                                                                                                                                     |
| `devices. cover:0.exclude`         | Set this option to `true` to prevent this cover from being added to HomeKit.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `devices. cover:0.type`            | Only available for devices in cover mode. The type of accessory used to represent the cover. Available options are `"door"`, `"window"` (default) and `"windowCovering"`.                                                                                                                                                                                                                                                                                                          |
| `devices. light:0.exclude`         | Set this option to `true` to prevent this light from being added to HomeKit.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `devices. temperature:100.exclude` | Set this option to `true` to prevent an add-on DS18B20 temperature sensor (component ID 100) from being added to HomeKit. Same pattern applies for `temperature:101`–`199`.                                                                                                                                                                                                                                                                                                        |
| `devices. humidity:100.exclude`    | Set this option to `true` to prevent an add-on DHT22 humidity sensor (component ID 100) from being added to HomeKit. Same pattern applies for `humidity:101`–`199`.                                                                                                                                                                                                                                                                                                                |
| `mdns`                             | Settings for the mDNS device discovery service.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mdns. enable`                     | Set this option to `false` to disable automatic device discovery using mDNS.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mdns. interface`                  | The network interface to use when sending and receiving mDNS packets. You probably don't need to use this setting unless you know what you're doing. If not specified, all available network interfaces will be used.                                                                                                                                                                                                                                                              |
| `websocket. requestTimeout`        | The time, in seconds, to wait for a response before a request is aborted.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `websocket. pingInterval`          | The interval, in seconds, at which ping requests should be made to verify that the connection is open. Set to `0` to disable.                                                                                                                                                                                                                                                                                                                                                      |
| `websocket. reconnectInterval`     | The interval, in seconds, at which a connection attempt should be made after a socket has been closed. If an array or a comma-separated list of numbers is specified, the first value will be used for the first connection attempt, the second value for the second attempt and so on. When the last value has been reached, it will be used for all subsequent connection attempts; unless the value is `0`, in which case no more attempts will be made. Set to `0` to disable. |

## Maintainer

Maintained by [Luca Becker](https://luca-becker.me) ([hello@luca-becker.me](mailto:hello@luca-becker.me)).

## Credits

Forked from [homebridge-shelly-ng](https://github.com/alexryd/homebridge-shelly-ng) by Alexander Rydén.
For first-generation Shelly devices, see [homebridge-shelly](https://github.com/alexryd/homebridge-shelly).
