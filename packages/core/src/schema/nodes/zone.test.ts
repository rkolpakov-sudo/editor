import { describe, expect, test } from 'bun:test'
import { SPACE_CATEGORIES, ZoneNode } from './zone'

describe('ZoneNode architectural room data', () => {
  test('keeps legacy zones generic while supplying room-safe defaults', () => {
    const zone = ZoneNode.parse({
      id: 'zone_legacy',
      name: 'Landscape area',
      polygon: [
        [0, 0],
        [4, 0],
        [4, 3],
      ],
    })

    expect(zone).toMatchObject({
      spaceRole: 'generic',
      spaceCategory: 'public',
      roomNumber: '',
      enclosureStatus: 'auto',
      floorFinish: '',
      wallFinish: '',
      ceilingFinish: '',
      ceilingHeight: 2.7,
      occupancy: '',
      clearDimensionPolicy: 'none',
    })
  })

  test('persists a complete architectural room profile', () => {
    const room = ZoneNode.parse({
      id: 'zone_office',
      name: 'Office',
      polygon: [
        [0, 0],
        [4, 0],
        [4, 3],
      ],
      spaceRole: 'room',
      spaceCategory: 'office_permanent',
      roomNumber: '101',
      enclosureStatus: 'enclosed',
      floorFinish: 'Timber',
      wallFinish: 'Paint',
      ceilingFinish: 'ACT',
      ceilingHeight: 3,
      occupancy: 'Business',
      clearDimensionPolicy: 'inside-faces',
    })

    expect(room.spaceRole).toBe('room')
    expect(room.spaceCategory).toBe('office_permanent')
    expect(room.roomNumber).toBe('101')
    expect(room.clearDimensionPolicy).toBe('inside-faces')
  })

  test('rejects an unknown spaceCategory', () => {
    expect(() =>
      ZoneNode.parse({
        id: 'zone_unknown',
        name: 'Storage',
        polygon: [
          [0, 0],
          [4, 0],
          [4, 3],
        ],
        spaceCategory: 'server-room',
      }),
    ).toThrow()
  })

  test('exposes the full SP air-exchange category row', () => {
    expect(SPACE_CATEGORIES).toEqual([
      'kitchen_gas',
      'kitchen_electric',
      'bath',
      'toilet',
      'combined_wc',
      'living',
      'office_short',
      'office_permanent',
      'public',
      'industrial',
    ])
  })
})
