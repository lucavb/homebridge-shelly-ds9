import { Service } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import { DeviceLogger } from '../utils/device-logger.ts';
import type { ShellyPlatform } from '../platform.ts';
import { Ability, type ServiceClass } from './base.ts';

class TestAbility extends Ability {
    protected get serviceClass(): ServiceClass {
        return Service.Lightbulb;
    }

    protected initialize(): void {}

    detach(): void {}
}

function setupAbility(ability: TestAbility, initialServices: Service[] = []) {
    const services = [...initialServices];
    const getServiceById = vi.fn((serviceClass: ServiceClass, subtype: string) =>
        services.find((service) => service.UUID === serviceClass.UUID && service.subtype === subtype),
    );
    const accessory = {
        addService: vi.fn((serviceClass: typeof Service, name?: string, subtype?: string) => {
            const service = new serviceClass(name, subtype);
            services.push(service);
            return service;
        }),
        getService: vi.fn((nameOrClass: string | ServiceClass) =>
            typeof nameOrClass === 'string'
                ? services.find((service) => service.displayName === nameOrClass)
                : services.find((service) => service.UUID === nameOrClass.UUID),
        ),
        getServiceById,
        removeService: vi.fn((service: Service) => {
            const index = services.indexOf(service);
            if (index !== -1) {
                services.splice(index, 1);
            }
        }),
    } as unknown as PlatformAccessory;
    const platform = {
        log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        api: { hap: { Service } },
    } as unknown as ShellyPlatform;
    const log = new DeviceLogger({ id: 'test' } as never, 'Test', platform.log);
    ability.setup(accessory, platform, log);

    return { accessory, services, getServiceById };
}

describe('Ability service lookup', () => {
    it('reuses a cached service by class UUID and subtype rather than by display name', () => {
        const sameNameOtherSubtype = new Service.Lightbulb('Shared name', 'other-subtype');
        const cachedService = new Service.Lightbulb('Shared name', 'target-subtype');
        const otherServiceType = new Service.Switch('Shared name', 'target-subtype');
        const ability = new TestAbility('Shared name', 'target-subtype');
        const { accessory, services, getServiceById } = setupAbility(ability, [
            sameNameOtherSubtype,
            otherServiceType,
            cachedService,
        ]);

        expect(getServiceById).toHaveBeenCalledWith(Service.Lightbulb, 'target-subtype');
        expect(accessory.addService).not.toHaveBeenCalled();
        expect(services).toEqual([sameNameOtherSubtype, otherServiceType, cachedService]);
        expect(ability['service']).toBe(cachedService);

        ability.detach();
    });

    it('adds the requested class/subtype when only a same-name different service exists', () => {
        const unrelatedService = new Service.Switch('Shared name', 'target-subtype');
        const ability = new TestAbility('Shared name', 'target-subtype');
        const { accessory, services } = setupAbility(ability, [unrelatedService]);

        expect(accessory.addService).toHaveBeenCalledWith(Service.Lightbulb, 'Shared name', 'target-subtype');
        expect(services).toHaveLength(2);
        expect(services[0]).toBe(unrelatedService);
        expect(ability['service']).toBe(services[1]);

        ability.detach();
    });

    it('removes only the matching cached service when no service instance is held', () => {
        const sameNameOtherSubtype = new Service.Lightbulb('Shared name', 'other-subtype');
        const cachedService = new Service.Lightbulb('Shared name', 'target-subtype');
        const ability = new TestAbility('Shared name', 'target-subtype').setActive(false) as TestAbility;
        const { accessory, services, getServiceById } = setupAbility(ability, [sameNameOtherSubtype, cachedService]);

        expect(getServiceById).toHaveBeenCalledWith(Service.Lightbulb, 'target-subtype');
        expect(accessory.removeService).toHaveBeenCalledWith(cachedService);
        expect(services).toEqual([sameNameOtherSubtype]);

        ability.detach();
    });
});
