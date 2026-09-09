import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, MapStyleImageMissingEvent } from 'maplibre-gl';
import type { GuideMap } from '../shared/api-types';
import type { TripStop } from './trip';
import { isJejuPoint } from './api';

export type CatalogPoints = GeoJSON.FeatureCollection<GeoJSON.Point, {
  id: string; name: string; category: string; source_label: string;
}>;
const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700;
const osmCredit = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors · ODbL</a>';

export class CatalogMap {
  constructor(readonly map: MapLibreMap, onSelect: (id: string) => void) {
    // Numeric sprite images keep cluster labels local and GPU rendered. No
    // remote glyph service and no DOM element for each catalog place.
    map.on('styleimagemissing', this.missingImage);
    map.addSource('catalog-points', {
      type: 'geojson', data: empty(), cluster: true, clusterMaxZoom: 14, clusterRadius: 42,
      clusterMinPoints: 3, attribution: osmCredit,
    });
    map.addLayer({
      id: 'catalog-clusters', type: 'circle', source: 'catalog-points', filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#187c87', 'circle-opacity': 0.91,
        'circle-radius': ['step', ['get', 'point_count'], 15, 20, 19, 100, 23, 1000, 27],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'catalog-cluster-labels', type: 'symbol', source: 'catalog-points', filter: ['has', 'point_count'],
      layout: {
        'icon-image': ['concat', 'atlas-count-', ['to-string', ['get', 'point_count']]],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    map.addLayer({
      id: 'catalog-dots', type: 'circle', source: 'catalog-points', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 13, 6, 17, 9],
        'circle-color': ['match', ['get', 'category'],
          ['food', 'restaurant', '맛집'], '#bb7851', ['cafe', '카페'], '#927153',
          ['stay', 'hotel', 'lodging', 'accommodation', '숙소', '박물관'], '#6d799e',
          ['nature', 'mountain', 'park', '오름', '올레길'], '#668b6b',
          ['beach', 'coast', 'island', '해변'], '#3b96a0',
          ['shopping', '시장'], '#ab935d', ['parking', '주차장'], '#687a86', '#187c87'],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2, 'circle-opacity': 0.87,
      },
    });
    this.routeLayer('trip', '#c16d43');
    this.routeLayer('guide', '#587a9b');
    const select = (event: MapLayerMouseEvent) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === 'string') onSelect(id);
    };
    map.on('click', 'catalog-dots', select);
    map.on('click', 'trip-stops', select);
    map.on('click', 'guide-stops', select);
    map.on('click', 'catalog-clusters', async (event) => {
      const feature = event.features?.[0];
      if (feature?.geometry.type !== 'Point') return;
      const source = map.getSource('catalog-points') as GeoJSONSource;
      try {
        const zoom = await source.getClusterExpansionZoom(Number(feature.properties.cluster_id));
        map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom: Math.min(17, zoom), duration: motion() });
      } catch { /* A newer point request may replace a cluster before the click resolves. */ }
    });
    for (const layer of ['catalog-clusters', 'catalog-dots', 'trip-stops', 'guide-stops']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
  }

  private missingImage = (event: MapStyleImageMissingEvent): void => {
    if (!/^atlas-(count|stop)-\d{1,5}$/.test(event.id) || this.map.hasImage(event.id)) return;
    const label = event.id.split('-').at(-1)!;
    const canvas = document.createElement('canvas');
    canvas.width = 112;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = 'bold 24px ui-monospace, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.fillText(label, 56, 20);
    this.map.addImage(event.id, context.getImageData(0, 0, 112, 40), { pixelRatio: 2 });
  };

  private routeLayer(kind: 'trip' | 'guide', color: string): void {
    this.map.addSource(`${kind}-route`, { type: 'geojson', data: empty() });
    this.map.addLayer({
      id: `${kind}-route-line`, type: 'line', source: `${kind}-route`,
      paint: { 'line-color': color, 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 },
      layout: { 'line-join': 'round', 'line-cap': 'round' },
    });
    this.map.addSource(`${kind}-places`, { type: 'geojson', data: empty() });
    this.map.addLayer({
      id: `${kind}-stops`, type: 'circle', source: `${kind}-places`,
      paint: { 'circle-color': color, 'circle-radius': 12, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    });
    this.map.addLayer({
      id: `${kind}-numbers`, type: 'symbol', source: `${kind}-places`,
      layout: { 'icon-image': ['concat', 'atlas-stop-', ['to-string', ['get', 'order']]], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    });
  }

  setPoints(data: CatalogPoints): void {
    (this.map.getSource('catalog-points') as GeoJSONSource).setData(data);
  }

  setVisible(visible: boolean): void {
    for (const id of ['catalog-clusters', 'catalog-cluster-labels', 'catalog-dots']) {
      this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  private setRoute(kind: 'trip' | 'guide', places: { id: string; name: string; lat: number; lng: number }[], route: [number, number][]): void {
    (this.map.getSource(`${kind}-places`) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: places.map((place, index) => ({
        type: 'Feature', properties: { id: place.id, name: place.name, order: index + 1 },
        geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
      })),
    });
    (this.map.getSource(`${kind}-route`) as GeoJSONSource).setData(route.length < 2 ? empty() : {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route } }],
    });
  }

  setTrip(stops: TripStop[]): void {
    this.setRoute('trip', stops, stops.map((stop) => [stop.lng, stop.lat]));
  }

  setGuide(response: GuideMap): void {
    const markers = response.markers.filter((point) => isJejuPoint(point.lng, point.lat)).slice(0, 40);
    const route = response.route.filter((point) => isJejuPoint(point.lng, point.lat)).slice(0, 512).map((point): [number, number] => [point.lng, point.lat]);
    this.setRoute('guide', markers, route);
    if (response.center && isJejuPoint(response.center.lng, response.center.lat)) {
      this.map.flyTo({
        center: [response.center.lng, response.center.lat],
        zoom: Math.max(8, Math.min(15, Number.isFinite(response.zoom) ? response.zoom : 11)),
        duration: motion(),
      });
    }
  }
}
