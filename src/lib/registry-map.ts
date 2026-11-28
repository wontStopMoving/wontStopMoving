import type { RegistryBounds } from './registry';

export type MapPoint = [dot: string, lat: number, lng: number, name: string, units: number, state: string, color?: string];
export type MapCluster = { lat: number; lng: number; count: number };

const longitudeOffset = (lng: number, west: number) => ((lng - west) % 360 + 360) % 360;

/** Count every located company. Dense views increment grid cells as each snapshot is read. */
export function collectRegistryMap(bounds: RegistryBounds | undefined, zoom: number) {
  const west = bounds?.west ?? -180, south = bounds?.south ?? -90;
  const height = Math.max((bounds?.north ?? 90) - south, 0.00001);
  const width = Math.max(Math.min((bounds?.east ?? 180) - west, 360), 0.00001);
  const columns = 40, rows = 24;
  const pinLimit = zoom >= 18 && height < 0.1 && width < 0.1 ? 5000 : 2500;
  const cells = new Map<number, MapCluster>();
  const pending: MapPoint[] = [];
  let total = 0;

  function addToCell(lat: number, lng: number) {
    const offset = longitudeOffset(lng, west);
    const column = Math.min(columns - 1, Math.floor(offset / width * columns));
    const row = Math.min(rows - 1, Math.floor((lat - south) / height * rows));
    const key = row * columns + column;
    const cell = cells.get(key);
    if (cell) {
      cell.lat += lat;
      cell.lng += west + offset;
      cell.count++;
    } else {
      cells.set(key, { lat, lng: west + offset, count: 1 });
    }
  }

  return {
    add(points: MapPoint[]) {
      total += points.length;
      if (total <= pinLimit) {
        for (const point of points) pending.push(point);
        return;
      }
      for (const [, lat, lng] of pending) addToCell(lat, lng);
      pending.length = 0;
      for (const [, lat, lng] of points) addToCell(lat, lng);
    },
    result() {
      const points = bounds
        ? pending.map(([dot, lat, lng, ...data]): MapPoint => [dot, lat, west + longitudeOffset(lng, west), ...data])
        : pending;
      const clusters = [...cells.values()].map(({ lat, lng, count }) => ({ lat: lat / count, lng: lng / count, count }));
      return { total, points, clusters };
    },
  };
}

export function registryMap(points: MapPoint[], bounds: RegistryBounds | undefined, zoom: number) {
  const map = collectRegistryMap(bounds, zoom);
  map.add(points);
  return map.result();
}
