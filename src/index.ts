import type { API } from 'homebridge';

import { PLATFORM_NAME, ShellyPlatform } from './platform.ts';

export default (api: API) => {
    api.registerPlatform(PLATFORM_NAME, ShellyPlatform);
};
